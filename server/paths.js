'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.MCF_DATA_DIR ? path.resolve(process.env.MCF_DATA_DIR) : path.join(ROOT, 'data');
const IS_WIN = process.platform === 'win32';

module.exports = {
  ROOT,
  DATA,
  IS_WIN,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  AUTHPACK_SRC: path.join(__dirname, 'authpack'),
  CONFIG_FILE: path.join(DATA, 'config.json'),
  SERVERS_FILE: path.join(DATA, 'servers.json'),
  RUNTIME_FILE: path.join(DATA, 'runtime.json'),
  BDS_DIR: path.join(DATA, 'bedrock'),
  DOWNLOADS_DIR: path.join(DATA, 'bedrock', 'downloads'),
  INSTANCES_DIR: path.join(DATA, 'instances'),
  SLOTS_DIR: path.join(DATA, 'slots'),
  // Servers run from data/slots/1..MAX_SLOTS. The paths never change, so Windows Firewall rules can be
  // registered for them once (see firewall-setup.ps1) instead of prompting for every new server.
  MAX_SLOTS: 32,
  FIREWALL_GROUP: 'Minecraft Server Farm',
  TRASH_DIR: path.join(DATA, 'trash'),
  BDS_EXE: IS_WIN ? 'bedrock_server.exe' : 'bedrock_server',
  // Java Edition: server jars per game version, and the Java runtimes (from Mojang) they run on.
  JAVA_DIR: path.join(DATA, 'java'),
  JAVA_VERSIONS_DIR: path.join(DATA, 'java', 'versions'),
  JAVA_RUNTIME_DIR: path.join(DATA, 'java', 'runtime'),
  JAVA_DOWNLOADS_DIR: path.join(DATA, 'java', 'downloads'),
};
