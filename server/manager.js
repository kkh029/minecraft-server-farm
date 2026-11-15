'use strict';
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { RUNTIME_FILE, IS_WIN, MAX_SLOTS } = require('./paths');
const { HttpError, readJson, writeJson, randomPin, isAlive } = require('./util');
const instance = require('./instance');
const system = require('./system');
const { UDP_BLOCK } = require('./store');

// preparing → starting → running → stopping → stopped | error
// "orphaned": a server left running by an earlier portal process. It still holds a slot, but without its
// console we can only force-stop it.
const ACTIVE = new Set(['preparing', 'starting', 'running', 'stopping', 'orphaned']);
const LOG_LIMIT = 1500;
const STOP_TIMEOUT_MS = 45000;
const AUTH_READY_GRACE_MS = 5000;

const RE = {
  started: /Server started\./,
  connected: /Player connected: (.+?), xuid: ?(\d*)/,
  disconnected: /Player disconnected: (.+?), xuid/,
  script: /\[Scripting\] MCF_([A-Z_]+)(?:\t(.*?))?\s*$/,
  scriptError: /\[Scripting\].*(error|Error|not supported|failed)/,
  stopping: /Server stop requested|Stopping server/,
};

function newRuntime() {
  return {
    status: 'stopped',
    runSeq: 0,
    proc: null,
    pid: null,
    slot: null,
    startedAt: null,
    runningAt: null,
    pin: null,
    protect: false,
    authReady: false,
    players: new Map(),
    logs: [],
    logSeq: 0,
    error: null,
    version: null,
    memBytes: null,
    stopTimer: null,
    readyTimer: null,
    failReason: null,
    cancel: false,
  };
}

class Manager extends EventEmitter {
  constructor(store, bds) {
    super();
    this.store = store;
    this.bds = bds;
    this.rt = new Map();
    this.statsTimer = setInterval(() => this.refreshStats(), 5000);
    this.statsTimer.unref();
  }

  runtime(id) {
    if (!this.rt.has(id)) this.rt.set(id, newRuntime());
    return this.rt.get(id);
  }

  changed() {
    this.emit('change');
  }

  activeCount() {
    let n = 0;
    for (const rt of this.rt.values()) if (ACTIVE.has(rt.status)) n++;
    return n;
  }

  slots() {
    const rec = system.recommend(this.store.config.estRamPerServerGB);
    const chosen = this.store.config.maxConcurrent ?? rec.recommended;
    const max = Math.min(Math.max(1, chosen), rec.hardMax);
    return { used: this.activeCount(), max, recommended: rec.recommended, hardMax: rec.hardMax, sizing: rec };
  }

  // ---------- logs ----------
  pushLog(id, rt, text) {
    rt.logSeq += 1;
    const entry = { seq: rt.logSeq, t: Date.now(), text };
    rt.logs.push(entry);
    if (rt.logs.length > LOG_LIMIT) rt.logs.splice(0, rt.logs.length - LOG_LIMIT);
    this.emit('log', id, entry);
  }

  portalLog(id, rt, text) {
    this.pushLog(id, rt, `[포털] ${text}`);
    // Also to the portal's own output, so a service log (journalctl, a terminal) shows server lifecycle events.
    const name = this.store.getServer(id)?.name || id;
    console.log(`[${new Date().toLocaleString('sv-SE')}] [${name}] ${text}`);
  }

  // ---------- lifecycle ----------
  async start(id) {
    const server = this.store.requireServer(id);
    const rt = this.runtime(id);
    if (ACTIVE.has(rt.status)) throw new HttpError(409, '이미 실행 중입니다.');
    const slots = this.slots();
    if (slots.used >= slots.max) throw new HttpError(409, `빈 슬롯이 없습니다. (${slots.used}/${slots.max} 실행 중)`);
    const version = this.bds.currentVersion();
    if (!version) throw new HttpError(409, '서버 프로그램(BDS)이 설치되지 않았습니다. 설정에서 먼저 설치하세요.');
    if (this.bds.busy() && this.bds.task.version === version) throw new HttpError(409, '서버 프로그램 설치가 끝난 뒤 실행하세요.');

    // Reserve the slot right away so two quick clicks can't overfill it.
    Object.assign(rt, {
      status: 'preparing',
      error: null,
      failReason: null,
      cancel: false,
      players: new Map(),
      authReady: false,
      version,
      protect: server.protect,
      pin: null,
      memBytes: null,
    });
    rt.logs = [];
    this.portalLog(id, rt, `서버 준비 중 (BDS ${version})`);
    this.changed();

    try {
      await this.checkPorts(server);
      if (rt.cancel) {
        rt.status = 'stopped';
        this.changed();
        return;
      }
      this.attachFreeSlot(id, rt, version);
      instance.writeProperties(rt.slot, version, server);
      const pin = randomPin(6);
      instance.writeAuthPack(id, {
        enabled: server.protect,
        pin,
        timeoutSec: this.store.config.authTimeoutSec,
        maxFails: this.store.config.authMaxFails,
      });
      rt.pin = server.protect ? pin : null;
      this.spawnProcess(id, server, rt);
    } catch (err) {
      this.releaseSlot(id, rt);
      rt.status = 'error';
      rt.error = err.message;
      this.portalLog(id, rt, `실행 실패: ${err.message}`);
      this.changed();
      throw err instanceof HttpError ? err : new HttpError(500, err.message);
    }
  }

  // Picks the lowest free slot folder and connects it to this server's data. A slot whose files are locked
  // (e.g. a BDS process the portal doesn't know about) is skipped.
  attachFreeSlot(id, rt, version) {
    const taken = new Set([...this.rt.values()].filter((r) => r !== rt && r.slot && ACTIVE.has(r.status)).map((r) => r.slot));
    let lastError = null;
    for (let n = 1; n <= MAX_SLOTS; n++) {
      if (taken.has(n)) continue;
      try {
        if (instance.attachSlot(n, id, version)) this.portalLog(id, rt, `슬롯 ${n}을(를) BDS ${version}으로 준비했습니다.`);
        rt.slot = n;
        return n;
      } catch (err) {
        lastError = err;
        this.portalLog(id, rt, `슬롯 ${n}을(를) 쓸 수 없어 건너뜁니다: ${err.message}`);
      }
    }
    throw new HttpError(409, `실행할 슬롯을 준비하지 못했습니다${lastError ? `: ${lastError.message}` : '.'}`);
  }

  releaseSlot(id, rt) {
    if (!rt.slot) return;
    instance.detachSlot(rt.slot, id);
    rt.slot = null;
  }

  async checkPorts(server) {
    const { port, transport } = server;
    const busy = [];
    if (transport === 'nethernet') {
      if (!(await tcpFree(port))) busy.push(`TCP ${port}`);
      const used = [];
      for (let p = server.udpPortStart; p < server.udpPortStart + UDP_BLOCK; p++) if (!(await udpFree(p))) used.push(p);
      if (used.length) busy.push(`UDP ${used.join(', ')}`);
    } else {
      if (!(await udpFree(port))) busy.push(`UDP ${port}`);
      if (!(await udpFree(port + 1, 'udp6'))) busy.push(`UDP ${port + 1}`);
    }
    if (server.lanVisibility && transport === 'raknet' && port !== 19132 && !(await udpFree(19132))) {
      busy.push('UDP 19132 (LAN 표시용)');
    }
    if (busy.length) throw new HttpError(409, `포트가 이미 사용 중입니다: ${busy.join(', ')}. 다른 프로그램이나 서버가 쓰고 있는지 확인하세요.`);
  }

  spawnProcess(id, server, rt) {
    const cwd = instance.slotDir(rt.slot);
    const env = { ...process.env };
    if (!IS_WIN) env.LD_LIBRARY_PATH = cwd;
    // detached: BDS runs outside the portal's console (Windows: its own hidden console; Linux: its own process
    // group/session). Ctrl+C or closing the portal's terminal then reaches only the portal, which saves and stops
    // each server cleanly instead of every server being killed at once.
    const proc = spawn(instance.slotExe(rt.slot), [], { cwd, env, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const runSeq = ++rt.runSeq;
    const current = () => rt.runSeq === runSeq;

    rt.proc = proc;
    rt.pid = proc.pid || null;
    rt.status = 'starting';
    rt.startedAt = Date.now();
    rt.cleanQuit = false;
    rt.killRequested = false;
    this.saveRuntimeFile();
    this.changed();

    const attach = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (current() && line.trim()) this.onLine(id, server, rt, line);
        }
      });
    };
    attach(proc.stdout);
    attach(proc.stderr);
    proc.stdin.on('error', () => {});

    // 'error' (e.g. the exe can't be launched) may or may not be followed by 'exit'; handle whichever comes first.
    const mine = () => current() && rt.proc === proc;
    proc.on('error', (err) => {
      if (!mine()) return;
      rt.failReason = `서버 프로그램을 실행할 수 없습니다: ${err.message}`;
      this.onExit(id, rt, null);
    });
    proc.on('exit', (code, signal) => {
      if (mine()) this.onExit(id, rt, code, signal);
    });
  }

  onLine(id, server, rt, line) {
    this.pushLog(id, rt, line);
    // BDS prints this only after it has saved the world and shut down properly.
    if (line.trim() === 'Quit correctly') rt.cleanQuit = true;
    let m;
    if ((m = line.match(RE.script))) {
      this.onScript(id, rt, m[1], m[2] ? m[2].split('\t') : []);
      return;
    }
    if (RE.started.test(line)) {
      rt.status = 'running';
      rt.runningAt = Date.now();
      this.portalLog(id, rt, '서버가 시작되었습니다.');
      if (!instance.hasIdentityKey(id)) {
        // Without a saved identity key players get a "trust this server?" prompt after every restart.
        this.write(rt, 'serveridentity save');
      }
      if (rt.protect && !rt.authReady) {
        rt.readyTimer = setTimeout(() => {
          if (rt.status === 'running' && !rt.authReady) {
            rt.failReason = '비밀번호 스크립트가 로드되지 않아 안전을 위해 서버를 중지했습니다. 콘솔 로그의 [Scripting] 오류를 확인하세요.';
            this.portalLog(id, rt, rt.failReason);
            this.stop(id).catch(() => {});
          }
        }, AUTH_READY_GRACE_MS);
      }
      this.changed();
    } else if ((m = line.match(RE.connected))) {
      rt.players.set(m[1], { name: m[1], xuid: m[2] || null, joinedAt: Date.now(), verified: !rt.protect });
      this.changed();
    } else if ((m = line.match(RE.disconnected))) {
      rt.players.delete(m[1]);
      this.changed();
    } else if (RE.stopping.test(line) && rt.status !== 'stopping') {
      rt.status = 'stopping';
      this.changed();
    }
  }

  onScript(id, rt, tag, fields) {
    const name = fields[0];
    const player = name ? rt.players.get(name) : null;
    switch (tag) {
      case 'READY':
        rt.authReady = true;
        break;
      case 'PENDING':
        if (player) player.verified = false;
        break;
      case 'AUTH_OK':
        if (player) player.verified = true;
        this.portalLog(id, rt, `${name} 님이 비밀번호 인증을 통과했습니다.`);
        break;
      case 'AUTH_FAIL':
        this.portalLog(id, rt, `${name} 님이 비밀번호를 틀렸습니다. (${fields[1]}회)`);
        break;
      case 'KICK':
        // The script could not kick by itself; the console always can.
        this.write(rt, `kick "${String(name).replace(/"/g, '')}" ${fields[1] || ''}`);
        break;
      default:
        break;
    }
    this.changed();
  }

  onExit(id, rt, code, signal) {
    clearTimeout(rt.stopTimer);
    clearTimeout(rt.readyTimer);
    const wasStopping = rt.status === 'stopping';
    rt.proc = null;
    rt.pid = null;
    rt.players = new Map();
    rt.memBytes = null;
    this.releaseSlot(id, rt);
    const how = signal ? ` (${signal})` : code != null ? ` (종료 코드 ${code})` : '';
    const unsaved = '마지막 몇 분 동안의 변경이 저장되지 않았을 수 있습니다.';
    let message;
    if (rt.failReason && rt.cleanQuit) {
      rt.status = 'error';
      rt.error = rt.failReason;
      message = rt.error;
    } else if (wasStopping && rt.cleanQuit) {
      rt.status = 'stopped';
      rt.error = null;
      message = '서버가 정지되었습니다.';
    } else if (rt.killRequested) {
      // The owner pressed 강제 종료, or the clean stop timed out.
      rt.status = 'stopped';
      rt.error = null;
      message = `서버를 강제로 종료했습니다. ${unsaved}`;
    } else if (wasStopping && !rt.failReason) {
      // Something else (the OS, a service manager) ended BDS while it was still saving.
      rt.status = 'error';
      rt.error = `서버가 저장을 마치기 전에 외부에서 종료되었습니다${how}. ${unsaved}`;
      message = rt.error;
    } else {
      rt.status = 'error';
      rt.error = rt.failReason || `서버가 예기치 않게 종료되었습니다${how}. 콘솔 로그를 확인하세요.`;
      message = rt.error;
    }
    this.portalLog(id, rt, message);
    this.saveRuntimeFile();
    this.changed();
  }

  write(rt, command) {
    if (!rt.proc || !rt.proc.stdin.writable) return false;
    rt.proc.stdin.write(`${command}\n`);
    return true;
  }

  async stop(id) {
    this.store.requireServer(id);
    const rt = this.runtime(id);
    switch (rt.status) {
      case 'preparing':
        rt.cancel = true;
        return;
      case 'starting':
      case 'running':
        rt.status = 'stopping';
        this.portalLog(id, rt, '서버를 정지합니다…');
        if (!this.write(rt, 'stop')) this.kill(id);
        clearTimeout(rt.stopTimer);
        rt.stopTimer = setTimeout(() => {
          if (rt.status === 'stopping') {
            this.portalLog(id, rt, '정상 종료가 늦어져 강제로 종료합니다.');
            this.kill(id);
          }
        }, STOP_TIMEOUT_MS);
        this.changed();
        return;
      case 'stopping':
        return;
      case 'orphaned':
        this.kill(id);
        return;
      default:
        throw new HttpError(409, '실행 중인 서버가 아닙니다.');
    }
  }

  kill(id) {
    const rt = this.runtime(id);
    if (rt.proc) {
      rt.status = 'stopping';
      rt.killRequested = true;
      rt.proc.kill();
    } else if (rt.pid) {
      try {
        process.kill(rt.pid);
      } catch { /* already gone */ }
      if (rt.status === 'orphaned') {
        rt.status = 'stopped';
        rt.pid = null;
        this.saveRuntimeFile();
        // Give the process a moment to exit before handing its slot back.
        setTimeout(() => this.releaseSlot(id, rt), 1500);
      }
    } else if (rt.status === 'stopping') {
      rt.status = 'stopped';
    }
    this.changed();
  }

  command(id, text) {
    const rt = this.runtime(id);
    const cmd = String(text || '').replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '');
    if (!cmd) throw new HttpError(400, '명령어를 입력하세요.');
    if (!this.write(rt, cmd)) throw new HttpError(409, '서버 콘솔에 연결되어 있지 않습니다.');
    this.pushLog(id, rt, `> ${cmd}`);
  }

  kickPlayer(id, name) {
    const rt = this.runtime(id);
    const safe = String(name || '').replace(/["\r\n]/g, '');
    if (!rt.players.has(safe)) throw new HttpError(404, '접속 중인 플레이어가 아닙니다.');
    if (!this.write(rt, `kick "${safe}" 관리자에 의해 퇴장되었습니다.`)) throw new HttpError(409, '서버 콘솔에 연결되어 있지 않습니다.');
    this.portalLog(id, rt, `${safe} 님을 퇴장시켰습니다.`);
  }

  newPin(id) {
    const rt = this.runtime(id);
    if (rt.status !== 'running') throw new HttpError(409, '실행 중인 서버에서만 바꿀 수 있습니다.');
    if (!rt.protect) throw new HttpError(409, '비밀번호 보호가 꺼져 있는 서버입니다.');
    const pin = randomPin(6);
    if (!this.write(rt, `scriptevent mcf:pin ${pin}`)) throw new HttpError(409, '서버 콘솔에 연결되어 있지 않습니다.');
    rt.pin = pin;
    this.saveRuntimeFile();
    instance.updateAuthPin(id, {
      enabled: true,
      pin,
      timeoutSec: this.store.config.authTimeoutSec,
      maxFails: this.store.config.authMaxFails,
    });
    this.portalLog(id, rt, '새 비밀번호를 발급했습니다. 이미 인증한 플레이어는 그대로 플레이할 수 있습니다.');
    this.changed();
    return pin;
  }

  // ---------- persistence of running processes ----------
  saveRuntimeFile() {
    const data = {};
    for (const [id, rt] of this.rt) {
      if (rt.pid && ACTIVE.has(rt.status)) {
        data[id] = { pid: rt.pid, slot: rt.slot, pin: rt.pin, protect: rt.protect, startedAt: rt.startedAt, version: rt.version };
      }
    }
    try {
      writeJson(RUNTIME_FILE, data);
    } catch { /* not fatal */ }
  }

  // Servers survive a portal crash (they run detached). Find them again so they keep their slot and can be stopped.
  async recoverOrphans() {
    const data = readJson(RUNTIME_FILE, {});
    for (const [id, info] of Object.entries(data)) {
      if (!this.store.getServer(id) || !isAlive(info.pid) || !(await system.isBedrockProcess(info.pid))) continue;
      const rt = this.runtime(id);
      Object.assign(rt, {
        status: 'orphaned',
        pid: info.pid,
        slot: info.slot || null, // servers started by older portal versions ran outside the slot folders
        pin: info.pin,
        protect: info.protect,
        startedAt: info.startedAt,
        version: info.version,
      });
      this.portalLog(id, rt, `포털이 재시작되기 전부터 실행 중인 서버입니다 (PID ${info.pid}). 콘솔에 다시 연결할 수 없으니, 정지 후 다시 실행하세요.`);
    }
    this.saveRuntimeFile();
    this.changed();
  }

  async refreshStats() {
    for (const [id, rt] of this.rt) {
      if (rt.status === 'orphaned' && !isAlive(rt.pid)) {
        rt.status = 'stopped';
        rt.pid = null;
        this.releaseSlot(id, rt);
        this.saveRuntimeFile();
      }
    }
    const running = [...this.rt.values()].filter((rt) => rt.pid && ACTIVE.has(rt.status));
    const mem = await system.processMemory(running.filter((rt) => rt.pid).map((rt) => rt.pid));
    for (const rt of running) rt.memBytes = mem[rt.pid] ?? rt.memBytes;
    this.changed();
  }

  // Graceful shutdown of everything this portal started.
  async shutdown() {
    const waits = [];
    for (const [id, rt] of this.rt) {
      if (!rt.proc) continue;
      waits.push(new Promise((resolve) => rt.proc.once('exit', resolve)));
      this.stop(id).catch(() => {});
    }
    if (!waits.length) return;
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 30000))]);
    for (const rt of this.rt.values()) {
      if (rt.proc) {
        rt.killRequested = true;
        rt.proc.kill();
      }
    }
  }

  // ---------- views ----------
  serverView(server) {
    const rt = this.runtime(server.id);
    return {
      ...server,
      runtime: {
        status: rt.status,
        pid: rt.pid,
        startedAt: rt.startedAt,
        runningAt: rt.runningAt,
        pin: rt.pin,
        protect: rt.protect,
        authReady: rt.authReady,
        players: [...rt.players.values()],
        error: rt.error,
        version: rt.version,
        memBytes: rt.memBytes,
        worldExists: instance.worldExists(server.id),
        installedVersion: instance.lastVersion(server.id),
        slot: rt.slot,
      },
    };
  }

  logs(id, since = 0) {
    const rt = this.runtime(id);
    return rt.logs.filter((l) => l.seq > since);
  }

  isActive(id) {
    return ACTIVE.has(this.runtime(id).status);
  }

  forget(id) {
    this.rt.delete(id);
  }
}

// Only "in use" / "not allowed" (e.g. a Windows reserved port range) count as busy; anything else, such as
// IPv6 being unavailable, is something BDS falls back from by itself.
const BUSY_CODES = new Set(['EADDRINUSE', 'EACCES']);

function tcpFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(!BUSY_CODES.has(err.code)));
    srv.listen({ port, host: '::', ipv6Only: false }, () => srv.close(() => resolve(true)));
  });
}

function udpFree(port, type = 'udp4') {
  return new Promise((resolve) => {
    let sock;
    try {
      sock = dgram.createSocket(type);
    } catch {
      return resolve(true);
    }
    sock.once('error', (err) => {
      try { sock.close(); } catch { /* ignore */ }
      resolve(!BUSY_CODES.has(err.code));
    });
    sock.bind(port, () => sock.close(() => resolve(true)));
  });
}

module.exports = { Manager, ACTIVE };
