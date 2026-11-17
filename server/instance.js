'use strict';
const fs = require('fs');
const path = require('path');
const { INSTANCES_DIR, SLOTS_DIR, TRASH_DIR, BDS_DIR, BDS_EXE, AUTHPACK_SRC, IS_WIN } = require('./paths');
const { UDP_BLOCK } = require('./store');
const { PORTAL_DEFAULTS, JAVA_PORTAL_DEFAULTS, JAVA_PER_SERVER, parseJavaProperties, escapeJava } = require('./properties');
const javaauth = require('./javaauth');
const { supportsProtect } = require('./java');

// Two kinds of folders:
//
//   data/instances/<id>/  A server's own data: worlds/, keys/, allowlist.json, permissions.json.
//   data/slots/<n>/       Where a server actually runs. BDS resolves server.properties, worlds/, packs, etc.
//                         relative to its own executable (it ignores the working directory), so a slot looks
//                         like a full BDS install:
//                           - executable/libraries: hard links to the shared version folder (no extra disk),
//                           - read-only data folders (behavior_packs, definitions, ...): junctions/symlinks,
//                           - worlds/ and keys/: junctions to the instance that is using the slot.
//
// Running from a fixed set of slot folders keeps the executable paths stable, which is what Windows Firewall
// remembers. Otherwise every new server would trigger a new "allow access?" prompt.
const LEVEL_NAME = 'world';
const VERSION_MARKER = '.mcf-version';
const LINKED_DATA = ['worlds', 'keys']; // instance folders exposed inside the slot
const SERVER_FILES = ['allowlist.json', 'permissions.json']; // copied in at start, copied back at stop
// Folders BDS writes at runtime. Never link these from the shared version folder, even if they exist there.
const RUNTIME_OWNED = new Set([
  ...LINKED_DATA, 'logs', 'world_templates', 'premium_cache', 'treatments',
  'development_behavior_packs', 'development_resource_packs', 'development_skin_packs',
]);
const SKIP_FILES = new Set(['packet-statistics.txt', 'valid_known_packs.json', 'server.properties', VERSION_MARKER, ...SERVER_FILES]);
const BINARY = /\.(exe|dll|so)$|^bedrock_server$/i;

const AUTH_PACK_ID = '00f4d995-5147-4c45-95d6-ccddcffa6d36';
const AUTH_MODULE_ID = 'ee8e1b69-eb4c-4ef1-919d-a356917f706c';
const AUTH_PACK_VERSION = [1, 0, 0];

function dir(id) {
  return path.join(INSTANCES_DIR, id);
}

function worldDir(id) {
  return path.join(dir(id), 'worlds', LEVEL_NAME);
}

function slotDir(n) {
  return path.join(SLOTS_DIR, String(n));
}

function slotExe(n) {
  return path.join(slotDir(n), BDS_EXE);
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Removes a junction/symlink without touching what it points to.
function removeLink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

function linkDir(target, linkPath) {
  fs.symlinkSync(target, linkPath, IS_WIN ? 'junction' : 'dir');
}

// ---------- instance data ----------

// Creates the instance's data folders. Instances made by older versions of the portal also held their own
// copy of the BDS program (hard links + junctions); those leftovers are removed, the world stays.
function ensureInstance(id) {
  const base = dir(id);
  for (const name of LINKED_DATA) fs.mkdirSync(path.join(base, name), { recursive: true });
  for (const entry of fs.readdirSync(base)) {
    const p = path.join(base, entry);
    try {
      if (isLink(p)) removeLink(p);
      else if (BINARY.test(entry)) fs.unlinkSync(p);
    } catch { /* still in use by an old server process; harmless, retried next start */ }
  }
}

function lastVersion(id) {
  try {
    return fs.readFileSync(path.join(dir(id), VERSION_MARKER), 'utf8').trim();
  } catch {
    return null;
  }
}

function hasIdentityKey(id) {
  return fs.existsSync(path.join(dir(id), 'keys', 'server_identity_key.pem'));
}

function worldExists(id, edition = 'bedrock') {
  return fs.existsSync(path.join(edition === 'java' ? javaWorldDir(id) : worldDir(id), 'level.dat'));
}

// ---------- slots ----------

// Makes slot n a BDS install of the given version (only re-links when the version changed).
function linkVersion(n, version) {
  const target = slotDir(n);
  const src = path.join(BDS_DIR, version);
  fs.mkdirSync(target, { recursive: true });
  let current = null;
  try {
    current = fs.readFileSync(path.join(target, VERSION_MARKER), 'utf8').trim();
  } catch { /* new slot */ }
  if (current === version && fs.existsSync(path.join(target, BDS_EXE))) return false;

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (RUNTIME_OWNED.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (isLink(to)) removeLink(to);
      else if (exists(to)) fs.renameSync(to, `${to}.old-${Date.now()}`);
      linkDir(from, to);
    } else if (BINARY.test(entry.name)) {
      // Same path as before, so an existing firewall rule keeps applying after a BDS update.
      if (exists(to)) fs.unlinkSync(to);
      try {
        fs.linkSync(from, to);
      } catch {
        fs.copyFileSync(from, to); // different drive or filesystem without hard links
      }
      if (!IS_WIN) fs.chmodSync(to, 0o755);
    } else {
      fs.copyFileSync(from, to);
    }
  }
  fs.writeFileSync(path.join(target, VERSION_MARKER), version);
  return true;
}

// Connects slot n to an instance's data. Returns true if the slot's program files were (re)linked.
function attachSlot(n, id, version) {
  ensureInstance(id);
  const relinked = linkVersion(n, version);
  const target = slotDir(n);
  for (const name of LINKED_DATA) {
    const p = path.join(target, name);
    if (isLink(p)) removeLink(p);
    else if (exists(p)) fs.renameSync(p, `${p}.old-${Date.now()}`); // never delete a real folder
    linkDir(path.join(dir(id), name), p);
  }
  for (const file of SERVER_FILES) {
    const from = path.join(dir(id), file);
    const to = path.join(target, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
    else fs.writeFileSync(to, '[]\n');
  }
  fs.writeFileSync(path.join(dir(id), VERSION_MARKER), version);
  return relinked;
}

// Called after the server exits: keeps allowlist/permission changes made in-game and unhooks the slot.
function detachSlot(n, id) {
  const target = slotDir(n);
  for (const file of SERVER_FILES) {
    const from = path.join(target, file);
    try {
      if (id && fs.existsSync(dir(id)) && fs.existsSync(from)) fs.copyFileSync(from, path.join(dir(id), file));
    } catch { /* keep going */ }
  }
  for (const name of LINKED_DATA) {
    const p = path.join(target, name);
    try {
      if (isLink(p)) removeLink(p);
    } catch { /* retried on next attach */ }
  }
}

function setProp(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
}

function writeProperties(n, version, server) {
  let text = fs.readFileSync(path.join(BDS_DIR, version, 'server.properties'), 'utf8');
  const props = {
    'server-name': server.name,
    gamemode: server.gamemode,
    difficulty: server.difficulty,
    'allow-cheats': server.allowCheats,
    'max-players': server.maxPlayers,
    'online-mode': server.onlineMode,
    transport: server.transport,
    'server-port': server.port,
    'server-portv6': server.port + 1,
    'server-udp-ports': `${server.udpPortStart}-${server.udpPortStart + UDP_BLOCK - 1}`,
    'enable-lan-visibility': server.lanVisibility,
    'view-distance': server.viewDistance,
    'level-name': LEVEL_NAME,
    'level-seed': server.levelSeed || '',
    // The password script reports to the portal through console.log, which needs content logging on the console.
    'content-log-console-output-enabled': true,
  };
  // Order: shipped file → portal defaults → the owner's own settings → the fields the portal manages.
  for (const [k, v] of Object.entries(PORTAL_DEFAULTS)) text = setProp(text, k, v);
  for (const [k, v] of Object.entries(server.extraProperties || {})) {
    if (!(k in props) && /^[a-z][a-z0-9.-]*$/.test(k) && !/[\r\n]/.test(String(v))) text = setProp(text, k, v);
  }
  for (const [k, v] of Object.entries(props)) text = setProp(text, k, v);
  fs.writeFileSync(path.join(slotDir(n), 'server.properties'), text);
}

// ---------- password behavior pack ----------

function authConfigSource(opts) {
  const config = {
    enabled: Boolean(opts.enabled),
    pin: String(opts.pin || ''),
    timeoutSec: opts.timeoutSec,
    maxFails: opts.maxFails,
  };
  return `// Generated by minecraft-server-farm on every start. Do not edit.\nexport const CONFIG = ${JSON.stringify(config)};\n`;
}

// Installs the password behavior pack into the world. It is always installed; with protection off it just
// makes sure nobody stays frozen from an earlier protected session.
function writeAuthPack(id, opts) {
  const packDir = path.join(worldDir(id), 'behavior_packs', 'mcf_auth');
  fs.mkdirSync(path.join(packDir, 'scripts'), { recursive: true });
  const manifest = {
    format_version: 2,
    header: {
      name: 'Server Farm Password',
      description: 'Asks players for the server password before they can play.',
      uuid: AUTH_PACK_ID,
      version: AUTH_PACK_VERSION,
      min_engine_version: [1, 21, 0],
    },
    modules: [{ type: 'script', language: 'javascript', uuid: AUTH_MODULE_ID, version: AUTH_PACK_VERSION, entry: 'scripts/main.js' }],
    dependencies: [
      { module_name: '@minecraft/server', version: '2.0.0' },
      { module_name: '@minecraft/server-ui', version: '2.0.0' },
    ],
  };
  fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(AUTHPACK_SRC, 'main.js'), path.join(packDir, 'scripts', 'main.js'));
  fs.writeFileSync(path.join(packDir, 'scripts', 'config.js'), authConfigSource(opts));

  // Merge into world_behavior_packs.json so packs the owner added by hand keep working.
  const listFile = path.join(worldDir(id), 'world_behavior_packs.json');
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch { /* new world */ }
  list = list.filter((p) => p.pack_id !== AUTH_PACK_ID);
  list.unshift({ pack_id: AUTH_PACK_ID, version: AUTH_PACK_VERSION });
  fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
}

// Keeps the on-disk pin in sync when it is changed while the server runs (so a /reload keeps it).
function updateAuthPin(id, opts) {
  const file = path.join(worldDir(id), 'behavior_packs', 'mcf_auth', 'scripts', 'config.js');
  if (fs.existsSync(file)) fs.writeFileSync(file, authConfigSource(opts));
}

// ---------- Java Edition ----------
//
// A Java server runs straight from its instance folder (world/, server.properties, ops.json, whitelist.json, …).
// It needs no slot: the program Windows Firewall sees is the shared java.exe of its Java runtime, whose path
// never changes, and the server jar and its libraries are read from data/java/versions/<version>.

function javaWorldDir(id) {
  return path.join(dir(id), LEVEL_NAME);
}

function writeJavaProperties(id, server, templateFile) {
  const props = parseJavaProperties(fs.readFileSync(templateFile, 'utf8'));
  for (const k of JAVA_PER_SERVER) props.delete(k);
  const managed = {
    motd: server.name,
    gamemode: server.gamemode,
    difficulty: server.difficulty,
    'max-players': server.maxPlayers,
    'online-mode': server.onlineMode,
    'view-distance': server.viewDistance,
    'level-seed': server.levelSeed || '',
    'level-name': LEVEL_NAME,
    'server-port': server.port,
    'query.port': server.port,
  };
  // Order: the version's defaults → portal defaults → the owner's own settings → the fields the portal manages.
  for (const [k, v] of Object.entries(JAVA_PORTAL_DEFAULTS)) if (props.has(k)) props.set(k, v);
  for (const [k, v] of Object.entries(server.extraProperties || {})) {
    if (!(k in managed) && props.has(k) && !/[\r\n]/.test(String(v))) props.set(k, v);
  }
  for (const [k, v] of Object.entries(managed)) props.set(k, String(v));
  const lines = ['#Minecraft server properties', '#Written by minecraft-server-farm on every start. Change settings in the portal.'];
  for (const [k, v] of props) lines.push(`${k}=${escapeJava(v)}`);
  fs.writeFileSync(path.join(dir(id), 'server.properties'), `${lines.join('\n')}\n`);
}

// Everything a Java server needs in its folder before it starts. `eulaAcceptedAt` is when the owner agreed to
// the Minecraft EULA in the portal; the server refuses to run without eula=true.
function prepareJava(id, server, { version, template, dataPack, protect, runId, eulaAcceptedAt }) {
  fs.mkdirSync(dir(id), { recursive: true });
  fs.writeFileSync(path.join(dir(id), 'eula.txt'),
    `#Agreed to the Minecraft EULA (https://aka.ms/MinecraftEULA) in the server farm portal at ${eulaAcceptedAt}\neula=true\n`);
  writeJavaProperties(id, server, template);
  // Always installed: with protection off it unlocks anyone still locked from an earlier protected session.
  // Versions before 1.21 can't run it (and can't have been protected), so they get none.
  const packDir = path.join(javaWorldDir(id), 'datapacks', javaauth.PACK);
  if (dataPack && supportsProtect(version)) javaauth.writePack(javaWorldDir(id), { version, dataPack, protect, runId });
  else fs.rmSync(packDir, { recursive: true, force: true });
}

// Called once a Java server has opened its world: from now on the world needs this version or newer.
function markVersion(id, version) {
  try {
    fs.writeFileSync(path.join(dir(id), VERSION_MARKER), version);
  } catch { /* not fatal */ }
}

// Moves an instance to data/trash. Any links are removed first so nothing that cleans up the trash later
// can reach into shared files.
function moveToTrash(id) {
  const target = dir(id);
  if (!exists(target)) return null;
  for (const entry of fs.readdirSync(target)) {
    const p = path.join(target, entry);
    if (isLink(p)) removeLink(p);
    else if (BINARY.test(entry)) fs.unlinkSync(p);
  }
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const dest = path.join(TRASH_DIR, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.renameSync(target, dest);
  return dest;
}

module.exports = {
  dir,
  worldDir,
  slotDir,
  slotExe,
  lastVersion,
  attachSlot,
  detachSlot,
  writeProperties,
  writeAuthPack,
  updateAuthPin,
  hasIdentityKey,
  worldExists,
  moveToTrash,
  javaWorldDir,
  prepareJava,
  markVersion,
  LEVEL_NAME,
};
