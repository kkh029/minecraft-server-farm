'use strict';
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { IS_WIN, DATA } = require('./paths');

const GB = 1024 ** 3;

// --- CPU usage (system-wide), sampled in the background ---
let lastTimes = os.cpus().map((c) => c.times);
let cpuPercent = 0;
setInterval(() => {
  const now = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const p = lastTimes[i];
    if (!p) return;
    const d = (k) => t[k] - p[k];
    idle += d('idle');
    total += d('user') + d('nice') + d('sys') + d('idle') + d('irq');
  });
  cpuPercent = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  lastTimes = now;
}, 2000).unref();

const VIRTUAL_IF = /(vEthernet|VirtualBox|VMware|Hyper-V|WSL|Docker|Loopback|Bluetooth|tailscale|ZeroTier|vboxnet|docker|br-|veth)/i;

function privateRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return 2;
  return 3;
}

function lanAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      list.push({ address: a.address, iface: name, virtual: VIRTUAL_IF.test(name) });
    }
  }
  list.sort((a, b) => a.virtual - b.virtual || privateRank(a.address) - privateRank(b.address));
  return list;
}

// Sizing guide: Bedrock servers are mostly limited by RAM; each world tick loop also wants roughly two CPU threads.
function recommend(estRamPerServerGB) {
  const totalGB = os.totalmem() / GB;
  const threads = os.cpus().length;
  const reserveGB = Math.max(2, totalGB * 0.15); // keep room for the OS and this portal
  const est = Math.max(0.25, Number(estRamPerServerGB) || 1.5);
  const memMax = Math.max(1, Math.floor((totalGB - reserveGB) / est));
  const cpuMax = Math.max(1, Math.floor(threads / 2));
  const recommended = Math.min(memMax, cpuMax);
  const hardMax = Math.max(1, Math.min(memMax, threads, 32));
  return { recommended: Math.min(recommended, hardMax), hardMax, memMax, cpuMax, reserveGB, totalGB, threads, estRamPerServerGB: est };
}

let diskCache = { at: 0, value: null };
async function diskInfo() {
  if (Date.now() - diskCache.at < 30000) return diskCache.value;
  let value = null;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const s = await fs.promises.statfs(DATA);
    value = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    value = null;
  }
  diskCache = { at: Date.now(), value };
  return value;
}

function specs() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    cpuModel: (cpus[0]?.model || 'CPU').trim(),
    threads: cpus.length,
    cpuPercent,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    hostname: os.hostname(),
  };
}

// Resident memory (bytes) of the given PIDs.
function processMemory(pids) {
  return new Promise((resolve) => {
    const result = {};
    if (!pids.length) return resolve(result);
    if (!IS_WIN) {
      for (const pid of pids) {
        try {
          const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
          const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
          if (m) result[pid] = Number(m[1]) * 1024;
        } catch { /* process gone */ }
      }
      return resolve(result);
    }
    execFile('tasklist', ['/FI', 'IMAGENAME eq bedrock_server.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(result);
      for (const line of stdout.split(/\r?\n/)) {
        const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
        if (!cols || cols.length < 5) continue;
        const pid = Number(cols[1]);
        const kb = Number(cols[4].replace(/[^\d]/g, ''));
        if (pids.includes(pid) && kb) result[pid] = kb * 1024;
      }
      resolve(result);
    });
  });
}

// Confirms a PID still belongs to a Bedrock server (guards against PID reuse after a reboot).
function isBedrockProcess(pid) {
  return new Promise((resolve) => {
    if (!IS_WIN) {
      fs.readlink(`/proc/${pid}/exe`, (err, target) => resolve(!err && /bedrock_server/.test(target)));
      return;
    }
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && /bedrock_server/i.test(stdout));
    });
  });
}

module.exports = { specs, recommend, lanAddresses, diskInfo, processMemory, isBedrockProcess };
