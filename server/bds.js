'use strict';
const fs = require('fs');
const path = require('path');
const { once, EventEmitter } = require('events');
const AdmZip = require('adm-zip');
const { BDS_DIR, DOWNLOADS_DIR, BDS_EXE, IS_WIN } = require('./paths');
const { HttpError, compareVersions } = require('./util');

const LINKS_API = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const DOWNLOAD_TYPE = IS_WIN ? 'serverBedrockWindows' : 'serverBedrockLinux';
const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; bedrock-server-farm)' };

// Installs and tracks Bedrock Dedicated Server versions under data/bedrock/<version>/.
class BdsManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.task = null; // { version, phase: 'download'|'extract'|'done'|'error', percent, error }
    this.latest = null;
    this.latestCheckedAt = 0;
    this.latestError = null;
  }

  installed() {
    let names = [];
    try {
      names = fs.readdirSync(BDS_DIR, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && /^\d+(\.\d+)+$/.test(d.name))
        .map((d) => d.name)
        .filter((v) => fs.existsSync(path.join(BDS_DIR, v, BDS_EXE)));
    } catch { /* no versions yet */ }
    return names.sort((a, b) => compareVersions(b, a));
  }

  currentVersion() {
    const list = this.installed();
    const chosen = this.store.config.bdsVersion;
    if (chosen && list.includes(chosen)) return chosen;
    return list[0] || null;
  }

  versionDir(version) {
    return path.join(BDS_DIR, version);
  }

  async checkLatest(force = false) {
    if (!force && this.latest && Date.now() - this.latestCheckedAt < 30 * 60 * 1000) return this.latest;
    try {
      const res = await fetch(LINKS_API, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const link = body?.result?.links?.find((l) => l.downloadType === DOWNLOAD_TYPE);
      const version = link?.downloadUrl?.match(/bedrock-server-([\d.]+)\.zip/)?.[1];
      if (!version) throw new Error('다운로드 링크 형식을 알 수 없습니다.');
      this.latest = { version, url: link.downloadUrl };
      this.latestError = null;
    } catch (err) {
      this.latestError = `최신 버전 확인 실패: ${err.message}`;
      if (force) throw new HttpError(502, this.latestError);
    } finally {
      this.latestCheckedAt = Date.now();
    }
    return this.latest;
  }

  busy() {
    return this.task && (this.task.phase === 'download' || this.task.phase === 'extract');
  }

  // Starts installing the latest BDS in the background. Downloading it means accepting the Minecraft EULA,
  // so the caller must pass the user's explicit agreement.
  async installLatest({ agreeEula }) {
    if (!agreeEula) throw new HttpError(400, 'Minecraft EULA 및 개인정보처리방침에 동의해야 설치할 수 있습니다.');
    if (this.busy()) throw new HttpError(409, '이미 설치가 진행 중입니다.');
    const latest = await this.checkLatest(true);
    this.store.config.eulaAcceptedAt = new Date().toISOString();
    if (this.installed().includes(latest.version)) {
      this.store.config.bdsVersion = latest.version;
      this.store.saveConfig();
      this.task = { version: latest.version, phase: 'done', percent: 100 };
      this.emit('change');
      return this.task;
    }
    this.store.saveConfig();
    this.task = { version: latest.version, phase: 'download', percent: 0 };
    this.emit('change');
    this.runInstall(latest).catch((err) => {
      this.task = { ...this.task, phase: 'error', error: err.message };
      this.emit('change');
    });
    return this.task;
  }

  async runInstall({ version, url }) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    const zipPath = path.join(DOWNLOADS_DIR, `bedrock-server-${version}.zip`);
    const partPath = `${zipPath}.part`;

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok || !res.body) throw new Error(`다운로드 실패: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(partPath);
    let received = 0;
    let lastEmit = 0;
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await once(out, 'drain');
        if (Date.now() - lastEmit > 400) {
          lastEmit = Date.now();
          this.task.percent = total ? Math.round((received / total) * 100) : 0;
          this.task.receivedMB = Math.round(received / 1048576);
          this.emit('change');
        }
      }
      out.end();
      await once(out, 'finish');
    } catch (err) {
      out.destroy();
      fs.rmSync(partPath, { force: true });
      throw new Error(`다운로드 중단: ${err.message}`);
    }
    if (total && received !== total) throw new Error('다운로드한 파일 크기가 맞지 않습니다.');
    fs.renameSync(partPath, zipPath);

    this.task.phase = 'extract';
    this.task.percent = 0;
    this.emit('change');
    const tmpDir = path.join(BDS_DIR, `${version}.tmp`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    await new Promise((resolve, reject) => {
      new AdmZip(zipPath).extractAllToAsync(tmpDir, true, false, (err) => (err ? reject(err) : resolve()));
    });
    if (!fs.existsSync(path.join(tmpDir, BDS_EXE))) throw new Error('압축 파일 안에 서버 실행 파일이 없습니다.');
    if (!IS_WIN) fs.chmodSync(path.join(tmpDir, BDS_EXE), 0o755);
    fs.renameSync(tmpDir, this.versionDir(version));
    fs.rmSync(zipPath, { force: true });

    this.store.config.bdsVersion = version;
    this.store.saveConfig();
    this.task = { version, phase: 'done', percent: 100 };
    this.emit('change');
  }

  setCurrent(version) {
    if (!this.installed().includes(version)) throw new HttpError(404, '설치되지 않은 버전입니다.');
    this.store.config.bdsVersion = version;
    this.store.saveConfig();
    this.emit('change');
  }

  view() {
    const current = this.currentVersion();
    return {
      installed: this.installed(),
      current,
      latest: this.latest?.version || null,
      latestError: this.latestError,
      updateAvailable: Boolean(this.latest && current && compareVersions(this.latest.version, current) > 0),
      task: this.task,
      eulaAcceptedAt: this.store.config.eulaAcceptedAt,
    };
  }
}

module.exports = { BdsManager };
