// Painel do admin: login, cria sessões, recebe vídeo em tempo real via WebRTC
// e envia comandos de controle remoto por DataChannel.

function getJwt() {
  return sessionStorage.getItem('admin_jwt');
}
function setJwt(token) {
  sessionStorage.setItem('admin_jwt', token);
}
function clearJwt() {
  sessionStorage.removeItem('admin_jwt');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getJwt()}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    clearJwt();
    showLogin();
    throw new Error('sessão expirada');
  }
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return res.json();
}

function showLogin() {
  document.getElementById('loginBox').style.display = 'flex';
  document.getElementById('appBox').style.display = 'none';
}
function showApp() {
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('appBox').style.display = 'block';
  loadHistory();
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Falha no login';
      return;
    }
    setJwt(data.token);
    showApp();
  } catch (e) {
    errEl.textContent = 'Erro de conexão';
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearJwt();
  showLogin();
});

// Se já existe um JWT válido nesta aba, pula direto para o painel.
if (getJwt()) showApp(); else showLogin();

let currentToken = null;
let pc = null;
let dataChannel = null;

document.getElementById('createBtn').addEventListener('click', async () => {
  const studentName = document.getElementById('studentName').value.trim();
  const data = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ studentName, baseUrl: location.origin }),
  });
  currentToken = data.token;
  document.getElementById('linkOut').innerHTML =
    `Link para enviar ao aluno: <a href="${data.link}" target="_blank">${data.link}</a>`;
  connectSignaling(data.token);
  loadHistory();
});

document.getElementById('endBtn').addEventListener('click', async () => {
  if (!currentToken) return;
  await api(`/api/sessions/${currentToken}/end`, { method: 'POST' });
  teardown();
  loadHistory();
});

function connectSignaling(token) {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${wsProto}://${location.host}/ws?role=admin&token=${token}`);

  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.type === 'session-authorized') {
      console.log('Aluno autorizou. Aguardando o app iniciar a transmissão...');
    }

    if (msg.type === 'session-active') {
      document.getElementById('liveBox').style.display = 'block';
      document.getElementById('liveTitle').textContent = 'Sessão ativa';
      loadHistory();
    }

    if (msg.type === 'webrtc-offer') {
      await startPeerConnection(ws);
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'webrtc-answer', sdp: answer.sdp }));
    }

    if (msg.type === 'webrtc-ice' && pc) {
      try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn(e); }
    }

    if (msg.type === 'session-ended') {
      teardown();
      loadHistory();
    }
  };

  window._signalingSocket = ws;
}

async function fetchIceServers() {
  try {
    const res = await fetch('/api/ice-servers');
    const data = await res.json();
    return data.iceServers;
  } catch (e) {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

async function startPeerConnection(ws) {
  pc = new RTCPeerConnection({
    iceServers: await fetchIceServers(),
  });

  pc.ontrack = (event) => {
    document.getElementById('remoteVideo').srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'webrtc-ice', candidate: event.candidate }));
    }
  };

  // Canal para enviar comandos de controle remoto (tap/swipe) ao app Android
  dataChannel = pc.createDataChannel('control');

  const video = document.getElementById('remoteVideo');
  video.addEventListener('click', (e) => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    const rect = video.getBoundingClientRect();
    // Coordenadas normalizadas (0..1) — o app Android converte para pixels reais da tela dele
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    dataChannel.send(JSON.stringify({ type: 'tap', x: nx, y: ny }));
  });
}

function teardown() {
  if (pc) { pc.close(); pc = null; }
  document.getElementById('liveBox').style.display = 'none';
}

async function loadHistory() {
  const list = await api('/api/sessions');
  const body = document.getElementById('historyBody');
  body.innerHTML = '';
  for (const s of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.studentName || '-'}</td>
      <td><span class="badge ${s.status}">${s.status}</span></td>
      <td>${new Date(s.createdAt).toLocaleString('pt-BR')}</td>
      <td>${s.durationSeconds ? s.durationSeconds + 's' : '-'}</td>
      <td>${s.recordingFile ? `<a href="#" data-token="${s.token}" class="playBtn">Reproduzir</a>` : '-'}</td>
      <td>${s.status !== 'ended' ? `<button class="secondary reconnectBtn" data-token="${s.token}">Reconectar</button>` : ''}</td>
    `;
    body.appendChild(tr);
  }
  document.querySelectorAll('.playBtn').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const token = a.dataset.token;
      const w = window.open('', '_blank');
      w.document.write(
        `<video src="/api/sessions/${token}/recording" controls autoplay style="width:100%"></video>`
      );
      // injeta o header de auth via fetch+blob, pois <video src> puro não manda headers customizados
      fetch(`/api/sessions/${token}/recording`, { headers: { 'Authorization': `Bearer ${getJwt()}` } })
        .then((r) => r.blob())
        .then((blob) => {
          w.document.body.innerHTML = '';
          const v = document.createElement('video');
          v.src = URL.createObjectURL(blob);
          v.controls = true;
          v.autoplay = true;
          v.style.width = '100%';
          w.document.body.appendChild(v);
        });
    });
  });
  document.querySelectorAll('.reconnectBtn').forEach((b) => {
    b.addEventListener('click', () => {
      currentToken = b.dataset.token;
      connectSignaling(currentToken);
    });
  });
}

// (histórico é carregado automaticamente ao entrar — ver showApp())
