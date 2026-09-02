require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');

const app = express();
const PORT = process.env.PORT || 3000;

// 홈랩 환경은 자체 서명 인증서를 쓰는 경우가 많아 검증을 끕니다.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/* ------------------------- 설정 저장 (웹 UI 설정) ------------------------ */
// docker-compose.yml에서 ./data 를 이 경로로 마운트하면 컨테이너를
// 재생성해도(docker compose up --build) 설정이 사라지지 않습니다.
const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');

const DEFAULT_NOTIFICATIONS = {
  discordWebhook: '', telegramBotToken: '', telegramChatId: '',
  events: { serverDown: true, serverUp: true, tileDown: true, tileUp: true, loginFail: true },
};

const DEFAULT_SETTINGS = {
  refreshInterval: 15,
  title: '홈랩 대시보드',
  subtitle: 'Proxmox VE · Synology DSM',
};

let cfg = { proxmoxServers: [], synologyServers: [], groups: [], users: [], accessLog: [], settings: { ...DEFAULT_SETTINGS }, notifications: { ...DEFAULT_NOTIFICATIONS } };
let sseClients = []; // /api/stream 에 연결된 클라이언트들 (실시간 업데이트용)

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadConfig() {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    parsed = null;
  }

  if (!parsed) {
    // 파일이 없으면 최초 실행 - .env 값이 있으면 그걸로 시드
    cfg = { proxmoxServers: [], synologyServers: [], groups: [], users: [], accessLog: [], settings: { ...DEFAULT_SETTINGS }, notifications: { ...DEFAULT_NOTIFICATIONS } };
    if (process.env.PROXMOX_HOST) {
      cfg.proxmoxServers.push({
        id: newId('pve'), name: 'Proxmox',
        host: process.env.PROXMOX_HOST,
        tokenId: process.env.PROXMOX_TOKEN_ID || '',
        tokenSecret: process.env.PROXMOX_TOKEN_SECRET || '',
      });
    }
    if (process.env.SYNOLOGY_HOST) {
      cfg.synologyServers.push({
        id: newId('syn'), name: 'Synology',
        host: process.env.SYNOLOGY_HOST,
        user: process.env.SYNOLOGY_USER || '',
        password: process.env.SYNOLOGY_PASSWORD || '',
      });
    }
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    saveConfig();
    return;
  }

  cfg = { proxmoxServers: [], synologyServers: [], groups: [], users: [], accessLog: [], settings: { ...DEFAULT_SETTINGS }, notifications: { ...DEFAULT_NOTIFICATIONS }, ...parsed };
  cfg.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
  cfg.notifications = { ...DEFAULT_NOTIFICATIONS, ...(parsed.notifications || {}), events: { ...DEFAULT_NOTIFICATIONS.events, ...(parsed.notifications?.events || {}) } };

  // 구버전(단일 서버) 설정 마이그레이션
  if (parsed.proxmox && parsed.proxmox.host && cfg.proxmoxServers.length === 0) {
    cfg.proxmoxServers.push({ id: newId('pve'), name: 'Proxmox', ...parsed.proxmox });
  }
  if (parsed.synology && parsed.synology.host && cfg.synologyServers.length === 0) {
    cfg.synologyServers.push({ id: newId('syn'), name: 'Synology', ...parsed.synology });
  }
  delete cfg.proxmox;
  delete cfg.synology;

  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    saveConfig();
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  broadcastRefresh(); // 변경사항이 있을 때마다 연결된 모든 클라이언트에게 즉시 알림
}

loadConfig();

/* ------------------------------ 로그인/계정 ------------------------------ */

function isAuthEnabled() { return cfg.users.length > 0; }

app.use(express.json());
app.use(cookieSession({
  name: 'session',
  secret: cfg.sessionSecret,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30일
  sameSite: 'lax',
}));

function requireAuth(req, res, next) {
  if (!isAuthEnabled()) return next();
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ ok: false, error: '로그인이 필요합니다' });
}

function logAccess(entry) {
  cfg.accessLog.unshift({ time: Date.now(), ip: entry.ip, username: entry.username, success: entry.success });
  cfg.accessLog = cfg.accessLog.slice(0, 200);
  saveConfig();
}

app.get('/api/version', (req, res) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  res.json({ version: pkg.version });
});

app.get('/api/auth-status', (req, res) => {
  res.json({
    authEnabled: isAuthEnabled(),
    loggedIn: !!(req.session && req.session.userId),
    username: req.session?.username || null,
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = cfg.users.find((u) => u.username === username);
  const ok = user && bcrypt.compareSync(password || '', user.passwordHash);
  logAccess({ ip: req.ip, username: username || '(빈 값)', success: !!ok });
  if (!ok) {
    if (cfg.notifications.events.loginFail) {
      notify(`⚠️ 홈랩 대시보드 로그인 실패: 아이디 "${username || '(빈 값)'}", IP ${req.ip}`).catch(() => {});
    }
    return res.status(401).json({ ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/access-log', requireAuth, (req, res) => {
  res.json({ items: cfg.accessLog });
});

app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: cfg.users.map((u) => ({ id: u.id, username: u.username })) });
});

// 계정이 하나도 없을 때는(=로그인 기능이 아직 꺼져 있을 때) 인증 없이 첫 계정을 만들 수 있습니다.
// 계정이 이미 있으면 로그인한 사용자만 추가할 수 있습니다.
app.post('/api/users', requireAuth, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: '아이디와 비밀번호를 입력하세요' });
  if (cfg.users.find((u) => u.username === username)) return res.status(400).json({ ok: false, error: '이미 있는 아이디입니다' });
  const user = { id: newId('user'), username, passwordHash: bcrypt.hashSync(password, 10) };
  cfg.users.push(user);
  saveConfig();
  res.json({ ok: true, user: { id: user.id, username: user.username } });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  if (cfg.users.length <= 1) return res.status(400).json({ ok: false, error: '마지막 계정은 삭제할 수 없습니다' });
  cfg.users = cfg.users.filter((u) => u.id !== req.params.id);
  saveConfig();
  res.json({ ok: true });
});

app.put('/api/users/:id/password', requireAuth, (req, res) => {
  const user = cfg.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: '계정을 찾을 수 없습니다' });
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ ok: false, error: '새 비밀번호를 입력하세요' });
  user.passwordHash = bcrypt.hashSync(password, 10);
  saveConfig();
  res.json({ ok: true });
});

/* ------------------------------ 알림 (Discord / Telegram) ------------------------------ */

async function sendDiscord(message) {
  if (!cfg.notifications.discordWebhook) return;
  await axios.post(cfg.notifications.discordWebhook, { content: message }, { timeout: 5000 });
}

async function sendTelegram(message) {
  const { telegramBotToken, telegramChatId } = cfg.notifications;
  if (!telegramBotToken || !telegramChatId) return;
  await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    chat_id: telegramChatId, text: message,
  }, { timeout: 5000 });
}

async function notify(message) {
  await Promise.allSettled([sendDiscord(message), sendTelegram(message)]);
}

app.get('/api/notifications', (req, res) => {
  const n = cfg.notifications;
  res.json({
    hasDiscordWebhook: !!n.discordWebhook,
    hasTelegramBotToken: !!n.telegramBotToken,
    telegramChatId: n.telegramChatId || '',
    events: n.events,
  });
});

app.put('/api/notifications', requireAuth, (req, res) => {
  const { discordWebhook, telegramBotToken, telegramChatId, events } = req.body || {};
  if (discordWebhook) cfg.notifications.discordWebhook = discordWebhook;
  if (telegramBotToken) cfg.notifications.telegramBotToken = telegramBotToken;
  if (telegramChatId !== undefined) cfg.notifications.telegramChatId = telegramChatId;
  if (events) cfg.notifications.events = { ...cfg.notifications.events, ...events };
  saveConfig();
  res.json({ ok: true });
});

app.post('/api/notifications/test', requireAuth, async (req, res) => {
  try {
    await notify('🔔 홈랩 대시보드 알림 테스트입니다. 이 메시지가 보이면 정상 연결된 거예요!');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.response?.data?.description || err.message });
  }
});

/* ------------------------------ 백그라운드 상태 감시 (알림용) ------------------------------ */
// 브라우저를 안 열어놔도 서버 자체가 주기적으로 확인해서 다운/복구를 알려줍니다.

const monitorState = {}; // key: 'pve:id' | 'syn:id' | 'tile:id' -> 'up' | 'down'

async function checkAndNotify(key, isUp, upLabel, downLabel) {
  const prev = monitorState[key];
  const current = isUp ? 'up' : 'down';
  monitorState[key] = current;
  if (prev === undefined) return; // 서버 시작 직후 첫 체크는 알리지 않음 (기준점만 세움)
  if (prev === current) return;
  broadcastRefresh(); // 상태가 바뀌었으니 화면도 바로 갱신
  if (current === 'down' && cfg.notifications.events.serverDown) await notify(downLabel).catch(() => {});
  if (current === 'up' && cfg.notifications.events.serverUp) await notify(upLabel).catch(() => {});
}

async function runMonitorCycle() {
  await Promise.allSettled(cfg.proxmoxServers.map(async (s) => {
    let ok = false;
    try { await pveRequest(s, '/nodes'); ok = true; } catch { ok = false; }
    await checkAndNotify(`pve:${s.id}`, ok, `✅ [Proxmox] ${s.name} 서버가 다시 연결되었습니다.`, `🔴 [Proxmox] ${s.name} 서버에 연결할 수 없습니다.`);
  }));

  await Promise.allSettled(cfg.synologyServers.map(async (s) => {
    let ok = false;
    try { await synLogin(s); ok = true; } catch { ok = false; }
    await checkAndNotify(`syn:${s.id}`, ok, `✅ [Synology] ${s.name} 서버가 다시 연결되었습니다.`, `🔴 [Synology] ${s.name} 서버에 연결할 수 없습니다.`);
  }));

  const allTiles = cfg.groups.flatMap((g) => g.tiles || []);
  await Promise.allSettled(allTiles.filter((t) => t.statusCheck !== false && t.url).map(async (t) => {
    const status = await checkUp(t.url);
    const key = `tile:${t.id}`;
    const prev = monitorState[key];
    monitorState[key] = status;
    if (prev === undefined || prev === status) return;
    broadcastRefresh();
    if (status === 'down' && cfg.notifications.events.tileDown) await notify(`🔴 [바로가기] ${t.name}에 연결할 수 없습니다.`).catch(() => {});
    if (status === 'up' && cfg.notifications.events.tileUp) await notify(`✅ [바로가기] ${t.name}가 다시 온라인입니다.`).catch(() => {});
  }));
}

setInterval(() => { runMonitorCycle().catch(() => {}); }, 60 * 1000);
setTimeout(() => { runMonitorCycle().catch(() => {}); }, 5000); // 시작 5초 후 첫 기준점 체크

/* ------------------------------ 일반 설정 ------------------------------ */

app.get('/api/settings', (req, res) => {
  res.json({ settings: cfg.settings });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const { refreshInterval, title, subtitle } = req.body || {};
  if (refreshInterval) cfg.settings.refreshInterval = Math.max(5, Math.min(600, Number(refreshInterval) || 15));
  if (title !== undefined) cfg.settings.title = title.trim() || DEFAULT_SETTINGS.title;
  if (subtitle !== undefined) cfg.settings.subtitle = subtitle.trim();
  saveConfig();
  scheduleBroadcast();
  res.json({ ok: true, settings: cfg.settings });
});

/* ------------------------------ 실시간 업데이트 (Server-Sent Events) ------------------------------ */
// Proxmox/Synology 자체엔 "변경 알림" 기능이 없어서 서버가 주기적으로 확인하는 건 동일하지만,
// 브라우저가 각자 타이머로 물어보는 대신 서버가 준비되는 즉시 모든 접속자에게 동시에 밀어줍니다.

let broadcastTimer = null;

function broadcastRefresh() {
  sseClients.forEach((res) => {
    try { res.write('event: refresh\ndata: {}\n\n'); } catch { /* 끊긴 연결은 무시 */ }
  });
}

function scheduleBroadcast() {
  if (broadcastTimer) clearInterval(broadcastTimer);
  const seconds = Math.max(5, cfg.settings.refreshInterval || 15);
  broadcastTimer = setInterval(broadcastRefresh, seconds * 1000);
}
scheduleBroadcast();

app.get('/api/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

/* ------------------------------ 로그인 게이트 ------------------------------ */

app.get('/', (req, res, next) => {
  if (isAuthEnabled() && !(req.session && req.session.userId)) {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// 이 아래의 모든 /api/* 라우트는 계정이 하나 이상 등록되어 있으면 로그인을 요구합니다.
app.use('/api', requireAuth);

function findPve(id) { return cfg.proxmoxServers.find((s) => s.id === id); }
function findSyn(id) { return cfg.synologyServers.find((s) => s.id === id); }

function maskPve(s) {
  return { id: s.id, name: s.name, host: s.host, tokenId: s.tokenId, hasTokenSecret: !!s.tokenSecret };
}
function maskSyn(s) {
  return { id: s.id, name: s.name, host: s.host, user: s.user, hasPassword: !!s.password };
}

// 설정 화면용: 등록된 서버 목록 (마스킹된 값)
app.get('/api/servers', (req, res) => {
  res.json({
    proxmox: cfg.proxmoxServers.map(maskPve),
    synology: cfg.synologyServers.map(maskSyn),
  });
});

app.post('/api/proxmox/servers', (req, res) => {
  const { name, host, tokenId, tokenSecret } = req.body || {};
  if (!name || !host || !tokenId || !tokenSecret) return res.status(400).json({ ok: false, error: '모든 항목을 입력하세요' });
  const server = { id: newId('pve'), name, host, tokenId, tokenSecret };
  cfg.proxmoxServers.push(server);
  saveConfig();
  res.json({ ok: true, server: maskPve(server) });
});

// :id 라우트보다 먼저 와야 "reorder"가 id로 잘못 매칭되지 않습니다
app.put('/api/proxmox/servers/reorder', (req, res) => {
  const order = req.body?.order || [];
  cfg.proxmoxServers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveConfig();
  res.json({ ok: true });
});

app.put('/api/proxmox/servers/:id', (req, res) => {
  const s = findPve(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  const { name, host, tokenId, tokenSecret } = req.body || {};
  if (name) s.name = name;
  if (host) s.host = host;
  if (tokenId) s.tokenId = tokenId;
  if (tokenSecret) s.tokenSecret = tokenSecret;
  saveConfig();
  res.json({ ok: true, server: maskPve(s) });
});

app.delete('/api/proxmox/servers/:id', (req, res) => {
  cfg.proxmoxServers = cfg.proxmoxServers.filter((s) => s.id !== req.params.id);
  saveConfig();
  res.json({ ok: true });
});

app.post('/api/synology/servers', (req, res) => {
  const { name, host, user, password } = req.body || {};
  if (!name || !host || !user || !password) return res.status(400).json({ ok: false, error: '모든 항목을 입력하세요' });
  const server = { id: newId('syn'), name, host, user, password };
  cfg.synologyServers.push(server);
  saveConfig();
  res.json({ ok: true, server: maskSyn(server) });
});

// :id 라우트보다 먼저 와야 "reorder"가 id로 잘못 매칭되지 않습니다
app.put('/api/synology/servers/reorder', (req, res) => {
  const order = req.body?.order || [];
  cfg.synologyServers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveConfig();
  res.json({ ok: true });
});

app.put('/api/synology/servers/:id', (req, res) => {
  const s = findSyn(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  const { name, host, user, password } = req.body || {};
  if (name) s.name = name;
  if (host) s.host = host;
  if (user) s.user = user;
  if (password) s.password = password;
  delete synSidMap[s.id];
  saveConfig();
  res.json({ ok: true, server: maskSyn(s) });
});

app.delete('/api/synology/servers/:id', (req, res) => {
  cfg.synologyServers = cfg.synologyServers.filter((s) => s.id !== req.params.id);
  delete synSidMap[req.params.id];
  saveConfig();
  res.json({ ok: true });
});

/* ----------------------------- Proxmox VE ----------------------------- */

async function pveRequest(server, pathSuffix) {
  const res = await axios.get(`${server.host}/api2/json${pathSuffix}`, {
    headers: { Authorization: `PVEAPIToken=${server.tokenId}=${server.tokenSecret}` },
    httpsAgent: insecureAgent,
    timeout: 5000,
  });
  return res.data.data;
}

async function pveRaw(server, method, pathSuffix, data) {
  return axios({
    method,
    url: `${server.host}/api2/json${pathSuffix}`,
    headers: { Authorization: `PVEAPIToken=${server.tokenId}=${server.tokenSecret}` },
    httpsAgent: insecureAgent,
    timeout: 5000,
    data,
  });
}

app.get('/api/proxmox/:id', async (req, res) => {
  const server = findPve(req.params.id);
  if (!server) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  try {
    const nodes = await pveRequest(server, '/nodes');
    const nodesDetailed = await Promise.all(
      nodes.map(async (n) => {
        const [qemu, lxc] = await Promise.all([
          pveRequest(server, `/nodes/${n.node}/qemu`).catch(() => []),
          pveRequest(server, `/nodes/${n.node}/lxc`).catch(() => []),
        ]);
        return {
          node: n.node,
          status: n.status,
          cpu: n.cpu,
          maxcpu: n.maxcpu,
          mem: n.mem,
          maxmem: n.maxmem,
          disk: n.disk,
          maxdisk: n.maxdisk,
          uptime: n.uptime,
          guests: [
            ...qemu.map((v) => ({
              id: v.vmid, name: v.name, type: 'qemu', status: v.status, node: n.node,
              cpu: v.cpu, mem: v.mem, maxmem: v.maxmem,
            })),
            ...lxc.map((v) => ({
              id: v.vmid, name: v.name, type: 'lxc', status: v.status, node: n.node,
              cpu: v.cpu, mem: v.mem, maxmem: v.maxmem,
            })),
          ],
        };
      })
    );
    res.json({ ok: true, name: server.name, nodes: nodesDetailed, host: server.host });
  } catch (err) {
    res.json({ ok: false, name: server.name, error: err.message, host: server.host });
  }
});

// VM/LXC 전원 제어 (시작/종료/재시작). type은 qemu 또는 lxc.
const ALLOWED_POWER_ACTIONS = new Set(['start', 'shutdown', 'stop', 'reboot']);

app.post('/api/proxmox/:id/guest/:node/:type/:vmid/:action', async (req, res) => {
  const server = findPve(req.params.id);
  if (!server) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  const { node, vmid, action } = req.params;
  const type = req.params.type === 'lxc' ? 'lxc' : 'qemu';
  if (!ALLOWED_POWER_ACTIONS.has(action)) return res.status(400).json({ ok: false, error: '지원하지 않는 동작입니다' });
  try {
    await pveRaw(server, 'post', `/nodes/${node}/${type}/${vmid}/status/${action}`);
    broadcastRefresh();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : err.message });
  }
});

/* ------------------------------ Synology ------------------------------ */

const synSidMap = {}; // { [serverId]: { sid, expiry } }

async function synLogin(server) {
  const cache = synSidMap[server.id];
  if (cache && Date.now() < cache.expiry) return cache.sid;
  const res = await axios.get(`${server.host}/webapi/auth.cgi`, {
    params: {
      api: 'SYNO.API.Auth', version: 6, method: 'login',
      account: server.user, passwd: server.password, session: 'DSM', format: 'sid',
    },
    httpsAgent: insecureAgent,
    timeout: 5000,
  });
  if (!res.data.success) {
    throw new Error('Synology 로그인 실패 (코드 ' + (res.data.error && res.data.error.code) + ')');
  }
  const sid = res.data.data.sid;
  synSidMap[server.id] = { sid, expiry: Date.now() + 5 * 60 * 1000 };
  return sid;
}

app.get('/api/synology/:id', async (req, res) => {
  const server = findSyn(req.params.id);
  if (!server) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  try {
    const sid = await synLogin(server);
    const call = (api, version, method, extra = {}) =>
      axios.get(`${server.host}/webapi/entry.cgi`, {
        params: { api, version, method, _sid: sid, ...extra },
        httpsAgent: insecureAgent,
        timeout: 5000,
      });

    const [utilRes, infoRes, storageRes] = await Promise.all([
      call('SYNO.Core.System.Utilization', 1, 'get'),
      call('SYNO.Core.System', 1, 'info'),
      call('SYNO.Storage.CGI.Storage', 1, 'load_info'),
    ]);

    res.json({
      ok: true,
      name: server.name,
      host: server.host,
      utilization: utilRes.data.data,
      info: infoRes.data.data,
      storage: storageRes.data.data,
    });
  } catch (err) {
    delete synSidMap[server.id];
    res.json({ ok: false, name: server.name, error: err.message, host: server.host });
  }
});

/* ------------------- Proxmox: 방화벽 차단 IP 관리 ------------------- */
const BLOCK_IPSET = 'dashboard_blocked';

async function ensureBlockIpset(server) {
  try {
    await pveRequest(server, `/cluster/firewall/ipset/${BLOCK_IPSET}`);
  } catch {
    await pveRaw(server, 'post', '/cluster/firewall/ipset', { name: BLOCK_IPSET, comment: 'Homelab dashboard blocklist' });
  }
  const rules = await pveRequest(server, '/cluster/firewall/rules').catch(() => []);
  const hasRule = rules.some((r) => r.source === `+${BLOCK_IPSET}` && r.action === 'DROP');
  if (!hasRule) {
    await pveRaw(server, 'post', '/cluster/firewall/rules', {
      type: 'in', action: 'DROP', source: `+${BLOCK_IPSET}`, enable: 1,
      comment: 'Homelab dashboard - blocked IPs',
    });
  }
}

app.get('/api/proxmox/:id/blocklist', async (req, res) => {
  const server = findPve(req.params.id);
  if (!server) return res.json({ ok: false, items: [] });
  try {
    const items = await pveRequest(server, `/cluster/firewall/ipset/${BLOCK_IPSET}`).catch(() => []);
    res.json({ ok: true, items });
  } catch (err) {
    res.json({ ok: false, error: err.message, items: [] });
  }
});

app.post('/api/proxmox/:id/block', async (req, res) => {
  const server = findPve(req.params.id);
  if (!server) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  const { ip, comment } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: 'ip가 필요합니다' });
  try {
    await ensureBlockIpset(server);
    await pveRaw(server, 'post', `/cluster/firewall/ipset/${BLOCK_IPSET}`, { cidr: ip, comment: comment || '' });
    res.json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : err.message });
  }
});

app.delete('/api/proxmox/:id/block/:cidr', async (req, res) => {
  const server = findPve(req.params.id);
  if (!server) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  try {
    await pveRaw(server, 'delete', `/cluster/firewall/ipset/${BLOCK_IPSET}/${encodeURIComponent(req.params.cidr)}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

app.get('/api/proxmox/:id/connections', async (req, res) => {
  const server = findPve(req.params.id);
  if (!server) return res.json({ ok: false, items: [] });
  try {
    const nodes = await pveRequest(server, '/nodes');
    const perNode = await Promise.all(nodes.map(async (n) => {
      const lines = await pveRequest(server, `/nodes/${n.node}/firewall/log?limit=60`).catch(() => []);
      return lines.map((l) => l.t).filter(Boolean);
    }));
    const raw = perNode.flat();
    const items = raw.map((line) => {
      const src = line.match(/SRC=([0-9a-fA-F.:]+)/);
      const dpt = line.match(/DPT=(\d+)/);
      const action = /DROP/i.test(line) ? 'DROP' : (/ACCEPT/i.test(line) ? 'ACCEPT' : '-');
      return src ? { ip: src[1], port: dpt ? dpt[1] : null, action } : null;
    }).filter(Boolean).slice(0, 40);
    res.json({ ok: true, items });
  } catch (err) {
    res.json({ ok: false, error: err.message, items: [] });
  }
});

/* --------- Synology: 로그인 세션 / IP 차단 / Docker 컨테이너 --------- */

// DSM 버전마다 API의 최신 버전 번호가 다를 수 있어서, 고정값 대신 매번 물어봅니다.
const synApiVersionCache = {}; // { [serverId]: { [apiName]: maxVersion } }

async function synApiMaxVersion(server, sid, apiName) {
  synApiVersionCache[server.id] = synApiVersionCache[server.id] || {};
  if (synApiVersionCache[server.id][apiName]) return synApiVersionCache[server.id][apiName];
  const r = await axios.get(`${server.host}/webapi/entry.cgi`, {
    params: { api: 'SYNO.API.Info', version: 1, method: 'query', query: apiName, _sid: sid },
    httpsAgent: insecureAgent, timeout: 5000,
  });
  const info = r.data?.data?.[apiName];
  const version = info?.maxVersion || 1;
  synApiVersionCache[server.id][apiName] = version;
  return version;
}

app.get('/api/synology/:id/sessions', async (req, res) => {
  const server = findSyn(req.params.id);
  if (!server) return res.json({ ok: false, items: [] });
  try {
    const sid = await synLogin(server);
    const apiName = 'SYNO.Core.CurrentConnection';
    const version = await synApiMaxVersion(server, sid, apiName);
    const r = await axios.get(`${server.host}/webapi/entry.cgi`, {
      params: { api: apiName, version, method: 'list', type: 'login', _sid: sid },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    const list = r.data.data.items || r.data.data.list || r.data.data.connection || r.data.data || [];
    res.json({ ok: true, items: Array.isArray(list) ? list : [] });
  } catch (err) {
    res.json({ ok: false, error: err.message, items: [] });
  }
});

app.get('/api/synology/:id/blocklist', async (req, res) => {
  const server = findSyn(req.params.id);
  if (!server) return res.json({ ok: false, items: [] });
  try {
    const sid = await synLogin(server);
    const r = await axios.get(`${server.host}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Core.Security.AutoBlock', version: 1, method: 'list', _sid: sid },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    res.json({ ok: true, items: r.data.data.items || r.data.data.list || [] });
  } catch (err) {
    res.json({ ok: false, error: err.message, items: [] });
  }
});

app.post('/api/synology/:id/block', async (req, res) => {
  const server = findSyn(req.params.id);
  if (!server) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: 'ip가 필요합니다' });
  try {
    const sid = await synLogin(server);
    const r = await axios.get(`${server.host}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Core.Security.AutoBlock', version: 1, method: 'block', _sid: sid, list: JSON.stringify([ip]) },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.delete('/api/synology/:id/block/:ip', async (req, res) => {
  const server = findSyn(req.params.id);
  if (!server) return res.status(404).json({ ok: false, error: '서버를 찾을 수 없습니다' });
  try {
    const sid = await synLogin(server);
    const r = await axios.get(`${server.host}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Core.Security.AutoBlock', version: 1, method: 'unblock', _sid: sid, list: JSON.stringify([req.params.ip]) },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/synology/:id/docker', async (req, res) => {
  const server = findSyn(req.params.id);
  if (!server) return res.json({ ok: false, items: [] });
  try {
    const sid = await synLogin(server);
    const apiName = 'SYNO.Docker.Container';
    const version = await synApiMaxVersion(server, sid, apiName);
    const r = await axios.get(`${server.host}/webapi/entry.cgi`, {
      params: { api: apiName, version, method: 'list', limit: -1, offset: 0, type: 'all', _sid: sid },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code + ' (Container Manager 패키지가 설치되어 있는지 확인하세요)');
    const raw = r.data.data;
    const items = Array.isArray(raw) ? raw
      : Array.isArray(raw?.containers) ? raw.containers
      : raw && typeof raw === 'object' ? Object.values(raw) : [];
    res.json({ ok: true, items: items.map((c) => ({ name: c.name, status: c.status, image: c.image || c.path || '' })) });
  } catch (err) {
    res.json({ ok: false, error: err.message, items: [] });
  }
});

/* ------------------------- 서비스 바로가기 (그룹/타일) ------------------------ */

// 응답용으로 비밀값(apiKey/headerValue)을 마스킹
function maskTile(t) {
  const out = { ...t };
  if (out.widget === 'portainer') {
    out.portainer = { host: t.portainer?.host || '', hasApiKey: !!t.portainer?.apiKey };
  }
  if (out.widget === 'custom_json') {
    out.customJson = {
      endpoint: t.customJson?.endpoint || '',
      headerName: t.customJson?.headerName || '',
      hasHeaderValue: !!t.customJson?.headerValue,
      fields: t.customJson?.fields || [],
    };
  }
  return out;
}

app.get('/api/groups', (req, res) => {
  const groups = cfg.groups.map((g) => ({ ...g, tiles: (g.tiles || []).map(maskTile) }));
  res.json({ groups });
});

app.post('/api/groups', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '이름이 필요합니다' });
  const group = { id: newId('grp'), name, tiles: [] };
  cfg.groups.push(group);
  saveConfig();
  res.json({ ok: true, group });
});

// 그룹 카드 순서 바꾸기 (드래그앤드롭) - :id 라우트보다 먼저 와야 "reorder"가 id로 잘못 매칭되지 않습니다
app.put('/api/groups/reorder', (req, res) => {
  const order = req.body?.order || [];
  cfg.groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveConfig();
  res.json({ ok: true });
});

app.put('/api/groups/:id', (req, res) => {
  const group = cfg.groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: '그룹을 찾을 수 없습니다' });
  if (req.body?.name) group.name = req.body.name.trim();
  saveConfig();
  res.json({ ok: true });
});

app.delete('/api/groups/:id', (req, res) => {
  cfg.groups = cfg.groups.filter((g) => g.id !== req.params.id);
  saveConfig();
  res.json({ ok: true });
});

// 같은 그룹 안 타일 순서 바꾸기 (드래그앤드롭)
app.put('/api/groups/:id/tiles/reorder', (req, res) => {
  const group = cfg.groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: '그룹을 찾을 수 없습니다' });
  const order = req.body?.order || [];
  group.tiles.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveConfig();
  res.json({ ok: true });
});

function applyTileFields(tile, body) {
  tile.name = body.name ?? tile.name ?? '';
  tile.subtitle = body.subtitle ?? tile.subtitle ?? '';
  tile.url = body.url ?? tile.url ?? '';
  tile.icon = body.icon ?? tile.icon ?? '';
  tile.statusCheck = body.statusCheck ?? tile.statusCheck ?? true;
  tile.widget = body.widget ?? tile.widget ?? 'none';

  if (tile.widget === 'portainer') {
    tile.portainer = tile.portainer || {};
    if (body.portainer) {
      tile.portainer.host = body.portainer.host ?? tile.portainer.host ?? '';
      if (body.portainer.apiKey) tile.portainer.apiKey = body.portainer.apiKey;
    }
  } else {
    delete tile.portainer;
  }

  if (tile.widget === 'custom_json') {
    tile.customJson = tile.customJson || {};
    if (body.customJson) {
      tile.customJson.endpoint = body.customJson.endpoint ?? tile.customJson.endpoint ?? '';
      tile.customJson.headerName = body.customJson.headerName ?? tile.customJson.headerName ?? '';
      if (body.customJson.headerValue) tile.customJson.headerValue = body.customJson.headerValue;
      if (Array.isArray(body.customJson.fields)) tile.customJson.fields = body.customJson.fields;
    }
  } else {
    delete tile.customJson;
  }
  return tile;
}

app.post('/api/groups/:id/tiles', (req, res) => {
  const group = cfg.groups.find((g) => g.id === req.params.id);
  if (!group) return res.status(404).json({ ok: false, error: '그룹을 찾을 수 없습니다' });
  const tile = applyTileFields({ id: newId('tile') }, req.body || {});
  group.tiles.push(tile);
  saveConfig();
  res.json({ ok: true, tile: maskTile(tile) });
});

app.put('/api/tiles/:id', (req, res) => {
  for (const g of cfg.groups) {
    const tile = (g.tiles || []).find((t) => t.id === req.params.id);
    if (tile) {
      applyTileFields(tile, req.body || {});
      saveConfig();
      return res.json({ ok: true, tile: maskTile(tile) });
    }
  }
  res.status(404).json({ ok: false, error: '타일을 찾을 수 없습니다' });
});

app.delete('/api/tiles/:id', (req, res) => {
  for (const g of cfg.groups) {
    const before = (g.tiles || []).length;
    g.tiles = (g.tiles || []).filter((t) => t.id !== req.params.id);
    if (g.tiles.length !== before) { saveConfig(); return res.json({ ok: true }); }
  }
  res.json({ ok: true });
});

// 타일을 다른 그룹으로 옮기기 (드래그앤드롭으로 그룹 간 이동)
app.put('/api/tiles/:id/move', (req, res) => {
  const { toGroupId, order } = req.body || {};
  const targetGroup = cfg.groups.find((g) => g.id === toGroupId);
  if (!targetGroup) return res.status(404).json({ ok: false, error: '대상 그룹을 찾을 수 없습니다' });

  let tile = null;
  for (const g of cfg.groups) {
    const idx = (g.tiles || []).findIndex((t) => t.id === req.params.id);
    if (idx !== -1) {
      tile = g.tiles.splice(idx, 1)[0];
      break;
    }
  }
  if (!tile) return res.status(404).json({ ok: false, error: '타일을 찾을 수 없습니다' });

  targetGroup.tiles = targetGroup.tiles || [];
  targetGroup.tiles.push(tile);
  if (Array.isArray(order)) {
    targetGroup.tiles.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }
  saveConfig();
  res.json({ ok: true });
});

// 점 표기법으로 중첩 필드 읽기 (예: "stats.photos.total", "items.0.count")
function getByPath(obj, pathStr) {
  if (!pathStr) return undefined;
  return pathStr.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function checkUp(url) {
  try {
    await axios.get(url, { httpsAgent: insecureAgent, timeout: 4000, validateStatus: () => true });
    return 'up';
  } catch {
    return 'down';
  }
}

async function getPortainerStats(t) {
  const { host, apiKey } = t.portainer || {};
  if (!host || !apiKey) return null;
  const headers = { 'X-API-Key': apiKey };
  const endpoints = await axios.get(`${host}/api/endpoints`, { headers, httpsAgent: insecureAgent, timeout: 5000 }).then(r => r.data);
  let running = 0, stopped = 0;
  for (const ep of endpoints) {
    const containers = await axios.get(`${host}/api/endpoints/${ep.Id}/docker/containers/json?all=true`, { headers, httpsAgent: insecureAgent, timeout: 5000 }).then(r => r.data).catch(() => []);
    containers.forEach((c) => (c.State === 'running' ? running++ : stopped++));
  }
  return [
    { label: 'RUNNING', value: running },
    { label: 'STOPPED', value: stopped },
    { label: 'TOTAL', value: running + stopped },
  ];
}

async function getCustomJsonStats(t) {
  const cj = t.customJson || {};
  if (!cj.endpoint) return null;
  const headers = {};
  if (cj.headerName && cj.headerValue) headers[cj.headerName] = cj.headerValue;
  const data = await axios.get(cj.endpoint, { headers, httpsAgent: insecureAgent, timeout: 5000 }).then(r => r.data);
  return (cj.fields || []).map((f) => ({ label: f.label, value: getByPath(data, f.path) ?? '-' }));
}

app.get('/api/tiles/status', async (req, res) => {
  const allTiles = cfg.groups.flatMap((g) => g.tiles || []);
  const result = {};
  await Promise.all(allTiles.map(async (t) => {
    const entry = { status: 'unknown', stats: null, error: null };
    try {
      if (t.statusCheck !== false && t.url) entry.status = await checkUp(t.url);
      if (t.widget === 'portainer') entry.stats = await getPortainerStats(t);
      if (t.widget === 'custom_json') entry.stats = await getCustomJsonStats(t);
    } catch (err) {
      entry.error = err.message;
    }
    result[t.id] = entry;
  }));
  res.json({ items: result });
});

app.listen(PORT, () => console.log(`Homelab dashboard listening on :${PORT}`));
