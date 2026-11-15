'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file} 파일을 읽을 수 없습니다: ${err.message}`);
  }
}

// Write to a temp file first so a crash mid-write never leaves a truncated JSON file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function randomPin(length = 6) {
  let pin = '';
  for (let i = 0; i < length; i++) pin += crypto.randomInt(0, 10);
  // A leading zero is easy to drop when typing on a phone keypad; avoid it.
  if (pin[0] === '0') pin = String(crypto.randomInt(1, 10)) + pin.slice(1);
  return pin;
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

module.exports = { HttpError, readJson, writeJson, compareVersions, randomPin, newId, isAlive };
