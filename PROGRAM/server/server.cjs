'use strict';

// Experimental reference-v2 HTTP interception is retired. All requests use the
// authenticated router below. Server Compute is retired: /v1/compute/* answers 410.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const createLibraGraphLifecycle = require('./core/libra-graph-lifecycle.cjs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { validateStoredHostLineage } = require('./core/host-lineage-metadata.cjs');
const { createFlashbackWriterFence } = require('./core/flashback-writer-fence.cjs');
const gradiaReadSession = require('./core/gradia-libra-read-session.cjs');
const gradiaOwnerReadSessions = Object.freeze({libra:gradiaReadSession,
  hayaku:require('./core/gradia-hayaku-read-session.cjs'),flashback:require('./core/gradia-flashback-read-session.cjs')});
const { exportBackupArchive, importBackupArchive } = require('./portable/backup_archive.cjs');
const { planMigrationMetadataInstall, applyMigrationMetadataPlan, installMigrationMetadata, verifyAuxiliary, rollbackMigrationMetadata } = require('./core/migration_metadata.cjs');
const { ensureDataInstanceIdentity, readDataInstanceIdentity } = require('./core/data-instance-identity.cjs');
const authorityContracts = require('./authority/contracts.cjs');
const { assertAuthorityStore } = require('./authority/control-store.cjs');
const { bindOwnerStore, verifyOwnerGuards, readOwnerOperationResult } = require('./authority/owner-store.cjs');
const receiptRetention = require('./authority/receipt-retention.cjs');
const receiptCodec = require('./authority/receipt-codec.cjs');
const { createAuthorityCoordinator } = require('./authority/coordinator.cjs');
const { assertLegacyAuthorityUnavailable } = require('./authority/legacy-admission.cjs');
const { openCore3ServerRuntime } = require('./authority/core3-runtime.cjs');

const SERVER_NAME = 'Librarian System Data Server';
const SERVER_VERSION = '0.3.71';
const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 9;
const DATABASE_SCHEMA_VERSION = 1;
const DATA_LAYOUT_SCHEMA = 'memory-suite.data-layout.v1';
const DATA_LAYOUT_VERSION = 1;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 47630;
const MAX_BODY_BYTES = 96 * 1024 * 1024;
const KV_KEYS_PAGE_DEFAULT = 400;
const KV_KEYS_PAGE_MAX = 1000;
const KV_GET_MANY_RESPONSE_BYTES_DEFAULT = 4 * 1024 * 1024;
const KV_GET_MANY_RESPONSE_BYTES_MAX = 8 * 1024 * 1024;
const KV_GET_MANY_RESPONSE_BYTES_MIN = 256 * 1024;
const KV_INTERACTIVE_SET_BODY_BYTES = (4 * 1024 * 1024) + (256 * 1024);
const KV_INTERACTIVE_REMOVE_BODY_BYTES = 512 * 1024;
const KV_CONDITIONAL_BATCH_MAX_ITEMS = 64;
const KV_CONDITIONAL_BATCH_BODY_BYTES = 4 * 1024 * 1024;
const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_BACKUP_RECENT_KEEP = 12;
const AUTO_BACKUP_DAILY_KEEP = 7;
const AUTO_BACKUP_WEEKLY_KEEP = 4;
const AUTO_BACKUP_MIN_COOLDOWN_MS = 10 * 60 * 1000;
const CHANGE_SETTLED_BACKUP_DELAY_MS = 45 * 1000;
const RESTORE_JOURNAL_SCHEMA = 'memory-suite.restore-transaction.v1';
const RESTORE_JOURNAL_FILE = 'restore-transaction.json';
const RECOVERY_QUARANTINE_SCHEMA = 'memory-suite.recovery-quarantine.v1';
const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OPERATION_SOFT_CAP = 100000;
const MANAGER_PLAN_TTL_MS = 2 * 60 * 1000;
const MANAGER_MAX_MUTATIONS = 4096;
const DIAGNOSTIC_EVENT_SCHEMA = 'memory-suite.server-diagnostic-event.v1';
const DIAGNOSTIC_EXPORT_SCHEMA = 'memory-suite.server-diagnostics.v1';
const DIAGNOSTIC_RING_LIMIT = 2000;
const DIAGNOSTIC_EXPORT_LIMIT = 1000;
const DIAGNOSTIC_LOG_MAX_BYTES = 4 * 1024 * 1024;
const DIAGNOSTIC_LOG_KEEP = 5;
const NAMESPACES = Object.freeze(['flashback', 'hayaku', 'libra', 'lia', 'retrace']);
// Compatibility inventory is deliberately unchanged; only these owners create new live stores.
const ACTIVE_STORAGE_NAMESPACES = Object.freeze(['flashback', 'hayaku', 'libra']);
const LEGACY_STORAGE_NAMESPACES = Object.freeze(['lia', 'retrace']);
// Only active storage owners are included in the service inventory.
const SUPPORTED_STORAGE_OWNERS = ACTIVE_STORAGE_NAMESPACES;
const SPACES = new Set(['plugin', 'local']);
const REQUIRED_CAPABILITIES = Object.freeze([
  'kv.v1',
  'keys.v1',
  'revision.v1',
  'digest.v1',
  'idempotency.v1',
  'tombstone.v1',
  'readback.v1',
  'namespace-integrity.v1',
  'backup.v1',
  'integrity.v1',
  'restore.v1',
  'program-data-separation.v1',
  'portable-data-folder.v1',
  'automatic-data-migration.v1',
  'server-namespace-read.v1',
  'handoff-sync-proof.v1',
  'server-batch-read.v1',
  'keys-pagination.v1',
  'server-batch-read-budget.v1',
  'interactive-storage-soft-cap.v1',
  'conditional-batch.v1',
  'libra-graph-lifecycle.v1',
  'libra-graph-projection-pages.v1',
  'flashback-writer-fence.v1',
  'scope-index.v1',
  'scope-catalog.v1',
  'scope-reference-graph.v1',
  'scope-delete-plan.v1',
  'scope-delete-preview.v1',
  'scope-delete-commit.v1',
  'scope-delete-job.v1',
  'manager-control.v1',
  'portable-transfer.v1',
  'logical-migration.v1',
  'libra-scope-health.v1',
  'deleted-scope-backup.v1',
  'orphan-scope-management.v1',
  'scope-pin.v1',
  'scope-recovery-pairing.v1',
  'manager-owner-gate.v1',
  'server-diagnostics.v1',
  'manager-diagnostics.v1',
  'diagnostic-events.v1',
  'diagnostic-log-rotation.v1',
  'scoped-capability-auth.v1',
  'shutdown-backup.v1',
  'recovery-safe-mode.v1',
  'restore-journal.v1',
  'backup-scrub.v1',
  'generational-backup-retention.v1',
  'scope-catalog-fallback.v1'
]);

const now = () => Date.now();
const sha256Text = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const dataInstanceIdForToken = token => crypto.createHmac('sha256', String(token || '').trim())
  .update('memory-suite.data-instance.v1', 'utf8')
  .digest('base64url')
  .slice(0, 24);
const sha256File = filePath => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
};
const safeFilePart = value => String(value || '')
  .trim()
  .replace(/[^A-Za-z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);
const sqlString = value => `'${String(value).replace(/'/g, "''")}'`;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}


function diagnosticHash(value, length = 16) {
  const body = String(value || '');
  return body ? sha256Text(body).slice(0, Math.max(8, Math.min(64, Number(length) || 16))) : '';
}

function sanitizeDiagnosticText(value, max = 600) {
  return String(value == null ? '' : value)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|api_key|token|access_token|auth|authorization)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/("?(?:api[_-]?key|access[_-]?token|authorization|private[_-]?key|secret|password|credential)"?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(0, Number(max) || 0));
}

function decodeDiagnosticHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return decodeURIComponent(raw).slice(0, 1200); }
  catch (_) { return raw.slice(0, 1200); }
}

function diagnosticKeyType(value) {
  const key = String(value || '').toLowerCase();
  if (!key) return '';
  const rules = [
    ['route_registry', /__memory_suite_(?:internal_)?scope_routes/],
    ['sync_job', /__memory_suite_internal_sync_job/],
    ['manifest', /manifest/],
    ['vector', /vector|embedding_projection|local_vector/],
    ['archive', /archive/],
    ['worldline', /worldline/],
    ['memory', /memory|summary|record/],
    ['ledger', /ledger/],
    ['story_arc', /story[_-]?arc|story_arcs/],
    ['narrative', /narrative/],
    ['persona', /persona/],
    ['settings', /settings|config|preset/],
    ['journal', /journal|operation_log|handoff/],
    ['shard', /shard/],
    ['catalog', /catalog|index|registry/]
  ];
  for (const [type, pattern] of rules) if (pattern.test(key)) return type;
  return 'opaque_record';
}

const PLUGIN_NAMESPACE_MAP = Object.freeze({
  flashback_memory: 'flashback',
  flashback: 'flashback',
  hayaku_locator_continuity: 'hayaku',
  hayaku: 'hayaku',
  libra: 'libra',
  lia_persona_linker: 'lia',
  lia: 'lia',
  flashback_hayaku_bridge: 'retrace',
  retrace: 'retrace'
});
const RETRACE_PLUGIN_ID = 'flashback_hayaku_bridge';
const RETRACE_PEER_PREFIX = `${RETRACE_PLUGIN_ID}:peer:`;
const CAPABILITY_TOKEN_PREFIX = 'mscap1';

function namespaceForPluginId(value) {
  const plugin = String(value || '').trim().toLowerCase();
  return PLUGIN_NAMESPACE_MAP[plugin] || '';
}

const GRADIA_READ_OWNERS = Object.freeze(['libra', 'hayaku', 'flashback']);
function principalForPluginId(value, gradiaReadOwners) {
  const pluginId = String(value || '').trim().toLowerCase();
  if (!pluginId || pluginId.length > 120) return null;
  if (pluginId === gradiaReadSession.PLUGIN_ID) {
    const requested = gradiaReadOwners === undefined ? ['libra'] : gradiaReadOwners;
    if (!Array.isArray(requested) || !requested.length || requested.length > GRADIA_READ_OWNERS.length
        || new Set(requested).size !== requested.length || requested.some(owner => !GRADIA_READ_OWNERS.includes(owner))) return null;
    return { kind: 'plugin', pluginId, namespace: 'libra', roles: ['readonly'],
      readNamespaces: GRADIA_READ_OWNERS.filter(owner => requested.includes(owner)), writeNamespaces: [] };
  }
  if (pluginId.startsWith(RETRACE_PEER_PREFIX)) {
    const peerPluginId = pluginId.slice(RETRACE_PEER_PREFIX.length);
    const namespace = namespaceForPluginId(peerPluginId);
    if (!NAMESPACES.includes(namespace) || namespace === 'retrace') return null;
    return {
      kind: 'plugin', pluginId, namespace, roles: ['peer_reader'],
      readNamespaces: [namespace], writeNamespaces: []
    };
  }
  const namespace = namespaceForPluginId(pluginId);
  if (!namespace) return null;
  const manager = pluginId === RETRACE_PLUGIN_ID;
  return {
    kind: 'plugin', pluginId, namespace, roles: manager ? ['manager'] : LEGACY_STORAGE_NAMESPACES.includes(namespace) ? ['legacy_reader'] : ['owner'],
    readNamespaces: manager ? NAMESPACES.slice() : [namespace],
    writeNamespaces: ACTIVE_STORAGE_NAMESPACES.includes(namespace) ? [namespace] : []
  };
}

function httpHost(value) {
  const host = String(value || '').trim().toLowerCase();
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function loopbackUrl(host, port) {
  return `http://${httpHost(host)}:${Number(port)}`;
}

function createBackupStoresInWorker(tasks) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'backup_worker.cjs'), { workerData: { tasks } });
    let received = false;
    let stores;
    let failure = null;
    // A result/error message is not proof that the worker can no longer write.
    // Keep its result provisional until the actual Worker exit event.
    worker.on('message', message => {
      if (received) {
        failure ||= new Error('backup_worker_multiple_results');
        return;
      }
      received = true;
      if (message?.ok === true) stores = message.stores || {};
      else failure ||= new Error(message?.error || 'backup_worker_failed');
    });
    worker.once('error', error => { failure ||= error; });
    worker.once('exit', code => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`backup_worker_exit:${code}`));
      else if (!received) reject(new Error('backup_worker_exited_without_result'));
      else resolve(stores);
    });
  });
}

function issueCapabilityToken(masterToken, principal) {
  const payload = Buffer.from(JSON.stringify({
    schema: 'memory-suite.capability-token.v1',
    pluginId: principal.pluginId,
    ...(principal.pluginId === gradiaReadSession.PLUGIN_ID ? {gradiaReadOwners: principal.readNamespaces} : {})
  }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', String(masterToken)).update(payload).digest('base64url');
  return `${CAPABILITY_TOKEN_PREFIX}.${payload}.${signature}`;
}

function verifyCapabilityToken(masterToken, value) {
  const token = String(value || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== CAPABILITY_TOKEN_PREFIX || !safeEqual(
    crypto.createHmac('sha256', String(masterToken)).update(parts[1]).digest('base64url'),
    parts[2]
  )) return null;
  let payload = null;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch (_) { return null; }
  if (payload?.schema !== 'memory-suite.capability-token.v1') return null;
  // Tokens issued before this feature have no owner set and remain LIBRA-only.
  return principalForPluginId(payload.pluginId, payload.gradiaReadOwners);
}

function safeDiagnosticIntegrity(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    namespace: String(value.namespace || ''),
    ok: value.ok === true,
    result: sanitizeDiagnosticText(value.result || '', 180),
    records: Math.max(0, Number(value.records || 0) || 0),
    liveRecords: Math.max(0, Number(value.liveRecords || 0) || 0),
    tombstones: Math.max(0, Number(value.tombstones || 0) || 0),
    operations: Math.max(0, Number(value.operations || 0) || 0),
    fileBytes: Math.max(0, Number(value.fileBytes || 0) || 0)
  };
}


function readDiagnosticTextLogTail(filePath, maxChars = 32000) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    const maxBytes = Math.min(stat.size, Math.max(4096, Number(maxChars || 0) * 4));
    const buffer = Buffer.alloc(maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buffer, 0, maxBytes, Math.max(0, stat.size - maxBytes)); }
    finally { fs.closeSync(fd); }
    const tail = buffer.toString('utf8')
      .split(/\r?\n/)
      .slice(-240)
      .map(line => sanitizeDiagnosticText(line, 2200))
      .filter(Boolean)
      .join('\n')
      .slice(-Math.max(1000, Number(maxChars || 32000)));
    return { file: path.basename(filePath), bytes: Math.max(0, Number(stat.size || 0) || 0), updatedAt: Math.max(0, Number(stat.mtimeMs || 0) || 0), tail };
  } catch (error) {
    return { file: path.basename(filePath), bytes: 0, updatedAt: 0, tail: '', error: sanitizeDiagnosticText(error?.message || error, 500) };
  }
}

function readDiagnosticTextLogs(dataDir) {
  const logsDir = path.join(dataDir, 'logs');
  return ['startup.log', 'startup-error.log', 'server.log'].map(name => readDiagnosticTextLogTail(path.join(logsDir, name))).filter(Boolean);
}

function createDiagnosticJournal(dataDir, { memoryOnly = false } = {}) {
  const logsDir = path.join(dataDir, 'logs');
  if (!memoryOnly) fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'server-debug.jsonl');
  const ring = [];
  let sequence = 0;
  let dropped = 0;
  let writeFailures = 0;
  const pendingLines = [];
  let flushTimer = null;
  const rotatedPath = index => index <= 0 ? filePath : path.join(logsDir, `server-debug.${index}.jsonl`);

  for (let index = memoryOnly ? -1 : DIAGNOSTIC_LOG_KEEP - 1; index >= 0; index -= 1) {
    const candidate = rotatedPath(index);
    if (!fs.existsSync(candidate)) continue;
    try {
      const lines = fs.readFileSync(candidate, 'utf8').split(/\r?\n/).filter(Boolean).slice(-DIAGNOSTIC_RING_LIMIT);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event?.schema !== DIAGNOSTIC_EVENT_SCHEMA) continue;
          sequence = Math.max(sequence, Number(event.sequence || 0) || 0);
          ring.push(event);
          if (ring.length > DIAGNOSTIC_RING_LIMIT) ring.shift();
        } catch (_) {}
      }
    } catch (_) {}
  }

  const rotate = incomingBytes => {
    let currentBytes = 0;
    try { currentBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; } catch (_) {}
    if (currentBytes + incomingBytes <= DIAGNOSTIC_LOG_MAX_BYTES) return;
    for (let index = DIAGNOSTIC_LOG_KEEP - 1; index >= 1; index -= 1) {
      const target = rotatedPath(index);
      const source = index === 1 ? filePath : rotatedPath(index - 1);
      try { if (fs.existsSync(target)) fs.rmSync(target, { force: true }); } catch (_) {}
      try { if (fs.existsSync(source)) fs.renameSync(source, target); } catch (_) {}
    }
  };

  const record = raw => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const at = Math.max(0, Number(source.at || now()) || now());
    const scopeId = String(source.scopeId || '');
    const key = String(source.key || '');
    const namespace = NAMESPACES.includes(String(source.namespace || '').toLowerCase()) ? String(source.namespace).toLowerCase() : '';
    const redactKnownDiagnosticValues = value => {
      let textValue = String(value == null ? '' : value);
      for (const [rawValue, marker] of [[key, '[STORAGE_KEY]'], [scopeId, '[SCOPE_ID]'], [String(source.operationId || ''), '[OPERATION_ID]']]) {
        if (rawValue && rawValue.length >= 3) textValue = textValue.split(rawValue).join(marker);
      }
      return sanitizeDiagnosticText(textValue, 600);
    };
    const event = {
      schema: DIAGNOSTIC_EVENT_SCHEMA,
      sequence: ++sequence,
      at,
      iso: new Date(at).toISOString(),
      level: ['debug', 'info', 'warn', 'error'].includes(String(source.level || '')) ? String(source.level) : (Number(source.statusCode || 0) >= 400 ? 'error' : 'info'),
      event: sanitizeDiagnosticText(source.event || source.operation || 'server.event', 120),
      operation: sanitizeDiagnosticText(source.operation || '', 120),
      method: sanitizeDiagnosticText(source.method || '', 16),
      route: sanitizeDiagnosticText(source.route || '', 240),
      namespace,
      space: SPACES.has(String(source.space || '')) ? String(source.space) : '',
      storageMode: ['plugin_only', 'mirror', 'server_only'].includes(String(source.storageMode || '')) ? String(source.storageMode) : '',
      scopeIdHash: diagnosticHash(scopeId),
      keyType: diagnosticKeyType(key || source.keyType),
      keyHash: diagnosticHash(key),
      keyLength: key.length,
      operationIdHash: diagnosticHash(source.operationId),
      plugin: sanitizeDiagnosticText(source.plugin || '', 120),
      pluginVersion: sanitizeDiagnosticText(source.pluginVersion || '', 80),
      statusCode: Math.max(0, Number(source.statusCode || 0) || 0),
      ok: source.ok === true,
      durationMs: Math.max(0, Number(source.durationMs || 0) || 0),
      requestBytes: Math.max(0, Number(source.requestBytes || 0) || 0),
      responseBytes: Math.max(0, Number(source.responseBytes || 0) || 0),
      valueBytes: Math.max(0, Number(source.valueBytes || 0) || 0),
      itemCount: Math.max(0, Number(source.itemCount || 0) || 0),
      revision: Math.max(0, Number(source.revision || 0) || 0),
      digestPrefix: sanitizeDiagnosticText(source.digestPrefix || '', 24),
      tombstone: source.tombstone === true,
      errorCode: sanitizeDiagnosticText(source.errorCode || '', 120),
      error: redactKnownDiagnosticValues(source.error || ''),
      message: redactKnownDiagnosticValues(source.message || '')
    };
    ring.push(event);
    if (ring.length > DIAGNOSTIC_RING_LIMIT) { ring.shift(); dropped += 1; }
    if (memoryOnly) return event;
    pendingLines.push(`${JSON.stringify(event)}
`);
    if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 250);
      flushTimer.unref?.();
    }
    return event;
  };

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pendingLines.length) return true;
    const body = pendingLines.splice(0).join('');
    try {
      rotate(Buffer.byteLength(body));
      fs.appendFileSync(filePath, body, 'utf8');
      return true;
    } catch (_) { writeFailures += 1; return false; }
  };

  const query = ({ namespace = '', scopeId = '', limit = 500, since = 0, includeGlobal = true } = {}) => {
    const normalizedNamespace = String(namespace || '').trim().toLowerCase();
    const scopeHash = diagnosticHash(scopeId);
    const normalizedSince = Math.max(0, Number(since || 0) || 0);
    const normalizedLimit = Math.max(1, Math.min(DIAGNOSTIC_EXPORT_LIMIT, Number(limit || 500) || 500));
    return ring.filter(event => (
      (!normalizedNamespace || event.namespace === normalizedNamespace || (includeGlobal && !event.namespace))
      && (!scopeHash || event.scopeIdHash === scopeHash || (includeGlobal && !event.scopeIdHash))
      && (!normalizedSince || Number(event.at || 0) >= normalizedSince)
    )).slice(-normalizedLimit);
  };

  const stats = () => {
    let fileBytes = 0;
    let rotations = 0;
    for (let index = 0; !memoryOnly && index < DIAGNOSTIC_LOG_KEEP; index += 1) {
      const candidate = rotatedPath(index);
      try {
        if (!fs.existsSync(candidate)) continue;
        if (index > 0) rotations += 1;
        fileBytes += fs.statSync(candidate).size;
      } catch (_) {}
    }
    return {
      schema: 'memory-suite.server-diagnostic-log-stats.v1',
      retainedEvents: ring.length,
      ringLimit: DIAGNOSTIC_RING_LIMIT,
      exportLimit: DIAGNOSTIC_EXPORT_LIMIT,
      droppedEvents: dropped,
      writeFailures,
      pendingEvents: pendingLines.length,
      fileBytes,
      rotations,
      maxFileBytes: DIAGNOSTIC_LOG_MAX_BYTES,
      keepFiles: DIAGNOSTIC_LOG_KEEP,
      file: memoryOnly ? null : 'DATA/logs/server-debug.jsonl',
      ...(memoryOnly ? {memoryOnly:true} : {})
    };
  };

  const close = () => flush();
  return { record, query, stats, flush, close, filePath };
}

function parseArgs(argv = process.argv.slice(2)) {
  const explicitPortableSettings = new Set();
  const result = {
    command: 'serve',
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    dataDir: path.resolve(__dirname, '..', '..', 'DATA'),
    backupDir: '',
    autoBackup: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === 'serve' || arg === 'version') result.command = arg;
    else if (arg === '--data-dir') result.dataDir = path.resolve(argv[++index] || result.dataDir);
    else if (arg === '--backup-dir') result.backupDir = path.resolve(argv[++index] || path.join(result.dataDir, 'backups'));
    else if (arg === '--host') result.host = String(argv[++index] || result.host);
    else if (arg === '--port') result.port = Number(argv[++index] || result.port);
    else if (arg === '--portable-settings-from-data') result.portableSettingsFromData = true;
    else if (arg === '--no-auto-backup') { result.autoBackup = false; explicitPortableSettings.add('autoBackup'); }
    // Server Compute is retired. Older launchers may still pass these flags: accept and ignore them.
    else if (arg === '--no-compute') {}
    else if (arg === '--compute-workers') { if (index + 1 < argv.length && !String(argv[index + 1]).startsWith('--')) index += 1; }
  }
  if (result.portableSettingsFromData === true) result.explicitPortableSettings = [...explicitPortableSettings];
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535 || (result.port > 0 && result.port < 1024)) {
    throw new Error(`invalid_port:${result.port}`);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(result.host)) {
    throw new Error('memory_suite_server_must_bind_to_loopback');
  }
  return result;
}

function fsyncDirectory(directoryPath) {
  let fd = null;
  try {
    fd = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(fd);
  } catch (_) {
    // Windows and some virtual filesystems do not permit directory fsync.
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

function fsyncFile(filePath) {
  let fd = null;
  try {
    // Windows FlushFileBuffers requires a handle opened with write access.
    // Every caller passes a newly staged restore artifact, so r+ preserves the
    // bytes while providing the access required for a real durability barrier.
    fd = fs.openSync(filePath, 'r+');
    fs.fsyncSync(fd);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

function durableRename(fromPath, toPath) {
  fs.renameSync(fromPath, toPath);
  fsyncDirectory(path.dirname(fromPath));
  if (path.dirname(fromPath) !== path.dirname(toPath)) fsyncDirectory(path.dirname(toPath));
}

function atomicWrite(filePath, value, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', Number.isInteger(options.mode) ? options.mode : 0o600);
    const buffer = Buffer.from(String(value), 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
    throw error;
  }
}


function pathIsInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readJsonFile(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return fallback; }
}

function ensurePortableDataLayout(dataDir) {
  const layoutPath = path.join(dataDir, 'data-layout.json');
  const existing = readJsonFile(layoutPath, null);
  if (existing) {
    if (existing.schema !== DATA_LAYOUT_SCHEMA) throw new Error('invalid_data_layout_schema');
    const version = Number(existing.layoutVersion || 0);
    if (version > DATA_LAYOUT_VERSION) {
      const error = new Error(`data_layout_newer_than_program:${version}>${DATA_LAYOUT_VERSION}`);
      error.code = 'DATA_LAYOUT_NEWER_THAN_PROGRAM';
      throw error;
    }
    if (version < DATA_LAYOUT_VERSION) {
      const error = new Error(`data_layout_migration_missing:${version}->${DATA_LAYOUT_VERSION}`);
      error.code = 'DATA_LAYOUT_MIGRATION_MISSING';
      throw error;
    }
  }
  for (const relative of [
    'config',
    'stores',
    path.join('backups', 'auto'),
    path.join('backups', 'manual'),
    path.join('backups', 'pre-migration'),
    path.join('backups', 'deleted-scopes'),
    path.join('backups', 'recovery-quarantine'),
    'logs',
    'migrations'
  ]) fs.mkdirSync(path.join(dataDir, relative), { recursive: true });
  const next = {
    schema: DATA_LAYOUT_SCHEMA,
    layoutVersion: DATA_LAYOUT_VERSION,
    createdAt: existing?.createdAt || new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    lastServerVersion: SERVER_VERSION,
    databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
    portableRoot: true,
    programFolder: 'PROGRAM',
    dataFolder: 'DATA',
    backupRule: 'stop_server_then_copy_entire_DATA_folder',
    recoveryQuarantine: 'backups/recovery-quarantine',
    restoreJournal: 'migrations/restore-transaction.json',
    scopeCatalogPrevious: 'config/scope-catalog.previous.json'
  };
  atomicWrite(layoutPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function tableExists(database, tableName) {
  return !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function databaseColumns(database, tableName) {
  if (!tableExists(database, tableName)) return [];
  return database.prepare(`PRAGMA table_info(${tableName})`).all().map(row => String(row.name || ''));
}

function inferDatabaseSchemaVersion(database) {
  if (tableExists(database, 'metadata')) {
    try {
      const row = database.prepare("SELECT value FROM metadata WHERE key = 'database_schema_version'").get();
      const version = Number(row?.value);
      if (Number.isInteger(version) && version >= 0) return version;
    } catch (_) {}
  }
  try {
    const userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version || 0);
    if (Number.isInteger(userVersion) && userVersion > 0) return userVersion;
  } catch (_) {}
  const kv = new Set(databaseColumns(database, 'kv'));
  const operations = new Set(databaseColumns(database, 'operations'));
  const schemaOneKv = ['space', 'key', 'value_json', 'deleted', 'revision', 'digest', 'updated_at'].every(name => kv.has(name));
  const schemaOneOperations = ['operation_id', 'fingerprint', 'response_json', 'created_at'].every(name => operations.has(name));
  if (schemaOneKv && schemaOneOperations) return 1;
  return 0;
}

function inspectDatabaseFile(filePath, namespace) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return { namespace, filePath, exists: fs.existsSync(filePath), bytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0, version: 0, records: 0 };
  }
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = String(database.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
    if (integrity !== 'ok') throw new Error(`database_integrity_failed_before_open:${namespace}:${integrity}`);
    const version = inferDatabaseSchemaVersion(database);
    const records = tableExists(database, 'kv') ? Number(database.prepare('SELECT COUNT(*) AS count FROM kv').get()?.count || 0) : 0;
    return { namespace, filePath, exists: true, bytes: fs.statSync(filePath).size, version, records };
  } finally {
    database.close();
  }
}



function backupRootPath(backupDir, kind) {
  return path.join(backupDir, kind === 'manual' ? 'manual' : 'auto');
}

function listBackupsFromDisk(backupDir) {
  const rows = [];
  for (const kind of ['manual', 'auto']) {
    const root = backupRootPath(backupDir, kind);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      const manifestPath = path.join(dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest || manifest.schema !== 'memory-suite.backup.v1') continue;
        rows.push({...manifest,path:dir,coverage:{legacyOwners:Object.keys(manifest.stores||{})}});
      } catch (_) {}
    }
  }
  return rows.sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
}

function scrubBackupFromDisk(backup, requestedNamespaces = NAMESPACES) {
  const namespaces = [...new Set((Array.isArray(requestedNamespaces) ? requestedNamespaces : [requestedNamespaces]).map(validateNamespace))];
  const stores = {};
  let ok = true;
  for (const namespace of namespaces) {
    const meta = backup?.stores?.[namespace];
    const row = { namespace, ok: false, file: String(meta?.file || ''), digestOk: false, integrity: null, bytes: 0 };
    try {
      if (!meta?.file || !meta?.sha256) throw new Error('metadata_missing');
      const filePath = path.join(backup.path, meta.file);
      if (!fs.existsSync(filePath)) throw new Error('file_missing');
      row.bytes = fs.statSync(filePath).size;
      row.digestOk = sha256File(filePath) === meta.sha256;
      if (!row.digestOk) throw new Error('digest_mismatch');
      row.integrity = verifyBackupDatabase(filePath);
      if (!row.integrity.ok) throw new Error(`integrity_failed:${row.integrity.result}`);
      row.ok = true;
    } catch (error) {
      row.error = String(error?.message || error);
      ok = false;
    }
    stores[namespace] = row;
  }
  let scopeCatalog = null;
  if (backup?.scopeCatalog?.file || backup?.scopeCatalog?.sha256) {
    scopeCatalog = { ok: false, digestOk: false, jsonOk: false };
    try {
      if (!backup.scopeCatalog?.file || !backup.scopeCatalog?.sha256) throw new Error('metadata_incomplete');
      const filePath = path.join(backup.path, backup.scopeCatalog.file);
      if (!fs.existsSync(filePath)) throw new Error('file_missing');
      scopeCatalog.digestOk = sha256File(filePath) === backup.scopeCatalog.sha256;
      if (!scopeCatalog.digestOk) throw new Error('digest_mismatch');
      const parsed = readJsonFile(filePath, null);
      scopeCatalog.jsonOk = !!(parsed && parsed.schema === 'memory-suite.scope-catalog.v1' && parsed.namespaces && typeof parsed.namespaces === 'object');
      if (!scopeCatalog.jsonOk) throw new Error('invalid_json');
      scopeCatalog.ok = true;
    } catch (error) {
      scopeCatalog.error = String(error?.message || error);
      ok = false;
    }
  }
  return {
    schema: 'memory-suite.backup-scrub.v1',
    backupId: String(backup?.id || ''),
    checkedAt: new Date().toISOString(),
    ok,
    stores,
    scopeCatalog
  };
}

function restoreJournalPath(dataDir) {
  return path.join(dataDir, 'migrations', RESTORE_JOURNAL_FILE);
}

function writeRestoreJournal(dataDir, journal) {
  atomicWrite(path.join(dataDir,'migrations','scope-delete-generation.json'),JSON.stringify({restoreId:journal.id,updatedAt:now()}));
  atomicWrite(restoreJournalPath(dataDir), `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

function clearRestoreJournal(dataDir) {
  const filePath = restoreJournalPath(dataDir);
  try { fs.rmSync(filePath, { force: true }); } catch (_) {}
  fsyncDirectory(path.dirname(filePath));
}

function cleanupRestoreArtifact(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch (_) {}
}

function recoverInterruptedRestore(dataDir) {
  const filePath = restoreJournalPath(dataDir);
  if (!fs.existsSync(filePath)) return { recovered: false, reason: 'no_journal' };
  const journal = readJsonFile(filePath, null);
  if (!journal || journal.schema !== RESTORE_JOURNAL_SCHEMA || !Array.isArray(journal.items)) {
    const invalidPath = `${filePath}.invalid-${Date.now()}`;
    try { fs.renameSync(filePath, invalidPath); } catch (_) {}
    return { recovered: false, reason: 'invalid_journal', quarantined: invalidPath };
  }
  const committed = journal.phase === 'COMMITTED';
  const rolledBack = journal.phase === 'ROLLED_BACK';
  const actions = [];
  const targets = [...journal.items];
  if (journal.catalog) targets.push({ ...journal.catalog, namespace: 'scope-catalog', kind: 'catalog' });
  if (committed || rolledBack) {
    for (const item of targets) {
      cleanupRestoreArtifact(item.tempPath);
      cleanupRestoreArtifact(item.rollbackPath);
    }
    clearRestoreJournal(dataDir);
    return { recovered: true, action: committed ? 'commit_cleanup' : 'rollback_cleanup', transactionId: journal.id, actions };
  }
  for (const item of targets.slice().reverse()) {
    const currentPath = String(item.currentPath || '');
    const rollbackPath = String(item.rollbackPath || '');
    const tempPath = String(item.tempPath || '');
    if (!currentPath || !rollbackPath || !tempPath) continue;
    try {
      if (fs.existsSync(rollbackPath)) {
        cleanupRestoreArtifact(currentPath);
        durableRename(rollbackPath, currentPath);
        actions.push({ target: item.namespace, action: 'rollback_restored_original' });
      } else if (item.hadCurrent === false && fs.existsSync(currentPath)) {
        let installed = true;
        if (item.stagedSha256) {
          try { installed = sha256File(currentPath) === item.stagedSha256; } catch (_) { installed = false; }
        }
        if (installed) {
          cleanupRestoreArtifact(currentPath);
          actions.push({ target: item.namespace, action: 'rollback_removed_new_file' });
        }
      }
      cleanupRestoreArtifact(tempPath);
    } catch (error) {
      actions.push({ target: item.namespace, action: 'rollback_failed', error: String(error?.message || error) });
      throw error;
    }
  }
  if (journal.migrationMetadata) {
    rollbackMigrationMetadata(dataDir, journal.migrationMetadata);
    actions.push({ target: 'migration-metadata', action: 'rollback_restored_original' });
  }
  const receipt = {
    schema: 'memory-suite.restore-crash-recovery.v1',
    transactionId: journal.id,
    backupId: journal.backupId,
    recoveredAt: new Date().toISOString(),
    previousPhase: journal.phase,
    action: 'rolled_back_to_pre_restore_state',
    actions
  };
  const receiptPath = path.join(dataDir, 'migrations', `restore-crash-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  clearRestoreJournal(dataDir);
  return { recovered: true, action: 'rollback', transactionId: journal.id, actions, receiptPath };
}

function createRecoveryQuarantine(dataDir, namespaces, reason = 'recovery-restore') {
  const backupDir = path.join(dataDir, 'backups');
  const createdAtMs = now();
  const id = `${new Date(createdAtMs).toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(4).toString('hex')}_${safeFilePart(reason)}`;
  const targetDir = path.join(backupDir, 'recovery-quarantine', id);
  fs.mkdirSync(targetDir, { recursive: true });
  const files = {};
  const capture = (label, sourcePath) => {
    // The SQLite `-wal`/`-shm` sidecars are NOT durable: SQLite removes them when the
    // last connection closes (and a checkpoint can do the same mid-copy). An
    // existsSync-then-copy is therefore a TOCTOU race — the file can vanish between
    // the check and the copy, and a failure here aborts the whole quarantine/restore
    // that it is meant to protect. Treat a vanished sidecar as "nothing to capture":
    // the quarantine records only what it could actually read.
    if (!fs.existsSync(sourcePath)) return;
    const targetName = `${safeFilePart(label)}${path.extname(sourcePath) || '.bin'}`;
    const targetPath = path.join(targetDir, targetName);
    try {
      fs.copyFileSync(sourcePath, targetPath);
    } catch (error) {
      if (error?.code === 'ENOENT') { try { fs.rmSync(targetPath, { force: true }); } catch (_) {} return; }
      throw error;
    }
    files[label] = { file: targetName, bytes: fs.statSync(targetPath).size, sha256: sha256File(targetPath) };
  };
  for (const namespace of namespaces) {
    const current = namespaceDbPath(dataDir, namespace);
    capture(`${namespace}.sqlite`, current);
    capture(`${namespace}.sqlite-wal`, `${current}-wal`);
    capture(`${namespace}.sqlite-shm`, `${current}-shm`);
  }
  capture('scope-catalog.json', path.join(dataDir, 'config', 'scope-catalog.json'));
  const manifest = {
    schema: RECOVERY_QUARANTINE_SCHEMA,
    id,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
    reason,
    namespaces,
    files
  };
  atomicWrite(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { id, path: targetDir, manifest };
}

function validScopeCatalog(value) {
  return !!(value && value.schema === 'memory-suite.scope-catalog.v1' && value.namespaces && typeof value.namespaces === 'object');
}

function readScopeCatalogFromDisk(dataDir) {
  const currentPath = path.join(dataDir, 'config', 'scope-catalog.json');
  const previousPath = path.join(dataDir, 'config', 'scope-catalog.previous.json');
  const current = readJsonFile(currentPath, null);
  if (validScopeCatalog(current)) return { catalog: current, source: 'current', degraded: false, currentPath, previousPath };
  const previous = readJsonFile(previousPath, null);
  if (validScopeCatalog(previous)) return { catalog: previous, source: 'previous', degraded: true, currentPath, previousPath };
  return { catalog: { schema: 'memory-suite.scope-catalog.v1', updatedAt: 0, namespaces: {} }, source: 'empty', degraded: fs.existsSync(currentPath), currentPath, previousPath };
}

function findBackupById(backupDir, backupId) {
  return listBackupsFromDisk(backupDir).find(item => item.id === String(backupId || '')) || null;
}

function planOfflineRestore({ dataDir, backupDir = path.join(dataDir, 'backups'), backupId, namespaces = NAMESPACES, mode = 'offline-recovery' }) {
  const backup = findBackupById(backupDir, backupId);
  if (!backup) throw Object.assign(new Error('backup_not_found'), { statusCode: 404 });
  const targetNamespaces = [...new Set((Array.isArray(namespaces) ? namespaces : [namespaces]).map(validateNamespace))];
  if (!targetNamespaces.length) throw Object.assign(new Error('restore_namespace_required'), { statusCode: 400 });
  const scrub = scrubBackupFromDisk(backup, targetNamespaces);
  if (!scrub.ok) {
    const error = new Error('backup_scrub_failed');
    error.checks = scrub;
    throw error;
  }
  const current = {};
  let selectedCurrentBytes = 0;
  let selectedBackupBytes = 0;
  for (const namespace of targetNamespaces) {
    const currentPath = namespaceDbPath(dataDir, namespace);
    const bytes = fs.existsSync(currentPath) ? fs.statSync(currentPath).size : 0;
    current[namespace] = { exists: fs.existsSync(currentPath), bytes };
    selectedCurrentBytes += bytes;
    selectedBackupBytes += Math.max(0, Number(backup.stores?.[namespace]?.bytes || 0) || 0);
  }
  const allCurrentBytes = NAMESPACES.reduce((sum, namespace) => {
    const filePath = namespaceDbPath(dataDir, namespace);
    try { return sum + fs.statSync(filePath).size; } catch (_) { return sum; }
  }, 0);
  const estimatedWorkingBytes = mode === 'online'
    ? Math.ceil(allCurrentBytes * 1.25) + selectedBackupBytes
    : selectedCurrentBytes + selectedBackupBytes;
  let availableBytes = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const volume = fs.statfsSync(dataDir);
      availableBytes = Number(volume.bavail) * Number(volume.bsize);
    }
  } catch (_) {}
  return {
    schema: 'memory-suite.restore-plan.v1',
    mode,
    recoveryMode: mode !== 'online',
    backupId: backup.id,
    backupCreatedAt: backup.createdAt,
    namespaces: targetNamespaces,
    current,
    scrub,
    estimated: { selectedCurrentBytes, selectedBackupBytes, allCurrentBytes, workingBytes: estimatedWorkingBytes, availableBytes, spaceLikelySufficient: availableBytes == null ? null : availableBytes >= estimatedWorkingBytes },
    scopeCatalog: readScopeCatalogFromDisk(dataDir)
  };
}

function restoreBackupOffline({ dataDir, backupDir = path.join(dataDir, 'backups'), backupId, namespaces = NAMESPACES, reason = 'recovery-safe-mode' }) {
  fs.mkdirSync(path.join(dataDir, 'migrations'), { recursive: true });
  recoverInterruptedRestore(dataDir);
  const restorePlan = planOfflineRestore({ dataDir, backupDir, backupId, namespaces });
  const backup = findBackupById(backupDir, restorePlan.backupId);
  const targetNamespaces = restorePlan.namespaces;
  const quarantine = createRecoveryQuarantine(dataDir, targetNamespaces, reason);
  const restoreNonce = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const items = [];
  let catalog = null;
  const migrationAux = backup?.migrationAux && backup.migrationAux.schema === 'librarian.migration-aux.v1' ? backup.migrationAux : null;
  const migrationMetadata = migrationAux ? planMigrationMetadataInstall(dataDir, migrationAux) : null;
  try {
    for (const namespace of targetNamespaces) {
      const storeMeta = backup.stores[namespace];
      const sourcePath = path.join(backup.path, storeMeta.file);
      const currentPath = namespaceDbPath(dataDir, namespace);
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      const tempPath = `${currentPath}.restore-temp-${restoreNonce}`;
      const rollbackPath = `${currentPath}.restore-rollback-${restoreNonce}`;
      fs.copyFileSync(sourcePath, tempPath);
      fsyncFile(tempPath);
      if (sha256File(tempPath) !== storeMeta.sha256) throw new Error(`restore_copy_digest_mismatch:${namespace}`);
      items.push({ namespace, currentPath, tempPath, rollbackPath, hadCurrent: fs.existsSync(currentPath), stagedSha256: storeMeta.sha256 });
    }
    if (backup.scopeCatalog?.file && backup.scopeCatalog?.sha256) {
      const backupCatalog = readJsonFile(path.join(backup.path, backup.scopeCatalog.file), null);
      if (!validScopeCatalog(backupCatalog)) throw new Error('backup_scope_catalog_invalid');
      const currentCatalogState = readScopeCatalogFromDisk(dataDir);
      const nextCatalog = {
        schema: 'memory-suite.scope-catalog.v1', updatedAt: now(),
        namespaces: { ...(currentCatalogState.catalog.namespaces || {}) }
      };
      for (const namespace of targetNamespaces) nextCatalog.namespaces[namespace] = Array.isArray(backupCatalog.namespaces[namespace]) ? backupCatalog.namespaces[namespace] : [];
      const currentPath = path.join(dataDir, 'config', 'scope-catalog.json');
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      const tempPath = `${currentPath}.restore-temp-${restoreNonce}`;
      const rollbackPath = `${currentPath}.restore-rollback-${restoreNonce}`;
      fs.writeFileSync(tempPath, `${JSON.stringify(nextCatalog, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      fsyncFile(tempPath);
      const stagedSha256 = sha256File(tempPath);
      catalog = { currentPath, tempPath, rollbackPath, hadCurrent: fs.existsSync(currentPath), stagedSha256 };
    }
    const journal = {
      schema: RESTORE_JOURNAL_SCHEMA,
      id: restoreNonce,
      phase: 'PREPARED',
      mode: 'offline-recovery',
      backupId: backup.id,
      namespaces: targetNamespaces,
      createdAt: new Date().toISOString(),
      quarantineId: quarantine.id,
      items,
      catalog,
      migrationMetadata
    };
    writeRestoreJournal(dataDir, journal);
    for (const item of items) {
      for (const suffix of ['-wal', '-shm']) cleanupRestoreArtifact(`${item.currentPath}${suffix}`);
      if (item.hadCurrent) durableRename(item.currentPath, item.rollbackPath);
      durableRename(item.tempPath, item.currentPath);
    }
    if (catalog) {
      if (catalog.hadCurrent) durableRename(catalog.currentPath, catalog.rollbackPath);
      durableRename(catalog.tempPath, catalog.currentPath);
    }
    if (migrationMetadata) {
      applyMigrationMetadataPlan(dataDir, migrationMetadata);
      verifyAuxiliary(dataDir, migrationAux);
    }
    writeRestoreJournal(dataDir, { ...journal, phase: 'INSTALLED', installedAt: new Date().toISOString() });
    const stores = {};
    for (const item of items) {
      const checked = verifyBackupDatabase(item.currentPath);
      if (!checked.ok) throw new Error(`restored_store_integrity_failed:${item.namespace}:${checked.result}`);
      stores[item.namespace] = checked;
    }
    writeRestoreJournal(dataDir, { ...journal, phase: 'VERIFIED', verifiedAt: new Date().toISOString() });
    writeRestoreJournal(dataDir, { ...journal, phase: 'COMMITTED', committedAt: new Date().toISOString() });
    for (const item of items) cleanupRestoreArtifact(item.rollbackPath);
    if (catalog) cleanupRestoreArtifact(catalog.rollbackPath);
    clearRestoreJournal(dataDir);
    const receipt = {
      schema: 'memory-suite.restore.receipt.v1',
      recoveryMode: true,
      restartRequired: true,
      backupId: backup.id,
      namespaces: targetNamespaces,
      restoredAt: new Date().toISOString(),
      quarantineId: quarantine.id,
      scopeCatalogRestored: !!catalog,
      stores,
      migration: migrationAux ? { schema: migrationAux.schema, source: migrationAux.source || null, settingsApplied: true } : null
    };
    atomicWrite(path.join(dataDir, 'migrations', `recovery-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    return { ok: true, result: receipt };
  } catch (error) {
    try { recoverInterruptedRestore(dataDir); } catch (_) {}
    throw error;
  } finally {
    for (const item of items) cleanupRestoreArtifact(item.tempPath);
    if (catalog) cleanupRestoreArtifact(catalog.tempPath);
  }
}

function preflightDataCompatibility(dataDir) {
  const layoutPath = path.join(dataDir, 'data-layout.json');
  if (fs.existsSync(layoutPath)) {
    const layout = readJsonFile(layoutPath, null);
    if (!layout || layout.schema !== DATA_LAYOUT_SCHEMA) throw new Error('invalid_data_layout_schema');
    const layoutVersion = Number(layout.layoutVersion || 0);
    if (layoutVersion > DATA_LAYOUT_VERSION) {
      const error = new Error(`data_layout_newer_than_program:${layoutVersion}>${DATA_LAYOUT_VERSION}`);
      error.code = 'DATA_LAYOUT_NEWER_THAN_PROGRAM';
      throw error;
    }
  }
  const inspections = [];
  for (const namespace of NAMESPACES) {
    const filePath = namespaceDbPath(dataDir, namespace);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) continue;
    const inspection = inspectDatabaseFile(filePath, namespace);
    inspections.push(inspection);
    if (inspection.version > DATABASE_SCHEMA_VERSION) {
      const error = new Error(`data_schema_newer_than_program:${namespace}:${inspection.version}>${DATABASE_SCHEMA_VERSION}`);
      error.code = 'DATA_SCHEMA_NEWER_THAN_PROGRAM';
      throw error;
    }
  }
  return inspections;
}

function createSchemaV1(database, namespace) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 1000;
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      space TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (space, key)
    );
    CREATE TABLE IF NOT EXISTS operations (
      operation_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kv_space_key ON kv(space, key);
    CREATE INDEX IF NOT EXISTS idx_operations_created_at ON operations(created_at);
  `);
  if (namespace === 'libra') database.exec(`
    CREATE TABLE IF NOT EXISTS libra_deleted_owner_scopes (
      scope_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      backup_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS libra_deleted_owner_keys (
      space TEXT NOT NULL,
      key TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      PRIMARY KEY (space, key)
    );
  `);
  const kvColumns = new Set(databaseColumns(database, 'kv'));
  const operationColumns = new Set(databaseColumns(database, 'operations'));
  if (!['space', 'key', 'value_json', 'deleted', 'revision', 'digest', 'updated_at'].every(name => kvColumns.has(name))) {
    throw new Error(`unsupported_legacy_kv_schema:${namespace}`);
  }
  if (!['operation_id', 'fingerprint', 'response_json', 'created_at'].every(name => operationColumns.has(name))) {
    throw new Error(`unsupported_legacy_operations_schema:${namespace}`);
  }
  const metadataUpsert = database.prepare(`
    INSERT INTO metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  metadataUpsert.run('database_schema_version', '1');
  metadataUpsert.run('namespace', namespace);
  database.exec('PRAGMA user_version = 1;');
}

function createPreMigrationBackup(dataDir, backupDir, inspections, targetVersion) {
  const createdAtMs = now();
  const stamp = new Date(createdAtMs).toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}_${crypto.randomBytes(4).toString('hex')}_schema-${targetVersion}`;
  const targetDir = path.join(backupDir, 'pre-migration', id);
  fs.mkdirSync(targetDir, { recursive: true });
  const stores = {};
  try {
    for (const inspection of inspections.filter(item => item.exists && item.bytes > 0)) {
      const targetPath = path.join(targetDir, `${inspection.namespace}.sqlite`);
      const database = new DatabaseSync(inspection.filePath);
      try {
        try { database.exec('PRAGMA wal_checkpoint(FULL);'); } catch (_) {}
        database.exec(`VACUUM INTO ${sqlString(targetPath)};`);
      } finally {
        database.close();
      }
      const verified = verifyBackupDatabase(targetPath);
      if (!verified.ok) throw new Error(`pre_migration_backup_integrity_failed:${inspection.namespace}:${verified.result}`);
      stores[inspection.namespace] = {
        file: `${inspection.namespace}.sqlite`,
        fromVersion: inspection.version,
        toVersion: targetVersion,
        sha256: sha256File(targetPath),
        bytes: fs.statSync(targetPath).size,
        records: verified.records
      };
    }
    const manifest = {
      schema: 'memory-suite.pre-migration-backup.v1',
      id,
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
      serverVersion: SERVER_VERSION,
      targetDatabaseSchemaVersion: targetVersion,
      stores
    };
    atomicWrite(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { id, targetDir, manifest };
  } catch (error) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}

function restorePreMigrationBackup(backup, inspections) {
  for (const inspection of inspections) {
    const meta = backup?.manifest?.stores?.[inspection.namespace];
    if (!meta) continue;
    const sourcePath = path.join(backup.targetDir, meta.file);
    if (!fs.existsSync(sourcePath) || sha256File(sourcePath) !== meta.sha256) {
      throw new Error(`pre_migration_rollback_source_invalid:${inspection.namespace}`);
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${inspection.filePath}${suffix}`, { force: true }); } catch (_) {}
    }
    fs.mkdirSync(path.dirname(inspection.filePath), { recursive: true });
    fs.copyFileSync(sourcePath, inspection.filePath);
  }
}

function migrateDatabaseFile(inspection) {
  fs.mkdirSync(path.dirname(inspection.filePath), { recursive: true });
  const database = new DatabaseSync(inspection.filePath);
  try {
    let version = inferDatabaseSchemaVersion(database);
    while (version < DATABASE_SCHEMA_VERSION) {
      if (version === 0) {
        createSchemaV1(database, inspection.namespace);
        version = 1;
        continue;
      }
      throw new Error(`database_migration_missing:${inspection.namespace}:${version}->${version + 1}`);
    }
    if (version > DATABASE_SCHEMA_VERSION) {
      const error = new Error(`data_schema_newer_than_program:${inspection.namespace}:${version}>${DATABASE_SCHEMA_VERSION}`);
      error.code = 'DATA_SCHEMA_NEWER_THAN_PROGRAM';
      throw error;
    }
    const integrity = String(database.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
    if (integrity !== 'ok') throw new Error(`database_integrity_failed_after_migration:${inspection.namespace}:${integrity}`);
  } finally {
    database.close();
  }
}

function prepareDatabaseSchemas(dataDir, backupDir) {
  const inspections = NAMESPACES.map(namespace => inspectDatabaseFile(namespaceDbPath(dataDir, namespace), namespace));
  const future = inspections.find(item => item.version > DATABASE_SCHEMA_VERSION);
  if (future) {
    const error = new Error(`data_schema_newer_than_program:${future.namespace}:${future.version}>${DATABASE_SCHEMA_VERSION}`);
    error.code = 'DATA_SCHEMA_NEWER_THAN_PROGRAM';
    throw error;
  }
  const migrationTargets = inspections.filter(item => item.exists && item.bytes > 0 && item.version < DATABASE_SCHEMA_VERSION);
  if (!migrationTargets.length) return { migrated: false, inspections, backup: null };
  const backup = createPreMigrationBackup(dataDir, backupDir, inspections, DATABASE_SCHEMA_VERSION);
  try {
    for (const inspection of migrationTargets) migrateDatabaseFile(inspection);
    const after = NAMESPACES.map(namespace => inspectDatabaseFile(namespaceDbPath(dataDir, namespace), namespace));
    const invalid = after.find(item => item.exists && item.bytes > 0 && item.version !== DATABASE_SCHEMA_VERSION);
    if (invalid) throw new Error(`database_migration_verification_failed:${invalid.namespace}:${invalid.version}`);
    const receipt = {
      schema: 'memory-suite.database-migration.receipt.v1',
      migratedAt: new Date().toISOString(),
      serverVersion: SERVER_VERSION,
      backupId: backup.id,
      targetVersion: DATABASE_SCHEMA_VERSION,
      stores: Object.fromEntries(after.map(item => [item.namespace, { before: inspections.find(old => old.namespace === item.namespace)?.version ?? 0, after: item.version }]))
    };
    atomicWrite(path.join(dataDir, 'migrations', `database-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    return { migrated: true, inspections: after, backup, receipt };
  } catch (error) {
    restorePreMigrationBackup(backup, inspections);
    throw error;
  }
}

function loadOrCreateToken(dataDir) {
  const tokenPath = path.join(dataDir, 'runtime-token.txt');
  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
    throw new Error('runtime_token_is_invalid');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  atomicWrite(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function namespaceDbPath(dataDir, namespace) {
  return path.join(dataDir, 'stores', namespace, `${namespace}.sqlite`);
}

function validateNamespace(value) {
  const namespace = String(value || '').trim().toLowerCase();
  if (!NAMESPACES.includes(namespace)) {
    throw Object.assign(new Error('invalid_namespace'), { statusCode: 400 });
  }
  return namespace;
}

function validateSpace(value) {
  const space = String(value || '').trim();
  if (!SPACES.has(space)) {
    throw Object.assign(new Error('invalid_storage_space'), { statusCode: 400 });
  }
  return space;
}

function validateKey(value) {
  const key = String(value ?? '');
  if (!key || key.length > 4096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(key)) {
    throw Object.assign(new Error('invalid_storage_key'), { statusCode: 400 });
  }
  return key;
}

function validateOperationId(value) {
  const operationId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{12,240}$/.test(operationId)) {
    throw Object.assign(new Error('invalid_operation_id'), { statusCode: 400 });
  }
  return operationId;
}

function clampStoragePageLimit(value, fallback = KV_KEYS_PAGE_DEFAULT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(KV_KEYS_PAGE_MAX, Math.trunc(parsed)));
}

function encodeStorageCursor(namespace, space, prefix, key) {
  const normalizedKey = String(key || '');
  if (!normalizedKey) return '';
  const payload = {
    v: 2,
    namespace: String(namespace || ''),
    space: String(space || ''),
    prefix: String(prefix || ''),
    key: normalizedKey
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeStorageCursor(value, expected = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (_) {
    throw Object.assign(new Error('invalid_storage_cursor'), { statusCode: 400 });
  }
  const key = String(decoded?.key || '');
  const namespace = String(decoded?.namespace || '');
  const space = String(decoded?.space || '');
  const prefix = String(decoded?.prefix || '');
  if (decoded?.v !== 2 || !key || key.length > 4096 || prefix.length > 4096) {
    throw Object.assign(new Error('invalid_storage_cursor'), { statusCode: 400 });
  }
  if (namespace !== String(expected.namespace || '') || space !== String(expected.space || '')) {
    throw Object.assign(new Error('storage_cursor_scope_mismatch'), { statusCode: 400 });
  }
  if (prefix !== String(expected.prefix || '')) {
    throw Object.assign(new Error('storage_cursor_prefix_mismatch'), { statusCode: 400 });
  }
  if (!key.startsWith(prefix)) {
    throw Object.assign(new Error('invalid_storage_cursor'), { statusCode: 400 });
  }
  return key;
}

function clampGetManyResponseBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return KV_GET_MANY_RESPONSE_BYTES_DEFAULT;
  return Math.max(KV_GET_MANY_RESPONSE_BYTES_MIN, Math.min(KV_GET_MANY_RESPONSE_BYTES_MAX, Math.trunc(parsed)));
}

function validateGetManyCursor(value, keyCount) {
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > keyCount) {
    throw Object.assign(new Error('invalid_get_many_cursor'), { statusCode: 400 });
  }
  return parsed;
}

function isSensitiveKey(namespace, key) {
  const normalized = String(key || '').toLowerCase();
  const generic = /(?:api[_:.-]?key|provider[_:.-]?secrets?|embedding[_:.-]?secret|credential|authorization|bearer|access[_:.-]?token|refresh[_:.-]?token|private[_:.-]?key|password|hosting[_:.-]?token|runtime[_:.-]?token)/i;
  if (generic.test(normalized)) return true;
  if (namespace === 'lia' && [
    'liapersonaillustrationconfigv1',
    'liapersonalinkerprovidersecretv1',
    'liapersonalinkerprovidersecretsyncedv1'
  ].includes(normalized)) return true;
  if (namespace === 'retrace' && [
    'memory_session_bridge:settings:v1',
    'memory_session_bridge:settings_local_backup:v1'
  ].includes(normalized)) return true;
  return false;
}

function assertNonSensitive(namespace, key) {
  if (isSensitiveKey(namespace, key)) {
    throw Object.assign(new Error('credential_keys_must_remain_in_risuai_local_storage'), { statusCode: 400 });
  }
}

function readBody(request, maxBytes = MAX_BODY_BYTES, tooLargeError = 'request_body_too_large') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const limit = Math.max(1, Math.min(MAX_BODY_BYTES, Number(maxBytes) || MAX_BODY_BYTES));
    const declaredBytes = Number(request.headers['content-length'] || 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
      reject(Object.assign(new Error(tooLargeError), { statusCode: 413, maxBytes: limit }));
      request.resume();
      return;
    }
    request.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > limit) {
        settled = true;
        reject(Object.assign(new Error(tooLargeError), { statusCode: 413, maxBytes: limit }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        request.__memorySuiteBodyBytes = bytes;
        request.__memorySuiteParsedBody = parsed;
        resolve(parsed);
      } catch (_) {
        reject(Object.assign(new Error('invalid_json_body'), { statusCode: 400 }));
      }
    });
    request.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.on('aborted', () => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('request_aborted'), { statusCode: 400 }));
    });
  });
}

function corsHeaders(request) {
  const origin = String(request?.headers?.origin || '').trim();
  const headers = {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Memory-Suite-Plugin, X-Memory-Suite-Read-Owners, X-Memory-Suite-Plugin-Version, X-Memory-Suite-Admin, X-Memory-Suite-Manager, X-Memory-Suite-Scope-Id, X-Memory-Suite-Storage-Mode, X-Memory-Suite-Reset-Epochs, X-Memory-Suite-Data-Instance',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'X-Content-Type-Options': 'nosniff'
  };
  // Native RisuAI requests and local admin tools normally have no Origin. about:srcdoc
  // plugin containers may send Origin:null. Normal remote web origins receive no CORS grant.
  if (origin === 'null') headers['Access-Control-Allow-Origin'] = 'null';
  else if (origin) {
    try {
      const parsed = new URL(origin);
      if (['127.0.0.1', 'localhost', '::1'].includes(String(parsed.hostname || '').toLowerCase())) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
    } catch (_) {}
  }
  return headers;
}

function sendJson(request, response, statusCode, payload) {
  const common = corsHeaders(request);
  if(request.__memorySuiteDataInstanceId){
    common['X-Memory-Suite-Data-Instance']=request.__memorySuiteDataInstanceId;
    common['Access-Control-Expose-Headers']='X-Memory-Suite-Data-Instance';
    payload={...payload,dataInstanceId:request.__memorySuiteDataInstanceId};
  }
  if (statusCode === 204) {
    response.writeHead(204, common);
    response.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  request.__memorySuiteResponsePayload = payload;
  request.__memorySuiteResponseBytes = body.length;
  response.writeHead(statusCode, {
    ...common,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  response.end(body);
}

function openDatabase(dataDir, namespace, options = {}) {
  const filePath = namespaceDbPath(dataDir, namespace);
  if (options.retiredAuthorityControl) {
    const witness = assertAuthorityStore(options.retiredAuthorityControl, {dataDir});
    if (authorityContracts.witnessProfile(witness).id !== authorityContracts.CORE3_AUTHORITY_PROFILE
      || !LEGACY_STORAGE_NAMESPACES.includes(namespace) || options.legacyReadOnly !== true) authorityContracts.fail('AUTHORITY_OWNER_NOT_IN_PROFILE');
    require('./authority/maintenance-admission.cjs').assertNoAuthorityDatabaseFile(filePath);
  } else assertLegacyAuthorityUnavailable({dataDir,namespaces:[namespace]});
  const legacyReadOnly = options.legacyReadOnly === true;
  const ephemeral = legacyReadOnly && !fs.existsSync(filePath);
  if (!legacyReadOnly) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const wasMissingOrEmpty = ephemeral || !fs.existsSync(filePath) || fs.statSync(filePath).size === 0;
  const database = new DatabaseSync(ephemeral ? ':memory:' : filePath, { readOnly: legacyReadOnly && !ephemeral });
  let existingVersion = inferDatabaseSchemaVersion(database);
  if (wasMissingOrEmpty && existingVersion === 0) {
    createSchemaV1(database, namespace);
    existingVersion = DATABASE_SCHEMA_VERSION;
  }
  if (existingVersion > DATABASE_SCHEMA_VERSION) {
    database.close();
    const error = new Error(`data_schema_newer_than_program:${namespace}:${existingVersion}>${DATABASE_SCHEMA_VERSION}`);
    error.code = 'DATA_SCHEMA_NEWER_THAN_PROGRAM';
    throw error;
  }
  if (existingVersion < DATABASE_SCHEMA_VERSION) {
    database.close();
    throw new Error(`database_not_prepared_before_open:${namespace}:${existingVersion}->${DATABASE_SCHEMA_VERSION}`);
  }
  if (legacyReadOnly) return { database, filePath, ephemeral, legacyReadOnly, retiredAuthorityControl:options.retiredAuthorityControl };
  createSchemaV1(database, namespace);
  const metadataUpsert = database.prepare(`
    INSERT INTO metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  metadataUpsert.run('database_schema_version', String(DATABASE_SCHEMA_VERSION));
  metadataUpsert.run('namespace', namespace);
  metadataUpsert.run('server_version_last_opened', SERVER_VERSION);
  return { database, filePath };
}

function createRepository(dataDir, namespace, isMaintenanceActive = () => false, authorityControl = null, options = {}) {
  let ownerStore = null;
  const legacyReadOnly = authorityControl === null && LEGACY_STORAGE_NAMESPACES.includes(namespace) && options.legacyMaintenance !== true;
  const opened = authorityControl === null ? openDatabase(dataDir, namespace, { legacyReadOnly, retiredAuthorityControl:options.retiredAuthorityControl }) : (() => {
    const witness = assertAuthorityStore(authorityControl, {dataDir});
    // Admission precedes any SQLite open, including retired/missing stores.
    authorityContracts.profileNamespace(namespace, authorityContracts.witnessProfile(witness).id);
    const filePath = namespaceDbPath(dataDir, namespace);
    const database = new DatabaseSync(filePath);
    try {
      ownerStore = bindOwnerStore({database,namespace,filePath,physicalBinding:witness.physicalBinding,resetEpoch:witness.resetEpochs[namespace]});
      verifyOwnerGuards(ownerStore);
      if (options.registerOwner) options.registerOwner(ownerStore);
      return {database,filePath};
    } catch (error) {
      if (ownerStore) ownerStore.close(); else database.close();
      throw error;
    }
  })();
  const { database, filePath } = opened;
  const coordinator = ownerStore ? createAuthorityCoordinator({control:authorityControl,resolveOwnerStore:owner => {
    if (owner !== namespace) throw Object.assign(new Error('AUTHORITY_QUARANTINED'),{code:'AUTHORITY_QUARANTINED'});
    return ownerStore;
  }}) : null;
  let currentOwnerTx = null;
  // Unit A may conclusively close a failed handle and reopen it for recovery.
  // Every activated transaction statement resolves through that CURRENT facade.
  // Outside transactions the existing raw handle remains read-only-by-guards;
  // a closed raw read handle fails rather than silently reopening legacy state.
  const prepareStatement = sql => {
    const statement = database.prepare(sql);
    return Object.freeze(Object.fromEntries(['run','get','all'].map(method => [method,(...args) =>
      currentOwnerTx ? currentOwnerTx[method](sql,...args) : statement[method](...args)])));
  };
  const runRepositoryTransaction = ({operationId,fingerprint,operationClass,maintenance = false,assertCurrent}, body) => {
    authorityContracts.synchronous(body);
    if (legacyReadOnly) throw Object.assign(new Error('retired_storage_owner_read_only'), {statusCode:403});
    const admit = () => {
      if (options.authorityAdmission) options.authorityAdmission({inTransaction:currentOwnerTx !== null});
      if (!maintenance && isMaintenanceActive()) throw Object.assign(new Error('server_maintenance_in_progress'),{statusCode:503});
      if (assertCurrent) authorityContracts.noPromise(assertCurrent());
    };
    if (!ownerStore) {
      assertLegacyAuthorityUnavailable({dataDir,namespaces:[namespace],database});
      admit();
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = authorityContracts.noPromise(body());
        database.exec('COMMIT'); return result;
      } catch (error) { try { database.exec('ROLLBACK'); } catch (_) {} throw error; }
    }
    assertAuthorityStore(authorityControl,{dataDir});
    admit();
    let outcome;
    try {
      outcome = coordinator.runMutation({namespace,operationId,fingerprint,operationClass}, ownerTx => {
        currentOwnerTx = ownerTx;
        try {
          admit();
          const result = authorityContracts.noPromise(body());
          const prior = selectOperation.get(operationId);
          if (!prior) insertOperation.run(operationId,fingerprint,JSON.stringify(result),now());
          else if (prior.fingerprint !== fingerprint) throw Object.assign(new Error('operation_id_payload_conflict'),{statusCode:409});
        } finally { currentOwnerTx = null; }
      });
    } catch (error) {
      if (error.code === 'OPERATION_CONFLICT') throw Object.assign(new Error('operation_id_payload_conflict'),{statusCode:409});
      if (options.protectedRuntime && /^AUTHORITY_/.test(error.code || '') && !error.statusCode) error.statusCode = 503;
      throw error;
    }
    if (outcome.status !== 'committed' || !outcome.decision?.receipt?.ordinaryResult) {
      throw Object.assign(new Error('AUTHORITY_OPERATION_ABORTED'),{code:'AUTHORITY_OPERATION_ABORTED',statusCode:409});
    }
    return readOwnerOperationResult(ownerStore,outcome,{expectedReceipt:outcome.decision.receipt});
  };
  const selectKv = prepareStatement('SELECT space, key, value_json, deleted, revision, digest, updated_at FROM kv WHERE space = ? AND key = ?');
  const selectKvSized = prepareStatement("SELECT space, key, value_json, deleted, revision, digest, updated_at, LENGTH(CAST(COALESCE(value_json, '') AS BLOB)) AS value_bytes FROM kv WHERE space = ? AND key = ?");
  const selectKvMetadata = prepareStatement("SELECT space, key, deleted, revision, digest, updated_at, LENGTH(CAST(COALESCE(value_json, '') AS BLOB)) AS value_bytes FROM kv WHERE space COLLATE BINARY = ? AND key COLLATE BINARY = ?");
  const selectKvBounded = prepareStatement("SELECT space, key, CASE WHEN LENGTH(CAST(COALESCE(value_json, '') AS BLOB)) <= ? THEN value_json ELSE NULL END AS value_json, deleted, revision, digest, updated_at, LENGTH(CAST(COALESCE(value_json, '') AS BLOB)) AS value_bytes FROM kv WHERE space COLLATE BINARY = ? AND key COLLATE BINARY = ?");
  const operationStatement = prepareStatement(ownerStore ? "SELECT CASE WHEN typeof(fingerprint)='text' AND LENGTH(CAST(fingerprint AS BLOB))<=64 THEN fingerprint ELSE NULL END AS fingerprint FROM operations WHERE operation_id = ?" : 'SELECT fingerprint, response_json FROM operations WHERE operation_id = ?');
  const selectOperation = Object.freeze({ get(operationId) {
    const row = operationStatement.get(operationId);
    if (ownerStore && row && (typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint))) authorityContracts.fail('AUTHORITY_QUARANTINED');
    return row;
  }});
  const selectKeys = prepareStatement("SELECT key, deleted, revision, digest, updated_at, LENGTH(CAST(COALESCE(value_json, '') AS BLOB)) AS value_bytes FROM kv WHERE space = ? AND key LIKE ? ESCAPE '\\' ORDER BY key");
  const selectLiveKeys = prepareStatement("SELECT key, deleted, revision, digest, updated_at, LENGTH(CAST(COALESCE(value_json, '') AS BLOB)) AS value_bytes FROM kv WHERE deleted = 0 AND space = ? AND key LIKE ? ESCAPE '\\' ORDER BY key");
  const selectKeysPaged = prepareStatement("SELECT key, deleted, revision, digest, updated_at, LENGTH(CAST(COALESCE(value_json, '') AS BLOB)) AS value_bytes FROM kv WHERE space = ? AND key LIKE ? ESCAPE '\\' AND key > ? ORDER BY key LIMIT ?");
  const upsertKv = prepareStatement(`
    INSERT INTO kv(space, key, value_json, deleted, revision, digest, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(space, key) DO UPDATE SET
      value_json = excluded.value_json,
      deleted = excluded.deleted,
      revision = excluded.revision,
      digest = excluded.digest,
      updated_at = excluded.updated_at
  `);
  const deleteKv = prepareStatement('DELETE FROM kv WHERE space = ? AND key = ?');
  const insertOperation = prepareStatement('INSERT INTO operations(operation_id, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?)');
  const deleteOldOperations = prepareStatement('DELETE FROM operations WHERE created_at < ?');
  const countOperations = prepareStatement('SELECT COUNT(*) AS count FROM operations');
  const trimOperations = prepareStatement(`
    DELETE FROM operations
    WHERE operation_id IN (
      SELECT operation_id FROM operations ORDER BY created_at ASC LIMIT ?
    )
  `);
  const countKv = prepareStatement('SELECT COUNT(*) AS count FROM kv');
  const countLive = prepareStatement('SELECT COUNT(*) AS count FROM kv WHERE deleted = 0');
  const countTombstones = prepareStatement('SELECT COUNT(*) AS count FROM kv WHERE deleted = 1');
  const deletedOwnerScope = namespace === 'libra' ? prepareStatement('SELECT scope_key, backup_id FROM libra_deleted_owner_scopes WHERE scope_id = ?') : null;
  const deletedOwnerKey = namespace === 'libra' ? prepareStatement('SELECT scope_id FROM libra_deleted_owner_keys WHERE space = ? AND key = ?') : null;
  const deletedOwnerPrefixes = namespace === 'libra' ? prepareStatement('SELECT scope_key FROM libra_deleted_owner_scopes') : null;
  const insertDeletedOwnerScope = namespace === 'libra' ? prepareStatement('INSERT INTO libra_deleted_owner_scopes(scope_id,scope_key,backup_id,deleted_at) VALUES(?,?,?,?)') : null;
  const insertDeletedOwnerKey = namespace === 'libra' ? prepareStatement('INSERT INTO libra_deleted_owner_keys(space,key,scope_id) VALUES(?,?,?)') : null;
  let mutationsSinceMaintenance = 0;

  const rejectDeletedOwnerWrite = (space, key, scopeId = '') => {
    if (namespace !== 'libra') return;
    if (deletedOwnerKey.get(space, key) || (scopeId && deletedOwnerScope.get(scopeId))) {
      throw Object.assign(new Error('libra_deleted_scope_write_blocked'), { statusCode: 409 });
    }
    // Older direct clients may omit the scope header. Without an owner identity,
    // fail closed for keys under a deleted prefix; a scoped client can identify
    // a distinct live scope even when its key happens to share that prefix.
    if (!scopeId && deletedOwnerPrefixes.all().some(row => key.startsWith(`libra:v1:scope:${row.scope_key}:`))) {
      throw Object.assign(new Error('libra_deleted_scope_write_blocked'), { statusCode: 409 });
    }
  };

  const decodeRow = row => {
    if (!row) return { exists: false, tombstone: false, value: null, revision: 0, digest: '', updatedAt: 0 };
    let value = null;
    if (row.deleted !== 1) {
      try { value = JSON.parse(row.value_json); }
      catch (error) {
        throw Object.assign(new Error(`stored_json_corrupt:${namespace}:${row.space}:${row.key}`), { cause: error });
      }
    }
    return {
      exists: row.deleted !== 1,
      tombstone: row.deleted === 1,
      value,
      revision: Number(row.revision || 0),
      digest: String(row.digest || ''),
      updatedAt: Number(row.updated_at || 0)
    };
  };

  const maintenance = (allowDuringMaintenance = false) => {
    if (legacyReadOnly) throw Object.assign(new Error('retired_storage_owner_read_only'), {statusCode:403});
    mutationsSinceMaintenance = 0;
    const cleanup = () => {
      deleteOldOperations.run(now() - OPERATION_RETENTION_MS);
      const count = Number(countOperations.get()?.count || 0);
      if (count > OPERATION_SOFT_CAP) trimOperations.run(count - OPERATION_SOFT_CAP);
      return {namespace,kind:'ordinary-receipt-cleanup'};
    };
    if (!ownerStore) { try { cleanup(); } catch (_) {} return; }
    const operationId = 'receipt-cleanup:' + crypto.randomUUID();
    return runRepositoryTransaction({operationId,fingerprint:sha256Text(operationId),operationClass:'maintenance',maintenance:allowDuringMaintenance === true},cleanup);
  };

  const postCommitMaintenance = (allowDuringMaintenance = false) => {
    // The caller already has a verified durable receipt. Housekeeping is a
    // separate guarded intent; its recoverable failure cannot negate that
    // commit. Unit A still fail-stops any transaction it cannot safely end.
    try { maintenance(allowDuringMaintenance); } catch (_) {}
  };

  const getMetadata = (space, key) => {
    space=validateSpace(space);key=validateKey(key);
    const row=selectKvMetadata.get(space,key);
    return {namespace,space,key,exists:!!row&&Number(row.deleted)!==1,tombstone:!!row&&Number(row.deleted)===1,
      revision:Number(row?.revision||0),digest:String(row?.digest||''),updatedAt:Number(row?.updated_at||0),valueBytes:Number(row?.value_bytes||0)};
  };
  const get = (space, key, options = {}) => {
    if(options.maxValueBytes===undefined)return decodeRow(selectKv.get(space,key));
    const limit=options.maxValueBytes;
    if(!Number.isSafeInteger(limit)||limit<0)throw Object.assign(new Error('invalid_storage_value_limit'),{statusCode:400});
    // The size and conditional value projection come from one exact-key SELECT.
    // Even growth since getMetadata cannot send an oversized value to JSON.parse.
    const row=selectKvBounded.get(limit,space,key);
    if(row&&Number(row.value_bytes)>limit)throw Object.assign(new Error('storage_value_limit_exceeded'),{code:'STORAGE_VALUE_LIMIT',statusCode:413});
    return decodeRow(row);
  };
  let graphLifecycle;
  const assertGraphWrite = (key,options) => graphLifecycle?.assertWrite(key,options);
  const writerFence = createFlashbackWriterFence(database, namespace, {
    prepare:prepareStatement,
    runTransaction:(input,body) => {
      const operationId = 'writer-fence:' + crypto.randomUUID();
      return runRepositoryTransaction({operationId,fingerprint:sha256Text(JSON.stringify(input)),operationClass:'fence'},body);
    }
  });

  const mutate = ({ kind, space, key, value, operationId, expectedRevision = null, fence = null, scopeId = '', graphLease = null }) => {
    if(ownerStore)receiptCodec.assertWriterKey(space,key);
    let valueJson = '';
    if (kind === 'set') validateStoredHostLineage(value, namespace);
    if (kind === 'set') {
      try { valueJson = JSON.stringify(value); }
      catch (_) { throw Object.assign(new Error('set_value_is_not_json_serializable'), { statusCode: 400 }); }
      if (valueJson === undefined) throw Object.assign(new Error('set_value_is_not_json_serializable'), { statusCode: 400 });
    }
    const normalizedExpectedRevision = expectedRevision == null
      ? null
      : Math.max(0, Number(expectedRevision));
    if (normalizedExpectedRevision != null && !Number.isInteger(normalizedExpectedRevision)) {
      throw Object.assign(new Error('invalid_expected_revision'), { statusCode: 400 });
    }
    const fingerprint = sha256Text(JSON.stringify({ kind, namespace, space, key, valueJson, expectedRevision: normalizedExpectedRevision }));
    // A request whose body finished arriving after a backup began maintenance
    // must not commit into the snapshot window. The HTTP entry gate cannot see
    // this because it runs before `await readBody`; re-check at the transaction.
    let changed = false;
    const result = runRepositoryTransaction({operationId,fingerprint,operationClass:'kv'}, () => {
      rejectDeletedOwnerWrite(space, key, scopeId);
      const priorOperation = selectOperation.get(operationId);
      if (priorOperation) {
        if (priorOperation.fingerprint !== fingerprint) {
          throw Object.assign(new Error('operation_id_payload_conflict'), { statusCode: 409 });
        }
        return ownerStore ? null : JSON.parse(priorOperation.response_json);
      }

      writerFence.verify(key, fence);
      assertGraphWrite(key,{graphLease,kind,value});
      const previous = selectKv.get(space, key);
      const previousRevision = Math.max(0, Number(previous?.revision || 0));
      if (normalizedExpectedRevision != null && previousRevision !== normalizedExpectedRevision) {
        throw Object.assign(new Error('expected_revision_conflict'), {
          statusCode: 409,
          expectedRevision: normalizedExpectedRevision,
          actualRevision: previousRevision
        });
      }
      const revision = previousRevision + 1;
      const committedAt = now();
      const deleted = kind === 'remove' ? 1 : 0;
      const digest = kind === 'remove'
        ? sha256Text(`tombstone:${namespace}:${space}:${key}:${revision}`)
        : sha256Text(valueJson);
      upsertKv.run(space, key, kind === 'remove' ? null : valueJson, deleted, revision, digest, committedAt);
      const readback = selectKv.get(space, key);
      if (!readback
        || Number(readback.revision) !== revision
        || String(readback.digest) !== digest
        || Number(readback.deleted) !== deleted
        || (kind === 'set' && String(readback.value_json) !== valueJson)) {
        throw new Error('durable_readback_failed');
      }
      const result = {
        ok: true,
        result: {
          schema: 'memory-suite.storage.receipt.v1',
          namespace,
          operationId,
          kind,
          space,
          key,
          durable: true,
          verified: true,
          revision,
          digest,
          committedAt,
          tombstone: deleted === 1
        }
      };
      insertOperation.run(operationId, fingerprint, JSON.stringify(result), committedAt);
      changed = true;
      return result;
    });
    if (changed) {
      mutationsSinceMaintenance += 1;
      if (mutationsSinceMaintenance >= 1000) postCommitMaintenance();
    }
    return result;
  };

  const normalizeConditionalMutation = raw => {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const kind = String(source.kind || '').trim().toLowerCase();
    if (!['set', 'remove', 'purge', 'check'].includes(kind)) throw Object.assign(new Error('invalid_batch_mutation_kind'), { statusCode: 400 });
    const space = validateSpace(source.space || 'plugin');
    const key = validateKey(source.key);
    assertNonSensitive(namespace, key);
    const expectedRevision = Number(source.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw Object.assign(new Error('invalid_batch_expected_revision'), { statusCode: 400 });
    const expectedDigest = String(source.expectedDigest || '');
    const expectedExists = source.expectedExists === true;
    const expectedTombstone = source.expectedTombstone === true;
    if (expectedExists && expectedTombstone) throw Object.assign(new Error('invalid_batch_expected_state'), { statusCode: 400 });
    if (kind === 'set' && !Object.prototype.hasOwnProperty.call(source, 'value')) throw Object.assign(new Error('batch_set_value_required'), { statusCode: 400 });
    if (kind === 'set') validateStoredHostLineage(source.value, namespace);
    let valueJson = '';
    if (kind === 'set') {
      try { valueJson = JSON.stringify(source.value); } catch (_) { throw Object.assign(new Error('batch_set_value_not_serializable'), { statusCode: 400 }); }
      if (valueJson === undefined) throw Object.assign(new Error('batch_set_value_not_serializable'), { statusCode: 400 });
    }
    return { kind, space, key, value: source.value, valueJson, expectedRevision, expectedDigest, expectedExists, expectedTombstone };
  };

  const verifyConditionalBatch = (rawMutations, allowEmpty = false) => {
    const mutations = (Array.isArray(rawMutations) ? rawMutations : []).map(normalizeConditionalMutation);
    if (!mutations.length && !allowEmpty) throw Object.assign(new Error('batch_mutations_required'), { statusCode: 400 });
    if (mutations.length > MANAGER_MAX_MUTATIONS) throw Object.assign(new Error('batch_mutation_limit_exceeded'), { statusCode: 400 });
    const seen = new Set();
    const checks = [];
    for (const mutation of mutations) {
      const identity = `${mutation.space}\n${mutation.key}`;
      if (seen.has(identity)) throw Object.assign(new Error(`duplicate_batch_key:${mutation.key}`), { statusCode: 400 });
      seen.add(identity);
      const row = selectKv.get(mutation.space, mutation.key);
      const actualRevision = Math.max(0, Number(row?.revision || 0));
      const actualDigest = String(row?.digest || '');
      const actualExists = !!row && Number(row.deleted) !== 1;
      const actualTombstone = !!row && Number(row.deleted) === 1;
      const matches = actualRevision === mutation.expectedRevision
        && (!mutation.expectedDigest || actualDigest === mutation.expectedDigest)
        && actualExists === mutation.expectedExists
        && actualTombstone === mutation.expectedTombstone;
      checks.push({ ...mutation, matches, actualRevision, actualDigest, actualExists, actualTombstone });
    }
    const failed = checks.filter(item => !item.matches);
    if (failed.length) {
      const error = Object.assign(new Error(`conditional_batch_state_changed:${failed.length}`), { statusCode: 409, checks: failed.slice(0, 32) });
      throw error;
    }
    return { mutations, checks };
  };

  const applyConditionalBatch = (rawMutations, options = {}) => {
    if (legacyReadOnly) {
      if (opened.retiredAuthorityControl) throw Object.assign(new Error('retired_storage_owner_read_only'), {statusCode:403});
      if (options.maintenance !== true || !fs.existsSync(filePath)) throw Object.assign(new Error('retired_storage_owner_read_only'), {statusCode:403});
      // Only a manager's already-validated, revision-bound maintenance plan may change existing legacy data.
      const maintenanceRepo = createRepository(dataDir, namespace, isMaintenanceActive, null, {legacyMaintenance:true});
      try { return maintenanceRepo.applyConditionalBatch(rawMutations, options); } finally { maintenanceRepo.close(); }
    }
    // Manager plans preserve their original receipt shape. Public conditional
    // batches record their idempotency receipt in this SAME SQLite transaction.
    const ownedScopeDeletion = options.ownedScopeDeletion || null;
    if (ownedScopeDeletion && (namespace !== 'libra' || options.maintenance !== true
      || !ownedScopeDeletion.scopeId || !ownedScopeDeletion.scopeKey || !ownedScopeDeletion.backupId)) {
      throw Object.assign(new Error('invalid_libra_owner_scope_deletion'), { statusCode: 400 });
    }
    const operationId = options.operationId == null ? null : validateOperationId(options.operationId);
    const prepared = operationId ? { mutations: rawMutations.map(normalizeConditionalMutation) } : verifyConditionalBatch(rawMutations, !!ownedScopeDeletion);
    const fingerprint = operationId || ownerStore ? sha256Text(JSON.stringify({ kind:'conditional_batch', namespace, mutations:prepared.mutations, ownedScopeDeletion })) : '';
    const authorityOperationId = operationId || (ownerStore ? 'internal-batch:' + crypto.randomUUID() : null);
    const committedAt = now();
    const receipts = [];
    // options.maintenance===true is the manager's own maintenance-time batch
    // (e.g. scope-delete) and is allowed through; every other caller is a public
    // write that must not land inside a backup snapshot window.
    let changed = false;
    const result = runRepositoryTransaction({operationId:authorityOperationId,fingerprint,operationClass:options.maintenance === true ? 'maintenance' : 'batch',maintenance:options.maintenance === true}, () => {
      if (options.maintenance !== true) for (const mutation of prepared.mutations) {
        if (mutation.kind !== 'check') rejectDeletedOwnerWrite(mutation.space, mutation.key, options.scopeId || '');
      }
      if (operationId) {
        const prior = selectOperation.get(operationId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw Object.assign(new Error('operation_id_payload_conflict'), {statusCode:409});
          return ownerStore ? null : JSON.parse(prior.response_json);
        }
      }
      // Internal owner predicates run under the same writer transaction as data and receipt.
      if (options.assertTransactionCurrent) {
        const checked = options.assertTransactionCurrent();
        if (checked && typeof checked.then === 'function') throw new Error('conditional_transaction_predicate_must_be_synchronous');
      }
      verifyConditionalBatch(prepared.mutations, !!ownedScopeDeletion);
      for (const mutation of prepared.mutations) {
        if (mutation.kind !== 'check') { assertGraphWrite(mutation.key,{...options,kind:mutation.kind,value:mutation.value}); writerFence.verify(mutation.key, options.fence, options.maintenance === true); }
      }
      for (const mutation of prepared.mutations) {
        if (mutation.kind === 'check') continue;
        const previous = selectKv.get(mutation.space, mutation.key);
        const previousRevision = Math.max(0, Number(previous?.revision || 0));
        if (mutation.kind === 'purge') {
          deleteKv.run(mutation.space, mutation.key);
          if (selectKv.get(mutation.space, mutation.key)) throw new Error(`conditional_purge_readback_failed:${mutation.key}`);
          receipts.push({ kind: 'purge', space: mutation.space, key: mutation.key, previousRevision, previousDigest: String(previous?.digest || ''), committedAt });
          continue;
        }
        const revision = previousRevision + 1;
        const deleted = mutation.kind === 'remove' ? 1 : 0;
        const digest = deleted ? sha256Text(`tombstone:${namespace}:${mutation.space}:${mutation.key}:${revision}`) : sha256Text(mutation.valueJson);
        upsertKv.run(mutation.space, mutation.key, deleted ? null : mutation.valueJson, deleted, revision, digest, committedAt);
        const readback = selectKv.get(mutation.space, mutation.key);
        if (!readback || Number(readback.revision) !== revision || String(readback.digest) !== digest || Number(readback.deleted) !== deleted || (!deleted && String(readback.value_json) !== mutation.valueJson)) {
          throw new Error(`conditional_batch_readback_failed:${mutation.key}`);
        }
        receipts.push({ kind: mutation.kind, space: mutation.space, key: mutation.key, revision, digest, tombstone: deleted === 1, committedAt });
      }
      if (ownedScopeDeletion) {
        for (const mutation of prepared.mutations) {
          if (mutation.kind !== 'remove') throw Object.assign(new Error('invalid_libra_owner_scope_deletion_mutation'), { statusCode: 400 });
          insertDeletedOwnerKey.run(mutation.space, mutation.key, ownedScopeDeletion.scopeId);
        }
        insertDeletedOwnerScope.run(ownedScopeDeletion.scopeId, ownedScopeDeletion.scopeKey, ownedScopeDeletion.backupId, committedAt);
        const sealed = deletedOwnerScope.get(ownedScopeDeletion.scopeId);
        if (sealed?.scope_key !== ownedScopeDeletion.scopeKey || sealed?.backup_id !== ownedScopeDeletion.backupId
          || prepared.mutations.some(mutation => !deletedOwnerKey.get(mutation.space, mutation.key))) {
          throw new Error('libra_deleted_scope_fence_readback_failed');
        }
      }
      const result = operationId ? {ok:true,result:{schema:'memory-suite.storage.batch-receipt.v1',namespace,operationId,
        atomicScope:'single_namespace_sqlite',durable:true,verified:true,committedAt,receipts,
        checked:prepared.mutations.filter(m=>m.kind==='check').length}} : { namespace, committedAt, receipts };
      if (operationId) insertOperation.run(operationId, fingerprint, JSON.stringify(result), committedAt);
      changed = true;
      return result;
    });
    if (changed) {
      mutationsSinceMaintenance += receipts.length;
      if (mutationsSinceMaintenance >= 1000) postCommitMaintenance(options.maintenance === true);
    }
    return result;
  };

  const list = (space, prefix = '', options = {}) => {
    const escaped = String(prefix || '').replace(/[\\%_]/g, value => `\\${value}`);
    const paged = options?.paged === true;
    const limit = clampStoragePageLimit(options?.limit, KV_KEYS_PAGE_DEFAULT);
    const cursorKey = paged ? String(options?.cursorKey || '') : '';
    const selectedRows = paged
      ? selectKeysPaged.all(space, `${escaped}%`, cursorKey, limit + 1)
      : (options.liveOnly===true?selectLiveKeys:selectKeys).all(space, `${escaped}%`);
    const hasMore = paged && selectedRows.length > limit;
    const rows = hasMore ? selectedRows.slice(0, limit) : selectedRows;
    const records = rows.map(row => ({
      space,
      key: String(row.key || ''),
      tombstone: Number(row.deleted || 0) === 1,
      revision: Number(row.revision || 0),
      digest: String(row.digest || ''),
      updatedAt: Number(row.updated_at || 0),
      valueBytes: Math.max(0, Number(row.value_bytes || 0) || 0)
    }));
    const nextCursor = hasMore && records.length
      ? encodeStorageCursor(namespace, space, prefix, records.at(-1).key)
      : '';
    return {
      keys: records.filter(row => !row.tombstone).map(row => row.key),
      tombstones: records.filter(row => row.tombstone).map(row => row.key),
      records,
      ...(paged ? {
        page: {
          schema: 'memory-suite.storage-key-page.v1',
          limit,
          returned: records.length,
          hasMore,
          nextCursor
        },
        nextCursor
      } : {})
    };
  };

  const getMany = (space, keys, options = {}) => {
    const list = Array.isArray(keys) ? keys : [];
    const paged = options?.paged === true;
    const cursor = validateGetManyCursor(options?.cursor, list.length);
    const maxResponseBytes = clampGetManyResponseBytes(options?.maxResponseBytes);
    const values = Object.create(null);
    const oversizedKeys = [];
    // Reserve enough room for the outer response envelope and continuation
    // metadata. Oversized rows are classified from SQLite byte metadata before
    // JSON.parse, so a large record cannot stall the interactive batch path.
    let estimatedResponseBytes = 768;
    let returnedCount = 0;
    let index = cursor;
    for (; index < list.length;) {
      const key = list[index];
      const row = selectKvSized.get(space, key);
      const keyBytes = Buffer.byteLength(JSON.stringify(key), 'utf8');
      const valueBytes = Math.max(0, Number(row?.value_bytes || 0) || 0);
      const oversizedEntryBytes = keyBytes + 8;
      if (valueBytes + keyBytes + 512 > maxResponseBytes) {
        if (!paged) {
          throw Object.assign(new Error('kv_get_many_single_record_too_large_use_individual_get'), {
            statusCode: 413,
            key,
            responseBytes: valueBytes + keyBytes + 512,
            maxResponseBytes
          });
        }
        if (estimatedResponseBytes + oversizedEntryBytes > maxResponseBytes && (returnedCount || oversizedKeys.length)) break;
        oversizedKeys.push(key);
        estimatedResponseBytes += oversizedEntryBytes;
        index += 1;
        continue;
      }
      const value = decodeRow(row);
      const pairBytes = keyBytes + 1 + Buffer.byteLength(JSON.stringify(value), 'utf8') + (returnedCount > 0 ? 1 : 0);
      if (estimatedResponseBytes + pairBytes > maxResponseBytes) {
        if (!paged) {
          throw Object.assign(new Error('kv_get_many_response_too_large_use_pagination'), {
            statusCode: 413,
            cursor: index,
            maxResponseBytes
          });
        }
        if (returnedCount || oversizedKeys.length) break;
        // Metadata underestimation or encoding expansion: use the ordinary
        // single-key endpoint rather than returning an over-budget page.
        oversizedKeys.push(key);
        estimatedResponseBytes += oversizedEntryBytes;
        index += 1;
        continue;
      }
      Object.defineProperty(values, key, { value, enumerable: true, configurable: true, writable: true });
      returnedCount += 1;
      estimatedResponseBytes += pairBytes;
      index += 1;
    }
    const nextCursor = index < list.length ? index : null;
    if (!paged) return { values };
    const continuation = {
      schema: 'memory-suite.storage-get-many-continuation.v1',
      cursor,
      nextCursor,
      returned: returnedCount,
      oversized: oversizedKeys.length,
      remaining: Math.max(0, list.length - index),
      complete: nextCursor == null,
      maxResponseBytes,
      estimatedResponseBytes
    };
    return { values, oversizedKeys, continuation };
  };


  const operation = operationId => {
    if(ownerStore)return receiptRetention.readOrdinaryResult(database,operationId);
    const row = selectOperation.get(operationId);
    return row ? JSON.parse(row.response_json) : null;
  };

  const integrity = () => {
    let result = 'unknown';
    try { result = String(prepareStatement('PRAGMA integrity_check').get()?.integrity_check || 'unknown'); }
    catch (error) { result = `error:${String(error?.message || error)}`; }
    return {
      namespace,
      ok: result === 'ok',
      result,
      records: Number(countKv.get()?.count || 0),
      liveRecords: Number(countLive.get()?.count || 0),
      tombstones: Number(countTombstones.get()?.count || 0),
      operations: Number(countOperations.get()?.count || 0),
      filePath,
      fileBytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
    };
  };

  const checkpoint = () => {
    if (options.protectedRuntime && !legacyReadOnly) throw Object.assign(new Error('AUTHORITY_LIFECYCLE_UNAVAILABLE'), {code:'AUTHORITY_LIFECYCLE_UNAVAILABLE',statusCode:503});
    if (legacyReadOnly) return true;
    try { database.exec('PRAGMA wal_checkpoint(FULL);'); return true; }
    catch (_) { return false; }
  };

  const vacuumInto = targetPath => {
    if (options.protectedRuntime) throw Object.assign(new Error('AUTHORITY_LIFECYCLE_UNAVAILABLE'), {code:'AUTHORITY_LIFECYCLE_UNAVAILABLE',statusCode:503});
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
    checkpoint();
    database.exec(`VACUUM INTO ${sqlString(targetPath)};`);
    return targetPath;
  };

  const publicDatabase = options.protectedRuntime && ownerStore ? new DatabaseSync(filePath,{readOnly:true}) : database;
  const close = () => {
    if (publicDatabase !== database) { try { publicDatabase.close(); } catch (_) {} }
    if (ownerStore) { ownerStore.close(); return; }
    try { checkpoint(); } catch (_) {}
    try { database.close(); } catch (_) {}
  };

  graphLifecycle = createLibraGraphLifecycle({namespace,get,getMetadata,list,applyConditionalBatch});
  return { namespace, database:publicDatabase, filePath, ephemeral:opened.ephemeral === true, legacyReadOnly, ...(options.protectedRuntime ? {maintainReceipts:maintenance} : {}), get, getMetadata, getMany, mutate, list, operation, integrity, checkpoint, vacuumInto, verifyConditionalBatch, applyConditionalBatch, graphLifecycle,
    isOwnerScopeDeleted: scopeId => namespace === 'libra' && !!deletedOwnerScope.get(scopeId), writerFence, close };
}

function verifyBackupDatabase(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = database.prepare('PRAGMA integrity_check').get();
    const result = String(row?.integrity_check || 'unknown');
    const records = Number(database.prepare('SELECT COUNT(*) AS count FROM kv').get()?.count || 0);
    const liveRecords = Number(database.prepare('SELECT COUNT(*) AS count FROM kv WHERE deleted = 0').get()?.count || 0);
    const tombstones = Number(database.prepare('SELECT COUNT(*) AS count FROM kv WHERE deleted = 1').get()?.count || 0);
    return { ok: result === 'ok', result, records, liveRecords, tombstones };
  } finally {
    database.close();
  }
}

function createMemorySuiteServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.resolve(__dirname, '..', '..', 'DATA'));
  let authorityRuntime = null;
  if (options.authorityProfile !== undefined) {
    // Selection grants no authority. Stored profile/receipt/locks are checked
    // independently; this constructor branch has no qualified live transport.
    if (options.autoBackup !== false || options.portableSettingsFromData === true) {
      throw Object.assign(new Error('AUTHORITY_RUNTIME_OPTIONS_UNSUPPORTED'), {code:'AUTHORITY_RUNTIME_OPTIONS_UNSUPPORTED',statusCode:503});
    }
    authorityRuntime = openCore3ServerRuntime({dataDir,authorityProfile:options.authorityProfile});
  }
  try { return createMemorySuiteServerWithRuntime(options,authorityRuntime); }
  catch (error) { authorityRuntime?.close(); throw error; }
}

function createMemorySuiteServerWithRuntime(options, authorityRuntime) {
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port ?? DEFAULT_PORT);
  const dataDir = path.resolve(options.dataDir || path.resolve(__dirname, '..', '..', 'DATA'));
  // Even read-only SQLite admission may materialize WAL sidecars. Reject an
  // invalid physical reset journal before that owner-store observation.
  require('./core/namespace-reset.cjs').preflightPhysicalAdmission(dataDir, NAMESPACES);
  if (!authorityRuntime) assertLegacyAuthorityUnavailable({dataDir});
  const backupDir = path.resolve(options.backupDir || path.join(dataDir, 'backups'));
  const autoBackupIntervalMs = Math.max(1000, Number(options.autoBackupIntervalMs || AUTO_BACKUP_INTERVAL_MS));
  const autoBackupMinCooldownMs = Math.max(0, Number(options.autoBackupMinCooldownMs ?? AUTO_BACKUP_MIN_COOLDOWN_MS));
  const changeSettledBackupDelayMs = Math.max(10, Number(options.changeSettledBackupDelayMs || CHANGE_SETTLED_BACKUP_DELAY_MS));
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('memory_suite_server_must_bind_to_loopback');
  if (!pathIsInside(dataDir, backupDir)) throw new Error('backup_directory_must_be_inside_DATA');
  let interruptedRestoreRecovery = { recovered: false, reason: 'data_dir_absent' };
  if (authorityRuntime) interruptedRestoreRecovery = {recovered:false,reason:'qualified_core3_lifecycle_closed'};
  else if (fs.existsSync(dataDir)) interruptedRestoreRecovery = recoverInterruptedRestore(dataDir);
  if(interruptedRestoreRecovery.requiresRecovery)throw new Error("restore_components_recovery_required");
  // Only launchers opt in. Recover first so durable rollback also governs this
  // process's preferences; explicit CLI overrides and direct API calls retain
  // their existing meaning. Host/port are outside portable migration settings.
  if (options.portableSettingsFromData === true) {
    const stored = require('../tools/platform_launcher.cjs').readConfig(dataDir);
    const explicit = new Set(Array.isArray(options.explicitPortableSettings) ? options.explicitPortableSettings : []);
    options = { ...options };
    for (const key of ['autoBackup']) {
      if (!explicit.has(key)) options[key] = stored[key];
    }
  }
  const autoBackup = options.autoBackup !== false;
  if (!authorityRuntime && fs.existsSync(dataDir)) preflightDataCompatibility(dataDir);
  if (!authorityRuntime) fs.mkdirSync(dataDir, { recursive: true });
  const dataLayout = authorityRuntime ? readJsonFile(path.join(dataDir,'data-layout.json'),null) : ensurePortableDataLayout(dataDir);
  const {dataInstanceId,dataIdentityContract}=authorityRuntime ? readDataInstanceIdentity(dataDir) : ensureDataInstanceIdentity(dataDir);
  if (!authorityRuntime) {
  fs.mkdirSync(path.join(dataDir, 'stores'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'auto'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'manual'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'pre-migration'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'deleted-scopes'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'recovery-quarantine'), { recursive: true });
  }
  const databasePreparation = authorityRuntime ? {migrated:false,authorityProfile:authorityContracts.CORE3_AUTHORITY_PROFILE,ownerSchemaVersion:3} : prepareDatabaseSchemas(dataDir, backupDir);
  const token = options.token || (authorityRuntime ? crypto.randomBytes(32).toString('base64url') : loadOrCreateToken(dataDir));
  const updaterVerificationMode = String(process.env.LIBRARIAN_UPDATER_VERIFY_MODE || '') === '1';
  let maintenanceMode = updaterVerificationMode;
  const repositories = authorityRuntime
    ? authorityRuntime.createRepositories((namespace,control,repositoryOptions) => createRepository(dataDir,namespace,()=>maintenanceMode === true,control,repositoryOptions))
    : Object.create(null);
  if (!authorityRuntime) for (const namespace of NAMESPACES) repositories[namespace] = createRepository(dataDir, namespace, () => maintenanceMode === true);
  const diagnosticJournal = createDiagnosticJournal(dataDir,{memoryOnly:!!authorityRuntime});

  const startedAt = now();
  diagnosticJournal.record({ event: 'server.created', operation: 'server.create', ok: true, message: `${host}:${port}`, itemCount: NAMESPACES.length });
  const clients = new Map();
  let closing = false;
  let backupInFlight = null;
  let autoBackupTimer = null;
  let startupBackupTimer = null;
  let changeSettledBackupTimer = null;
  let dirtySinceBackup = false;
  let lastSuccessfulAutoBackupAt = 0;
  let scopeCatalogDegraded = false;
  const managerPlans = new Map();
  const scopeCatalogPath = path.join(dataDir, 'config', 'scope-catalog.json');
  scopeCatalogDegraded = readScopeCatalogFromDisk(dataDir).degraded === true;

  const authenticate = request => {
    const authorization = String(request.headers.authorization || '');
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!supplied) return null;
    if (safeEqual(supplied, token)) {
      return String(request.headers['x-memory-suite-admin'] || '').trim() === '1'
        ? { kind: 'admin', pluginId: 'memory-suite-admin', namespace: '', roles: ['admin'], readNamespaces: NAMESPACES.slice(), writeNamespaces: NAMESPACES.slice() }
        : null;
    }
    const principal = verifyCapabilityToken(token, supplied);
    if (!principal) return null;
    const claimedPluginId = String(request.headers['x-memory-suite-plugin'] || '').trim().toLowerCase();
    return claimedPluginId === principal.pluginId ? principal : null;
  };

  const authorityHandler = authorityRuntime?.createAuthenticatedHandler({authenticate});

  const rememberClient = (request, principal = null) => {
    const plugin = String(principal?.pluginId || request.headers['x-memory-suite-plugin'] || '').trim().slice(0, 120);
    if (!plugin) return;
    const version = String(request.headers['x-memory-suite-plugin-version'] || '').trim().slice(0, 80);
    clients.set(plugin, {
      plugin, version, namespace: String(principal?.namespace || ''),
      roles: Array.isArray(principal?.roles) ? principal.roles.slice() : [], lastSeenAt: now()
    });
  };

  const hasRole = (principal, role) => Array.isArray(principal?.roles) && principal.roles.includes(role);
  const isAdminRequest = principal => hasRole(principal, 'admin');
  const isManagerRequest = principal => hasRole(principal, 'manager');
  const assertNamespaceAccess = (principal, namespace, access = 'read') => {
    const allowed = access === 'write' ? principal?.writeNamespaces : principal?.readNamespaces;
    if ((access === 'write' && LEGACY_STORAGE_NAMESPACES.includes(namespace)) || !Array.isArray(allowed) || !allowed.includes(namespace)) {
      const error = new Error(`namespace_${access}_forbidden:${namespace}`);
      error.statusCode = 403;
      throw error;
    }
    return namespace;
  };

  const backupRoot = kind => backupRootPath(backupDir, kind);

  const listBackups = () => listBackupsFromDisk(backupDir);
  // Repair resolves one registered directory only. Manifest bytes are opened
  // and bounded by the proof reader, never by the unbounded manager catalog.
  const resolveRepairBackupById = backupId => {
    if(typeof backupId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(backupId))return null;
    const root=fs.realpathSync(backupDir),matches=[];
    for(const kind of ['manual','auto']) {
      const target=path.join(root,kind,backupId);
      try { const entry=fs.lstatSync(target);if(entry.isDirectory()&&!entry.isSymbolicLink())matches.push({id:backupId,kind,path:target}); } catch (_) {}
    }
    return matches.length===1?matches[0]:null;
  };
  lastSuccessfulAutoBackupAt = Number(listBackups().find(item => item.kind === 'auto')?.createdAtMs || 0);

  const isoWeekKey = timestamp => {
    const d = new Date(timestamp);
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };

  const enforceAutoBackupRetention = () => {
    const auto = listBackups().filter(item => item.kind === 'auto');
    const keep = new Set(auto.slice(0, AUTO_BACKUP_RECENT_KEEP).map(item => item.id));
    const daily = new Set();
    const weekly = new Set();
    for (const item of auto) {
      const ts = Number(item.createdAtMs || 0);
      if (!ts) continue;
      const dayKey = new Date(ts).toISOString().slice(0, 10);
      if (daily.size < AUTO_BACKUP_DAILY_KEEP && !daily.has(dayKey)) { daily.add(dayKey); keep.add(item.id); }
      const weekKey = isoWeekKey(ts);
      if (weekly.size < AUTO_BACKUP_WEEKLY_KEEP && !weekly.has(weekKey)) { weekly.add(weekKey); keep.add(item.id); }
    }
    for (const item of auto) {
      if (keep.has(item.id)) continue;
      try { fs.rmSync(item.path, { recursive: true, force: true }); } catch (_) {}
    }
  };

  const createBackup = async (kind = 'manual', label = '', backupOptions = {}) => {
    assertLegacyAuthorityUnavailable({dataDir});
    if (backupInFlight) return await backupInFlight;
    backupInFlight = (async () => {
      const normalizedKind = kind === 'auto' ? 'auto' : 'manual';
      if (maintenanceMode && backupOptions.allowDuringMaintenance !== true && !String(label || '').startsWith('pre-restore-')) {
        throw new Error('backup_blocked_during_maintenance');
      }
      if (typeof fs.statfsSync === 'function') {
        const sourceBytes = NAMESPACES.reduce((sum, namespace) => {
          const filePath = namespaceDbPath(dataDir, namespace);
          try { return sum + fs.statSync(filePath).size; } catch (_) { return sum; }
        }, 0);
        const requiredBytes = Math.max(64 * 1024 * 1024, Math.ceil(sourceBytes * 1.25));
        const volume = fs.statfsSync(backupDir);
        const availableBytes = Number(volume.bavail) * Number(volume.bsize);
        if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
          throw new Error(`backup_free_space_insufficient:${availableBytes}<${requiredBytes}`);
        }
      }
      const createdAtMs = now();
      const stamp = new Date(createdAtMs).toISOString().replace(/[:.]/g, '-');
      const id = `${stamp}_${crypto.randomBytes(4).toString('hex')}${label ? `_${safeFilePart(label)}` : ''}`;
      const targetDir = path.join(backupRoot(normalizedKind), id);
      fs.mkdirSync(targetDir, { recursive: true });
      const stores = {};
      const ownsMaintenanceMode = maintenanceMode !== true;
      if (ownsMaintenanceMode) maintenanceMode = true;
      const captureBackupRepairAuthority = () => {
        const physical = readDataInstanceIdentity(dataDir);
        if (physical.dataInstanceId !== dataInstanceId || physical.dataIdentityContract !== dataIdentityContract) throw new Error('backup_physical_identity_changed');
        return { schema:'memory-suite.backup-repair-authority.v1', ...physical, resetEpochs:namespaceReset.epochs() };
      };
      try {
        const backupRepairAuthority = captureBackupRepairAuthority();
        const assertBackupRepairAuthority = () => {
          if (!maintenanceMode || JSON.stringify(captureBackupRepairAuthority()) !== JSON.stringify(backupRepairAuthority)) throw new Error('backup_repair_authority_changed');
        };

        // Writes are maintenance-gated while the worker produces and verifies every
        // namespace snapshot. Health/diagnostics remain responsive on the main loop.
        for (const namespace of NAMESPACES) repositories[namespace].checkpoint();
        const tasks = [];
        for (const namespace of NAMESPACES) {
          const file = `${namespace}.sqlite`, targetPath = path.join(targetDir, file);
          if (repositories[namespace].ephemeral) {
            // Preserve the five-slot portable format without creating an inactive live store.
            repositories[namespace].vacuumInto(targetPath);
            const checked = verifyBackupDatabase(targetPath);
            if (!checked.ok) throw new Error(`backup_empty_legacy_snapshot_invalid:${namespace}`);
            stores[namespace] = {file,sha256:sha256File(targetPath),bytes:fs.statSync(targetPath).size,records:checked.records,liveRecords:checked.liveRecords,tombstones:checked.tombstones};
          } else tasks.push({namespace,file,sourcePath:repositories[namespace].filePath,targetPath});
        }
        Object.assign(stores, await createBackupStoresInWorker(tasks));
        assertBackupRepairAuthority();
        for (const namespace of NAMESPACES) {
          if (!stores[namespace]?.sha256 || !fs.existsSync(path.join(targetDir, stores[namespace].file || ''))) {
            throw new Error(`backup_worker_store_missing:${namespace}`);
          }
        }
        let scopeCatalog = null;
        const scopeState = readScopeCatalogFromDisk(dataDir);
        if (validScopeCatalog(scopeState.catalog)) {
          const scopeCatalogTarget = path.join(targetDir, 'scope-catalog.json');
          atomicWrite(scopeCatalogTarget, `${JSON.stringify(scopeState.catalog, null, 2)}\n`);
          scopeCatalog = {
            file: 'scope-catalog.json',
            sha256: sha256File(scopeCatalogTarget),
            bytes: fs.statSync(scopeCatalogTarget).size,
            source: scopeState.source,
            degradedAtBackup: scopeState.degraded === true
          };
        }
        let manifest = {
          schema: 'memory-suite.backup.v1',
          backupRepairAuthority,
          id,
          kind: normalizedKind,
          label: String(label || '').slice(0, 240),
          createdAt: new Date(createdAtMs).toISOString(),
          createdAtMs,
          serverVersion: SERVER_VERSION,
          protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
          databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
          clients: Array.from(clients.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
          scopeCatalog,
          retentionPolicy: normalizedKind === 'auto' ? { recent: AUTO_BACKUP_RECENT_KEEP, daily: AUTO_BACKUP_DAILY_KEEP, weekly: AUTO_BACKUP_WEEKLY_KEEP, minCooldownMs: autoBackupMinCooldownMs } : null,
          stores
        };
        assertBackupRepairAuthority();
        atomicWrite(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        if (normalizedKind === 'auto') {
          lastSuccessfulAutoBackupAt = createdAtMs;
          enforceAutoBackupRetention();
        }
        dirtySinceBackup = false;
        return { ok: true, result: manifest };
      } catch (error) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
        throw error;
      } finally {
        if (ownsMaintenanceMode) maintenanceMode = false;
      }
    })().finally(() => { backupInFlight = null; });
    return await backupInFlight;
  };

  const scrubBackups = backupId => {
    if (authorityRuntime) authorityRuntime.unavailable();
    const rows = backupId ? [listBackups().find(item => item.id === String(backupId || ''))].filter(Boolean) : listBackups();
    if (backupId && !rows.length) throw Object.assign(new Error('backup_not_found'), { statusCode: 404 });
    const results = rows.map(item => scrubBackupFromDisk(item, NAMESPACES));
    return { schema: 'memory-suite.backup-scrub-report.v1', checkedAt: new Date().toISOString(), ok: results.every(item => item.ok), results };
  };

  // Legacy admin path-based snapshot archive bridge. Browser transfers use the
  // separate authenticated bounded portable-transfer service below.
  const backupArchiveExportRoot = () => {
    const root = path.join(backupDir, 'exports');
    fs.mkdirSync(root, { recursive: true });
    return root;
  };

  const exportBackupArchiveById = backupId => {
    const backup = listBackups().find(item => item.id === String(backupId || ''));
    if (!backup) throw Object.assign(new Error('backup_not_found'), { statusCode: 404 });
    const archivePath = path.join(backupArchiveExportRoot(), backup.id + '.zip');
    const result = exportBackupArchive({ backupDir: backup.path, archivePath, rootName: backup.id });
    return {
      schema: 'memory-suite.backup-export.v1',
      backupId: backup.id,
      archivePath: result.archivePath,
      bytes: result.bytes,
      sha256: result.sha256,
      files: Array.isArray(result.files) ? result.files.length : 0
    };
  };

  const importBackupArchiveFromPath = archivePath => {
    if (maintenanceMode) throw Object.assign(new Error('maintenance_in_progress'), { statusCode: 409 });
    const backupIdExists = candidate => listBackups().some(item => item.id === candidate);
    const imported = importBackupArchive({
      archivePath: String(archivePath || ''),
      backupRootManual: backupRoot('manual'),
      backupIdExists,
      verifyDatabase: verifyBackupDatabase
    });
    return {
      schema: 'memory-suite.backup-import.v1',
      backupId: imported.backupId,
      importedFromId: imported.manifest.importedFromId || '',
      coverage:{legacyOwners:Object.keys(imported.manifest.stores||{})},
      verified: imported.verified,
      // The imported backup is now a normal backupId; restore it via the
      // standard /v1/admin/restore engine (epoch + journal + rollback apply).
      restoreHint: { endpoint: '/v1/admin/restore', backupId: imported.backupId }
    };
  };

  const maybeCreateAutomaticBackup = async (label, options = {}) => {
    if (!autoBackup || !dirtySinceBackup) return { ok: true, skipped: true, reason: 'not_dirty_or_disabled' };
    if (maintenanceMode && options.allowDuringMaintenance !== true) return { ok: true, skipped: true, reason: 'maintenance' };
    const age = now() - Number(lastSuccessfulAutoBackupAt || 0);
    if (options.ignoreCooldown !== true && lastSuccessfulAutoBackupAt > 0 && age < autoBackupMinCooldownMs) {
      return { ok: true, skipped: true, reason: 'cooldown', retryAfterMs: autoBackupMinCooldownMs - age };
    }
    return await createBackup('auto', label, { allowDuringMaintenance: options.allowDuringMaintenance === true });
  };

  const flashbackScopeHealth = require('./core/flashback-scope-health.cjs')({getRepository:()=>repositories.flashback,dataInstanceId,epochs:()=>namespaceReset.epochs(),canRead:()=>!maintenanceMode&&!namespaceReset.active()});
  const flashbackVectorProof = require('./core/flashback-server-vector-proof.cjs')({resolveBackupById:resolveRepairBackupById,backupRoot:backupDir,dataInstanceId,dataIdentityContract,epochs:()=>namespaceReset.epochs(),readIdentity:()=>readDataInstanceIdentity(dataDir)});
  const flashbackServerRepair = require('./core/flashback-server-repair.cjs')({getRepository:()=>repositories.flashback,dataInstanceId,epochs:()=>namespaceReset.epochs(),canWrite:()=>!maintenanceMode&&!namespaceReset.active(),strongProofProvider:flashbackVectorProof});
  const ownerScopeHealth = require('./core/owner-scope-health.cjs')({getRepository:()=>repositories.libra,dataInstanceId,epochs:()=>namespaceReset.epochs(),canRead:()=>!maintenanceMode&&!namespaceReset.active()});
  const legacyOwnerScopeDelete = require('./core/owner-scope-delete.cjs')({repositories,backup:createBackup,canStart:()=>!maintenanceMode,
    setMaintenance:value=>{maintenanceMode=value;},advanceEpochs:namespaces=>namespaceReset.advanceEpochs(namespaces)});
  const ownerScopeDelete = async (...args) => { assertLegacyAuthorityUnavailable({dataDir}); return legacyOwnerScopeDelete(...args); };
  let libraNativeArchiveRepairBinding = null;
  const getLibraNativeArchiveRepair = () => {
    const repository = repositories.libra;
    if (!repository) {
      libraNativeArchiveRepairBinding = null;
      throw Object.assign(new Error('libra_native_archive_repair_unavailable'), { statusCode: 503 });
    }
    // Restore and rollback reopen repositories. Plans and cached receipts belong
    // only to the repository incarnation against which they were verified.
    if (libraNativeArchiveRepairBinding?.repository !== repository) {
      libraNativeArchiveRepairBinding = {
        repository,
        service: require('./core/libra-native-archive-repair.cjs')({
          repository,listBackups,scrubBackup:scrubBackupFromDisk,
          canStart:()=>!maintenanceMode&&!namespaceReset.active(),
          onCommitted:()=>scheduleChangeSettledBackup()
        })
      };
    }
    return libraNativeArchiveRepairBinding.service;
  };
  const integrityAll = () => {
    const stores = Object.fromEntries(NAMESPACES.map(namespace => [namespace, repositories[namespace].integrity()]));
    return {
      ok: Object.values(stores).every(item => item.ok),
      schema: 'memory-suite.integrity.v1',
      checkedAt: new Date().toISOString(),
      stores
    };
  };

  const restoreBackup = async (backupId, requestedNamespaces = NAMESPACES) => {
    assertLegacyAuthorityUnavailable({dataDir});
    if (maintenanceMode) throw Object.assign(new Error('maintenance_in_progress'), { statusCode: 409 });
    const backup = listBackups().find(item => item.id === String(backupId || ''));
    if (!backup) throw Object.assign(new Error('backup_not_found'), { statusCode: 404 });
    const namespaces = [...new Set((Array.isArray(requestedNamespaces) ? requestedNamespaces : [requestedNamespaces]).map(validateNamespace))];
    if (!namespaces.length) throw Object.assign(new Error('restore_namespace_required'), { statusCode: 400 });

    let restoreRequiresRecovery = false;
    const stagedRestoreFiles = new Set();
    maintenanceMode = true;
    try {
      // Single owner of restore-time epoch advancement for every entrypoint
      // (admin/direct, manager, future ZIP restore). Fences old clients before
      // the first restore write; a later failure still requires reconnection.
      namespaceReset.advanceEpochs(namespaces);
      const preRestore = await createBackup('manual', `pre-restore-${backup.id}`);
      const plan = [];
      const restoreNonce = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      let catalogPlan = null;
      const migrationAux = backup?.migrationAux && backup.migrationAux.schema === 'librarian.migration-aux.v1' ? backup.migrationAux : null;
      let migrationMetadataReceipt = null;
      // Validate and stage every requested database before mutating any live store.
      for (const namespace of namespaces) {
        const storeMeta = backup.stores?.[namespace];
        if (!storeMeta?.file || !storeMeta?.sha256) throw new Error(`backup_store_missing:${namespace}`);
        const sourcePath = path.join(backup.path, storeMeta.file);
        if (!fs.existsSync(sourcePath)) throw new Error(`backup_store_file_missing:${namespace}`);
        if (sha256File(sourcePath) !== storeMeta.sha256) throw new Error(`backup_store_digest_mismatch:${namespace}`);
        const sourceIntegrity = verifyBackupDatabase(sourcePath);
        if (!sourceIntegrity.ok) throw new Error(`backup_store_integrity_failed:${namespace}:${sourceIntegrity.result}`);
        const currentPath = namespaceDbPath(dataDir, namespace);
        const nonce = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const tempPath = `${currentPath}.restore-temp-${nonce}`;
        const rollbackPath = `${currentPath}.restore-rollback-${nonce}`;
        // Explicit backup restoration may materialize legacy inventory. Reopening
        // below retains the ordinary retired-owner read-only repository policy.
        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.copyFileSync(sourcePath, tempPath);
        stagedRestoreFiles.add(tempPath);
        fsyncFile(tempPath);
        if (sha256File(tempPath) !== storeMeta.sha256) {
          fs.rmSync(tempPath, { force: true });
          throw new Error(`restore_copy_digest_mismatch:${namespace}`);
        }
        plan.push({ namespace, currentPath, tempPath, rollbackPath, storeMeta });
      }

      if (backup.scopeCatalog?.file || backup.scopeCatalog?.sha256) {
        if (!backup.scopeCatalog?.file || !backup.scopeCatalog?.sha256) throw new Error('backup_scope_catalog_metadata_incomplete');
        const sourcePath = path.join(backup.path, backup.scopeCatalog.file);
        if (!fs.existsSync(sourcePath)) throw new Error('backup_scope_catalog_file_missing');
        if (sha256File(sourcePath) !== backup.scopeCatalog.sha256) throw new Error('backup_scope_catalog_digest_mismatch');
        const backupCatalog = readJsonFile(sourcePath, null);
        if (!backupCatalog || backupCatalog.schema !== 'memory-suite.scope-catalog.v1' || !backupCatalog.namespaces || typeof backupCatalog.namespaces !== 'object') {
          throw new Error('backup_scope_catalog_invalid');
        }
        const currentCatalog = readScopeCatalogFromDisk(dataDir).catalog;
        const nextCatalog = {
          schema: 'memory-suite.scope-catalog.v1',
          updatedAt: now(),
          namespaces: { ...(currentCatalog?.namespaces && typeof currentCatalog.namespaces === 'object' ? currentCatalog.namespaces : {}) }
        };
        for (const namespace of namespaces) {
          nextCatalog.namespaces[namespace] = Array.isArray(backupCatalog.namespaces[namespace])
            ? backupCatalog.namespaces[namespace]
            : [];
        }
        const tempPath = `${scopeCatalogPath}.restore-temp-${restoreNonce}`;
        const rollbackPath = `${scopeCatalogPath}.restore-rollback-${restoreNonce}`;
        fs.writeFileSync(tempPath, `${JSON.stringify(nextCatalog, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        stagedRestoreFiles.add(tempPath);
        fsyncFile(tempPath);
        catalogPlan = {
          currentPath: scopeCatalogPath, tempPath, rollbackPath,
          hadCurrent: fs.existsSync(scopeCatalogPath), currentMoved: false, tempInstalled: false
        };
      }

      migrationMetadataReceipt = migrationAux ? planMigrationMetadataInstall(dataDir, migrationAux) : null;
      const restoreJournal = {
        schema: RESTORE_JOURNAL_SCHEMA,
        id: restoreNonce,
        phase: 'PREPARED',
        mode: 'online',
        migrationMetadata: migrationMetadataReceipt,
        backupId: backup.id,
        namespaces,
        createdAt: new Date().toISOString(),
        preRestoreBackupId: preRestore.result.id,
        items: plan.map(item => ({
          namespace: item.namespace, currentPath: item.currentPath, tempPath: item.tempPath, rollbackPath: item.rollbackPath,
          hadCurrent: fs.existsSync(item.currentPath), stagedSha256: item.storeMeta.sha256
        })),
        catalog: catalogPlan ? {
          currentPath: catalogPlan.currentPath, tempPath: catalogPlan.tempPath, rollbackPath: catalogPlan.rollbackPath,
          hadCurrent: catalogPlan.hadCurrent, stagedSha256: sha256File(catalogPlan.tempPath)
        } : null
      };
      writeRestoreJournal(dataDir, restoreJournal);
      restoreRequiresRecovery = true;

      const restored = {};
      try {
        for (const item of plan) {
          repositories[item.namespace].close();
          delete repositories[item.namespace];
          for (const suffix of ['-wal', '-shm']) {
            try { fs.rmSync(`${item.currentPath}${suffix}`, { force: true }); } catch (_) {}
          }
        }
        for (const item of plan) {
          item.hadCurrent = fs.existsSync(item.currentPath);
          item.currentMoved = false;
          item.tempInstalled = false;
          if (item.hadCurrent) {
            durableRename(item.currentPath, item.rollbackPath);
            item.currentMoved = true;
          }
          durableRename(item.tempPath, item.currentPath);
          item.tempInstalled = true;
        }
        for (const item of plan) {
          repositories[item.namespace] = createRepository(dataDir, item.namespace, () => maintenanceMode === true);
          const checked = repositories[item.namespace].integrity();
          if (!checked.ok) throw new Error(`restored_store_integrity_failed:${item.namespace}:${checked.result}`);
          restored[item.namespace] = checked;
        }
        if (catalogPlan) {
          if (catalogPlan.hadCurrent) {
            durableRename(catalogPlan.currentPath, catalogPlan.rollbackPath);
            catalogPlan.currentMoved = true;
          }
          durableRename(catalogPlan.tempPath, catalogPlan.currentPath);
          catalogPlan.tempInstalled = true;
        }
        // Logical migration may carry portable server preferences, but never
        // source host/port/auth identity. Apply only after all DB/catalog files
        // are installed so the same restore rollback covers metadata failure.
        if (migrationAux) {
          applyMigrationMetadataPlan(dataDir, migrationMetadataReceipt);
          verifyAuxiliary(dataDir, migrationAux);
        }
        writeRestoreJournal(dataDir, { ...restoreJournal, phase: 'INSTALLED', installedAt: new Date().toISOString() });
        writeRestoreJournal(dataDir, { ...restoreJournal, phase: 'VERIFIED', verifiedAt: new Date().toISOString() });
        writeRestoreJournal(dataDir, { ...restoreJournal, phase: 'COMMITTED', committedAt: new Date().toISOString() });
        restoreRequiresRecovery = false;
        for (const item of plan) {
          try { fs.rmSync(item.rollbackPath, { force: true }); } catch (_) {}
        }
        if (catalogPlan) {
          try { fs.rmSync(catalogPlan.rollbackPath, { force: true }); } catch (_) {}
        }
        clearRestoreJournal(dataDir);
      } catch (error) {
        // Roll back the whole requested set, not only the database that failed.
        let metadataRollbackError = null;
        if (migrationMetadataReceipt) {
          try { rollbackMigrationMetadata(dataDir, migrationMetadataReceipt); } catch (rollbackError) { metadataRollbackError = rollbackError; }
        }
        for (const item of plan) {
          try { repositories[item.namespace]?.close(); } catch (_) {}
          delete repositories[item.namespace];
        }
        if (catalogPlan) {
          if (catalogPlan.tempInstalled) {
            try { fs.rmSync(catalogPlan.currentPath, { force: true }); } catch (_) {}
          }
          if (catalogPlan.currentMoved && fs.existsSync(catalogPlan.rollbackPath)) {
            durableRename(catalogPlan.rollbackPath, catalogPlan.currentPath);
          }
        }
        for (const item of plan.slice().reverse()) {
          if (item.tempInstalled) {
            try { fs.rmSync(item.currentPath, { force: true }); } catch (_) {}
          }
          if (item.currentMoved && fs.existsSync(item.rollbackPath)) {
            durableRename(item.rollbackPath, item.currentPath);
          }
        }
        for (const item of plan) {
          repositories[item.namespace] = createRepository(dataDir, item.namespace, () => maintenanceMode === true);
        }
        if (metadataRollbackError) {
          // Preserve PREPARED/INSTALLED evidence for startup recovery. Database
          // rollback alone cannot certify a restored DB/config pair.
          error.restoreRollbackIncomplete = true;
          error.rollbackError = metadataRollbackError;
          throw error;
        }
        try {
          writeRestoreJournal(dataDir, { ...restoreJournal, phase: 'ROLLED_BACK', rolledBackAt: new Date().toISOString(), error: String(error?.message || error) });
          restoreRequiresRecovery = false;
          clearRestoreJournal(dataDir);
        } catch (_) {}
        throw error;
      } finally {
        for (const item of plan) {
          try { fs.rmSync(item.tempPath, { force: true }); } catch (_) {}
          try {
            if (!repositories[item.namespace]) repositories[item.namespace] = createRepository(dataDir, item.namespace, () => maintenanceMode === true);
          } catch (_) {}
        }
        if (catalogPlan) {
          try { fs.rmSync(catalogPlan.tempPath, { force: true }); } catch (_) {}
        }
      }

      return {
        ok: true,
        result: {
          schema: 'memory-suite.restore.receipt.v1',
          backupId: backup.id,
          namespaces,
          restoredAt: new Date().toISOString(),
          preRestoreBackupId: preRestore.result.id,
          scopeCatalogRestored: catalogPlan !== null,
          stores: restored,
          migration: migrationAux ? { schema: migrationAux.schema, source: migrationAux.source || null, settingsApplied: true } : null
        }
      };
    } finally {
      // An incomplete rollback must not reopen writes or overwrite its journal.
      if (!restoreRequiresRecovery) {
        // Staging can fail before the install try/finally or journal exists.
        // Remove only copies successfully created by this invocation.
        for (const stagedPath of stagedRestoreFiles) cleanupRestoreArtifact(stagedPath);
        maintenanceMode = false;
      }
    }
  };

  const emptyScopeCatalog = () => ({ schema: 'memory-suite.scope-catalog.v1', updatedAt: 0, namespaces: {} });
  const scopeCatalogPreviousPath = path.join(dataDir, 'config', 'scope-catalog.previous.json');
  const readScopeCatalog = () => {
    const state = readScopeCatalogFromDisk(dataDir);
    scopeCatalogDegraded = state.degraded === true;
    return state.catalog;
  };
  const writeScopeCatalog = catalog => {
    assertLegacyAuthorityUnavailable({dataDir});
    const current = readJsonFile(scopeCatalogPath, null);
    if (validScopeCatalog(current)) atomicWrite(scopeCatalogPreviousPath, `${JSON.stringify(current, null, 2)}\n`);
    const next = { ...emptyScopeCatalog(), ...(catalog || {}), schema: 'memory-suite.scope-catalog.v1', updatedAt: now() };
    atomicWrite(scopeCatalogPath, `${JSON.stringify(next, null, 2)}\n`);
    scopeCatalogDegraded = false;
    return next;
  };
  const normalizeCatalogMember = (namespace, raw = {}) => {
    const space = validateSpace(raw.space || 'plugin');
    const key = validateKey(raw.key);
    assertNonSensitive(namespace, key);
    const current = repositories[namespace].get(space, key);
    return {
      space, key, sharedRecord: raw.sharedRecord === true,
      exists: current.exists === true, tombstone: current.tombstone === true,
      revision: Number(current.revision || 0), digest: String(current.digest || ''),
      updatedAt: Number(current.updatedAt || 0), valueBytes: Math.max(0, Number(raw.valueBytes || 0) || 0)
    };
  };
  const normalizeCatalogScope = (namespace, raw = {}) => {
    const scopeId = String(raw.scopeId || '').trim().slice(0, 320);
    if (!scopeId) throw Object.assign(new Error('scope_catalog_scope_id_required'), { statusCode: 400 });
    const descriptor = raw.descriptor && typeof raw.descriptor === 'object' && !Array.isArray(raw.descriptor) ? raw.descriptor : {};
    const baseClassification = String(raw.baseClassification || descriptor.baseClassification || 'unverified').trim();
    if (!['active', 'paired_recovery', 'orphan_candidate', 'unverified'].includes(baseClassification)) throw Object.assign(new Error(`invalid_scope_base_classification:${baseClassification}`), { statusCode: 400 });
    const members = (Array.isArray(raw.members) ? raw.members : []).map(item => normalizeCatalogMember(namespace, item));
    const seen = new Set();
    for (const member of members) {
      const id = `${member.space}\n${member.key}`;
      if (seen.has(id)) throw Object.assign(new Error(`scope_catalog_duplicate_member:${scopeId}:${member.key}`), { statusCode: 400 });
      seen.add(id);
    }
    const links = (Array.isArray(raw.links) ? raw.links : []).map(item => ({
      targetRef: String(item?.targetRef || '').trim().slice(0, 700),
      kind: String(item?.kind || 'reference').trim().slice(0, 120) || 'reference'
    })).filter(item => item.targetRef);
    const latestStoredAt = members.reduce((max, item) => Math.max(max, item.updatedAt), 0);
    const pairingSource = raw.recoveryPairing && typeof raw.recoveryPairing === 'object' && !Array.isArray(raw.recoveryPairing)
      ? raw.recoveryPairing
      : descriptor.recoveryPairing && typeof descriptor.recoveryPairing === 'object' && !Array.isArray(descriptor.recoveryPairing)
        ? descriptor.recoveryPairing : null;
    const recoveryPairing = pairingSource?.schema === 'memory-suite.scope-recovery-pairing.v1'
      ? {
        schema: 'memory-suite.scope-recovery-pairing.v1',
        targetCharacterId: String(pairingSource.targetCharacterId || '').trim().slice(0, 320),
        targetChatId: String(pairingSource.targetChatId || '').trim().slice(0, 320),
        targetPersonaId: String(pairingSource.targetPersonaId || '').trim().slice(0, 320),
        targetTitle: String(pairingSource.targetTitle || '').trim().slice(0, 300),
        targetTranscriptDigest: String(pairingSource.targetTranscriptDigest || '').trim().slice(0, 160),
        targetMessageCount: Math.max(0, Number(pairingSource.targetMessageCount || 0) || 0),
        sourceBaseClassification: ['active', 'orphan_candidate', 'unverified'].includes(pairingSource.sourceBaseClassification)
          ? pairingSource.sourceBaseClassification : 'unverified',
        evidence: (Array.isArray(pairingSource.evidence) ? pairingSource.evidence : []).map(item => String(item || '').trim().slice(0, 160)).filter(Boolean).slice(0, 12),
        inventoryFingerprint: String(pairingSource.inventoryFingerprint || '').trim().slice(0, 160),
        pairedAt: Math.max(0, Number(pairingSource.pairedAt || 0) || 0),
        pairedBy: String(pairingSource.pairedBy || '').trim().slice(0, 160),
        ownerVerifiedAt: Math.max(0, Number(pairingSource.ownerVerifiedAt || 0) || 0),
        ownerProofDigest: String(pairingSource.ownerProofDigest || '').trim().slice(0, 160),
        ownerModeAfter: String(pairingSource.ownerModeAfter || '').trim().slice(0, 80),
        ownerPluginVersion: String(pairingSource.ownerPluginVersion || '').trim().slice(0, 80),
        lastValidatedAt: Math.max(0, Number(pairingSource.lastValidatedAt || 0) || 0),
        validationState: String(pairingSource.validationState || '').trim().slice(0, 160)
      } : null;
    if (recoveryPairing && (!recoveryPairing.targetCharacterId || !recoveryPairing.targetChatId)) {
      throw Object.assign(new Error('scope_recovery_pairing_target_required'), { statusCode: 400 });
    }
    return {
      namespace, scopeId,
      scopeKey: String(raw.scopeKey || descriptor.scopeKey || '').trim().slice(0, 700),
      kind: String(raw.kind || descriptor.kind || 'unknown').trim().slice(0, 120) || 'unknown',
      characterId: String(raw.characterId || descriptor.characterId || '').trim().slice(0, 320),
      chatId: String(raw.chatId || descriptor.chatId || '').trim().slice(0, 320),
      personaId: String(raw.personaId || descriptor.personaId || '').trim().slice(0, 320),
      displayName: String(raw.displayName || descriptor.displayName || scopeId).trim().slice(0, 300),
      baseClassification,
      pinned: raw.pinned === true || descriptor.pinned === true,
      coverageComplete: raw.coverageComplete === true,
      inventoryObservedAt: Number(raw.inventoryObservedAt || descriptor.inventoryObservedAt || 0),
      descriptor: { ...descriptor, recoveryPairing },
      recoveryPairing,
      members,
      links,
      memberCount: members.length,
      liveRecords: members.filter(item => item.exists).length,
      tombstones: members.filter(item => item.tombstone).length,
      bytes: members.reduce((sum, item) => sum + item.valueBytes, 0),
      latestStoredAt,
      indexedAt: now()
    };
  };
  const replaceNamespaceScopeIndex = (namespace, scopes) => {
    assertLegacyAuthorityUnavailable({dataDir});
    const catalog = readScopeCatalog();
    const previous = new Map((Array.isArray(catalog.namespaces?.[namespace]) ? catalog.namespaces[namespace] : []).map(item => [item.scopeId, item]));
    const normalized = (Array.isArray(scopes) ? scopes : []).slice(0, 5000).map(item => {
      const pairingCleared = item?.recoveryPairingCleared === true || item?.descriptor?.recoveryPairingCleared === true;
      const row = normalizeCatalogScope(namespace, item);
      const old = previous.get(row.scopeId);
      const preserved = !pairingCleared && !row.recoveryPairing && old?.recoveryPairing
        ? { ...row, recoveryPairing: old.recoveryPairing, descriptor: { ...row.descriptor, recoveryPairing: old.recoveryPairing } }
        : row;
      return old?.pinned === true ? { ...preserved, pinned: true, pinnedAt: Number(old.pinnedAt || 0) } : preserved;
    });
    catalog.namespaces[namespace] = normalized;
    writeScopeCatalog(catalog);
    return { schema: 'memory-suite.scope-index.receipt.v1', namespace, indexed: normalized.length, members: normalized.reduce((sum, item) => sum + item.members.length, 0), links: normalized.reduce((sum, item) => sum + item.links.length, 0), updatedAt: now() };
  };
  const globalScopeCatalog = () => {
    const catalog = readScopeCatalog();
    const rows = NAMESPACES.flatMap(namespace => Array.isArray(catalog.namespaces?.[namespace]) ? catalog.namespaces[namespace] : []);
    const byRef = new Map();
    for (const row of rows) {
      byRef.set(`${row.namespace}:${row.scopeId}`, row);
      byRef.set(row.scopeId, byRef.get(row.scopeId) || row);
      if (row.scopeKey) {
        byRef.set(`${row.namespace}:scope-key:${row.scopeKey}`, row);
        byRef.set(row.scopeKey, byRef.get(row.scopeKey) || row);
      }
    }
    const inbound = new Map();
    for (const source of rows) {
      for (const link of source.links || []) {
        const target = byRef.get(link.targetRef) || byRef.get(`${source.namespace}:${link.targetRef}`) || null;
        if (!target) continue;
        const id = `${target.namespace}:${target.scopeId}`;
        const list = inbound.get(id) || [];
        list.push({ sourceNamespace: source.namespace, sourceScopeId: source.scopeId, sourceDisplayName: source.displayName, kind: link.kind, targetRef: link.targetRef });
        inbound.set(id, list);
      }
    }
    return rows.map(row => {
      const refs = inbound.get(`${row.namespace}:${row.scopeId}`) || [];
      const classification = refs.length && !['active', 'paired_recovery'].includes(row.baseClassification) ? 'referenced_ancestor' : row.baseClassification;
      return { ...row, classification, inboundReferences: refs, referenceCount: refs.length };
    }).sort((a, b) => Number(b.latestStoredAt || b.indexedAt || 0) - Number(a.latestStoredAt || a.indexedAt || 0));
  };
  const findCatalogScope = (namespace, scopeId) => globalScopeCatalog().find(item => item.namespace === namespace && item.scopeId === scopeId) || null;
  const removeCatalogScope = (namespace, scopeId) => {
    assertLegacyAuthorityUnavailable({dataDir});
    const catalog = readScopeCatalog();
    const rows = Array.isArray(catalog.namespaces?.[namespace]) ? catalog.namespaces[namespace] : [];
    catalog.namespaces[namespace] = rows.filter(item => item.scopeId !== scopeId);
    writeScopeCatalog(catalog);
  };
  const setCatalogScopePinned = (namespace, scopeId, pinned) => {
    assertLegacyAuthorityUnavailable({dataDir});
    const catalog = readScopeCatalog();
    const rows = Array.isArray(catalog.namespaces?.[namespace]) ? catalog.namespaces[namespace] : [];
    const index = rows.findIndex(item => item.scopeId === scopeId);
    if (index < 0) throw Object.assign(new Error('scope_pin_scope_not_indexed'), { statusCode: 404 });
    rows[index] = { ...rows[index], pinned: pinned === true, pinnedAt: pinned === true ? now() : 0 };
    catalog.namespaces[namespace] = rows;
    writeScopeCatalog(catalog);
    return {
      schema: 'memory-suite.scope-pin.receipt.v1',
      namespace,
      scopeId,
      pinned: pinned === true,
      updatedAt: now()
    };
  };
  const createDeletedScopeBackup = (namespace, scope, mutations) => {
    assertLegacyAuthorityUnavailable({dataDir});
    const createdAtMs = now();
    const stamp = new Date(createdAtMs).toISOString().replace(/[:.]/g, '-');
    const id = `${stamp}_${safeFilePart(namespace)}_${safeFilePart(scope.scopeId) || 'scope'}_${crypto.randomBytes(4).toString('hex')}`;
    const targetDir = path.join(backupDir, 'deleted-scopes', id);
    fs.mkdirSync(targetDir, { recursive: true });
    try {
      const targetPath = path.join(targetDir, `${namespace}.sqlite`);
      repositories[namespace].vacuumInto(targetPath);
      const checked = verifyBackupDatabase(targetPath);
      if (!checked.ok) throw new Error(`deleted_scope_backup_integrity_failed:${namespace}:${checked.result}`);
      const manifest = {
        schema: 'memory-suite.deleted-scope-backup.v1', id, namespace, scopeId: scope.scopeId,
        scopeKey: scope.scopeKey, displayName: scope.displayName, classification: scope.classification,
        createdAt: new Date(createdAtMs).toISOString(), createdAtMs, serverVersion: SERVER_VERSION,
        databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
        database: { file: `${namespace}.sqlite`, sha256: sha256File(targetPath), bytes: fs.statSync(targetPath).size, records: checked.records },
        mutationSummary: mutations.map(item => ({ kind: item.kind, space: item.space, key: item.key, expectedRevision: item.expectedRevision, expectedDigest: item.expectedDigest }))
      };
      atomicWrite(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      return { ...manifest, path: targetDir };
    } catch (error) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
      throw error;
    }
  };
  const scopeDeleteStateDir = path.join(dataDir,'migrations','scope-delete-jobs');
  if (!authorityRuntime) fs.mkdirSync(scopeDeleteStateDir,{recursive:true});
  const deletionStatePath = id => {
    if(!/^[a-zA-Z0-9_-]{8,160}$/.test(String(id||'')))throw Object.assign(new Error('invalid_scope_delete_job_id'),{statusCode:400});
    return path.join(scopeDeleteStateDir,id+'.json');
  };
  const namespaceContentFingerprint = namespace => sha256Text(JSON.stringify(repositories[namespace].database.prepare('SELECT space,key,revision,digest,deleted FROM kv ORDER BY space,key').all()));
  const deletionGeneration = namespace => sha256Text(JSON.stringify({epoch:namespaceReset.epochs()[namespace]||0,restore:readJsonFile(path.join(dataDir,'migrations','scope-delete-generation.json'),null)}));
  const saveDeletePlan = plan => { assertLegacyAuthorityUnavailable({dataDir}); return atomicWrite(deletionStatePath(plan.planId),JSON.stringify(plan)); };
  const loadDeletePlan = id => managerPlans.get(id)||readJsonFile(deletionStatePath(id),null);
  const prepareJobBackup = (jobId, namespace, scope, mutations) => {
    assertLegacyAuthorityUnavailable({dataDir});
    if(!jobId)return createDeletedScopeBackup(namespace,scope,mutations);
    const file=deletionStatePath(jobId);
    const job=readJsonFile(file,null)||{id:jobId,namespaces:{}};
    const register=backup=>{const manifestFile=path.join(backup.path,'manifest.json');const manifest=readJsonFile(manifestFile,null);if(!manifest)throw new Error('scope_delete_backup_manifest_missing');const targets=Array.isArray(manifest.jobTargets)?manifest.jobTargets:[];if(!targets.some(row=>row.scopeId===scope.scopeId))targets.push({scopeId:scope.scopeId,scopeKey:scope.scopeKey,displayName:scope.displayName});atomicWrite(manifestFile,JSON.stringify({...manifest,jobId,jobTargets:targets}));return backup;};
    const prior=job.namespaces[namespace];
    const fingerprint=namespaceContentFingerprint(namespace), generation=deletionGeneration(namespace);
    if(prior && prior.generation!==generation)throw Object.assign(new Error('scope_delete_job_generation_changed'),{statusCode:409});
    if(prior && prior.fingerprint===fingerprint && fs.existsSync(path.join(prior.backup.path,namespace+'.sqlite')) && sha256File(path.join(prior.backup.path,namespace+'.sqlite'))===prior.backup.database.sha256)return register(prior.backup);
    const backup=createDeletedScopeBackup(namespace,scope,mutations);
    job.namespaces[namespace]={generation,fingerprint,backup};
    atomicWrite(file,JSON.stringify(job));return register(backup);
  };
  const advanceDeleteJob = (plan, covered) => {
    assertLegacyAuthorityUnavailable({dataDir});
    if(!plan.jobId)return;
    const file=deletionStatePath(plan.jobId),job=readJsonFile(file,null);
    if(job?.namespaces?.[plan.namespace]){job.namespaces[plan.namespace].fingerprint=covered?namespaceContentFingerprint(plan.namespace):'changed_outside_job';atomicWrite(file,JSON.stringify(job));}
  };
  const pruneManagerPlans = () => {
    const timestamp = now();
    for (const [id, plan] of managerPlans.entries()) if (Number(plan.expiresAt || 0) <= timestamp) managerPlans.delete(id);
  };
  const createScopeDeletePlan = body => {
    assertLegacyAuthorityUnavailable({dataDir});
    pruneManagerPlans();
    readScopeCatalog();
    if (scopeCatalogDegraded) throw Object.assign(new Error('scope_catalog_degraded_delete_blocked'), { statusCode: 409 });
    const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const namespace = validateNamespace(source.namespace);
    const scopeId = String(source.scopeId || '').trim().slice(0, 320);
    if (!scopeId) throw Object.assign(new Error('scope_delete_scope_id_required'), { statusCode: 400 });
    const scope = findCatalogScope(namespace, scopeId);
    if (!scope) throw Object.assign(new Error('scope_delete_scope_not_indexed'), { statusCode: 404 });
    if (scope.pinned === true) throw Object.assign(new Error('scope_delete_pinned_scope_blocked'), { statusCode: 409 });
    if (scope.referenceCount > 0 || scope.classification === 'referenced_ancestor') throw Object.assign(new Error(`scope_delete_referenced_ancestor:${scope.referenceCount}`), { statusCode: 409 });
    if (scope.classification === 'unverified') throw Object.assign(new Error('scope_delete_unverified_scope_blocked'), { statusCode: 409 });
    if (!['active', 'orphan_candidate'].includes(scope.classification)) throw Object.assign(new Error(`scope_delete_classification_blocked:${scope.classification}`), { statusCode: 409 });
    if (scope.coverageComplete !== true) throw Object.assign(new Error('scope_delete_scope_coverage_incomplete'), { statusCode: 409 });
    const modeProof = source.modeProof && typeof source.modeProof === 'object' ? source.modeProof : {};
    if (modeProof.verified !== true
      || String(modeProof.modeAfter || '') !== 'plugin_only'
      || String(modeProof.namespace || '') !== namespace
      || (modeProof.scopeId && String(modeProof.scopeId) !== scopeId)) {
      throw Object.assign(new Error('scope_delete_plugin_only_mode_proof_required'), { statusCode: 409 });
    }
    const inventoryProof = source.inventoryProof && typeof source.inventoryProof === 'object' ? source.inventoryProof : {};
    if (scope.classification === 'orphan_candidate' && (inventoryProof.hostInventoryStable !== true || inventoryProof.complete !== true)) {
      throw Object.assign(new Error('scope_delete_stable_host_inventory_proof_required'), { statusCode: 409 });
    }
    const mutations = Array.isArray(source.mutations) ? source.mutations : [];
    if (!mutations.length) throw Object.assign(new Error('scope_delete_mutations_required'), { statusCode: 400 });
    if (mutations.length > MANAGER_MAX_MUTATIONS) throw Object.assign(new Error('scope_delete_mutation_limit_exceeded'), { statusCode: 400 });
    const memberSet = new Set(scope.members.map(item => `${item.space}\n${item.key}`));
    for (const mutation of mutations) if (!memberSet.has(`${String(mutation?.space || 'plugin')}\n${String(mutation?.key || '')}`)) throw Object.assign(new Error(`scope_delete_mutation_not_indexed_member:${mutation?.key || ''}`), { statusCode: 409 });
    const mutationByMember = new Map(mutations.map(item => [`${String(item?.space || 'plugin')}\n${String(item?.key || '')}`, item]));
    const liveShared = scope.members.filter(item => item.sharedRecord === true && item.exists === true);
    const missingShared = liveShared.filter(item => !mutationByMember.has(`${item.space}\n${item.key}`));
    if (missingShared.length) throw Object.assign(new Error(`scope_delete_shared_members_missing_owner_rewrite:${missingShared.length}`), { statusCode: 409 });
    const unsafeShared = liveShared.filter(item => String(mutationByMember.get(`${item.space}\n${item.key}`)?.kind || '') !== 'set');
    if (unsafeShared.length) throw Object.assign(new Error(`scope_delete_shared_members_require_set_rewrite:${unsafeShared.length}`), { statusCode: 409 });
    const unchangedShared = liveShared.filter(item => {
      const mutation = mutationByMember.get(`${item.space}\n${item.key}`);
      if (!mutation || mutation.kind !== 'set') return false;
      const current = repositories[namespace].get(item.space, item.key);
      return current.exists === true && sha256Text(JSON.stringify(mutation.value)) === current.digest;
    });
    if (unchangedShared.length) throw Object.assign(new Error(`scope_delete_shared_rewrite_made_no_change:${unchangedShared.length}`), { statusCode: 409 });
    const liveUnique = scope.members.filter(item => item.sharedRecord !== true && item.exists === true);
    const missingUnique = liveUnique.filter(item => !mutationByMember.has(`${item.space}\n${item.key}`));
    if (missingUnique.length) throw Object.assign(new Error(`scope_delete_unique_members_missing:${missingUnique.length}`), { statusCode: 409 });
    const unsafeUnique = liveUnique.filter(item => !['remove', 'purge'].includes(String(mutationByMember.get(`${item.space}\n${item.key}`)?.kind || '')));
    if (unsafeUnique.length) throw Object.assign(new Error(`scope_delete_unique_members_require_delete:${unsafeUnique.length}`), { statusCode: 409 });
    const repository = repositories[namespace];
    const integrity = repository.integrity();
    if (!integrity.ok) throw Object.assign(new Error(`scope_delete_integrity_failed:${integrity.result}`), { statusCode: 409 });
    const prepared = repository.verifyConditionalBatch(mutations);
    const backup = prepareJobBackup(source.jobId || '', namespace, scope, prepared.mutations);
    const createdAt = now();
    const planId = `scope-delete-${crypto.randomBytes(18).toString('base64url')}`;
    const mutationFingerprint = sha256Text(JSON.stringify(prepared.mutations.map(item => ({ kind: item.kind, space: item.space, key: item.key, expectedRevision: item.expectedRevision, expectedDigest: item.expectedDigest, expectedExists: item.expectedExists, expectedTombstone: item.expectedTombstone, valueDigest: item.kind === 'set' ? sha256Text(item.valueJson) : '' }))));
    const plan = { schema: 'memory-suite.scope-delete-plan.v1', planId, createdAt, expiresAt: createdAt + MANAGER_PLAN_TTL_MS, namespace, scopeId, scopeKey: scope.scopeKey, displayName: scope.displayName, classification: scope.classification, modeProof, inventoryProof, metadata: source.metadata || {}, mutations: prepared.mutations, mutationFingerprint, backupId: backup.id, backupPath: backup.path, counts: { total: mutations.length, purge: mutations.filter(item => item.kind === 'purge').length, rewrite: mutations.filter(item => item.kind === 'set').length, tombstone: mutations.filter(item => item.kind === 'remove').length } };
    plan.backupFingerprint = namespaceContentFingerprint(namespace);
    plan.jobId = source.jobId || '';
    plan.generation = deletionGeneration(namespace);
    managerPlans.set(planId, plan);
    saveDeletePlan(plan);
    return { ok: true, result: { ...plan, mutations: undefined, backupPath: undefined, conditionsVerified: true, databaseIntegrity: integrity } };
  };
  const executeScopeDeletePlan = body => {
    assertLegacyAuthorityUnavailable({dataDir});
    pruneManagerPlans();
    const planId = String(body?.planId || '').trim();
    const plan = loadDeletePlan(planId);
    if (!plan) throw Object.assign(new Error('scope_delete_plan_not_found_or_expired'), { statusCode: 404 });
    if (!safeEqual(String(body?.mutationFingerprint || ''), plan.mutationFingerprint)) throw Object.assign(new Error('scope_delete_plan_fingerprint_mismatch'), { statusCode: 409 });
    if(plan.generation && plan.generation!==deletionGeneration(plan.namespace))throw Object.assign(new Error('scope_delete_generation_changed'),{statusCode:409});
    if(body.statusOnly===true){const committed=!!plan.receipt||!!repositories[plan.namespace].database.prepare('SELECT operation_id FROM operations WHERE operation_id=?').get(planId);return {ok:true,result:{planId,state:committed?'committed':now()>=plan.expiresAt?'expired':'prepared'}};}
    if(plan.receipt)return {ok:true,result:plan.receipt};
    const priorCommit=repositories[plan.namespace].database.prepare('SELECT response_json FROM operations WHERE operation_id=?').get(planId);
    if(priorCommit){
      // A response or catalog write may have been lost after the atomic DB commit.
      // Do not replay mutations or remove a newly recreated scope.
      const current=findCatalogScope(plan.namespace,plan.scopeId);
      const unchanged=(!current || (!current.pinned && !current.referenceCount && current.members.every(m=>plan.mutations.some(p=>p.space===m.space && p.key===m.key)))) && plan.mutations.every(m=>{const row=repositories[plan.namespace].get(m.space,m.key);return m.kind==='purge'?!row.exists&&!row.tombstone:m.kind==='remove'?row.tombstone && row.revision===Number(m.expectedRevision)+1:m.kind==='set'?row.revision===Number(m.expectedRevision)+1 && row.digest===sha256Text(JSON.stringify(m.value)):true;});
      if(current && unchanged)removeCatalogScope(plan.namespace,plan.scopeId);
      const receipt={schema:'memory-suite.scope-delete-receipt.v1',planId,namespace:plan.namespace,scopeId:plan.scopeId,backupId:plan.backupId,counts:plan.counts,recovered:true,catalogChanged:!!current&&!unchanged,receipts:JSON.parse(priorCommit.response_json).receipts};
      plan.receipt=receipt;saveDeletePlan(plan);return {ok:true,result:receipt};
    }
    if(now()>=plan.expiresAt)throw Object.assign(new Error('scope_delete_plan_expired'),{statusCode:409});
    const latest = findCatalogScope(plan.namespace, plan.scopeId);
    if (!latest) throw Object.assign(new Error('scope_delete_scope_missing_after_confirmation'), { statusCode: 409 });
    if (latest.pinned === true) throw Object.assign(new Error('scope_delete_scope_pinned_after_confirmation'), { statusCode: 409 });
    if (latest.referenceCount > 0 || latest.classification === 'referenced_ancestor') throw Object.assign(new Error('scope_delete_reference_changed_after_confirmation'), { statusCode: 409 });
    if (latest.classification !== plan.classification || latest.coverageComplete !== true) throw Object.assign(new Error('scope_delete_classification_or_coverage_changed'), { statusCode: 409 });
    const plannedByMember = new Map(plan.mutations.map(item => [`${item.space}\n${item.key}`, item]));
    const latestShared = latest.members.filter(item => item.sharedRecord === true && item.exists === true);
    if (latestShared.some(item => String(plannedByMember.get(`${item.space}\n${item.key}`)?.kind || '') !== 'set')) {
      throw Object.assign(new Error('scope_delete_shared_members_changed_after_confirmation'), { statusCode: 409 });
    }
    const latestUnique = latest.members.filter(item => item.sharedRecord !== true && item.exists === true);
    if (latestUnique.some(item => !['remove', 'purge'].includes(String(plannedByMember.get(`${item.space}\n${item.key}`)?.kind || '')))) {
      throw Object.assign(new Error('scope_delete_unique_members_changed_after_confirmation'), { statusCode: 409 });
    }
    const repository = repositories[plan.namespace];
    const integrityBefore = repository.integrity();
    if (!integrityBefore.ok) throw Object.assign(new Error(`scope_delete_integrity_failed:${integrityBefore.result}`), { statusCode: 409 });
    const backupCovered = !plan.backupFingerprint || plan.backupFingerprint===namespaceContentFingerprint(plan.namespace);
    const batch = repository.applyConditionalBatch(plan.mutations, { maintenance: true, operationId: planId });
    const integrityAfter = repository.integrity();
    if (!integrityAfter.ok) throw new Error(`scope_delete_post_integrity_failed:${integrityAfter.result}`);
    removeCatalogScope(plan.namespace, plan.scopeId);
    advanceDeleteJob(plan, backupCovered);
    managerPlans.delete(planId);
    scheduleChangeSettledBackup();
    const receipt = { schema: 'memory-suite.scope-delete-receipt.v1', planId, namespace: plan.namespace, scopeId: plan.scopeId, scopeKey: plan.scopeKey, displayName: plan.displayName, classification: plan.classification, mutationFingerprint: plan.mutationFingerprint, backupId: plan.backupId, deletedAt: new Date().toISOString(), deletedAtMs: now(), counts: plan.counts, receipts: batch.receipts, integrityBefore, integrityAfter, modeProof: plan.modeProof, inventoryProof: plan.inventoryProof, metadata: plan.metadata };
    plan.receipt=receipt;saveDeletePlan(plan);
    const receiptName = `scope-delete-${new Date().toISOString().replace(/[:.]/g, '-')}-${safeFilePart(plan.namespace)}-${safeFilePart(plan.scopeId)}.json`;
    atomicWrite(path.join(dataDir, 'migrations', receiptName), `${JSON.stringify(receipt, null, 2)}\n`);
    try { atomicWrite(path.join(plan.backupPath, plan.jobId ? plan.planId + '.receipt.json' : 'deletion-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`); } catch (_) {}
    return { ok: true, result: receipt };
  };

  const scheduleChangeSettledBackup = () => {
    dirtySinceBackup = true;
    if (!autoBackup) return;
    if (changeSettledBackupTimer) clearTimeout(changeSettledBackupTimer);
    changeSettledBackupTimer = setTimeout(() => {
      changeSettledBackupTimer = null;
      if (!dirtySinceBackup || maintenanceMode) return;
      maybeCreateAutomaticBackup('change-settled').then(result => {
        if (result?.skipped && result.reason === 'cooldown' && Number(result.retryAfterMs || 0) > 0) {
          changeSettledBackupTimer = setTimeout(() => {
            changeSettledBackupTimer = null;
            maybeCreateAutomaticBackup('change-settled-deferred').catch(error => {
              process.stderr.write(`[LIBRARIAN SYSTEM] Deferred change-settled backup failed: ${String(error?.stack || error)}\n`);
            });
          }, Math.max(1000, Number(result.retryAfterMs || 0)));
          changeSettledBackupTimer.unref?.();
        }
      }).catch(error => {
        process.stderr.write(`[LIBRARIAN SYSTEM] Change-settled backup failed: ${String(error?.stack || error)}\n`);
      });
    }, changeSettledBackupDelayMs);
    changeSettledBackupTimer.unref?.();
  };

  const requestOperationForRoute = (method, pathname) => {
    const route = String(pathname || '');
    if (route === '/bootstrap') return 'server.bootstrap';
    if (route === '/health') return 'server.health';
    if (route === '/v1/kv/get') return 'kv.get';
    if (route === '/v1/kv/keys') return 'kv.keys';
    if (route === '/v1/kv/get-many') return 'kv.get_many';
    if (route === '/v1/kv/set') return 'kv.set';
    if (route === '/v1/kv/remove') return 'kv.remove';
    if (route === '/v1/kv/batch') return 'kv.conditional_batch';
    if (route === '/v1/integrity') return 'namespace.integrity';
    if (route.startsWith('/v1/operations/')) return 'operation.get';
    if (route.startsWith('/v1/compute/')) return 'compute.retired';
    if (route.startsWith('/v1/manager/')) return `manager.${route.split('/').slice(3).join('.') || 'request'}`;
    if (route.startsWith('/v1/admin/')) return `admin.${route.split('/').slice(3).join('.') || 'request'}`;
    if (route === '/v1/shutdown') return 'server.shutdown';
    return `${String(method || 'request').toLowerCase()}.request`;
  };

  const buildRequestDiagnostic = (request, response, url, started) => {
    const body = request.__memorySuiteParsedBody && typeof request.__memorySuiteParsedBody === 'object' ? request.__memorySuiteParsedBody : {};
    const payload = request.__memorySuiteResponsePayload && typeof request.__memorySuiteResponsePayload === 'object' ? request.__memorySuiteResponsePayload : {};
    const route = String(url?.pathname || request.url || '');
    let namespace = String(body.namespace || url?.searchParams?.get('namespace') || '').trim().toLowerCase();
    if (!namespace && route.startsWith('/v1/operations/')) {
      try { namespace = decodeURIComponent(route.slice('/v1/operations/'.length).split('/')[0] || '').toLowerCase(); } catch (_) {}
    }
    if (!NAMESPACES.includes(namespace)) namespace = namespaceForPluginId(request.headers['x-memory-suite-plugin']);
    const key = String(body.key || url?.searchParams?.get('key') || '');
    const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
    const receipt = result?.result && typeof result.result === 'object' ? result.result : result;
    let valueBytes = 0;
    if (Object.prototype.hasOwnProperty.call(body, 'value')) {
      try { valueBytes = Buffer.byteLength(JSON.stringify(body.value)); } catch (_) {}
    }
    let itemCount = Array.isArray(body.keys) ? body.keys.length : 0;
    if (!itemCount && Array.isArray(result.keys)) itemCount = result.keys.length;
    if (!itemCount && Array.isArray(result.records)) itemCount = result.records.length;
    const statusCode = Math.max(0, Number(response.statusCode || 0) || 0);
    return {
      event: requestOperationForRoute(request.method, route),
      operation: requestOperationForRoute(request.method, route),
      method: request.method || '',
      route,
      namespace,
      space: String(body.space || url?.searchParams?.get('space') || ''),
      storageMode: String(request.headers['x-memory-suite-storage-mode'] || ''),
      scopeId: decodeDiagnosticHeader(request.headers['x-memory-suite-scope-id']),
      key,
      operationId: String(body.operationId || ''),
      plugin: String(request.headers['x-memory-suite-plugin'] || ''),
      pluginVersion: String(request.headers['x-memory-suite-plugin-version'] || ''),
      statusCode,
      ok: statusCode >= 200 && statusCode < 400 && payload?.ok !== false,
      durationMs: now() - started,
      requestBytes: Math.max(0, Number(request.__memorySuiteBodyBytes || request.headers['content-length'] || 0) || 0),
      responseBytes: Math.max(0, Number(request.__memorySuiteResponseBytes || response.getHeader?.('Content-Length') || 0) || 0),
      valueBytes,
      itemCount,
      revision: Math.max(0, Number(receipt?.revision || 0) || 0),
      digestPrefix: String(receipt?.digest || '').slice(0, 16),
      tombstone: receipt?.tombstone === true,
      errorCode: String(payload?.code || ''),
      error: payload?.ok === false ? String(payload?.error || '') : '',
      message: payload?.ok === false ? '' : String(receipt?.reason || '')
    };
  };

  const namespaceReset = authorityRuntime ? authorityRuntime.namespaceState : require('./core/namespace-reset.cjs')({
    dataDir, dataInstanceId, dataIdentityContract, repositories,
    backup:()=>createBackup('manual','before-reset',{allowDuringMaintenance:true}),
    canStart:()=>!maintenanceMode,
    setMaintenance:value=>{maintenanceMode=value;},
    clearCatalog:namespaces=>{
      const catalog=readScopeCatalog();
      for(const namespace of namespaces) delete catalog.namespaces[namespace];
      const saved=writeScopeCatalog(catalog);
      // The fallback must not resurrect entries belonging to a reset namespace.
      atomicWrite(scopeCatalogPreviousPath, `${JSON.stringify(saved, null, 2)}\n`);
    }
  });
  const gradiaReaders = Object.fromEntries(Object.entries(gradiaOwnerReadSessions).map(([owner,adapter]) => [owner,adapter.createReadSession({
    getRepository: () => repositories[owner], dataInstanceId, epochs: () => namespaceReset.epochs(),
    canRead: () => !maintenanceMode && !namespaceReset.active()
  })]));
  const managerControl=authorityRuntime ? Object.freeze({handle:async()=>authorityRuntime.unavailable()}) : require('./core/manager-control.cjs')({
    dataDir,canStart:()=>!maintenanceMode&&!namespaceReset.active(),
    status:()=>({checkedAt:now(),version:SERVER_VERSION,dataInstanceId,dataPath:dataDir,uptimeMs:now()-startedAt,maintenanceMode,clients:Array.from(clients.values()),lastBackup:listBackups()[0]?.createdAt||null,stores:integrityAll(),resetEpochs:namespaceReset.epochs(),legacyNamespaces:NAMESPACES,supportedStorageOwners:SUPPORTED_STORAGE_OWNERS,backupCoverage:listBackups()[0]?.coverage||{legacyOwners:[]}}),
    listBackups,createBackup:()=>createBackup('manual','RETRACE'),scrubBackups,
    planRestore:(backupId,namespaces)=>planOfflineRestore({dataDir,backupDir,backupId,namespaces,mode:'online'}),
    restore:restoreBackup,
    advanceEpochs:namespaces=>namespaceReset.advanceEpochs(namespaces),
    fingerprint:namespaces=>JSON.stringify({dataInstanceId,epochs:namespaceReset.epochs(),stores:namespaces.map(ns=>[ns,namespaceContentFingerprint(ns)]),catalog:namespaces.map(ns=>[ns,readScopeCatalogFromDisk(dataDir).catalog?.namespaces?.[ns]||[]])}),
    extraHistory:()=>{
      const rows=listBackups().map(b=>({id:'backup-'+b.id,action:'backup-create',status:'complete',finishedAt:Date.parse(b.createdAt)||0,backupId:b.id,namespaces:Object.keys(b.stores||{})}));const migrationDir=path.join(dataDir,'migrations');
      for(const name of fs.readdirSync(migrationDir).filter(n=>/^(scope-delete-|recovery-restore-|restore-crash-recovery-).*\.json$/.test(n)).sort().slice(-100)){
        const value=readJsonFile(path.join(migrationDir,name),null);if(value&&(value.planId||value.backupId))rows.push({id:value.planId||name,action:name.startsWith('scope-delete-')?'scope-delete':'restore',status:'complete',finishedAt:value.deletedAtMs||Date.parse(value.restoredAt||value.createdAt||'')||0,backupId:value.backupId,namespaces:value.namespaces||(value.namespace?[value.namespace]:[])});
      }
      const resetState=readJsonFile(path.join(dataDir,'config','namespace-reset.json'),null);
      for(const reset of resetState?.history||(resetState?.last?[resetState.last]:[]))rows.push({id:reset.id,action:'reset',status:'complete',finishedAt:reset.finishedAt,namespaces:reset.namespaces,backupId:reset.backupId});
      return rows;
    }
  });
  const portableTransfers = authorityRuntime ? Object.freeze({handle:async()=>authorityRuntime.unavailable(),close:async()=>{}}) : require('./portable/transfer_manager.cjs')({
    dataDir, dataInstanceId, namespaces:NAMESPACES, databaseSchemaVersion:DATABASE_SCHEMA_VERSION,
    serverVersion:SERVER_VERSION, protocol:{major:PROTOCOL_MAJOR,minor:PROTOCOL_MINOR},
    createBackup:()=>createBackup('manual','RETRACE-full-server-export'), listBackups, managerControl,
    canStart:()=>!maintenanceMode&&!namespaceReset.active(),
    targetState:()=>{
      const counts=NAMESPACES.map(ns=>repositories[ns].database.prepare('SELECT COUNT(*) AS records, COALESCE(SUM(deleted),0) AS tombstones FROM kv').get());
      const records=counts.reduce((n,r)=>n+Number(r.records),0),tombstones=counts.reduce((n,r)=>n+Number(r.tombstones),0);
      const catalog=readScopeCatalogFromDisk(dataDir).catalog;
      return {records,tombstones,hasExistingData:records>0||NAMESPACES.some(ns=>catalog?.namespaces?.[ns]?.length>0)};
    }
  });
  const server = http.createServer(async (request, response) => {
    request.__memorySuiteDataInstanceId=dataInstanceId;
    const requestStartedAt = now();
    let parsedUrl = null;
    try { parsedUrl = new URL(request.url || '/', loopbackUrl(host, port || DEFAULT_PORT)); } catch (_) {}
    const requestPath = String(parsedUrl?.pathname || request.url || '');
    const suppressDiagnostic = request.method === 'OPTIONS'
      || requestPath === '/health'
      || requestPath === '/v1/diagnostics'
      || requestPath === '/v1/manager/diagnostics';
    response.once('finish', () => {
      if (suppressDiagnostic) return;
      try { diagnosticJournal.record(buildRequestDiagnostic(request, response, parsedUrl, requestStartedAt)); } catch (_) {}
    });
    try {
      const url = parsedUrl || new URL(request.url || '/', loopbackUrl(host, port || DEFAULT_PORT));
      if (authorityRuntime) authorityRuntime.assertRoute(request.method,url.pathname);
      if (request.method === 'OPTIONS') return sendJson(request, response, 204, {});
      const boundDataInstance=String(request.headers['x-memory-suite-data-instance']||'');
      if(boundDataInstance&&boundDataInstance!==dataInstanceId)return sendJson(request,response,409,{ok:false,error:'data_instance_binding_changed'});
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(request, response, 200, {
          ok: true,
          name: SERVER_NAME,
          version: SERVER_VERSION,
          dataInstanceId,
          dataIdentityContract,
          protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
          databaseSchemaVersion: authorityRuntime ? authorityContracts.OWNER_SCHEMA_VERSION : DATABASE_SCHEMA_VERSION,
          dataLayoutSchemaVersion: DATA_LAYOUT_VERSION,
          programDataSeparation: true,
          startedAt,
          uptimeMs: now() - startedAt,
          maintenanceMode,
          namespaces: NAMESPACES,
          legacyNamespaces:NAMESPACES,
          supportedStorageOwners:authorityRuntime ? ACTIVE_STORAGE_NAMESPACES : SUPPORTED_STORAGE_OWNERS,
          ...(authorityRuntime ? {authorityRuntime:authorityRuntime.status()} : {}),
          storageModeContract:authorityRuntime ? null : {schema:'memory-suite.storage-mode-contract.v2', operationalModes:['plugin_only','server_only'], transitionPhase:'mirror', mirrorSelectable:false, legacyMirrorReadable:true},
          securityGate: 'loopback_scoped_capability_token',
          dirtySinceBackup,
          lastSuccessfulAutoBackupAt,
          autoBackupPolicy: { intervalMs: autoBackupIntervalMs, minCooldownMs: autoBackupMinCooldownMs, recentKeep: AUTO_BACKUP_RECENT_KEEP, dailyKeep: AUTO_BACKUP_DAILY_KEEP, weeklyKeep: AUTO_BACKUP_WEEKLY_KEEP },
          compute: { retired: true, enabled: false, configured: false, ready: false },
          scopeCatalogDegraded,
          interruptedRestoreRecovery
        });
      }
      if (request.method === 'GET' && url.pathname === '/bootstrap') {
        let requestedReadOwners;
        if (String(request.headers['x-memory-suite-plugin'] || '').trim().toLowerCase() === gradiaReadSession.PLUGIN_ID
            && request.headers['x-memory-suite-read-owners'] !== undefined) {
          try { requestedReadOwners = JSON.parse(request.headers['x-memory-suite-read-owners']); }
          catch (_) { return sendJson(request,response,403,{ok:false,error:'gradia_read_owners_invalid'}); }
        }
        const bootstrapPrincipal = principalForPluginId(request.headers['x-memory-suite-plugin'], requestedReadOwners);
        if (!bootstrapPrincipal) {
          return sendJson(request, response, 403, { ok: false, error: 'bootstrap_official_plugin_id_required' });
        }
        if (authorityRuntime && bootstrapPrincipal.pluginId === gradiaReadSession.PLUGIN_ID) authorityRuntime.unavailable();
        rememberClient(request, bootstrapPrincipal);
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        const actualHost = typeof address === 'object' && address && address.address
          ? (address.address === '::' ? '::1' : address.address)
          : host;
        return sendJson(request, response, 200, {
          ok: true,
          schema: 'memory-suite.storage.bootstrap.v1',
          dataInstanceId,
          dataIdentityContract,
          resetEpochs: namespaceReset.epochs(),
          name: SERVER_NAME,
          version: SERVER_VERSION,
          protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
          databaseSchemaVersion: authorityRuntime ? authorityContracts.OWNER_SCHEMA_VERSION : DATABASE_SCHEMA_VERSION,
          dataLayoutSchemaVersion: DATA_LAYOUT_VERSION,
          programDataSeparation: true,
          securityGate: 'loopback_scoped_capability_token',
          url: loopbackUrl(actualHost, actualPort),
          token: issueCapabilityToken(token, bootstrapPrincipal),
          authorization: {
            schema: 'memory-suite.bootstrap-authorization.v1',
            pluginId: bootstrapPrincipal.pluginId,
            namespace: bootstrapPrincipal.namespace,
            roles: bootstrapPrincipal.roles,
            readNamespaces: bootstrapPrincipal.readNamespaces,
            writeNamespaces: bootstrapPrincipal.writeNamespaces
          },
          namespaces: NAMESPACES,
          ...(authorityRuntime ? {authorityRuntime:authorityRuntime.status()} : {}),
          capabilities: Object.fromEntries((authorityRuntime ? authorityRuntime.capabilities : [
            'storage-mode-contract.v2',
            'data-instance-binding.v1',
            'flashback-scope-health.v1',
            'libra-read-session.v1',
            'gradia-memory-read-session.v1',
            'flashback-physical-repair-protocol.v2',
            ...REQUIRED_CAPABILITIES
          ]).map(capability => [capability, true])),
          storageModeContract: authorityRuntime ? null : {schema:'memory-suite.storage-mode-contract.v2', operationalModes:['plugin_only','server_only'], transitionPhase:'mirror', mirrorSelectable:false, legacyMirrorReadable:true}
        });
      }
      if (url.pathname.startsWith('/v1/compute/')) {
        // Server Compute is retired. Older plugins (Compute SDK <= 0.3.8) open their circuit
        // on this answer and compute locally; GRADIA keeps its read-only refusal.
        const claimed = principalForPluginId(request.headers['x-memory-suite-plugin']);
        if (claimed?.pluginId === gradiaReadSession.PLUGIN_ID) return sendJson(request, response, 403, { ok: false, error: 'gradia_readonly_route_forbidden' });
        request.resume();
        return sendJson(request, response, 410, { ok: false, error: 'compute_retired', code: 'COMPUTE_RETIRED', schema: 'memory-suite.compute.retired.v1' });
      }
      const principal = authenticate(request);
      if (!principal) return sendJson(request, response, 403, { ok: false, error: 'forbidden' });
      if (authorityHandler && url.pathname.startsWith('/v1/authority/')) {
        const body = await readBody(request, 32768, 'authority_request_too_large');
        return sendJson(request,response,200,{ok:true,result:authorityHandler(request,url.pathname,body)});
      }
      // This guard must precede manager/reset/portable handlers, which may
      // mutate DATA before the ordinary maintenance guard further below.
      // The candidate updater only needs readback integrity and clean shutdown.
      if (updaterVerificationMode && !(isAdminRequest(principal)
          && request.method === 'POST'
          && ['/v1/admin/integrity', '/v1/shutdown'].includes(url.pathname))) {
        return sendJson(request, response, 503, { ok: false, error: 'server_maintenance_in_progress' });
      }
      const gradiaRouteOwner = Object.keys(gradiaOwnerReadSessions).find(owner => {
        const adapter = gradiaOwnerReadSessions[owner]; return [adapter.CAPTURE_ROUTE,adapter.CURRENT_ROUTE].includes(url.pathname);
      });
      const gradiaRoute = !!gradiaRouteOwner;
      const gradiaPrincipal = principal.pluginId === gradiaReadSession.PLUGIN_ID;
      if ((gradiaPrincipal && (!gradiaRoute || request.method !== 'POST' || !principal.readNamespaces.includes(gradiaRouteOwner))) || (gradiaRoute && !gradiaPrincipal)) {
        return sendJson(request, response, 403, { ok: false, error: 'gradia_readonly_route_forbidden' });
      }
      rememberClient(request, principal);
      if(url.pathname.startsWith('/v1/manager/portable/')){
        if(!isManagerRequest(principal))return sendJson(request,response,403,{ok:false,error:'retrace_manager_capability_required'});
        if(request.method!=='POST')return sendJson(request,response,405,{ok:false,error:'method_not_allowed'});
        const action=url.pathname.slice('/v1/manager/portable/'.length);
        const body=await readBody(request,384*1024,'portable_chunk_body_too_large');
        const result=await portableTransfers.handle(principal,action,body);
        return sendJson(request,response,200,{ok:true,result});
      }
      if(url.pathname.startsWith('/v1/manager/control/')){
        if(!isManagerRequest(principal))return sendJson(request,response,403,{ok:false,error:'retrace_manager_capability_required'});
        const action=url.pathname.slice('/v1/manager/control/'.length);
        const readOnly=['status','backups','history'].includes(action);
        if(request.method!==(readOnly?'GET':'POST'))return sendJson(request,response,405,{ok:false,error:'method_not_allowed'});
        const result=await managerControl.handle(action,readOnly?{}:await readBody(request));
        return sendJson(request,response,200,{ok:true,result});
      }
      if (url.pathname.startsWith('/v1/manager/reset/')) {
        if (!isManagerRequest(principal) && !isAdminRequest(principal)) return sendJson(request,response,403,{ok:false,error:'manager_capability_required'});
        if(request.method!=='POST')return sendJson(request,response,405,{ok:false,error:'method_not_allowed'});
        const body=await readBody(request);
        if(url.pathname.endsWith('/plan'))return sendJson(request,response,200,{ok:true,result:namespaceReset.plan(body.namespaces)});
        if(url.pathname.endsWith('/execute'))return sendJson(request,response,200,{ok:true,result:await namespaceReset.execute(body)});
        return sendJson(request,response,404,{ok:false,error:'reset_route_not_found'});
      }
      if (url.pathname.startsWith('/v1/kv/')) {
        const target=url.searchParams.get('namespace')||principal.namespace;
        if(!namespaceReset.allows(target,request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED',resetEpochs:namespaceReset.epochs()});
      }


      if (request.method === 'GET' && url.pathname === '/v1/clients') {
        if (!isAdminRequest(principal)) return sendJson(request, response, 403, { ok: false, error: 'admin_capability_required' });
        return sendJson(request, response, 200, { ok: true, result: Array.from(clients.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt) });
      }

      if (request.method === 'GET' && url.pathname === '/v1/diagnostics') {
        diagnosticJournal.flush();
        const ownerNamespace = hasRole(principal, 'owner') ? principal.namespace : '';
        const requestedNamespace = String(url.searchParams.get('namespace') || ownerNamespace).trim().toLowerCase();
        if (!ownerNamespace || requestedNamespace !== ownerNamespace) {
          return sendJson(request, response, 403, { ok: false, error: 'diagnostic_namespace_forbidden' });
        }
        const namespace = validateNamespace(requestedNamespace);
        const scopeId = String(url.searchParams.get('scopeId') || decodeDiagnosticHeader(request.headers['x-memory-suite-scope-id']) || '').slice(0, 1200);
        const limit = Math.max(1, Math.min(DIAGNOSTIC_EXPORT_LIMIT, Number(url.searchParams.get('limit') || 500) || 500));
        const since = Math.max(0, Number(url.searchParams.get('since') || 0) || 0);
        const includeGlobal = url.searchParams.get('includeGlobal') !== '0';
        // Process/startup text logs are suite-global and may mention another owner.
        // Normal plugins receive only their own namespace/scope structured journal.
        const includeTextLogs = false;
        diagnosticJournal.flush();
        return sendJson(request, response, 200, {
          ok: true,
          result: {
            schema: DIAGNOSTIC_EXPORT_SCHEMA,
            generatedAt: now(),
            reachable: true,
            server: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
              protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
              uptimeMs: now() - startedAt,
              maintenanceMode,
              dataLayoutVersion: DATA_LAYOUT_VERSION,
              databaseSchemaVersion: DATABASE_SCHEMA_VERSION
            },
            filter: { namespace, scopeIdHash: diagnosticHash(scopeId), since, limit, includeGlobal },
            integrity: safeDiagnosticIntegrity(repositories[namespace].integrity()),
            clients: Array.from(clients.values()).filter(item => String(item.plugin || '') === String(request.headers['x-memory-suite-plugin'] || '')).slice(0, 16),
            log: diagnosticJournal.stats(),
            events: diagnosticJournal.query({ namespace, scopeId, limit, since, includeGlobal }),
            textLogs: [],
            textLogsManagerOnly: true
          }
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/manager/diagnostics') {
        diagnosticJournal.flush();
        if (!isManagerRequest(principal)) return sendJson(request, response, 403, { ok: false, error: 'retrace_manager_capability_required' });
        const namespaceRaw = String(url.searchParams.get('namespace') || '').trim().toLowerCase();
        const namespace = namespaceRaw ? validateNamespace(namespaceRaw) : '';
        const scopeId = String(url.searchParams.get('scopeId') || '').slice(0, 1200);
        const limit = Math.max(1, Math.min(DIAGNOSTIC_EXPORT_LIMIT, Number(url.searchParams.get('limit') || 1000) || 1000));
        const since = Math.max(0, Number(url.searchParams.get('since') || 0) || 0);
        const includeGlobal = url.searchParams.get('includeGlobal') !== '0';
        const includeTextLogs = url.searchParams.get('includeTextLogs') === '1';
        diagnosticJournal.flush();
        const selectedNamespaces = namespace ? [namespace] : NAMESPACES.slice();
        return sendJson(request, response, 200, {
          ok: true,
          result: {
            schema: 'memory-suite.manager-server-diagnostics.v1',
            generatedAt: now(),
            reachable: true,
            server: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
              protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
              uptimeMs: now() - startedAt,
              maintenanceMode,
              dataLayoutVersion: DATA_LAYOUT_VERSION,
              databaseSchemaVersion: DATABASE_SCHEMA_VERSION
            },
            filter: { namespace, scopeIdHash: diagnosticHash(scopeId), since, limit, includeGlobal },
            integrity: Object.fromEntries(selectedNamespaces.map(item => [item, safeDiagnosticIntegrity(repositories[item].integrity())])),
            clients: Array.from(clients.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 64),
            log: diagnosticJournal.stats(),
            events: diagnosticJournal.query({ namespace, scopeId, limit, since, includeGlobal }),
            textLogs: includeTextLogs ? readDiagnosticTextLogs(dataDir) : []
          }
        });
      }

      if (maintenanceMode && !url.pathname.startsWith('/v1/admin/')
          && !(isAdminRequest(principal) && request.method === 'POST' && url.pathname === '/v1/shutdown')) {
        return sendJson(request, response, 503, { ok: false, error: 'server_maintenance_in_progress' });
      }

      if (gradiaRoute) {
        const adapter = gradiaOwnerReadSessions[gradiaRouteOwner], reader = gradiaReaders[gradiaRouteOwner];
        const body = await readBody(request, url.pathname === adapter.CAPTURE_ROUTE ? 16 * 1024 : adapter.LIMITS.currentRequestBytes);
        if (!namespaceReset.allows(gradiaRouteOwner, request.headers['x-memory-suite-reset-epochs'])) return sendJson(request, response, 409, { ok: false, error: 'MEMORY_SUITE_RESET_RECONNECT_REQUIRED' });
        const result = url.pathname === adapter.CAPTURE_ROUTE ? reader.capture(body) : reader.current(body);
        return sendJson(request, response, 200, { ok: true, result });
      }

      if (request.method === 'GET' && url.pathname === '/v1/kv/get') {
        const namespace = validateNamespace(url.searchParams.get('namespace'));
        assertNamespaceAccess(principal, namespace, 'read');
        const space = validateSpace(url.searchParams.get('space'));
        const key = validateKey(url.searchParams.get('key'));
        assertNonSensitive(namespace, key);
        return sendJson(request, response, 200, { ok: true, result: repositories[namespace].get(space, key) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/kv/keys') {
        const namespace = validateNamespace(url.searchParams.get('namespace'));
        assertNamespaceAccess(principal, namespace, 'read');
        const space = validateSpace(url.searchParams.get('space'));
        const prefix = String(url.searchParams.get('prefix') || '');
        if (prefix.length > 4096) throw Object.assign(new Error('invalid_storage_prefix'), { statusCode: 400 });
        const paged = url.searchParams.has('limit') || url.searchParams.has('cursor') || url.searchParams.get('paged') === '1';
        const limit = clampStoragePageLimit(url.searchParams.get('limit'), KV_KEYS_PAGE_DEFAULT);
        const cursorKey = paged
          ? decodeStorageCursor(url.searchParams.get('cursor'), { namespace, space, prefix })
          : '';
        return sendJson(request, response, 200, { ok: true, result: repositories[namespace].list(space, prefix, { paged, limit, cursorKey }) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/integrity') {
        const namespace = validateNamespace(url.searchParams.get('namespace'));
        assertNamespaceAccess(principal, namespace, 'read');
        return sendJson(request, response, 200, { ok: true, result: repositories[namespace].integrity() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/kv/get-many') {
        const body = await readBody(request);
        const namespace = validateNamespace(body.namespace);
        if(!namespaceReset.allows(namespace,request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        assertNamespaceAccess(principal, namespace, 'read');
        const space = validateSpace(body.space);
        const keys = Array.isArray(body.keys) ? body.keys.slice(0, 512).map(validateKey) : [];
        for (const key of keys) assertNonSensitive(namespace, key);
        const paged = body.paged === true || body.cursor != null || body.maxResponseBytes != null;
        const result = repositories[namespace].getMany(space, keys, {
          paged,
          cursor: body.cursor,
          maxResponseBytes: body.maxResponseBytes
        });
        return sendJson(request, response, 200, { ok: true, result });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/operations/')) {
        const parts = url.pathname.slice('/v1/operations/'.length).split('/').filter(Boolean).map(decodeURIComponent);
        if (parts.length !== 2) throw Object.assign(new Error('invalid_operation_route'), { statusCode: 400 });
        const namespace = validateNamespace(parts[0]);
        assertNamespaceAccess(principal, namespace, 'read');
        const operationId = validateOperationId(parts[1]);
        const operation = repositories[namespace].operation(operationId);
        return operation
          ? sendJson(request, response, 200, operation)
          : sendJson(request, response, 404, { ok: false, error: 'operation_not_found' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/libra/graph-lifecycle') {
        assertNamespaceAccess(principal,'libra','write');
        if(!namespaceReset.allows('libra',request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        const body=await readBody(request,32768,'graph_lifecycle_body_limit');
        if(!['server_only','mirror'].includes(request.headers['x-memory-suite-storage-mode'])||(['inventory','delete'].includes(body?.action)||body?.kind==='gc')&&request.headers['x-memory-suite-storage-mode']!=='server_only'||decodeDiagnosticHeader(request.headers['x-memory-suite-scope-id'])!==body?.scopeKey)throw Object.assign(new Error('LIBRA_GRAPH_ROUTE_BINDING_REQUIRED'),{statusCode:409});
        return sendJson(request,response,200,{ok:true,result:repositories.libra.graphLifecycle.command(body)});
      }
      if (request.method === 'POST' && url.pathname === '/v1/flashback/writer') {
        const body = await readBody(request, 8192, 'flashback_writer_request_too_large');
        if(!namespaceReset.allows('flashback',request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        assertNamespaceAccess(principal, 'flashback', 'write');
        return sendJson(request, response, 200, { ok: true, result: repositories.flashback.writerFence.command(body) });
      }
      if (request.method === 'POST' && url.pathname.startsWith('/v1/flashback/physical-repair/')) {
        const action = url.pathname.slice('/v1/flashback/physical-repair/'.length);
        assertNamespaceAccess(principal,'flashback',['preview','status'].includes(action)?'read':'write');
        if(!namespaceReset.allows('flashback',request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        const body = await readBody(request,2*1024**2,'repair_body_limit');
        if(request.headers['x-memory-suite-storage-mode']!=='server_only'||body?.mode!=='server_only'
          ||decodeDiagnosticHeader(request.headers['x-memory-suite-scope-id'])!==body?.scopeKey)return sendJson(request,response,409,{ok:false,error:'REPAIR_ROUTE_BINDING_REQUIRED'});
        const result = flashbackServerRepair(principal,action,body);
        if(!['preview','status'].includes(action))scheduleChangeSettledBackup();
        return sendJson(request,response,200,{ok:true,result});
      }
      if (request.method === 'POST' && url.pathname === '/v1/flashback/scope-health') {
        assertNamespaceAccess(principal,'flashback','read');
        if(!namespaceReset.allows('flashback',request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        const body=await readBody(request,8192,'scope_health_body_limit');
        return sendJson(request,response,200,{ok:true,result:await flashbackScopeHealth(principal,body)});
      }
      if (request.method === 'POST' && url.pathname === '/v1/owner/scope-health') {
        const body=await readBody(request,8192,'scope_health_body_limit');
        assertNamespaceAccess(principal,'libra','read');
        if(!namespaceReset.allows('libra',request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        return sendJson(request,response,200,{ok:true,result:await ownerScopeHealth(principal,body)});
      }
      if (request.method === 'POST' && ['/v1/owner/scope-delete/plan','/v1/owner/scope-delete/execute'].includes(url.pathname)) {
        const body = await readBody(request);
        assertNamespaceAccess(principal,'libra','write');
        if(!namespaceReset.allows('libra',request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        const result=await ownerScopeDelete(principal,url.pathname.endsWith('/plan')?'plan':'execute',body,
          decodeDiagnosticHeader(request.headers['x-memory-suite-scope-id']));
        return sendJson(request,response,200,{ok:true,result});
      }
      if (request.method === 'POST' && url.pathname === '/v1/kv/batch') {
        const body = await readBody(request, KV_CONDITIONAL_BATCH_BODY_BYTES, 'conditional_batch_body_too_large');
        const namespace = validateNamespace(body.namespace);
        if(!namespaceReset.allows(namespace,request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        assertNamespaceAccess(principal, namespace, 'write');
        const operationId = validateOperationId(body.operationId);
        const mutations = body.mutations, conditions = body.conditions === undefined ? [] : body.conditions;
        if (!Array.isArray(mutations) || !mutations.length || !Array.isArray(conditions)) throw Object.assign(new Error('conditional_batch_items_required'),{statusCode:400});
        if (mutations.length + conditions.length > KV_CONDITIONAL_BATCH_MAX_ITEMS) throw Object.assign(new Error('conditional_batch_item_limit_exceeded'),{statusCode:400});
        const normalize = (m,condition) => {
          if (!m || typeof m !== 'object' || Array.isArray(m)) throw Object.assign(new Error('invalid_conditional_batch_item'),{statusCode:400});
          const allowed = new Set(['space','key','expectedRevision','expectedDigest','expectedExists','expectedTombstone',...(condition?[]:['kind','value'])]);
          if (Object.keys(m).some(k=>!allowed.has(k))) throw Object.assign(new Error('unknown_conditional_batch_field'),{statusCode:400});
          if ((!condition && !['set','remove'].includes(m.kind)) || (m.kind==='remove' && Object.hasOwn(m,'value'))) throw Object.assign(new Error('invalid_conditional_batch_kind'),{statusCode:400});
          if (!Number.isSafeInteger(m.expectedRevision) || m.expectedRevision<0 || typeof m.expectedExists!=='boolean' || typeof m.expectedTombstone!=='boolean'
            || (m.expectedExists&&m.expectedTombstone) || typeof m.expectedDigest!=='string'
            || (m.expectedRevision===0 ? (m.expectedDigest!==''||m.expectedExists||m.expectedTombstone) : (!/^[a-f0-9]{64}$/.test(m.expectedDigest)||(!m.expectedExists&&!m.expectedTombstone))))
            throw Object.assign(new Error('conditional_batch_exact_preconditions_required'),{statusCode:400});
          return {...m,kind:condition?'check':m.kind};
        };
        const items=[...conditions.map(m=>normalize(m,true)),...mutations.map(m=>normalize(m,false))];
        const result = repositories[namespace].applyConditionalBatch(items,{operationId, fence: body.fence, graphLease: body.graphLease,
          scopeId:decodeDiagnosticHeader(request.headers['x-memory-suite-scope-id'])});
        scheduleChangeSettledBackup();
        return sendJson(request,response,200,result);
      }
      if (request.method === 'POST' && (url.pathname === '/v1/kv/set' || url.pathname === '/v1/kv/remove')) {
        const kind = url.pathname.endsWith('/set') ? 'set' : 'remove';
        const body = await readBody(
          request,
          kind === 'set' ? KV_INTERACTIVE_SET_BODY_BYTES : KV_INTERACTIVE_REMOVE_BODY_BYTES,
          kind === 'set'
            ? 'interactive_storage_request_too_large_use_shards'
            : 'interactive_storage_remove_request_too_large'
        );
        const namespace = validateNamespace(body.namespace);
        if(!namespaceReset.allows(namespace,request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        assertNamespaceAccess(principal, namespace, 'write');
        const space = validateSpace(body.space);
        const key = validateKey(body.key);
        assertNonSensitive(namespace, key);
        const operationId = validateOperationId(body.operationId);
        const expectedRevision = body.expectedRevision == null ? null : Number(body.expectedRevision);
        if (expectedRevision != null && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
          throw Object.assign(new Error('invalid_expected_revision'), { statusCode: 400 });
        }
        if (kind === 'set' && !Object.prototype.hasOwnProperty.call(body, 'value')) {
          throw Object.assign(new Error('set_value_is_required'), { statusCode: 400 });
        }
        const result = repositories[namespace].mutate({ kind, space, key, value: body.value, operationId, expectedRevision, fence: body.fence,
          scopeId:decodeDiagnosticHeader(request.headers['x-memory-suite-scope-id']) });
        scheduleChangeSettledBackup();
        return sendJson(request, response, 200, result);
      }

      if (url.pathname.startsWith('/v1/manager/') && !isManagerRequest(principal)) {
        return sendJson(request, response, 403, { ok: false, error: 'retrace_manager_capability_required' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/manager/scopes/index') {
        const body = await readBody(request);
        const namespace = validateNamespace(body.namespace);
        if(!namespaceReset.allows(namespace,request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        return sendJson(request, response, 200, { ok: true, result: replaceNamespaceScopeIndex(namespace, body.scopes || []) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/manager/scopes') {
        return sendJson(request, response, 200, { ok: true, result: { schema: 'memory-suite.scope-catalog.v1', generatedAt: now(), scopes: globalScopeCatalog() } });
      }
      if (request.method === 'POST' && url.pathname === '/v1/manager/scope-pin') {
        const body = await readBody(request);
        const namespace = validateNamespace(body.namespace);
        if(!namespaceReset.allows(namespace,request.headers['x-memory-suite-reset-epochs']))return sendJson(request,response,409,{ok:false,error:'MEMORY_SUITE_RESET_RECONNECT_REQUIRED'});
        const scopeId = String(body.scopeId || '').trim().slice(0, 320);
        if (!scopeId) throw Object.assign(new Error('scope_pin_scope_id_required'), { statusCode: 400 });
        return sendJson(request, response, 200, { ok: true, result: setCatalogScopePinned(namespace, scopeId, body.pinned === true) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/manager/scope-delete/plan') {
        const body = await readBody(request);
        return sendJson(request, response, 200, createScopeDeletePlan(body));
      }
      if (request.method === 'POST' && url.pathname === '/v1/manager/scope-delete/execute') {
        const body = await readBody(request);
        return sendJson(request, response, 200, executeScopeDeletePlan(body));
      }

      if ((url.pathname.startsWith('/v1/admin/') || url.pathname === '/v1/shutdown') && !isAdminRequest(principal)) {
        return sendJson(request, response, 403, { ok: false, error: 'admin_capability_required' });
      }

      if (request.method === 'POST' && url.pathname === '/v1/admin/backups/create') {
        const body = await readBody(request);
        const result = await createBackup(body.kind === 'auto' ? 'auto' : 'manual', body.label || '');
        return sendJson(request, response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/v1/admin/backups') {
        return sendJson(request, response, 200, { ok: true, result: listBackups().map(item => ({ ...item, path: undefined })) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/backups/scrub') {
        const body = await readBody(request);
        return sendJson(request, response, 200, { ok: true, result: scrubBackups(body.backupId || '') });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/backups/export') {
        const body = await readBody(request);
        return sendJson(request, response, 200, { ok: true, result: exportBackupArchiveById(body.backupId || '') });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/backups/import') {
        const body = await readBody(request);
        return sendJson(request, response, 200, { ok: true, result: importBackupArchiveFromPath(body.archivePath || '') });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/libra/native-archive-repair/plan') {
        const body = await readBody(request, 8192, 'native_archive_repair_body_limit');
        return sendJson(request, response, 200, { ok: true, result: getLibraNativeArchiveRepair().plan(body) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/libra/native-archive-repair/execute') {
        const body = await readBody(request, 8192, 'native_archive_repair_body_limit');
        return sendJson(request, response, 200, { ok: true, result: getLibraNativeArchiveRepair().execute(body) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/restore/plan') {
        const body = await readBody(request);
        return sendJson(request, response, 200, { ok: true, result: planOfflineRestore({ dataDir, backupDir, backupId: body.backupId, namespaces: body.namespaces || NAMESPACES, mode: 'online' }) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/integrity') {
        return sendJson(request, response, 200, { ok: true, result: integrityAll() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/restore') {
        const body = await readBody(request);
        const result = await restoreBackup(body.backupId, body.namespaces || NAMESPACES);
        return sendJson(request, response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/v1/shutdown') {
        sendJson(request, response, 200, { ok: true, result: { closing: true, backupBeforeClose: autoBackup && dirtySinceBackup } });
        setImmediate(() => { gracefulClose().catch(error => {
          process.stderr.write(`[LIBRARIAN SYSTEM] Graceful shutdown failed: ${String(error?.stack || error)}\n`);
          try { server.close(); } catch (_) {}
        }); });
        return;
      }
      return sendJson(request, response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return sendJson(request, response, Number(error?.statusCode || 500), {
        ok: false,
        error: String(error?.message || error || 'internal_error'),
        ...(error?.code ? { code: String(error.code) } : {}),
        ...(error?.checks ? { checks: error.checks } : {}),
        ...(Number.isFinite(Number(error?.maxBytes)) ? { maxBytes: Number(error.maxBytes) } : {}),
        ...(Number.isFinite(Number(error?.maxResponseBytes)) ? { maxResponseBytes: Number(error.maxResponseBytes) } : {}),
        ...(Number.isFinite(Number(error?.responseBytes)) ? { responseBytes: Number(error.responseBytes) } : {}),
        ...(Number.isFinite(Number(error?.cursor)) ? { cursor: Number(error.cursor) } : {}),
        ...(typeof error?.key === 'string' && error.key ? { key: error.key } : {})
      });
    }
  });

  if (authorityRuntime) server.listen = () => authorityRuntime.unavailable('AUTHORITY_HOST_PROFILE_UNQUALIFIED');

  const closeDatabases = () => {
    for (const namespace of NAMESPACES) {
      try { repositories[namespace]?.close(); } catch (_) {}
    }
    authorityRuntime?.close();
  };

  const gracefulClose = async () => {
    if (closing) return;
    diagnosticJournal.record({ event: 'server.stopping', operation: 'server.shutdown', ok: true, message: 'graceful shutdown requested' });
    await portableTransfers.close();
    maintenanceMode = true;
    if (autoBackupTimer) clearInterval(autoBackupTimer);
    if (startupBackupTimer) clearTimeout(startupBackupTimer);
    if (changeSettledBackupTimer) clearTimeout(changeSettledBackupTimer);
    autoBackupTimer = null;
    startupBackupTimer = null;
    changeSettledBackupTimer = null;
    if (autoBackup && dirtySinceBackup) {
      try {
        await maybeCreateAutomaticBackup('shutdown', { allowDuringMaintenance: true, ignoreCooldown: true });
      } catch (error) {
        diagnosticJournal.record({ event: 'backup.shutdown_failed', operation: 'backup.shutdown', ok: false, error: String(error?.message || error) });
        process.stderr.write(`[LIBRARIAN SYSTEM] Shutdown backup failed; continuing graceful close: ${String(error?.stack || error)}\n`);
      }
    }
    await new Promise(resolve => {
      if (!server.listening) { if (authorityRuntime) server.emit('close'); return resolve(); }
      server.close(() => resolve());
    });
  };

  server.on('close', () => {
    if (closing) return;
    closing = true;
    if (autoBackupTimer) clearInterval(autoBackupTimer);
    if (startupBackupTimer) clearTimeout(startupBackupTimer);
    if (changeSettledBackupTimer) clearTimeout(changeSettledBackupTimer);
    diagnosticJournal.record({ event: 'server.closed', operation: 'server.shutdown', ok: true, durationMs: now() - startedAt });
    diagnosticJournal.close();
    closeDatabases();
  });

  const scheduleAutomaticBackups = () => {
    if (!autoBackup) return;
    autoBackupTimer = setInterval(() => {
      if (!dirtySinceBackup || maintenanceMode) return;
      maybeCreateAutomaticBackup('scheduled', { ignoreCooldown: true }).catch(error => {
        process.stderr.write(`[LIBRARIAN SYSTEM] Scheduled backup failed: ${String(error?.stack || error)}\n`);
      });
    }, autoBackupIntervalMs);
    autoBackupTimer.unref?.();
  };

  return {
    server,
    token,
    dataDir,
    backupDir,
    dataLayout,
    databasePreparation,
    interruptedRestoreRecovery,
    repositories,
    ...(authorityRuntime ? {authorityRuntime:authorityRuntime.status()} : {}),
    createBackup,
    listBackups,
    scrubBackups,
    integrityAll,
    restoreBackup,
    diagnosticJournal,
    managerControl,
    listen: () => new Promise((resolve, reject) => {
      if (authorityRuntime) return reject(Object.assign(new Error('AUTHORITY_HOST_PROFILE_UNQUALIFIED'),{code:'AUTHORITY_HOST_PROFILE_UNQUALIFIED',statusCode:503}));
      server.once('error', reject);
      server.listen(port, host, async () => {
        server.off('error', reject);
        scheduleAutomaticBackups();
        diagnosticJournal.record({ event: 'server.started', operation: 'server.listen', ok: true, message: `${host}:${server.address()?.port || port}`, itemCount: NAMESPACES.length });
        resolve(server.address());
      });
    }),
    close: gracefulClose
  };
}


function createRecoverySafeModeServer(options = {}, startupError = null) {
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port ?? DEFAULT_PORT);
  const dataDir = path.resolve(options.dataDir || path.resolve(__dirname, '..', '..', 'DATA'));
  assertLegacyAuthorityUnavailable({dataDir});
  const backupDir = path.resolve(options.backupDir || path.join(dataDir, 'backups'));
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('memory_suite_server_must_bind_to_loopback');
  fs.mkdirSync(path.join(dataDir, 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'recovery-quarantine'), { recursive: true });
  const interruptedRestoreRecovery = recoverInterruptedRestore(dataDir);
  const token = loadOrCreateToken(dataDir);
  const {dataInstanceId,dataIdentityContract}=ensureDataInstanceIdentity(dataDir);
  let closing = false;
  const authenticateAdmin = request => {
    const authorization = String(request.headers.authorization || '');
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    return supplied && safeEqual(supplied, token) && String(request.headers['x-memory-suite-admin'] || '').trim() === '1';
  };
  const server = http.createServer(async (request, response) => {
    request.__memorySuiteDataInstanceId=dataInstanceId;
    try {
      const url = new URL(request.url || '/', loopbackUrl(host, port || DEFAULT_PORT));
      const boundDataInstance=String(request.headers['x-memory-suite-data-instance']||'');
      if(boundDataInstance&&boundDataInstance!==dataInstanceId)return sendJson(request,response,409,{ok:false,error:'data_instance_binding_changed'});
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(request, response, 200, {
          ok: true,
          name: SERVER_NAME,
          version: SERVER_VERSION,
          dataInstanceId,
          dataIdentityContract,
          protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
          recoveryMode: true,
          status: 'recovery_only',
          startupError: sanitizeDiagnosticText(startupError?.message || startupError || 'database_startup_failed', 600),
          interruptedRestoreRecovery,
          backups: listBackupsFromDisk(backupDir).length
        });
      }
      if (!authenticateAdmin(request)) return sendJson(request, response, 403, { ok: false, error: 'admin_capability_required' });
      if (request.method === 'GET' && url.pathname === '/v1/admin/backups') {
        return sendJson(request, response, 200, { ok: true, result: listBackupsFromDisk(backupDir).map(item => ({ ...item, path: undefined })) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/backups/scrub') {
        const body = await readBody(request);
        const rows = body.backupId ? [findBackupById(backupDir, body.backupId)].filter(Boolean) : listBackupsFromDisk(backupDir);
        if (body.backupId && !rows.length) throw Object.assign(new Error('backup_not_found'), { statusCode: 404 });
        const results = rows.map(item => scrubBackupFromDisk(item, NAMESPACES));
        return sendJson(request, response, 200, { ok: true, result: { schema: 'memory-suite.backup-scrub-report.v1', checkedAt: new Date().toISOString(), ok: results.every(item => item.ok), results } });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/restore/plan') {
        const body = await readBody(request);
        return sendJson(request, response, 200, { ok: true, result: planOfflineRestore({ dataDir, backupDir, backupId: body.backupId, namespaces: body.namespaces || NAMESPACES, mode: 'recovery-safe-mode' }) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/admin/restore') {
        const body = await readBody(request);
        const result = restoreBackupOffline({ dataDir, backupDir, backupId: body.backupId, namespaces: body.namespaces || NAMESPACES, reason: 'recovery-safe-mode' });
        return sendJson(request, response, 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/v1/shutdown') {
        sendJson(request, response, 200, { ok: true, result: { closing: true, recoveryMode: true } });
        return setImmediate(() => server.close());
      }
      return sendJson(request, response, 503, { ok: false, error: 'recovery_mode_only', recoveryMode: true });
    } catch (error) {
      return sendJson(request, response, Number(error?.statusCode || 500), { ok: false, error: String(error?.message || error), ...(error?.checks ? { checks: error.checks } : {}) });
    }
  });
  return {
    server, token, dataDir, backupDir, recoveryMode: true, startupError,
    listBackups: () => listBackupsFromDisk(backupDir),
    restorePlan: (backupId, namespaces) => planOfflineRestore({ dataDir, backupDir, backupId, namespaces, mode: 'recovery-safe-mode' }),
    restoreBackup: (backupId, namespaces) => restoreBackupOffline({ dataDir, backupDir, backupId, namespaces, reason: 'recovery-safe-mode' }),
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise(resolve => {
      if (closing || !server.listening) return resolve();
      closing = true;
      server.close(() => resolve());
    })
  };
}


function isRecoverySafeModeEligibleError(error) {
  const code = String(error?.code || '');
  if (['DATA_LAYOUT_NEWER_THAN_PROGRAM', 'DATA_SCHEMA_NEWER_THAN_PROGRAM', 'DATA_LAYOUT_MIGRATION_MISSING'].includes(code)) return false;
  const message = String(error?.message || error || '').toLowerCase();
  return /database|sqlite|malformed|disk image|integrity|file is not a database|restore/.test(message);
}

async function main() {
  const args = parseArgs();
  if (args.command === 'version') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      dataLayoutSchemaVersion: DATA_LAYOUT_VERSION,
      programDataSeparation: true
    })}\n`);
    return;
  }
  require('./core/fatal-monitor.cjs').installFatalMonitor({ dataDir: args.dataDir, version: SERVER_VERSION });
  let app = null;
  let recoveryStartupError = null;
  try {
    app = createMemorySuiteServer(args);
  } catch (error) {
    if (!isRecoverySafeModeEligibleError(error)) throw error;
    recoveryStartupError = error;
    app = createRecoverySafeModeServer(args, error);
  }
  const address = await app.listen();
  process.stdout.write(`[LIBRARIAN SYSTEM] ${app.recoveryMode ? 'Recovery Safe Mode' : 'Server'} ready at ${loopbackUrl(address.address === '::' ? '::1' : address.address, address.port)}\n`);
  process.stdout.write(`[LIBRARIAN SYSTEM] DATA: ${app.dataDir}\n`);
  try {
    const updaterNotice = require('../../UPDATER/update_check.cjs');
    setTimeout(() => updaterNotice.printUpdateNotice({ currentVersion: SERVER_VERSION }).catch(() => {}), 0).unref?.();
  } catch (_) {}
  process.stdout.write('[LIBRARIAN SYSTEM] Backup rule: stop server, then copy the entire DATA folder.\n');
  if (app.recoveryMode) {
    process.stdout.write(`[LIBRARIAN SYSTEM] RECOVERY ONLY: ${String(recoveryStartupError?.message || recoveryStartupError || 'startup failure')}\n`);
    process.stdout.write('[LIBRARIAN SYSTEM] Normal plugin reads/writes are blocked until a verified backup is restored.\n');
  } else {
    process.stdout.write(`[LIBRARIAN SYSTEM] Stores: ${NAMESPACES.join(', ')}\n`);
  }
  const shutdown = () => app.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(error => {
    const detail = String(error?.stack || error);
    try {
      const dataArgIndex = process.argv.indexOf('--data-dir');
      const dataDir = path.resolve(dataArgIndex >= 0 && process.argv[dataArgIndex + 1]
        ? process.argv[dataArgIndex + 1]
        : path.resolve(__dirname, '..', '..', 'DATA'));
      const logsDir = path.join(dataDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(path.join(logsDir, 'startup-error.log'),
        `[${new Date().toISOString()}] SERVER_FATAL\n${detail}\n`, 'utf8');
    } catch (_) {}
    process.stderr.write(`[LIBRARIAN SYSTEM] Server failed: ${detail}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createMemorySuiteServer,
  parseArgs,
  SERVER_VERSION,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  DATABASE_SCHEMA_VERSION,
  DATA_LAYOUT_VERSION,
  NAMESPACES,
  ACTIVE_STORAGE_NAMESPACES,
  LEGACY_STORAGE_NAMESPACES,
  SUPPORTED_STORAGE_OWNERS,
  principalForPluginId,
  namespaceForPluginId,
  ensurePortableDataLayout,
  inspectDatabaseFile,
  prepareDatabaseSchemas,
  preflightDataCompatibility,
  createRecoverySafeModeServer,
  listBackupsFromDisk,
  scrubBackupFromDisk,
  planOfflineRestore,
  restoreBackupOffline,
  recoverInterruptedRestore,
  atomicWrite,
  isRecoverySafeModeEligibleError,
  dataInstanceIdForToken
};
