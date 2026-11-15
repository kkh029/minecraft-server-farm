'use strict';
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { RUNTIME_FILE, IS_WIN, MAX_SLOTS } = require('./paths');
const { HttpError, readJson, writeJson, randomPin, isAlive, compareVersions } = require('./util');
const instance = require('./instance');
const system = require('./system');
const javaauth = require('./javaauth');
const { supportsProtect } = require('./java');
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

// Java Edition console lines look like "[12:34:56] [Server thread/INFO]: <message>"; since 26.3 replies to console
// commands start with "System chat: ". Player names can't contain spaces, brackets, < or *, which is what keeps
// chat ("<Bob> …", "[Bob] …", "* Bob …") from passing as one of these lines.
const JAVA_LINE = /^\[[\d:.]+\] \[[^\]]+\/[A-Z]+\]: (?:System chat: )?(.*)$/;
const JAVA_NAME = '[^\\s[\\]<>*:]+';
const JRE = {
  started: /^Done \([^)]*\)! For help, type/,
  joined: new RegExp(`^(${JAVA_NAME})(?: \\(formerly known as [^)]*\\))? joined the game$`),
  left: new RegExp(`^(${JAVA_NAME}) left the game$`),
  // A player's /trigger, logged because of gamerule log_admin_commands: "[Steve: Triggered [비밀번호] (set value to 123456)]"
  trigger: new RegExp(`^\\[(${JAVA_NAME}): Triggered \\[[^\\]]*\\] \\((?:set value to|added) (-?\\d+)(?: to value)?\\)\\]$`),
  score: /^#(run|alive) has (-?\d+) \[mcf\]$/,
  packs: /^There (?:are|is) \d+ data packs? enabled: (.*)$/,
  stopping: /^Stopping (?:the )?server$/,
  saving: /^Saving worlds$/,
  eula: /You need to agree to the EULA/,
  bind: /FAILED TO BIND TO PORT/,
};

function newRuntime() {
  return {
    status: 'stopped',
    runSeq: 0,
    proc: null,
    pid: null,
    slot: null,
    edition: 'bedrock',
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
    runId: null, // Java: id of this start, which the password data pack checks player tags against
    launch: null, // Java: { java, jar, repoDir, info } of the version being run
    auth: { run: null, alive: null },
  };
}

class Manager extends EventEmitter {
  constructor(store, bds, java) {
    super();
    this.store = store;
    this.bds = bds;
    this.java = java;
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
    const java = server.edition === 'java';
    let version;
    if (java) {
      version = server.javaVersion;
      if (!this.store.config.eulaAcceptedAt) throw new HttpError(409, 'Minecraft EULA에 동의해야 Java 서버를 실행할 수 있습니다. 서버 편집에서 동의하세요.');
      if (!this.java.platform) throw new HttpError(409, `Mojang이 이 운영체제(${process.platform}/${process.arch})용 Java 실행 환경을 제공하지 않아 Java 서버를 실행할 수 없습니다.`);
    } else {
      version = this.bds.currentVersion();
      if (!version) throw new HttpError(409, '서버 프로그램(BDS)이 설치되지 않았습니다. 설정에서 먼저 설치하세요.');
      if (this.bds.busy() && this.bds.task.version === version) throw new HttpError(409, '서버 프로그램 설치가 끝난 뒤 실행하세요.');
    }

    // Reserve the slot right away so two quick clicks can't overfill it.
    Object.assign(rt, {
      status: 'preparing',
      edition: server.edition,
      error: null,
      failReason: null,
      cancel: false,
      players: new Map(),
      authReady: false,
      auth: { run: null, alive: null },
      version,
      protect: server.protect && (!java || supportsProtect(version)),
      pin: null,
      memBytes: null,
      runId: null,
      launch: null,
    });
    rt.logs = [];
    this.portalLog(id, rt, java ? `서버 준비 중 (Java Edition ${version})` : `서버 준비 중 (BDS ${version})`);
    this.changed();

    try {
      if (java && !this.java.ready(version)) {
        this.portalLog(id, rt, `Java Edition ${version} 서버 프로그램을 Mojang에서 내려받습니다 (이 버전을 처음 실행할 때 한 번).`);
        await this.java.ensure(version);
        this.portalLog(id, rt, '내려받기를 마쳤습니다.');
      }
      if (rt.cancel) {
        rt.status = 'stopped';
        this.changed();
        return;
      }
      await this.checkPorts(server);
      if (rt.cancel) {
        rt.status = 'stopped';
        this.changed();
        return;
      }
      const pin = randomPin(6);
      if (java) {
        rt.launch = this.java.ready(version);
        if (!rt.launch) throw new Error(`Java Edition ${version} 서버 프로그램 파일이 없습니다. 다시 실행하면 새로 내려받습니다.`);
        const last = instance.lastVersion(id);
        if (last && compareVersions(version, last) < 0 && instance.worldExists(id, 'java')) {
          throw new HttpError(409, `이 월드는 ${last}에서 실행된 적이 있어 더 낮은 버전(${version})으로는 열 수 없습니다. 편집에서 버전을 ${last} 이상으로 고르세요.`);
        }
        rt.runId = crypto.randomInt(1, 2 ** 31 - 1);
        instance.prepareJava(id, server, {
          version,
          template: rt.launch.template,
          dataPack: rt.launch.info.dataPack,
          protect: rt.protect,
          runId: rt.runId,
          eulaAcceptedAt: this.store.config.eulaAcceptedAt,
        });
      } else {
        this.attachFreeSlot(id, rt, version);
        instance.writeProperties(rt.slot, version, server);
        instance.writeAuthPack(id, {
          enabled: server.protect,
          pin,
          timeoutSec: this.store.config.authTimeoutSec,
          maxFails: this.store.config.authMaxFails,
        });
      }
      rt.pin = rt.protect ? pin : null;
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

  // JVM options for a Java server. The heap limit is the server's memory setting; the encoding options keep
  // Korean text intact on the console pipe (otherwise Windows' code page is used).
  javaArgs(server, launch) {
    const mem = server.memoryMB || 2048;
    const args = [`-Xms${Math.min(512, mem)}M`, `-Xmx${mem}M`, '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'];
    // The server's libraries use native access / sun.misc.Unsafe; without these, newer Java prints warnings.
    if (launch.info.javaMajor >= 21) args.push('--enable-native-access=ALL-UNNAMED');
    if (launch.info.javaMajor >= 24) args.push('--sun-misc-unsafe-memory-access=allow');
    args.push(`-DbundlerRepoDir=${launch.repoDir}`, '-jar', launch.jar, 'nogui');
    return args;
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
    if (server.edition === 'java') {
      if (!(await tcpFree(port))) busy.push(`TCP ${port}`);
    } else if (transport === 'nethernet') {
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
    const java = rt.edition === 'java';
    const cwd = java ? instance.dir(id) : instance.slotDir(rt.slot);
    const env = { ...process.env };
    if (!IS_WIN && !java) env.LD_LIBRARY_PATH = cwd;
    const exe = java ? rt.launch.java : instance.slotExe(rt.slot);
    const args = java ? this.javaArgs(server, rt.launch) : [];
    // detached: the server runs outside the portal's console (Windows: its own hidden console; Linux: its own
    // process group/session). Ctrl+C or closing the portal's terminal then reaches only the portal, which saves and
    // stops each server cleanly instead of every server being killed at once.
    const proc = spawn(exe, args, { cwd, env, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const runSeq = ++rt.runSeq;
    const current = () => rt.runSeq === runSeq;

    rt.proc = proc;
    rt.pid = proc.pid || null;
    rt.status = 'starting';
    rt.startedAt = Date.now();
    rt.cleanQuit = false;
    rt.saving = false;
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
    if (rt.edition === 'java') {
      this.onJavaLine(id, server, rt, line);
      return;
    }
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

  // ---------- Java Edition ----------
  onJavaLine(id, server, rt, line) {
    this.pushLog(id, rt, line);
    if (JRE.eula.test(line)) rt.failReason = 'Minecraft EULA에 동의하지 않아 서버가 실행되지 않았습니다.';
    const msg = line.match(JAVA_LINE)?.[1];
    if (msg === undefined) return;
    let m;
    if ((m = msg.match(JRE.trigger))) {
      this.onJavaPassword(id, rt, m[1], m[2]);
    } else if ((m = msg.match(JRE.joined))) {
      this.onJavaJoin(id, rt, m[1]);
    } else if ((m = msg.match(JRE.left))) {
      const p = rt.players.get(m[1]);
      if (p) clearTimeout(p.timer);
      rt.players.delete(m[1]);
      this.changed();
    } else if ((m = msg.match(JRE.score))) {
      rt.auth[m[1]] = Number(m[2]);
      this.checkJavaAuth(id, rt);
    } else if ((m = msg.match(JRE.packs))) {
      // Re-enable the password data pack if it was turned off with /datapack disable (that sticks with the world).
      if (rt.protect && !m[1].includes(`file/${javaauth.PACK}`)) {
        this.portalLog(id, rt, '비밀번호 데이터 팩이 꺼져 있어 다시 켭니다.');
        this.write(rt, `datapack enable "file/${javaauth.PACK}"`);
        setTimeout(() => this.queryJavaAuth(rt), 1500);
      }
    } else if (JRE.started.test(msg)) {
      rt.status = 'running';
      rt.runningAt = Date.now();
      this.portalLog(id, rt, '서버가 시작되었습니다.');
      this.onJavaStarted(id, rt);
      this.changed();
    } else if (JRE.saving.test(msg)) {
      rt.saving = true;
    } else if (JRE.stopping.test(msg) && rt.status !== 'stopping') {
      rt.status = 'stopping';
      this.changed();
    } else if (JRE.bind.test(msg)) {
      rt.failReason = `포트 ${server.port}를 열 수 없습니다. 다른 프로그램이 쓰고 있는지 확인하세요.`;
    }
  }

  onJavaStarted(id, rt) {
    instance.markVersion(id, rt.version);
    if (!supportsProtect(rt.version)) return;
    // Passwords arrive as logged /trigger uses, so command logging must be on (it is by default).
    // Game rules were renamed to snake_case in 1.21.11.
    this.write(rt, `gamerule ${compareVersions(rt.version, '1.21.11') >= 0 ? 'log_admin_commands' : 'logAdminCommands'} true`);
    if (!rt.protect) return;
    this.write(rt, 'datapack list enabled');
    this.queryJavaAuth(rt);
    rt.readyTimer = setTimeout(() => {
      if (rt.status === 'running' && !rt.authReady) {
        rt.failReason = '비밀번호 데이터 팩이 동작하지 않아 안전을 위해 서버를 중지했습니다. 콘솔 로그에서 데이터 팩(mcf_auth) 오류를 확인하세요.';
        this.portalLog(id, rt, rt.failReason);
        this.stop(id).catch(() => {});
      }
    }, AUTH_READY_GRACE_MS);
  }

  // The data pack is working once its load function stored this start's id and its tick function has run.
  queryJavaAuth(rt) {
    this.write(rt, 'scoreboard players get #run mcf');
    this.write(rt, 'scoreboard players get #alive mcf');
  }

  checkJavaAuth(id, rt) {
    if (rt.authReady || rt.auth.run !== rt.runId || rt.auth.alive !== 1) return;
    rt.authReady = true;
    clearTimeout(rt.readyTimer);
    this.changed();
  }

  onJavaJoin(id, rt, name) {
    const player = { name, xuid: null, joinedAt: Date.now(), verified: !rt.protect, fails: 0, timer: null };
    const old = rt.players.get(name);
    if (old) clearTimeout(old.timer);
    rt.players.set(name, player);
    if (rt.protect) {
      // The data pack has already locked them; the portal times them out.
      player.timer = setTimeout(() => {
        if (rt.players.get(name) === player && !player.verified) {
          this.write(rt, `kick ${javaauth.target(name)} 비밀번호 입력 시간이 초과되었습니다.`);
          this.portalLog(id, rt, `${name} 님이 제한 시간 안에 비밀번호를 입력하지 않아 내보냈습니다.`);
        }
      }, this.store.config.authTimeoutSec * 1000);
      player.timer.unref?.();
    }
    this.changed();
  }

  onJavaPassword(id, rt, name, value) {
    const player = rt.players.get(name);
    if (!rt.protect || !player || player.verified) return;
    if (rt.pin && value === rt.pin) {
      player.verified = true;
      clearTimeout(player.timer);
      for (const cmd of javaauth.grantCommands(name, rt.runId)) this.write(rt, cmd);
      this.portalLog(id, rt, `${name} 님이 비밀번호 인증을 통과했습니다.`);
    } else {
      player.fails += 1;
      const max = this.store.config.authMaxFails;
      this.portalLog(id, rt, `${name} 님이 비밀번호를 틀렸습니다. (${player.fails}회)`);
      if (player.fails >= max) this.write(rt, `kick ${javaauth.target(name)} 비밀번호를 여러 번 틀렸습니다.`);
      else for (const cmd of javaauth.retryCommands(name, max - player.fails)) this.write(rt, cmd);
    }
    this.changed();
  }

  onExit(id, rt, code, signal) {
    clearTimeout(rt.stopTimer);
    clearTimeout(rt.readyTimer);
    for (const p of rt.players.values()) clearTimeout(p.timer);
    // A Java server that saved its worlds and exited normally shut down cleanly.
    if (rt.edition === 'java' && code === 0 && rt.saving) rt.cleanQuit = true;
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
    const java = rt.edition === 'java';
    const safe = String(name || '').replace(java ? /[\r\n]/g : /["\r\n]/g, '');
    if (!rt.players.has(safe)) throw new HttpError(404, '접속 중인 플레이어가 아닙니다.');
    const who = java ? javaauth.target(safe) : `"${safe}"`;
    if (!this.write(rt, `kick ${who} 관리자에 의해 퇴장되었습니다.`)) throw new HttpError(409, '서버 콘솔에 연결되어 있지 않습니다.');
    this.portalLog(id, rt, `${safe} 님을 퇴장시켰습니다.`);
  }

  newPin(id) {
    const rt = this.runtime(id);
    if (rt.status !== 'running') throw new HttpError(409, '실행 중인 서버에서만 바꿀 수 있습니다.');
    if (!rt.protect) throw new HttpError(409, '비밀번호 보호가 꺼져 있는 서버입니다.');
    if (!rt.proc) throw new HttpError(409, '서버 콘솔에 연결되어 있지 않습니다.');
    const pin = randomPin(6);
    // Java: the portal itself checks passwords, so changing its copy is enough.
    if (rt.edition !== 'java' && !this.write(rt, `scriptevent mcf:pin ${pin}`)) throw new HttpError(409, '서버 콘솔에 연결되어 있지 않습니다.');
    rt.pin = pin;
    this.saveRuntimeFile();
    if (rt.edition !== 'java') {
      instance.updateAuthPin(id, {
        enabled: true,
        pin,
        timeoutSec: this.store.config.authTimeoutSec,
        maxFails: this.store.config.authMaxFails,
      });
    }
    this.portalLog(id, rt, '새 비밀번호를 발급했습니다. 이미 인증한 플레이어는 그대로 플레이할 수 있습니다.');
    this.changed();
    return pin;
  }

  // ---------- persistence of running processes ----------
  saveRuntimeFile() {
    const data = {};
    for (const [id, rt] of this.rt) {
      if (rt.pid && ACTIVE.has(rt.status)) {
        data[id] = { pid: rt.pid, slot: rt.slot, edition: rt.edition, pin: rt.pin, protect: rt.protect, startedAt: rt.startedAt, version: rt.version };
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
      const edition = info.edition || 'bedrock';
      if (!this.store.getServer(id) || !isAlive(info.pid) || !(await system.isServerProcess(info.pid, edition))) continue;
      const rt = this.runtime(id);
      Object.assign(rt, {
        status: 'orphaned',
        edition,
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
    const java = server.edition === 'java';
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
        players: [...rt.players.values()].map(({ name, xuid, joinedAt, verified }) => ({ name, xuid, joinedAt, verified })),
        error: rt.error,
        version: rt.version,
        memBytes: rt.memBytes,
        worldExists: instance.worldExists(server.id, server.edition),
        installedVersion: instance.lastVersion(server.id),
        slot: rt.slot,
        // Java: download progress while a version is fetched before its first start.
        task: java && rt.status === 'preparing' ? this.java.tasks.get(rt.version) || null : null,
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
