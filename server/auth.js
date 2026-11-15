'use strict';
const crypto = require('crypto');
const { HttpError } = require('./util');

// Browsers share cookies across ports on the same host, so the cookie name includes the portal's port —
// otherwise logging into a second portal on this PC would log you out of the first.
const COOKIE = `mcf_session_${Number(process.env.PORT) || 8080}`;
const SESSION_DAYS = 14;
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, '관리자 비밀번호는 8자 이상이어야 합니다.');
  if (password.length > 200) throw new HttpError(400, '비밀번호가 너무 깁니다.');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

class Auth {
  constructor(store) {
    this.store = store;
    this.failures = new Map(); // ip -> { count, until }
  }

  get setupRequired() {
    return !this.store.config.adminPasswordHash;
  }

  // Sessions are signed with the server secret and the current password hash, so changing the
  // password logs out every other session.
  sign(expires) {
    const key = `${this.store.config.sessionSecret}:${this.store.config.adminPasswordHash}`;
    return crypto.createHmac('sha256', key).update(String(expires)).digest('hex');
  }

  issue(res, req) {
    const expires = Date.now() + SESSION_DAYS * 86400000;
    const token = `${expires}.${this.sign(expires)}`;
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  }

  clear(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  isAuthenticated(req) {
    if (this.setupRequired) return false;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return false;
    const [expires, sig] = token.split('.');
    if (!expires || !sig || Number(expires) < Date.now()) return false;
    const expected = this.sign(expires);
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  checkLock(ip) {
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) {
      const min = Math.ceil((f.until - Date.now()) / 60000);
      throw new HttpError(429, `로그인 시도가 너무 많습니다. ${min}분 후에 다시 시도하세요.`);
    }
  }

  recordFailure(ip) {
    const f = this.failures.get(ip) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) {
      f.until = Date.now() + LOCK_MS;
      f.count = 0;
    }
    this.failures.set(ip, f);
  }

  setup(password) {
    if (!this.setupRequired) throw new HttpError(409, '이미 관리자 비밀번호가 설정되어 있습니다.');
    validateNewPassword(password);
    this.store.config.adminPasswordHash = hashPassword(password);
    this.store.saveConfig();
  }

  login(ip, password) {
    this.checkLock(ip);
    if (!verifyPassword(password, this.store.config.adminPasswordHash)) {
      this.recordFailure(ip);
      throw new HttpError(401, '비밀번호가 올바르지 않습니다.');
    }
    this.failures.delete(ip);
  }

  changePassword(current, next) {
    if (!verifyPassword(current, this.store.config.adminPasswordHash)) throw new HttpError(401, '현재 비밀번호가 올바르지 않습니다.');
    validateNewPassword(next);
    this.store.config.adminPasswordHash = hashPassword(next);
    this.store.saveConfig();
  }

  middleware() {
    return (req, res, next) => {
      if (this.isAuthenticated(req)) return next();
      res.status(401).json({ error: '로그인이 필요합니다.' });
    };
  }
}

module.exports = { Auth };
