'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { once, EventEmitter } = require('events');
const AdmZip = require('adm-zip');
const { JAVA_VERSIONS_DIR, JAVA_RUNTIME_DIR, JAVA_DOWNLOADS_DIR, IS_WIN } = require('./paths');
const { HttpError, compareVersions, readJson, writeJson } = require('./util');

// Minecraft Java Edition servers, installed from Mojang the same way the Minecraft launcher installs the game:
//
//   data/java/versions/<id>/server.jar        the official server jar
//   data/java/versions/<id>/libraries, versions/  what the jar unpacks to (shared by every server on this version)
//   data/java/versions/<id>/server.properties the default settings of that version (the "전체 서버 설정" list)
//   data/java/versions/<id>/info.json         Java runtime it needs, data pack format
//   data/java/runtime/<component>/            the Java runtime from Mojang (java-runtime-delta = Java 21, …)
//
// Each game version names the Java runtime it was built for, so nothing has to be installed on the PC itself.
const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RUNTIME_INDEX = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; minecraft-server-farm)' };

// Every server jar from 1.18 on is a "bundler" jar, and 1.18.1+ carry the Log4Shell fix.
const MIN_VERSION = '1.18.2';
// The password check needs player attributes and the data pack layout introduced in 1.21.
const PROTECT_MIN_VERSION = '1.21';
const RELEASE_ID = /^\d+(\.\d+)+$/;
const IDLE_TIMEOUT_MS = 30000;
const PARALLEL = 8;

function platformKey() {
  const { arch } = process;
  if (process.platform === 'win32') return { x64: 'windows-x64', arm64: 'windows-arm64', ia32: 'windows-x86' }[arch] || null;
  if (process.platform === 'linux') return { x64: 'linux', ia32: 'linux-i386' }[arch] || null;
  if (process.platform === 'darwin') return { x64: 'mac-os', arm64: 'mac-os-arm64' }[arch] || null;
  return null;
}

const versionDir = (id) => path.join(JAVA_VERSIONS_DIR, id);
const runtimeDir = (component) => path.join(JAVA_RUNTIME_DIR, component);
const supportsProtect = (id) => compareVersions(id, PROTECT_MIN_VERSION) >= 0;
const isOffered = (id) => RELEASE_ID.test(id) && compareVersions(id, MIN_VERSION) >= 0;

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${new URL(url).hostname})`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Downloads url to dest, checking the SHA-1 Mojang publishes for it. onBytes(n) reports progress (negative
// when a failed attempt is rolled back before a retry).
async function download(url, dest, { sha1, onBytes = () => {} } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    let got = 0;
    const ctrl = new AbortController();
    let idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = crypto.createHash('sha1');
      const out = fs.createWriteStream(part);
      try {
        for await (const chunk of res.body) {
          clearTimeout(idle);
          idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
          hash.update(chunk);
          got += chunk.length;
          onBytes(chunk.length);
          if (!out.write(chunk)) await once(out, 'drain');
        }
        out.end();
        await once(out, 'finish');
      } catch (err) {
        out.destroy();
        throw err;
      }
      if (sha1 && hash.digest('hex') !== sha1) throw new Error('내려받은 파일이 손상되었습니다 (SHA-1 불일치)');
      fs.renameSync(part, dest);
      return;
    } catch (err) {
      onBytes(-got);
      fs.rmSync(part, { force: true });
      if (attempt >= 3) throw new Error(`${path.basename(dest)} 내려받기 실패: ${err.name === 'AbortError' ? '응답 없음' : err.message}`);
      await sleep(1000 * attempt);
    } finally {
      clearTimeout(idle);
    }
  }
}

async function pool(items, size, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

// The bundler jar unpacks its libraries next to the working directory on every start unless they are already
// there. Unpacking them once per version (and pointing -DbundlerRepoDir at it) shares them between servers and
// avoids two servers starting at the same moment writing the same files.
function unpackBundler(jarPath, repoDir) {
  const zip = new AdmZip(jarPath);
  let count = 0;
  for (const kind of ['libraries', 'versions']) {
    const list = zip.getEntry(`META-INF/${kind}.list`);
    if (!list) continue;
    for (const line of zip.readAsText(list).split(/\r?\n/)) {
      const rel = line.split('\t')[2];
      if (!rel) continue;
      const entry = zip.getEntry(`META-INF/${kind}/${rel}`);
      const dest = path.join(repoDir, kind, ...rel.split('/'));
      if (!entry || !dest.startsWith(path.join(repoDir, kind) + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
      count++;
    }
  }
  const meta = zip.getEntry('version.json');
  const version = meta ? JSON.parse(zip.readAsText(meta)) : {};
  return { count, version };
}

// The data pack format of a game version, from version.json inside its server jar. Older versions give one
// number; 1.21.9 and later give major.minor.
function dataPackFormat(version) {
  const p = version?.pack_version;
  if (!p) return null;
  if (typeof p === 'number') return { major: p, minor: 0 };
  if (Number.isInteger(p.data)) return { major: p.data, minor: 0 };
  if (Number.isInteger(p.data_major)) return { major: p.data_major, minor: p.data_minor || 0 };
  return null;
}

class JavaManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.platform = platformKey();
    this.manifest = null;
    this.manifestAt = 0;
    this.manifestError = null;
    this.runtimeIndex = null;
    this.tasks = new Map(); // version → { version, phase, step, percent, receivedMB, totalMB, error }
    this.installs = new Map(); // version → promise
    this.runtimeInstalls = new Map(); // component → promise
  }

  // ---------- what is available ----------
  async checkVersions(force = false) {
    if (!force && this.manifest && Date.now() - this.manifestAt < 30 * 60 * 1000) return this.manifest;
    try {
      const body = await getJson(VERSION_MANIFEST);
      this.manifest = {
        latest: body.latest?.release || null,
        releases: body.versions.filter((v) => v.type === 'release' && isOffered(v.id)),
      };
      this.manifestError = null;
    } catch (err) {
      this.manifestError = `Java 버전 목록 확인 실패: ${err.message}`;
      if (force) throw new HttpError(502, this.manifestError);
    } finally {
      this.manifestAt = Date.now();
    }
    return this.manifest;
  }

  latest() {
    return this.manifest?.latest || this.installed()[0] || null;
  }

  info(id) {
    if (!RELEASE_ID.test(String(id))) return null;
    const info = readJson(path.join(versionDir(id), 'info.json'), null);
    if (!info || !fs.existsSync(path.join(versionDir(id), 'server.jar'))) return null;
    return info;
  }

  installed() {
    let names = [];
    try {
      names = fs.readdirSync(JAVA_VERSIONS_DIR).filter((id) => this.info(id));
    } catch { /* nothing yet */ }
    return names.sort((a, b) => compareVersions(b, a));
  }

  runtime(component) {
    const meta = readJson(path.join(runtimeDir(component), '.mcf-runtime.json'), null);
    if (!meta) return null;
    const java = path.join(runtimeDir(component), ...meta.javaPath.split('/'));
    return fs.existsSync(java) ? { ...meta, java } : null;
  }

  runtimes() {
    let names = [];
    try {
      names = fs.readdirSync(JAVA_RUNTIME_DIR).filter((c) => this.runtime(c));
    } catch { /* nothing yet */ }
    return names.map((c) => this.runtime(c));
  }

  // Everything needed to launch a server on this version, or null if something still has to be downloaded.
  ready(id) {
    const info = this.info(id);
    if (!info) return null;
    const rt = this.runtime(info.javaComponent);
    if (!rt) return null;
    return { info, java: rt.java, jar: path.join(versionDir(id), 'server.jar'), repoDir: versionDir(id), template: path.join(versionDir(id), 'server.properties') };
  }

  isValidVersion(id) {
    if (!isOffered(String(id))) return false;
    if (this.info(id)) return true;
    return !this.manifest || this.manifest.releases.some((v) => v.id === id);
  }

  busy(id) {
    const t = this.tasks.get(id);
    return Boolean(t && (t.phase === 'download' || t.phase === 'extract'));
  }

  // ---------- installing ----------
  // Downloads whatever this version still lacks. Several servers asking for the same version share one download.
  ensure(id) {
    const ready = this.ready(id);
    if (ready) return Promise.resolve(ready);
    if (!this.platform) return Promise.reject(new HttpError(409, `Mojang이 이 운영체제(${process.platform}/${process.arch})용 Java 실행 환경을 제공하지 않습니다.`));
    if (!this.installs.has(id)) {
      const task = { version: id, phase: 'download', step: '준비', percent: 0, receivedMB: 0, totalMB: 0, error: null };
      this.tasks.set(id, task);
      this.emit('change');
      const p = this.install(id, task)
        .then(() => {
          Object.assign(task, { phase: 'done', percent: 100, step: '완료' });
          this.emit('change');
          return this.ready(id);
        })
        .catch((err) => {
          Object.assign(task, { phase: 'error', error: err.message });
          this.emit('change');
          throw err;
        })
        .finally(() => this.installs.delete(id));
      this.installs.set(id, p);
    }
    return this.installs.get(id);
  }

  async install(id, task) {
    const manifest = await this.checkVersions(true);
    const entry = manifest.releases.find((v) => v.id === id);
    if (!entry) throw new HttpError(404, `Java Edition ${id} 버전을 찾을 수 없습니다.`);
    const meta = await getJson(entry.url);
    const server = meta.downloads?.server;
    if (!server) throw new HttpError(404, `${id} 버전은 서버 프로그램을 제공하지 않습니다.`);
    const component = meta.javaVersion?.component || 'jre-legacy';
    const major = meta.javaVersion?.majorVersion || 8;

    const dir = versionDir(id);
    const jar = path.join(dir, 'server.jar');
    const needJar = !fs.existsSync(jar);
    const runtimePlan = this.runtime(component) ? null : await this.planRuntime(component);
    const total = (needJar ? server.size : 0) + (runtimePlan ? runtimePlan.bytes : 0);
    let received = 0;
    let lastEmit = 0;
    task.totalMB = Math.round(total / 1048576);
    const onBytes = (n) => {
      received += n;
      if (Date.now() - lastEmit > 400) {
        lastEmit = Date.now();
        task.percent = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
        task.receivedMB = Math.round(received / 1048576);
        this.emit('change');
      }
    };

    if (needJar) {
      task.step = '서버 프로그램';
      await download(server.url, jar, { sha1: server.sha1, onBytes });
    }
    if (runtimePlan) {
      task.step = `Java ${major}`;
      this.emit('change');
      await this.installRuntime(component, runtimePlan, onBytes);
    }

    task.phase = 'extract';
    task.step = '압축 풀기';
    this.emit('change');
    const { version } = unpackBundler(jar, dir);
    const info = {
      id,
      javaComponent: component,
      javaMajor: major,
      dataPack: dataPackFormat(version),
      protocol: version.protocol_version ?? null,
      releaseTime: entry.releaseTime,
    };
    task.step = '기본 설정 만들기';
    this.emit('change');
    await this.makeTemplate(id, this.runtime(component).java, jar, dir);
    writeJson(path.join(dir, 'info.json'), info);
  }

  async planRuntime(component) {
    if (!this.runtimeIndex) this.runtimeIndex = await getJson(RUNTIME_INDEX);
    const entry = this.runtimeIndex[this.platform]?.[component]?.[0];
    if (!entry) throw new HttpError(409, `Mojang이 이 PC(${this.platform})용 ${component} Java 실행 환경을 제공하지 않습니다.`);
    const manifest = await getJson(entry.manifest.url);
    const files = Object.entries(manifest.files);
    const bytes = files.reduce((a, [, f]) => a + (f.type === 'file' ? f.downloads.raw.size : 0), 0);
    return { entry, files, bytes };
  }

  installRuntime(component, plan, onBytes) {
    if (this.runtimeInstalls.has(component)) return this.runtimeInstalls.get(component);
    const p = (async () => {
      const final = runtimeDir(component);
      const tmp = `${final}.tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const inside = (rel) => {
        const p2 = path.join(tmp, ...rel.split('/'));
        if (!p2.startsWith(tmp + path.sep)) throw new Error(`잘못된 경로: ${rel}`);
        return p2;
      };
      let javaPath = null;
      for (const [rel, f] of plan.files) if (f.type === 'directory') fs.mkdirSync(inside(rel), { recursive: true });
      const files = plan.files.filter(([, f]) => f.type === 'file');
      await pool(files, PARALLEL, async ([rel, f]) => {
        const dest = inside(rel);
        await download(f.downloads.raw.url, dest, { sha1: f.downloads.raw.sha1, onBytes });
        if (f.executable && !IS_WIN) fs.chmodSync(dest, 0o755);
      });
      for (const [rel, f] of plan.files) {
        if (f.type === 'link' && !IS_WIN) {
          fs.mkdirSync(path.dirname(inside(rel)), { recursive: true });
          fs.symlinkSync(f.target, inside(rel));
        }
        if (f.type === 'file' && /(^|\/)bin\/java(\.exe)?$/.test(rel)) javaPath = rel;
      }
      if (!javaPath) throw new Error('Java 실행 파일을 찾지 못했습니다.');
      writeJson(path.join(tmp, '.mcf-runtime.json'), { component, version: plan.entry.version?.name || null, javaPath });
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
    })().finally(() => this.runtimeInstalls.delete(component));
    this.runtimeInstalls.set(component, p);
    return p;
  }

  // Asks the server jar for its default server.properties (--initSettings writes it and quits).
  async makeTemplate(id, java, jar, repoDir) {
    fs.mkdirSync(JAVA_DOWNLOADS_DIR, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(JAVA_DOWNLOADS_DIR, 'init-'));
    try {
      const proc = spawn(java, [`-DbundlerRepoDir=${repoDir}`, '-jar', jar, '--initSettings', '--nogui'], { cwd: tmp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout.on('data', (d) => { output += d; });
      proc.stderr.on('data', (d) => { output += d; });
      const timer = setTimeout(() => proc.kill(), 120000);
      const [code] = await once(proc, 'exit');
      clearTimeout(timer);
      const file = path.join(tmp, 'server.properties');
      if (!fs.existsSync(file)) throw new Error(`서버 기본 설정을 만들지 못했습니다 (종료 코드 ${code}): ${output.trim().split('\n').slice(-3).join(' ')}`);
      fs.copyFileSync(file, path.join(versionDir(id), 'server.properties'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  view() {
    const installed = this.installed();
    const tasks = {};
    for (const [id, t] of this.tasks) tasks[id] = t;
    return {
      platformSupported: Boolean(this.platform),
      latest: this.manifest?.latest || null,
      releases: (this.manifest?.releases || []).map((v) => v.id),
      installed,
      runtimes: this.runtimes().map((r) => ({ component: r.component, version: r.version })),
      tasks,
      error: this.manifestError,
      minVersion: MIN_VERSION,
      protectMinVersion: PROTECT_MIN_VERSION,
    };
  }
}

module.exports = { JavaManager, supportsProtect, isOffered, MIN_VERSION, PROTECT_MIN_VERSION, platformKey };
