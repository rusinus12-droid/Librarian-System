'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'http://127.0.0.1:47630';
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'DATA');
const { planOfflineRestore, restoreBackupOffline, dataInstanceIdForToken } = require('./server.cjs');
const { readDataInstanceIdentity, contract: physicalDataIdentityContract } = require('./core/data-instance-identity.cjs');
const COMMAND_TIMEOUT_MS = Object.freeze({
  status: 3000,
  stop: 5000,
  clients: 10000,
  'list-backups': 10000,
  integrity: 120000,
  scrub: 120000,
  'restore-plan': 120000,
  backup: 600000,
  restore: 600000
});

function usage() {
  process.stdout.write([
    'Librarian System admin commands:',
    '  node admin.cjs status [--url URL]',
    '  node admin.cjs clients [--url URL] [--data-dir DATA]',
    '  node admin.cjs backup [label] [--url URL] [--data-dir DATA]',
    '  node admin.cjs list-backups [--url URL] [--data-dir DATA]',
    '  node admin.cjs integrity [--url URL] [--data-dir DATA]',
    '  node admin.cjs scrub [backup-id] [--url URL] [--data-dir DATA]',
    '  node admin.cjs restore-plan <backup-id> [all|flashback,hayaku,libra,lia,retrace] [--url URL] [--data-dir DATA]',
    '  node admin.cjs restore <backup-id> [all|flashback,hayaku,libra,lia,retrace] [--url URL] [--data-dir DATA]',
    '  node admin.cjs restore-offline <backup-id> [all|flashback,hayaku,libra,lia,retrace] --yes [--data-dir DATA]',
    '  node admin.cjs stop [--url URL] [--data-dir DATA]',
    '  optional: --timeout-ms 100..1800000',
    ''
  ].join('\n'));
}

function parse(argv = process.argv.slice(2)) {
  const result = { command: String(argv[0] || 'status'), args: [], url: DEFAULT_URL, dataDir: DEFAULT_DATA_DIR, yes: false, timeoutMs: 0 };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--yes') result.yes = true;
    else if (argv[i] === '--url') result.url = String(argv[++i] || DEFAULT_URL).replace(/\/+$/, '');
    else if (argv[i] === '--data-dir') result.dataDir = path.resolve(argv[++i] || DEFAULT_DATA_DIR);
    else if (argv[i] === '--timeout-ms') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 100 || value > 30 * 60 * 1000) throw new Error('invalid_timeout_ms');
      result.timeoutMs = value;
    }
    else result.args.push(String(argv[i] || ''));
  }
  return result;
}

async function jsonFetch(url, init = {}, timeoutMs = 30000) {
  const boundedTimeoutMs = Math.max(100, Math.min(30 * 60 * 1000, Number(timeoutMs) || 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
  timer.unref?.();
  try {
    let response;
    try { response = await fetch(url, { ...init, signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        const timeoutError = new Error(`Librarian System admin request timed out after ${boundedTimeoutMs}ms: ${url}`);
        timeoutError.code = 'MEMORY_SUITE_ADMIN_TIMEOUT';
        throw timeoutError;
      }
      throw error;
    }
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch (_) { throw new Error(`Invalid JSON from ${url}: ${raw.slice(0, 400)}`); }
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function connection(baseUrl, dataDir, timeoutMs = 3000) {
  const tokenPath = path.join(path.resolve(dataDir || DEFAULT_DATA_DIR), 'runtime-token.txt');
  let token = '';
  try { token = fs.readFileSync(tokenPath, 'utf8').trim(); }
  catch (_) { throw new Error(`Librarian System admin token is unavailable: ${tokenPath}`); }
  if (token.length < 32) throw new Error(`Librarian System admin token is invalid: ${tokenPath}`);
  const url = String(baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  const health = await jsonFetch(`${url}/health`, {}, Math.min(10000, Math.max(100, Number(timeoutMs) || 3000)));
  const expectedDataInstanceId = health?.dataIdentityContract===physicalDataIdentityContract
    ? readDataInstanceIdentity(dataDir).dataInstanceId : dataInstanceIdForToken(token);
  if (String(health?.dataInstanceId || '') !== expectedDataInstanceId) {
    const error = new Error(`Librarian System DATA identity mismatch: expected ${expectedDataInstanceId}, received ${String(health?.dataInstanceId || 'missing')}`);
    error.code = 'MEMORY_SUITE_DATA_IDENTITY_MISMATCH';
    throw error;
  }
  return { url, token, dataInstanceId:expectedDataInstanceId };
}

async function request(conn, method, route, body = null, timeoutMs = 30000) {
  return await jsonFetch(`${conn.url}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      'X-Memory-Suite-Admin': '1',
      'X-Memory-Suite-Data-Instance': conn.dataInstanceId,
      ...(body == null ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body == null ? {} : { body: JSON.stringify(body) })
  }, timeoutMs);
}

async function main() {
  const parsed = parse();
  const timeoutMs = parsed.timeoutMs || COMMAND_TIMEOUT_MS[parsed.command] || 30000;
  if (['help', '--help', '-h'].includes(parsed.command)) return usage();
  if (parsed.command === 'status') {
    const payload = await jsonFetch(`${parsed.url}/health`, {}, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (parsed.command === 'restore-offline') {
    const backupId = parsed.args[0];
    if (!backupId) throw new Error('restore-offline requires a backup id.');
    if (!parsed.yes) throw new Error('restore-offline is destructive. Re-run with --yes after reviewing restore-plan.');
    const target = String(parsed.args[1] || 'all').toLowerCase();
    const namespaces = target === 'all' ? ['flashback', 'hayaku', 'libra', 'lia', 'retrace'] : target.split(',').map(value => value.trim()).filter(Boolean);
    const backupDir = path.join(parsed.dataDir, 'backups');
    const plan = planOfflineRestore({ dataDir: parsed.dataDir, backupDir, backupId, namespaces });
    process.stderr.write(`[LIBRARIAN SYSTEM ADMIN] Offline restore plan verified for ${plan.namespaces.join(', ')} from ${plan.backupId}.\n`);
    const result = restoreBackupOffline({ dataDir: parsed.dataDir, backupDir, backupId, namespaces, reason: 'admin-offline-restore' });
    process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`);
    return;
  }
  const conn = await connection(parsed.url, parsed.dataDir, timeoutMs);
  if (parsed.command === 'clients') {
    const payload = await request(conn, 'GET', '/v1/clients', null, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
    return;
  }
  if (parsed.command === 'backup') {
    const payload = await request(conn, 'POST', '/v1/admin/backups/create', { kind: 'manual', label: parsed.args.join(' ') || 'manual' }, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
    return;
  }
  if (parsed.command === 'list-backups') {
    const payload = await request(conn, 'GET', '/v1/admin/backups', null, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
    return;
  }
  if (parsed.command === 'integrity') {
    const payload = await request(conn, 'POST', '/v1/admin/integrity', {}, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
    process.exitCode = payload.result?.ok === true ? 0 : 2;
    return;
  }
  if (parsed.command === 'scrub') {
    const payload = await request(conn, 'POST', '/v1/admin/backups/scrub', { backupId: parsed.args[0] || '' }, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
    process.exitCode = payload.result?.ok === true ? 0 : 2;
    return;
  }
  if (parsed.command === 'restore-plan') {
    const backupId = parsed.args[0];
    if (!backupId) throw new Error('restore-plan requires a backup id.');
    const target = String(parsed.args[1] || 'all').toLowerCase();
    const namespaces = target === 'all' ? ['flashback', 'hayaku', 'libra', 'lia', 'retrace'] : target.split(',').map(value => value.trim()).filter(Boolean);
    const payload = await request(conn, 'POST', '/v1/admin/restore/plan', { backupId, namespaces }, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
    return;
  }
  if (parsed.command === 'restore') {
    const backupId = parsed.args[0];
    if (!backupId) throw new Error('restore requires a backup id.');
    const target = String(parsed.args[1] || 'all').toLowerCase();
    const namespaces = target === 'all'
      ? ['flashback', 'hayaku', 'libra', 'lia', 'retrace']
      : target.split(',').map(value => value.trim()).filter(Boolean);
    const payload = await request(conn, 'POST', '/v1/admin/restore', { backupId, namespaces }, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
    return;
  }
  if (parsed.command === 'stop') {
    const payload = await request(conn, 'POST', '/v1/shutdown', {}, timeoutMs);
    process.stdout.write(`${JSON.stringify(payload.result, null, 2)}\n`);
    return;
  }
  usage();
  throw new Error(`Unknown command: ${parsed.command}`);
}

main().catch(error => {
  process.stderr.write(`[LIBRARIAN SYSTEM ADMIN] ${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
