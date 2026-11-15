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

const GAMEMODES = ['survival', 'creative', 'adventure'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
const TRANSPORTS = ['nethernet', 'raknet'];

const SERVER_DEFAULTS = {
  gamemode: 'survival',
  difficulty: 'normal',
  maxPlayers: 10,
  levelSeed: '',
  protect: true,
  transport: 'nethernet',
  onlineMode: true,
  allowCheats: false,
  viewDistance: 32,
  lanVisibility: false,
};

class Store {
  constructor() {
    this.config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
    if (!this.config.sessionSecret) {
      this.config.sessionSecret = crypto.randomBytes(32).toString('hex');
      this.saveConfig();
    }
    this.servers = readJson(SERVERS_FILE, []);
    // Servers created before UDP ranges existed get one now.
    let migrated = false;
    for (const s of this.servers) {
      if (!Number.isInteger(s.udpPortStart)) {
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

  // Every port a server uses: `port` and `port + 1` (TCP handshake / RakNet IPv6) plus its UDP block.
  static ranges(s) {
    const list = [[s.port, s.port + 1]];
    if (Number.isInteger(s.udpPortStart)) list.push([s.udpPortStart, s.udpPortStart + UDP_BLOCK - 1]);
    return list;
  }

  rangeTaken(from, to, exceptId) {
    return this.servers.some((s) => s.id !== exceptId && Store.ranges(s).some(([a, b]) => from <= b && a <= to));
  }

  portTaken(port, exceptId) {
    return this.rangeTaken(port, port + 1, exceptId);
  }

  nextFreePort() {
    for (let port = this.config.portBase; port < 65534; port += 2) {
      if (!this.portTaken(port)) return port;
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
    const [[p], [u0, u1]] = Store.ranges(server);
    if (this.portTaken(p, server.id)) throw new HttpError(409, `포트 ${p}(또는 ${p + 1})는 다른 서버가 사용 중입니다.`);
    if (this.rangeTaken(u0, u1, server.id)) throw new HttpError(409, `UDP 포트 ${u0}-${u1}은(는) 다른 서버가 사용 중입니다.`);
    if (p + 1 >= u0 && p <= u1) throw new HttpError(409, `포트 ${p}가 이 서버의 UDP 범위(${u0}-${u1})와 겹칩니다.`);
  }

  createServer(input) {
    const fields = normalizeServerInput(input, null);
    const port = fields.port ?? this.nextFreePort();
    const udpPortStart = fields.udpPortStart ?? this.nextFreeUdpStart(null, [port, port + 1]);
    const server = { id: newId(), ...SERVER_DEFAULTS, ...fields, port, udpPortStart, createdAt: new Date().toISOString() };
    this.checkPorts(server);
    this.servers.push(server);
    this.saveServers();
    return server;
  }

  updateServer(id, input) {
    const server = this.requireServer(id);
    const fields = normalizeServerInput(input, server);
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

function normalizeServerInput(input, existing) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '잘못된 요청입니다.');
  const out = {};
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
  if (has('transport')) {
    if (!TRANSPORTS.includes(input.transport)) throw new HttpError(400, '네트워크 방식이 올바르지 않습니다.');
    out.transport = input.transport;
  }
  if (has('maxPlayers')) out.maxPlayers = intInRange(input.maxPlayers, 1, 100, '최대 인원');
  if (has('viewDistance')) out.viewDistance = intInRange(input.viewDistance, 6, 96, '시야 거리');
  if (has('port') && input.port !== '') out.port = intInRange(input.port, 1024, 65534, '포트');
  if (has('udpPortStart') && input.udpPortStart !== '') {
    out.udpPortStart = intInRange(input.udpPortStart, 1024, 65535 - UDP_BLOCK, 'UDP 시작 포트');
  }
  for (const key of ['protect', 'onlineMode', 'allowCheats', 'lanVisibility']) {
    if (has(key)) out[key] = Boolean(input[key]);
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

module.exports = { Store, GAMEMODES, DIFFICULTIES, TRANSPORTS, SERVER_DEFAULTS, UDP_BLOCK };
