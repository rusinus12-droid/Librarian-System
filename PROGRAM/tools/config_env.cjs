'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_SCHEMA = 'memory-suite.server-config.v1';

function parseArgs(argv = process.argv.slice(2)) {
  const result = { dataDir: '', out: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--data-dir') result.dataDir = path.resolve(argv[++index] || '.');
    else if (argv[index] === '--out') result.out = path.resolve(argv[++index] || '.');
  }
  if (!result.dataDir) throw new Error('--data-dir is required');
  if (!result.out) throw new Error('--out is required');
  return result;
}

function batchEscape(value) {
  return String(value).replace(/%/g, '%%').replace(/"/g, '');
}

function main() {
  const args = parseArgs();
  const configPath = path.join(args.dataDir, 'config', 'server-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.schema !== CONFIG_SCHEMA) throw new Error('invalid_server_config_schema');
  const host = String(config.host || '').trim().toLowerCase();
  const port = Number(config.port);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('server_config_host_must_be_loopback');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('server_config_port_invalid');
  const autoBackup = config.autoBackup !== false;
  const urlHost = host === '::1' ? '[::1]' : host;
  const lines = [
    '@echo off',
    `set "MEMORY_SUITE_HOST=${batchEscape(host)}"`,
    `set "MEMORY_SUITE_PORT=${port}"`,
    `set "MEMORY_SUITE_AUTO_BACKUP=${autoBackup ? 'true' : 'false'}"`,
    `set "MEMORY_SUITE_SERVER_URL=http://${batchEscape(urlHost)}:${port}"`,
    `set "MEMORY_SUITE_BACKUP_DIR=${batchEscape(path.join(args.dataDir, 'backups'))}"`
  ];
  fs.writeFileSync(args.out, `${lines.join('\r\n')}\r\n`, 'utf8');
}

try { main(); }
catch (error) {
  process.stderr.write(`[LIBRARIAN SYSTEM CONFIG] ${String(error?.stack || error)}\n`);
  process.exitCode = 1;
}
