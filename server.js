require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 홈랩 환경은 자체 서명 인증서를 쓰는 경우가 많아 검증을 끕니다.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------- 설정 저장 (웹 UI 설정) ------------------------ */
// docker-compose.yml에서 ./data 를 이 경로로 마운트하면 컨테이너를
// 재생성해도(docker compose up --build) 설정이 사라지지 않습니다.
const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');

let cfg = { proxmoxServers: [], synologyServers: [], groups: [] };

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
    cfg = { proxmoxServers: [], synologyServers: [], groups: [] };
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
    if (cfg.proxmoxServers.length || cfg.synologyServers.length) saveConfig();
    return;
  }

  cfg = { proxmoxServers: [], synologyServers: [], groups: [], ...parsed };

  // 구버전(단일 서버) 설정 마이그레이션
  if (parsed.proxmox && parsed.proxmox.host && cfg.proxmoxServers.length === 0) {
    cfg.proxmoxServers.push({ id: newId('pve'), name: 'Proxmox', ...parsed.proxmox });
  }
  if (parsed.synology && parsed.synology.host && cfg.synologyServers.length === 0) {
    cfg.synologyServers.push({ id: newId('syn'), name: 'Synology', ...parsed.synology });
  }
  delete cfg.proxmox;
  delete cfg.synology;
}

function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

loadConfig();

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
              id: v.vmid, name: v.name, type: 'qemu', status: v.status,
              cpu: v.cpu, mem: v.mem, maxmem: v.maxmem,
            })),
            ...lxc.map((v) => ({
              id: v.vmid, name: v.name, type: 'lxc', status: v.status,
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

app.get('/api/synology/:id/sessions', async (req, res) => {
  const server = findSyn(req.params.id);
  if (!server) return res.json({ ok: false, items: [] });
  try {
    const sid = await synLogin(server);
    const r = await axios.get(`${server.host}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Core.CurrentConnection.Login', version: 1, method: 'list', _sid: sid },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    const list = r.data.data.items || r.data.data.list || r.data.data || [];
    res.json({ ok: true, items: list });
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
    const r = await axios.get(`${server.host}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Docker.Container', version: 1, method: 'list', _sid: sid },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code + ' (Container Manager 패키지가 설치되어 있는지 확인하세요)');
    const items = r.data.data.containers || r.data.data.list || r.data.data || [];
    res.json({ ok: true, items });
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
