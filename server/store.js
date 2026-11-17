'use strict';
const crypto = require('crypto');
const { CONFIG_FILE, SERVERS_FILE } = require('./paths');
const { HttpError, readJson, writeJson, newId } = require('./util');

const DEFAULT_CONFIG = {
  adminPasswordHash: null,
  sessionSecret: null,
  maxConcurrent: null, // null = use the recommendation computed from system specs
  estRamPerServerGB: 1.5,
  publicHost: '',
  lanHost: '',
  portBase: 19132,
  udpPortBase: 20000,
  javaPortBase: 25565,
  authTimeoutSec: 120,
  authMaxFails: 5,
  bdsVersion: null, // null = newest installed version
  eulaAcceptedAt: null,
};

// NetherNet: clients do the handshake over TCP on `port`, then play over UDP. Each server gets its own block of
// UDP ports for that. Players report a single shared port (BDS's default) failing for internet joins with error
// "Terracotta" (Mojang bug BDS-23130) while a dedicated range works, and a known range is what gets
// port-forwarded. Verified working for LAN joins on BDS 1.26.63.1.
const UDP_BLOCK = 16;

const EDITIONS = ['bedrock', 'java'];
const GAMEMODES = ['survival', 'creative', 'adventure'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
const TRANSPORTS = ['nethernet', 'raknet'];
const JAVA_MEMORY_MB = { min: 512, max: 32768, default: 2048 };

const SERVER_DEFAULTS = {
  gamemode: 'survival',
  difficulty: 'normal',
  maxPlayers: 10,
  levelSeed: '',
  protect: true,
  onlineMode: true,
};

// Fields that only mean something for one edition.
const EDITION_DEFAULTS = {
  bedrock: { transport: 'nethernet', allowCheats: false, viewDistance: 32, lanVisibility: false },
  java: { viewDistance: 10, memoryMB: JAVA_MEMORY_MB.default },
};

const VIEW_DISTANCE = { bedrock: [6, 96], java: [3, 32] };

class Store {
  constructor() {
    this.config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
    if (!this.config.sessionSecret) {
      this.config.sessionSecret = crypto.randomBytes(32).toString('hex');
      this.saveConfig();
    }
    this.servers = readJson(SERVERS_FILE, []);
    let migrated = false;
    for (const s of this.servers) {
      // Every server made before Java Edition support is a Bedrock server.
      if (!EDITIONS.includes(s.edition)) {
        s.edition = 'bedrock';
        migrated = true;
      }
      // Bedrock servers created before UDP ranges existed get one now.
      if (s.edition === 'bedrock' && !Number.isInteger(s.udpPortStart)) {
        s.udpPortStart = this.nextFreeUdpStart(s.id, [s.port, s.port + 1]);
        migrated = true;
      }
    }
    if (migrated) this.saveServers();
  }

  saveConfig() {
    writeJson(CONFIG_FILE, this.config);
  }

  saveServers() {
    writeJson(SERVERS_FILE, this.servers);
  }

  getServer(id) {
    return this.servers.find((s) => s.id === id) || null;
  }

  requireServer(id) {
    const server = this.getServer(id);
    if (!server) throw new HttpError(404, '서버를 찾을 수 없습니다.');
    return server;
  }

  // Every port a server uses. Bedrock: `port` and `port + 1` (TCP handshake / RakNet IPv6) plus its UDP block.
  // Java: just its TCP port.
  static ranges(s) {
    if (s.edition === 'java') return [[s.port, s.port]];
    const list = [[s.port, s.port + 1]];
    if (Number.isInteger(s.udpPortStart)) list.push([s.udpPortStart, s.udpPortStart + UDP_BLOCK - 1]);
    return list;
  }

  rangeTaken(from, to, exceptId) {
    return this.servers.some((s) => s.id !== exceptId && Store.ranges(s).some(([a, b]) => from <= b && a <= to));
  }

  portTaken(port, exceptId, edition = 'bedrock') {
    return this.rangeTaken(port, edition === 'java' ? port : port + 1, exceptId);
  }

  nextFreePort(edition = 'bedrock') {
    const java = edition === 'java';
    for (let port = java ? this.config.javaPortBase : this.config.portBase; port < 65534; port += java ? 1 : 2) {
      if (!this.portTaken(port, null, edition)) return port;
    }
    throw new HttpError(409, '사용 가능한 포트가 없습니다.');
  }

  nextFreeUdpStart(exceptId, avoid = []) {
    const clash = (start) => avoid.some((p) => p >= start && p < start + UDP_BLOCK);
    for (let start = this.config.udpPortBase; start + UDP_BLOCK <= 65535; start += UDP_BLOCK) {
      if (!this.rangeTaken(start, start + UDP_BLOCK - 1, exceptId) && !clash(start)) return start;
    }
    throw new HttpError(409, '사용 가능한 UDP 포트 범위가 없습니다.');
  }

  checkPorts(server) {
    if (server.edition === 'java') {
      if (this.portTaken(server.port, server.id, 'java')) throw new HttpError(409, `포트 ${server.port}는 다른 서버가 사용 중입니다.`);
      return;
    }
    const [[p], [u0, u1]] = Store.ranges(server);
    if (this.portTaken(p, server.id)) throw new HttpError(409, `포트 ${p}(또는 ${p + 1})는 다른 서버가 사용 중입니다.`);
    if (this.rangeTaken(u0, u1, server.id)) throw new HttpError(409, `UDP 포트 ${u0}-${u1}은(는) 다른 서버가 사용 중입니다.`);
    if (p + 1 >= u0 && p <= u1) throw new HttpError(409, `포트 ${p}가 이 서버의 UDP 범위(${u0}-${u1})와 겹칩니다.`);
  }

  createServer(input) {
    const edition = input?.edition ?? 'bedrock';
    if (!EDITIONS.includes(edition)) throw new HttpError(400, '에디션은 bedrock 또는 java여야 합니다.');
    const fields = normalizeServerInput(input, null, edition);
    const port = fields.port ?? this.nextFreePort(edition);
    const ports = edition === 'java' ? {} : { udpPortStart: fields.udpPortStart ?? this.nextFreeUdpStart(null, [port, port + 1]) };
    const server = {
      id: newId(),
      edition,
      ...SERVER_DEFAULTS,
      ...EDITION_DEFAULTS[edition],
      ...fields,
      port,
      ...ports,
      createdAt: new Date().toISOString(),
    };
    this.checkPorts(server);
    this.servers.push(server);
    this.saveServers();
    return server;
  }

  updateServer(id, input) {
    const server = this.requireServer(id);
    if (input?.edition !== undefined && input.edition !== server.edition) {
      throw new HttpError(400, '만든 뒤에는 에디션을 바꿀 수 없습니다 (Java와 Bedrock은 월드 형식이 다릅니다).');
    }
    const fields = normalizeServerInput(input, server, server.edition);
    this.checkPorts({ ...server, ...fields });
    Object.assign(server, fields);
    this.saveServers();
    return server;
  }

  removeServer(id) {
    this.requireServer(id);
    this.servers = this.servers.filter((s) => s.id !== id);
    this.saveServers();
  }
}

function normalizeServerInput(input, existing, edition) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '잘못된 요청입니다.');
  const out = {};
  const java = edition === 'java';
  const has = (k) => input[k] !== undefined && input[k] !== null;

  if (has('name') || !existing) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new HttpError(400, '서버 이름을 입력하세요.');
    if (name.length > 40) throw new HttpError(400, '서버 이름은 40자 이하로 입력하세요.');
    if (/[;\r\n\t]/.test(name)) throw new HttpError(400, '서버 이름에 ; 나 줄바꿈은 쓸 수 없습니다.');
    out.name = name;
  }
  if (has('gamemode')) {
    if (!GAMEMODES.includes(input.gamemode)) throw new HttpError(400, '게임 모드가 올바르지 않습니다.');
    out.gamemode = input.gamemode;
  }
  if (has('difficulty')) {
    if (!DIFFICULTIES.includes(input.difficulty)) throw new HttpError(400, '난이도가 올바르지 않습니다.');
    out.difficulty = input.difficulty;
  }
  if (has('transport') && !java) {
    if (!TRANSPORTS.includes(input.transport)) throw new HttpError(400, '네트워크 방식이 올바르지 않습니다.');
    out.transport = input.transport;
  }
  if (has('maxPlayers')) out.maxPlayers = intInRange(input.maxPlayers, 1, 100, '최대 인원');
  if (has('viewDistance')) out.viewDistance = intInRange(input.viewDistance, ...VIEW_DISTANCE[edition], '시야 거리');
  if (has('port') && input.port !== '') out.port = intInRange(input.port, 1024, 65534, '포트');
  if (has('udpPortStart') && input.udpPortStart !== '' && !java) {
    out.udpPortStart = intInRange(input.udpPortStart, 1024, 65535 - UDP_BLOCK, 'UDP 시작 포트');
  }
  for (const key of java ? ['protect', 'onlineMode'] : ['protect', 'onlineMode', 'allowCheats', 'lanVisibility']) {
    if (has(key)) out[key] = Boolean(input[key]);
  }
  if (java) {
    // Which versions exist is checked by the API layer against Mojang's list (JavaManager.isValidVersion).
    if (has('javaVersion') || !existing) {
      const v = String(input.javaVersion ?? '').trim();
      if (!/^\d+(\.\d+)+$/.test(v)) throw new HttpError(400, 'Java 버전을 고르세요.');
      out.javaVersion = v;
    }
    if (has('memoryMB')) out.memoryMB = intInRange(input.memoryMB, JAVA_MEMORY_MB.min, JAVA_MEMORY_MB.max, '메모리(MB)');
  }
  // Already checked against the BDS option list by the API layer (properties.validate).
  if (has('extraProperties')) {
    const extra = input.extraProperties;
    if (typeof extra !== 'object' || Array.isArray(extra) || Object.values(extra).some((v) => typeof v !== 'string')) {
      throw new HttpError(400, '서버 설정 형식이 올바르지 않습니다.');
    }
    out.extraProperties = { ...extra };
  }
  // The seed only matters when the world is first generated, so it can't be changed afterwards.
  if (has('levelSeed') && !existing) {
    const seed = String(input.levelSeed).trim();
    if (seed.length > 32 || /[\r\n]/.test(seed)) throw new HttpError(400, '시드는 32자 이하로 입력하세요.');
    out.levelSeed = seed;
  }
  return out;
}

function intInRange(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} 값은 ${min}~${max} 사이 정수여야 합니다.`);
  return n;
}

module.exports = { Store, EDITIONS, GAMEMODES, DIFFICULTIES, TRANSPORTS, SERVER_DEFAULTS, EDITION_DEFAULTS, UDP_BLOCK, JAVA_MEMORY_MB };
