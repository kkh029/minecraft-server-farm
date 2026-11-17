'use strict';
// NetherNet signaling proxy for Bedrock servers.
//
// A NetherNet join is an HTTP exchange on the server's TCP port (GET /v1/join, then POST /v1/join/<id> with the
// client's SDP offer; the reply is the server's SDP answer), after which game traffic flows over UDP directly
// between the client and BDS. BDS only lists its own LAN addresses as ICE candidates, and the Minecraft client uses
// no STUN/TURN, so a player outside the LAN (mobile data, another network) has no address to reach and the join
// hangs or fails with error "Door".
//
// The portal therefore listens on the server's public port and forwards to BDS on an internal port. In the SDP
// answer it adds a server-reflexive candidate with the internet address (from the 외부 주소 setting) and the same
// UDP port BDS chose; the router forwards the server's UDP block to this PC unchanged. Only candidate lines are
// added: the answer's identity signature covers the a=fingerprint lines, not the candidates.
const http = require('http');
const net = require('net');
const dns = require('dns');

const IP_CACHE_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 30 * 1000;
const MAX_BODY = 256 * 1024;

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128);
}

// Resolves the 외부 주소 setting to a public IPv4 address, cached briefly so a changed dynamic IP is picked up
// by the next join without restarting anything.
function createPublicIpResolver(getHost) {
  let cache = { host: null, ip: null, at: 0 };
  return async function resolve() {
    const host = String(getHost() || '').trim();
    if (!host) return null;
    if (cache.host === host && Date.now() - cache.at < IP_CACHE_MS) return cache.ip;
    let ip = null;
    if (net.isIPv4(host)) ip = host;
    else if (!net.isIP(host)) {
      try {
        ip = (await dns.promises.lookup(host, { family: 4 })).address;
      } catch {
        ip = cache.host === host ? cache.ip : null; // keep the last good answer through a DNS hiccup
      }
    }
    if (ip && isPrivateIPv4(ip)) ip = null;
    cache = { host, ip, at: Date.now() };
    return ip;
  };
}

// Adds a srflx candidate for publicIp next to BDS's host candidates (one per UDP port it offered).
function addPublicCandidates(sdp, publicIp) {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const hosts = [];
  let last = -1;
  lines.forEach((line, i) => {
    const m = /^a=candidate:\S+ (\d+) udp \d+ (\S+) (\d+) typ host/i.exec(line);
    if (m) {
      last = i;
      if (net.isIPv4(m[2])) hosts.push({ component: m[1], ip: m[2], port: m[3] });
    } else if (/^a=candidate:/i.test(line)) last = i;
  });
  if (last < 0 || !hosts.length) return { sdp, added: 0 };
  if (lines.some((l) => new RegExp(`^a=candidate:\\S+ \\d+ udp \\d+ ${publicIp.replace(/\./g, '\\.')} `, 'i').test(l))) {
    return { sdp, added: 0 };
  }
  const seen = new Set();
  const extra = [];
  // Prefer a real LAN address over virtual adapters (e.g. WSL's 172.x) as the related address.
  hosts.sort((a, b) => Number(b.ip.startsWith('192.168.')) - Number(a.ip.startsWith('192.168.')));
  for (const h of hosts) {
    const key = `${h.component}:${h.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Standard srflx priority (type preference 100), below the host candidates so LAN players keep using those.
    const priority = (100 << 24) + (65535 << 8) + (256 - Number(h.component));
    extra.push(`a=candidate:mcf${seen.size} ${h.component} udp ${priority >>> 0} ${publicIp} ${h.port} typ srflx raddr ${h.ip} rport ${h.port}`);
  }
  lines.splice(last + 1, 0, ...extra);
  return { sdp: lines.join(eol), added: extra.length };
}

// Starts a proxy on publicPort (all interfaces) forwarding to BDS on 127.0.0.1:internalPort.
// Resolves once listening; rejects if the port can't be bound.
function start({ publicPort, internalPort, resolvePublicIp, log }) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => forward(req, Buffer.concat(chunks), res));
    req.on('error', () => res.destroy());
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;

  function forward(req, body, res) {
    const headers = { ...req.headers, host: `127.0.0.1:${internalPort}` };
    delete headers['accept-encoding']; // keep the answer uncompressed so it can be edited
    if (body.length) headers['content-length'] = String(body.length);
    const up = http.request({ host: '127.0.0.1', port: internalPort, method: req.method, path: req.url, headers, timeout: UPSTREAM_TIMEOUT_MS }, (upRes) => {
      const isAnswer = req.method === 'POST' && /^\/v1\/join\/[^/?]+/.test(req.url) && upRes.statusCode >= 200 &&
        upRes.statusCode < 300 && /application\/sdp/i.test(upRes.headers['content-type'] || '');
      if (!isAnswer) {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const parts = [];
      upRes.on('data', (c) => parts.push(c));
      upRes.on('end', async () => {
        let text = Buffer.concat(parts).toString('utf8');
        const outHeaders = { ...upRes.headers };
        delete outHeaders['transfer-encoding'];
        try {
          const ip = await resolvePublicIp();
          if (ip) {
            const r = addPublicCandidates(text, ip);
            text = r.sdp;
            if (r.added) log?.(`외부 접속 주소 ${ip}를 접속 정보에 추가했습니다 (${req.socket.remoteAddress?.replace(/^::ffff:/, '')}).`);
          }
        } catch { /* send BDS's answer unchanged */ }
        const out = Buffer.from(text, 'utf8');
        outHeaders['content-length'] = String(out.length);
        res.writeHead(upRes.statusCode, outHeaders);
        res.end(out);
      });
      upRes.on('error', () => res.destroy());
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    up.end(body);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // '::' with ipv6Only false accepts IPv4 too, like BDS's own dual-stack socket.
    server.listen({ port: publicPort, host: '::', ipv6Only: false }, () => {
      server.off('error', reject);
      server.on('error', () => {});
      resolve({
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

module.exports = { start, addPublicCandidates, createPublicIpResolver, isPrivateIPv4 };
