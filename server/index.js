'use strict';
const express = require('express');
const { PUBLIC_DIR } = require('./paths');
const { HttpError } = require('./util');
const { Store } = require('./store');
const { Auth } = require('./auth');
const { BdsManager } = require('./bds');
const { Manager } = require('./manager');
const { FirewallCheck } = require('./firewall');
const properties = require('./properties');
const instance = require('./instance');
const system = require('./system');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const store = new Store();
const auth = new Auth(store);
const bds = new BdsManager(store);
const manager = new Manager(store, bds);
const firewall = new FirewallCheck();

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clientIp = (req) => req.socket.remoteAddress || 'unknown';

// ---------- auth ----------
app.get('/api/auth/status', (req, res) => {
  res.json({ setupRequired: auth.setupRequired, authenticated: auth.isAuthenticated(req) });
});

app.post('/api/auth/setup', (req, res) => {
  auth.setup(req.body?.password);
  auth.issue(res, req);
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  auth.login(clientIp(req), String(req.body?.password ?? ''));
  auth.issue(res, req);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clear(res);
  res.json({ ok: true });
});

app.use('/api', auth.middleware());

app.post('/api/auth/password', (req, res) => {
  auth.changePassword(String(req.body?.current ?? ''), req.body?.next);
  auth.issue(res, req);
  res.json({ ok: true });
});

// ---------- state ----------
function hosts() {
  const lan = system.lanAddresses();
  return {
    lan: store.config.lanHost || lan[0]?.address || '127.0.0.1',
    lanCandidates: lan,
    public: store.config.publicHost || '',
  };
}

function publicSettings() {
  const c = store.config;
  return {
    maxConcurrent: c.maxConcurrent,
    estRamPerServerGB: c.estRamPerServerGB,
    publicHost: c.publicHost,
    lanHost: c.lanHost,
    portBase: c.portBase,
    udpPortBase: c.udpPortBase,
    authTimeoutSec: c.authTimeoutSec,
    authMaxFails: c.authMaxFails,
  };
}

async function snapshot() {
  return {
    system: { ...system.specs(), disk: await system.diskInfo() },
    settings: publicSettings(),
    slots: manager.slots(),
    bds: bds.view(),
    firewall: firewall.state,
    hosts: hosts(),
    servers: store.servers.map((s) => manager.serverView(s)),
  };
}

app.get('/api/state', wrap(async (req, res) => res.json(await snapshot())));

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
let stateTimer = null;
let pendingLogs = new Map();
let logTimer = null;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function scheduleState() {
  if (stateTimer || !clients.size) return;
  stateTimer = setTimeout(async () => {
    stateTimer = null;
    const data = await snapshot();
    for (const res of clients) send(res, 'state', data);
  }, 150);
}

manager.on('change', scheduleState);
bds.on('change', scheduleState);
firewall.on('change', scheduleState);
manager.on('log', (id, entry) => {
  if (!clients.size) return;
  if (!pendingLogs.has(id)) pendingLogs.set(id, []);
  pendingLogs.get(id).push(entry);
  if (!logTimer) {
    logTimer = setTimeout(() => {
      logTimer = null;
      const batch = pendingLogs;
      pendingLogs = new Map();
      for (const [sid, lines] of batch) for (const res of clients) send(res, 'log', { id: sid, lines });
    }, 200);
  }
});
setInterval(scheduleState, 3000).unref(); // keeps CPU/RAM figures fresh

app.get('/api/events', wrap(async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  send(res, 'state', await snapshot());
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}));

// ---------- settings ----------
function numberIn(v, min, max, label, integer = true) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, `${label} 값은 ${min}~${max} 사이여야 합니다.`);
  }
  return n;
}

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const c = store.config;
  const next = {};
  if (b.estRamPerServerGB !== undefined) next.estRamPerServerGB = numberIn(b.estRamPerServerGB, 0.25, 16, '서버당 예상 메모리', false);
  if (b.maxConcurrent !== undefined) {
    if (b.maxConcurrent === null || b.maxConcurrent === 'auto') next.maxConcurrent = null;
    else {
      const rec = system.recommend(next.estRamPerServerGB ?? c.estRamPerServerGB);
      next.maxConcurrent = numberIn(b.maxConcurrent, 1, rec.hardMax, '동시 실행 수');
    }
  }
  if (b.publicHost !== undefined) {
    const v = String(b.publicHost).trim();
    if (v.length > 253 || !/^[A-Za-z0-9.\-:[\]]*$/.test(v)) throw new HttpError(400, '외부 주소는 도메인이나 IP 주소만 입력할 수 있습니다.');
    next.publicHost = v;
  }
  if (b.lanHost !== undefined) {
    const v = String(b.lanHost).trim();
    if (v.length > 253 || !/^[A-Za-z0-9.\-:[\]]*$/.test(v)) throw new HttpError(400, 'LAN 주소가 올바르지 않습니다.');
    next.lanHost = v;
  }
  if (b.portBase !== undefined) next.portBase = numberIn(b.portBase, 1024, 65000, '시작 포트');
  if (b.udpPortBase !== undefined) next.udpPortBase = numberIn(b.udpPortBase, 1024, 65000, 'UDP 시작 포트');
  if (b.authTimeoutSec !== undefined) next.authTimeoutSec = numberIn(b.authTimeoutSec, 30, 600, '인증 제한 시간');
  if (b.authMaxFails !== undefined) next.authMaxFails = numberIn(b.authMaxFails, 1, 20, '비밀번호 오류 허용 횟수');
  Object.assign(c, next);
  store.saveConfig();
  scheduleState();
  res.json({ ok: true, settings: publicSettings() });
});

// ---------- Windows Firewall (read-only check) ----------
app.post('/api/firewall/check', wrap(async (req, res) => res.json(await firewall.check())));

// ---------- Bedrock Dedicated Server versions ----------
app.get('/api/bds/latest', wrap(async (req, res) => {
  await bds.checkLatest(true);
  scheduleState();
  res.json(bds.view());
}));

app.post('/api/bds/install', wrap(async (req, res) => {
  const task = await bds.installLatest({ agreeEula: req.body?.agreeEula === true });
  res.status(202).json({ task });
}));

app.put('/api/bds/current', (req, res) => {
  bds.setCurrent(String(req.body?.version || ''));
  res.json(bds.view());
});

// ---------- servers ----------
function requireStopped(id) {
  if (manager.isActive(id)) throw new HttpError(409, '서버를 정지한 뒤에 바꿀 수 있습니다.');
}

// Every server.properties option of the installed BDS version, for the "전체 서버 설정" form.
app.get('/api/server-properties', (req, res) => {
  const s = properties.schema(bds.currentVersion());
  if (!s) throw new HttpError(409, '서버 프로그램(BDS)이 설치되어 있어야 상세 설정을 볼 수 있습니다.');
  res.json(s);
});

function withCheckedProperties(body) {
  if (!body || body.extraProperties === undefined) return body;
  return { ...body, extraProperties: properties.validate(bds.currentVersion(), body.extraProperties) };
}

app.post('/api/servers', (req, res) => {
  const server = store.createServer(withCheckedProperties(req.body));
  scheduleState();
  res.status(201).json(manager.serverView(server));
});

app.patch('/api/servers/:id', (req, res) => {
  requireStopped(req.params.id);
  const server = store.updateServer(req.params.id, withCheckedProperties(req.body));
  scheduleState();
  res.json(manager.serverView(server));
});

app.delete('/api/servers/:id', (req, res) => {
  store.requireServer(req.params.id);
  requireStopped(req.params.id);
  const trashed = instance.moveToTrash(req.params.id);
  store.removeServer(req.params.id);
  manager.forget(req.params.id);
  scheduleState();
  res.json({ ok: true, trashed });
});

app.post('/api/servers/:id/start', wrap(async (req, res) => {
  await manager.start(req.params.id);
  res.json(manager.serverView(store.requireServer(req.params.id)));
}));

app.post('/api/servers/:id/stop', wrap(async (req, res) => {
  await manager.stop(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/servers/:id/kill', (req, res) => {
  store.requireServer(req.params.id);
  manager.kill(req.params.id);
  res.json({ ok: true });
});

app.post('/api/servers/:id/pin', (req, res) => {
  store.requireServer(req.params.id);
  res.json({ pin: manager.newPin(req.params.id) });
});

app.post('/api/servers/:id/command', (req, res) => {
  store.requireServer(req.params.id);
  manager.command(req.params.id, req.body?.command);
  res.json({ ok: true });
});

app.post('/api/servers/:id/kick', (req, res) => {
  store.requireServer(req.params.id);
  manager.kickPlayer(req.params.id, req.body?.name);
  res.json({ ok: true });
});

app.get('/api/servers/:id/logs', (req, res) => {
  store.requireServer(req.params.id);
  res.json({ lines: manager.logs(req.params.id, Number(req.query.since) || 0) });
});

app.use('/api', (req, res) => res.status(404).json({ error: '없는 API입니다.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? `서버 오류: ${err.message}` : err.message });
});

// ---------- startup / shutdown ----------
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    console.log('강제 종료합니다. 실행 중이던 서버는 백그라운드에서 계속 돌아갑니다.');
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`\n${signal}: 실행 중인 마인크래프트 서버를 정지하는 중… (한 번 더 누르면 강제 종료)`);
  await manager.shutdown();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));

manager.recoverOrphans().catch((err) => console.error('이전 실행 정보 복구 실패:', err.message));
bds.checkLatest().catch(() => {});
firewall.check().catch(() => {});

app.listen(PORT, HOST, () => {
  const lan = system.lanAddresses().filter((a) => !a.virtual);
  console.log('마인크래프트 서버 팜 포털이 시작되었습니다.');
  console.log(`  이 PC:  http://localhost:${PORT}`);
  for (const a of lan) console.log(`  LAN:    http://${a.address}:${PORT}  (${a.iface})`);
  if (auth.setupRequired) console.log('  처음 접속하면 관리자 비밀번호를 설정합니다.');
});
