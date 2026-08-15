/**
 * Backend do MVP de Suporte Remoto
 * - Cria sessões e links únicos
 * - Serve a página de autorização do aluno
 * - Sinalização WebRTC (WebSocket) entre admin <-> app Android do aluno
 * - Recebe upload da gravação e a mantém acessível SOMENTE ao admin
 *
 * Rodar: npm install && ADMIN_TOKEN=troque-isto npm start
 */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DATA_DIR = path.join(__dirname, 'data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
const DB_FILE = path.join(DATA_DIR, 'sessions.json');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
// Hash bcrypt da senha do admin. Gere com: npx bcryptjs-cli hash "sua-senha"
// ou use scripts/hash-password.js incluso neste projeto.
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ||
  bcrypt.hashSync('troque-esta-senha', 10); // fallback só para dev local

// ---------- "Banco de dados" simples em arquivo JSON (suficiente para MVP) ----------
function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function saveSession(session) {
  const db = readDb();
  db[session.token] = session;
  writeDb(db);
}
function getSession(token) {
  return readDb()[token];
}

// Estados possíveis da sessão
// created -> authorized -> active -> ended

// ---------- Autenticação do admin (login + JWT) ----------
function requireAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'não autorizado' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'sessão expirada ou inválida' });
  }
}

const app = express();
app.use(express.json());
app.use('/admin', express.static(path.join(__dirname, 'public')));

// Login: usuário/senha -> JWT válido por 12h.
// Rate-limit simples em memória para dificultar força bruta.
const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10; // máx 10 tentativas / 15min por IP
}

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  if (loginRateLimited(ip)) {
    return res.status(429).json({ error: 'muitas tentativas, tente novamente mais tarde' });
  }
  const { username, password } = req.body || {};
  const userOk = typeof username === 'string' &&
    crypto.timingSafeEqual(
      Buffer.from(username.padEnd(64)), Buffer.from(ADMIN_USERNAME.padEnd(64))
    );
  const passOk = typeof password === 'string' && bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'usuário ou senha inválidos' });
  }
  const token = jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// ================== ICE servers (STUN + TURN) ==================
// Endpoint público (admin e app Android usam) — evita hardcode nos clientes
// e permite trocar o TURN sem precisar recompilar o app.
const TURN_HOST = process.env.TURN_HOST || null; // ex: openrelay.metered.ca (TURN gerenciado) ou seu IP (coturn próprio)
const TURN_USER = process.env.TURN_USER || 'suporte';
const TURN_PASS = process.env.TURN_PASS || 'troque-esta-senha';
const TURN_PORT = process.env.TURN_PORT || '3478';

app.get('/api/ice-servers', (req, res) => {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_HOST) {
    servers.push(
      { urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, username: TURN_USER, credential: TURN_PASS },
      { urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`, username: TURN_USER, credential: TURN_PASS }
    );
  }
  res.json({ iceServers: servers });
});

// ================== API ADMIN ==================

// Criar sessão + gerar link único
app.post('/api/sessions', requireAdmin, (req, res) => {
  const token = crypto.randomBytes(16).toString('hex');
  const session = {
    token,
    studentName: req.body.studentName || null,
    status: 'created',
    createdAt: new Date().toISOString(),
    authorizedAt: null,
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    recordingFile: null,
  };
  saveSession(session);
  const baseUrl = req.body.baseUrl || `${req.protocol}://${req.get('host')}`;
  res.json({ ...session, link: `${baseUrl}/s/${token}` });
});

// Listar histórico
app.get('/api/sessions', requireAdmin, (req, res) => {
  const db = readDb();
  const list = Object.values(db).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(list);
});

// Detalhe de uma sessão
app.get('/api/sessions/:token', requireAdmin, (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  res.json(session);
});

// Encerrar sessão (admin)
app.post('/api/sessions/:token/end', requireAdmin, (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  session.status = 'ended';
  session.endedAt = new Date().toISOString();
  if (session.startedAt) {
    session.durationSeconds = Math.round(
      (new Date(session.endedAt) - new Date(session.startedAt)) / 1000
    );
  }
  saveSession(session);
  broadcastToSession(session.token, { type: 'session-ended' });
  res.json(session);
});

// Reproduzir gravação (somente admin, via token de auth)
app.get('/api/sessions/:token/recording', requireAdmin, (req, res) => {
  const session = getSession(req.params.token);
  if (!session || !session.recordingFile) return res.status(404).end();
  const filePath = path.join(RECORDINGS_DIR, session.recordingFile);
  res.sendFile(filePath);
});

// ================== API ALUNO (página pública de autorização) ==================

// Página servida ao abrir o link
app.get('/s/:token', (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).send('Link inválido ou expirado.');
  res.sendFile(path.join(__dirname, 'public-student', 'authorize.html'));
});

// Info da sessão para a página do aluno carregar via JS
app.get('/api/public/sessions/:token', (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  res.json({ token: session.token, status: session.status });
});

// Aluno autoriza (chamado depois que o app Android confirma consentimento)
app.post('/api/public/sessions/:token/authorize', (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  session.status = 'authorized';
  session.authorizedAt = new Date().toISOString();
  saveSession(session);
  broadcastToSession(session.token, { type: 'session-authorized' });
  res.json({ ok: true });
});

// App Android avisa que começou a transmitir/gravar
app.post('/api/public/sessions/:token/start', (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  session.status = 'active';
  session.startedAt = new Date().toISOString();
  saveSession(session);
  broadcastToSession(session.token, { type: 'session-active' });
  res.json({ ok: true });
});

// Upload da gravação ao final da sessão (multipart/form-data, campo "video")
const upload = multer({ dest: RECORDINGS_DIR });
app.post('/api/public/sessions/:token/recording', upload.single('video'), (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  const finalName = `${session.token}.mp4`;
  fs.renameSync(req.file.path, path.join(RECORDINGS_DIR, finalName));
  session.recordingFile = finalName;
  saveSession(session);
  res.json({ ok: true });
});

// ================== Sinalização WebRTC (WebSocket) ==================
// Admin e app Android conectam no mesmo token e trocam SDP/ICE.
// O servidor apenas repassa mensagens (relay) — não interpreta o conteúdo.

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// token -> { admin: ws|null, student: ws|null }
const rooms = new Map();

function broadcastToSession(token, payload) {
  const room = rooms.get(token);
  if (!room) return;
  const msg = JSON.stringify(payload);
  if (room.admin) room.admin.send(msg);
  if (room.student) room.student.send(msg);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const role = url.searchParams.get('role'); // 'admin' | 'student'

  const session = getSession(token);
  if (!session || (role !== 'admin' && role !== 'student')) {
    ws.close(4000, 'sessão ou papel inválido');
    return;
  }

  if (!rooms.has(token)) rooms.set(token, { admin: null, student: null });
  rooms.get(token)[role] = ws;

  ws.on('message', (raw) => {
    // Repassa sinalização (offer/answer/ice) e comandos de controle
    // para a outra ponta da mesma sessão.
    const room = rooms.get(token);
    const target = role === 'admin' ? room.student : room.admin;
    if (target && target.readyState === target.OPEN) {
      target.send(raw.toString());
    }
  });

  ws.on('close', () => {
    const room = rooms.get(token);
    if (room) room[role] = null;
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Painel admin: http://localhost:${PORT}/admin`);
  console.log(`ADMIN_TOKEN atual: ${ADMIN_TOKEN}`);
});
