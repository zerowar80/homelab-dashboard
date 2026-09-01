require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 홈랩 환경은 자체 서명 인증서를 쓰는 경우가 많아 검증을 끕니다.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ----------------------------- Proxmox VE ----------------------------- */

const PVE_HOST = process.env.PROXMOX_HOST; // 예: https://192.168.1.10:8006
const PVE_TOKEN_ID = process.env.PROXMOX_TOKEN_ID; // 예: root@pam!dashboard
const PVE_TOKEN_SECRET = process.env.PROXMOX_TOKEN_SECRET;

async function pveRequest(pathSuffix) {
  const res = await axios.get(`${PVE_HOST}/api2/json${pathSuffix}`, {
    headers: { Authorization: `PVEAPIToken=${PVE_TOKEN_ID}=${PVE_TOKEN_SECRET}` },
    httpsAgent: insecureAgent,
    timeout: 5000,
  });
  return res.data.data;
}

app.get('/api/proxmox', async (req, res) => {
  if (!PVE_HOST || !PVE_TOKEN_ID || !PVE_TOKEN_SECRET) {
    return res.json({ configured: false });
  }
  try {
    const nodes = await pveRequest('/nodes');
    const nodesDetailed = await Promise.all(
      nodes.map(async (n) => {
        const [qemu, lxc] = await Promise.all([
          pveRequest(`/nodes/${n.node}/qemu`).catch(() => []),
          pveRequest(`/nodes/${n.node}/lxc`).catch(() => []),
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
    res.json({ configured: true, ok: true, nodes: nodesDetailed, host: PVE_HOST });
  } catch (err) {
    res.json({ configured: true, ok: false, error: err.message, host: PVE_HOST });
  }
});

/* ------------------------------ Synology ------------------------------ */

const SYN_HOST = process.env.SYNOLOGY_HOST; // 예: https://192.168.1.20:5001
const SYN_USER = process.env.SYNOLOGY_USER;
const SYN_PASS = process.env.SYNOLOGY_PASSWORD;

let synSid = null;
let synSidExpiry = 0;

async function synLogin() {
  if (synSid && Date.now() < synSidExpiry) return synSid;
  const res = await axios.get(`${SYN_HOST}/webapi/auth.cgi`, {
    params: {
      api: 'SYNO.API.Auth', version: 6, method: 'login',
      account: SYN_USER, passwd: SYN_PASS, session: 'DSM', format: 'sid',
    },
    httpsAgent: insecureAgent,
    timeout: 5000,
  });
  if (!res.data.success) {
    throw new Error('Synology 로그인 실패 (코드 ' + (res.data.error && res.data.error.code) + ')');
  }
  synSid = res.data.data.sid;
  synSidExpiry = Date.now() + 5 * 60 * 1000; // 5분 캐시
  return synSid;
}

app.get('/api/synology', async (req, res) => {
  if (!SYN_HOST || !SYN_USER || !SYN_PASS) {
    return res.json({ configured: false });
  }
  try {
    const sid = await synLogin();
    const call = (api, version, method, extra = {}) =>
      axios.get(`${SYN_HOST}/webapi/entry.cgi`, {
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
      configured: true,
      ok: true,
      host: SYN_HOST,
      utilization: utilRes.data.data,
      info: infoRes.data.data,
      storage: storageRes.data.data,
    });
  } catch (err) {
    // sid가 만료됐을 수 있으니 다음 요청에서 재로그인하도록 초기화
    synSid = null;
    res.json({ configured: true, ok: false, error: err.message, host: SYN_HOST });
  }
});

/* ------------------- Proxmox: 방화벽 차단 IP 관리 ------------------- */
// 대시보드 전용 ipset을 만들어서 그 안에만 IP를 추가/삭제합니다.
// 기존 방화벽 설정은 건드리지 않습니다.
const BLOCK_IPSET = 'dashboard_blocked';

async function pveRaw(method, pathSuffix, data) {
  return axios({
    method,
    url: `${PVE_HOST}/api2/json${pathSuffix}`,
    headers: { Authorization: `PVEAPIToken=${PVE_TOKEN_ID}=${PVE_TOKEN_SECRET}` },
    httpsAgent: insecureAgent,
    timeout: 5000,
    data,
  });
}

async function ensureBlockIpset() {
  try {
    await pveRequest(`/cluster/firewall/ipset/${BLOCK_IPSET}`);
  } catch {
    // ipset이 없으면 새로 생성
    await pveRaw('post', '/cluster/firewall/ipset', { name: BLOCK_IPSET, comment: 'Homelab dashboard blocklist' });
  }
  // 이 ipset을 참조하는 DROP 규칙이 있는지 확인하고 없으면 추가
  const rules = await pveRequest('/cluster/firewall/rules').catch(() => []);
  const hasRule = rules.some((r) => r.source === `+${BLOCK_IPSET}` && r.action === 'DROP');
  if (!hasRule) {
    await pveRaw('post', '/cluster/firewall/rules', {
      type: 'in', action: 'DROP', source: `+${BLOCK_IPSET}`, enable: 1,
      comment: 'Homelab dashboard - blocked IPs',
    });
  }
}

app.get('/api/proxmox/blocklist', async (req, res) => {
  if (!PVE_HOST) return res.json({ configured: false, items: [] });
  try {
    const items = await pveRequest(`/cluster/firewall/ipset/${BLOCK_IPSET}`).catch(() => []);
    res.json({ configured: true, ok: true, items });
  } catch (err) {
    res.json({ configured: true, ok: false, error: err.message, items: [] });
  }
});

app.post('/api/proxmox/block', async (req, res) => {
  const { ip, comment } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: 'ip가 필요합니다' });
  try {
    await ensureBlockIpset();
    await pveRaw('post', `/cluster/firewall/ipset/${BLOCK_IPSET}`, { cidr: ip, comment: comment || '' });
    res.json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : err.message });
  }
});

app.delete('/api/proxmox/block/:cidr', async (req, res) => {
  try {
    await pveRaw('delete', `/cluster/firewall/ipset/${BLOCK_IPSET}/${encodeURIComponent(req.params.cidr)}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// 노드 방화벽 로그에서 최근 접속 시도(SRC IP)를 뽑아옵니다.
// 노드 방화벽에 로깅이 켜져 있어야 값이 나옵니다 (기본은 비활성).
app.get('/api/proxmox/connections', async (req, res) => {
  if (!PVE_HOST) return res.json({ configured: false, items: [] });
  try {
    const nodes = await pveRequest('/nodes');
    const perNode = await Promise.all(nodes.map(async (n) => {
      const lines = await pveRequest(`/nodes/${n.node}/firewall/log?limit=60`).catch(() => []);
      return lines.map((l) => l.t).filter(Boolean);
    }));
    const raw = perNode.flat();
    const items = raw.map((line) => {
      const src = line.match(/SRC=([0-9a-fA-F.:]+)/);
      const dpt = line.match(/DPT=(\d+)/);
      const action = /DROP/i.test(line) ? 'DROP' : (/ACCEPT/i.test(line) ? 'ACCEPT' : '-');
      return src ? { ip: src[1], port: dpt ? dpt[1] : null, action } : null;
    }).filter(Boolean).slice(0, 40);
    res.json({ configured: true, ok: true, items, loggingEnabled: items.length > 0 });
  } catch (err) {
    res.json({ configured: true, ok: false, error: err.message, items: [] });
  }
});

/* --------- Synology: 로그인 세션 / IP 차단 / Docker 컨테이너 --------- */

app.get('/api/synology/sessions', async (req, res) => {
  if (!SYN_HOST) return res.json({ configured: false, items: [] });
  try {
    const sid = await synLogin();
    const r = await axios.get(`${SYN_HOST}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Core.CurrentConnection.Login', version: 1, method: 'list', _sid: sid },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    const list = r.data.data.items || r.data.data.list || r.data.data || [];
    res.json({ configured: true, ok: true, items: list });
  } catch (err) {
    res.json({ configured: true, ok: false, error: err.message, items: [] });
  }
});

app.get('/api/synology/blocklist', async (req, res) => {
  if (!SYN_HOST) return res.json({ configured: false, items: [] });
  try {
    const sid = await synLogin();
    const r = await axios.get(`${SYN_HOST}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Core.Security.AutoBlock', version: 1, method: 'list', _sid: sid },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    res.json({ configured: true, ok: true, items: r.data.data.items || r.data.data.list || [] });
  } catch (err) {
    res.json({ configured: true, ok: false, error: err.message, items: [] });
  }
});

app.post('/api/synology/block', async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ ok: false, error: 'ip가 필요합니다' });
  try {
    const sid = await synLogin();
    const r = await axios.get(`${SYN_HOST}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Core.Security.AutoBlock', version: 1, method: 'block', _sid: sid, list: JSON.stringify([ip]) },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.delete('/api/synology/block/:ip', async (req, res) => {
  try {
    const sid = await synLogin();
    const r = await axios.get(`${SYN_HOST}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Core.Security.AutoBlock', version: 1, method: 'unblock', _sid: sid, list: JSON.stringify([req.params.ip]) },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/synology/docker', async (req, res) => {
  if (!SYN_HOST) return res.json({ configured: false, items: [] });
  try {
    const sid = await synLogin();
    const r = await axios.get(`${SYN_HOST}/webapi/entry.cgi`, {
      params: { api: 'SYNO.Docker.Container', version: 1, method: 'list', _sid: sid },
      httpsAgent: insecureAgent, timeout: 5000,
    });
    if (!r.data.success) throw new Error('API 오류 코드 ' + r.data.error?.code + ' (Container Manager 패키지가 설치되어 있는지 확인하세요)');
    const items = r.data.data.containers || r.data.data.list || r.data.data || [];
    res.json({ configured: true, ok: true, items });
  } catch (err) {
    res.json({ configured: true, ok: false, error: err.message, items: [] });
  }
});

app.listen(PORT, () => console.log(`Homelab dashboard listening on :${PORT}`));
