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
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ||
  bcrypt.hashSync('troque-esta-senha', 10);

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

const loginAttempts = new Map();
function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
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

const TURN_HOST = process.env.TURN_HOST || null;
const TURN_USER = process.env.TURN_USER || 'suporte';
const TURN_PASS = process.env.TURN_PASS || 'troque-esta-senha';
const TURN_PORT = process.env.TURN_PORT || '3478';

const METERED_DOMAIN = process.env.METERED_DOMAIN || null;
const METERED_API_KEY = process.env.METERED_API_KEY || null;

app.get('/api/ice-servers', async (req, res) => {
  if (METERED_DOMAIN && METERED_API_KEY) {
    try {
      const url = `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
      const r = await fetch(url);
      const iceServers = await r.json();
      return res.json({ iceServers });
    } catch (e) {
      console.error('Falha ao buscar credenciais Metered, caindo para STUN simples:', e.message);
    }
  }

  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_HOST) {
    servers.push(
      { urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, username: TURN_USER, credential: TURN_PASS },
      { urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`, username: TURN_USER, credential: TURN_PASS }
    );
  }
  res.json({ iceServers: servers });
});

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

app.get('/api/sessions', requireAdmin, (req, res) => {
  const db = readDb();
  const list = Object.values(db).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(list);
});

app.get('/api/sessions/:token', requireAdmin, (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  res.json(session);
});

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

app.get('/api/sessions/:token/recording', requireAdmin, (req, res) => {
  const session = getSession(req.params.token);
  if (!session || !session.recordingFile) return res.status(404).end();
  const filePath = path.join(RECORDINGS_DIR, session.recordingFile);
  res.sendFile(filePath);
});

app.get('/s/:token', (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).send('Link inválido ou expirado.');
  res.sendFile(path.join(__dirname, 'public-student', 'authorize.html'));
});

app.get('/api/public/sessions/:token', (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  res.json({ token: session.token, status: session.status });
});

app.post('/api/public/sessions/:token/authorize', (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  session.status = 'authorized';
  session.authorizedAt = new Date().toISOString();
  saveSession(session);
  broadcastToSession(session.token, { type: 'session-authorized' });
  res.json({ ok: true });
});

app.post('/api/public/sessions/:token/start', (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'não encontrada' });
  session.status = 'active';
  session.startedAt = new Date().toISOString();
  saveSession(session);
  broadcastToSession(session.token, { type: 'session-active' });
  res.json({ ok: true });
});

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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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
  const role = url.searchParams.get('role');

  const session = getSession(token);
  if (!session || (role !== 'admin' && role !== 'student')) {
    ws.close(4000, 'sessão ou papel inválido');
    return;
  }

  if (!rooms.has(token)) rooms.set(token, { admin: null, student: null });
  rooms.get(token)[role] = ws;

  ws.on('message', (raw) => {
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
});
