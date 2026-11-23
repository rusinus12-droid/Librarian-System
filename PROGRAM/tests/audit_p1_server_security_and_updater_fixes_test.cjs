'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const {
  createMemorySuiteServer,
  createRecoverySafeModeServer,
  restoreBackupOffline
} = require('../server/server.cjs');
const { setRemoteAccess } = require('../tools/platform_launcher.cjs');
const { assertPersistentDataFilesystemInventory } = require('../server/portable/migration_data_policy.cjs');
const { installUpdaterIntoTarget } = require('../../UPDATER/core/updater-bootstrap.cjs');
const { scheduleUpdaterRefresh } = require('../tools/updater-refresh.cjs');

const makeTempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('Stage 3A: restoreBackupOffline advances namespace-reset epochs and clears active flashback writer leases', async () => {
  const dir = makeTempDir('audit-p1-offline-restore-');
  try {
    const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: dir, autoBackup: false });
    await app.listen();
    const fenceResult = app.repositories.flashback.writerFence.command({
      key: 'vector_rag_memory:scope:abc12345:manifest:v2',
      action: 'acquire',
      owner: 'client-lease-owner-0123456789'
    });
    assert.equal(fenceResult.epoch, 1);
    const bk = await app.createBackup('manual', 'test-offline-restore');
    assert.equal(bk.ok, true);
    await app.close();

    const receipt = restoreBackupOffline({
      dataDir: dir,
      backupId: bk.result.id,
      namespaces: ['flashback']
    });
    assert.equal(receipt.ok, true);

    const resetState = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'namespace-reset.json'), 'utf8'));
    assert.ok(Number(resetState?.epochs?.flashback || 0) >= 1, 'offline restore must advance reset epoch');

    const fbDb = new DatabaseSync(path.join(dir, 'stores', 'flashback', 'flashback.sqlite'), { readOnly: true });
    try {
      const row = fbDb.prepare('SELECT epoch, owner, expires_at FROM flashback_writer_fences WHERE alias=?').get('abc12345');
      assert.equal(row.epoch, 1, 'fence epoch stays monotonic');
      assert.equal(row.owner, '', 'restored lease owner must be released');
      assert.equal(row.expires_at, 0, 'restored lease expiry must be reset');
    } finally {
      fbDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Stage 3B: Local Host DNS-rebinding rejection, CORS PNA/HTTPS, /health redaction, 429 rate limit, and safe-mode container bind', async () => {
  const localDir = makeTempDir('audit-p1-local-sec-');
  const remoteDir = makeTempDir('audit-p1-remote-sec-');
  const safeDir = makeTempDir('audit-p1-safe-sec-');
  try {
    // 1. Local mode: reject non-loopback Host header; allow Origin: null + PNA header
    const localApp = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: localDir, autoBackup: false });
    const localAddr = await localApp.listen();
    try {
      const badHostStatus = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: localAddr.port,
          path: '/health',
          method: 'GET',
          headers: { Host: 'evil.example:47630' }
        }, res => {
          let raw = '';
          res.on('data', d => raw += d);
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(badHostStatus.status, 403);
      assert.equal(badHostStatus.body.error, 'invalid_host_header');

      const nullOriginRes = await fetch(`http://127.0.0.1:${localAddr.port}/health`, {
        headers: { Origin: 'null', 'Access-Control-Request-Private-Network': 'true' }
      });
      assert.equal(nullOriginRes.status, 200);
      assert.equal(nullOriginRes.headers.get('access-control-allow-origin'), 'null');
      assert.equal(nullOriginRes.headers.get('access-control-allow-private-network'), 'true');
    } finally {
      await localApp.close();
    }

    // 2. Remote mode: allow https Origin + PNA, redact interruptedRestoreRecovery, 429 after 12 failed auths
    await setRemoteAccess(remoteDir, 'remote', { tunnelCheck: false, write: () => {} });
    const remoteApp = createMemorySuiteServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: remoteDir,
      autoBackup: false,
      portableSettingsFromData: true
    });
    const remoteAddr = await remoteApp.listen();
    try {
      const hRes = await fetch(`http://127.0.0.1:${remoteAddr.port}/health`, {
        headers: { Origin: 'https://risuai.xyz', 'Access-Control-Request-Private-Network': 'true' }
      });
      assert.equal(hRes.status, 200);
      assert.equal(hRes.headers.get('access-control-allow-origin'), 'https://risuai.xyz');
      assert.equal(hRes.headers.get('access-control-allow-private-network'), 'true');
      const healthBody = await hRes.json();
      assert.deepEqual(healthBody.interruptedRestoreRecovery, { recovered: false });

      for (let i = 0; i < 12; i += 1) {
        const failRes = await fetch(`http://127.0.0.1:${remoteAddr.port}/bootstrap`, {
          headers: { 'X-Memory-Suite-Plugin': 'libra', 'X-Memory-Suite-Access-Key': 'wrong-' + i }
        });
        assert.equal(failRes.status, 403);
      }
      const rateLimited = await fetch(`http://127.0.0.1:${remoteAddr.port}/bootstrap`, {
        headers: { 'X-Memory-Suite-Plugin': 'libra', 'X-Memory-Suite-Access-Key': 'wrong-13' }
      });
      assert.equal(rateLimited.status, 429);
      assert.equal((await rateLimited.json()).error, 'auth_rate_limited');
    } finally {
      await remoteApp.close();
    }

    // 3. Recovery Safe Mode with container:true binds 0.0.0.0 and redacts startupError details
    const safeServer = createRecoverySafeModeServer(
      { host: '127.0.0.1', port: 0, dataDir: safeDir, container: true },
      new Error('sqlite file corrupted at C:\\secret\\path\\libra.sqlite')
    );
    const safeAddr = await safeServer.listen();
    try {
      assert.equal(safeAddr.address, '0.0.0.0');
      const safeHealth = await fetch(`http://127.0.0.1:${safeAddr.port}/health`).then(r => r.json());
      assert.equal(safeHealth.startupError, 'database_startup_failed');
    } finally {
      await safeServer.close();
    }
  } finally {
    fs.rmSync(localDir, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
    fs.rmSync(safeDir, { recursive: true, force: true });
  }
});

test('Stage 3C: OS metadata exemption, updater-bootstrap missing UPDATER, migration_required updater-refresh, EXDEV export fallback, and SDK retry/restored recall', async () => {
  // 1. OS metadata exemption in migration_data_policy.cjs
  const dataDir = makeTempDir('audit-p1-policy-');
  try {
    fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'desktop.ini'), '[ViewState]\n');
    fs.writeFileSync(path.join(dataDir, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(dataDir, 'Thumbs.db'), 'x');
    fs.writeFileSync(path.join(dataDir, 'runtime', '.DS_Store'), 'x');
    assert.equal(assertPersistentDataFilesystemInventory(dataDir).ok, true);
    fs.writeFileSync(path.join(dataDir, 'unexpected.tmp'), 'bad');
    assert.throws(() => assertPersistentDataFilesystemInventory(dataDir), /migration_unknown_data_entries:unexpected\.tmp/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // 2. updater-bootstrap creates missing target/UPDATER directory
  const updSrc = makeTempDir('audit-p1-upd-src-');
  const updTgt = makeTempDir('audit-p1-upd-tgt-');
  try {
    fs.mkdirSync(path.join(updSrc, 'UPDATER'), { recursive: true });
    fs.writeFileSync(path.join(updSrc, 'UPDATER', 'updater.cjs'), '// stub\n');
    const bootRes = await installUpdaterIntoTarget({ sourceUpdaterDir: path.join(updSrc, 'UPDATER'), targetRoot: updTgt, logger: () => {} });
    assert.equal(bootRes.installed, true);
    assert.ok(fs.existsSync(path.join(updTgt, 'UPDATER', 'updater.cjs')));
  } finally {
    fs.rmSync(updSrc, { recursive: true, force: true });
    fs.rmSync(updTgt, { recursive: true, force: true });
  }

  // 3. updater-refresh accepts migration_required policy
  const refreshSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'updater-refresh.cjs'), 'utf8');
  assert.match(refreshSrc, /\['program_only',\s*'migration_required'\]\.includes\(journal\.policy\)/);
  const refDir = makeTempDir('audit-p1-refresh-');
  try {
    fs.mkdirSync(path.join(refDir, 'PROGRAM', 'tools', 'updater-payload'), { recursive: true });
    fs.mkdirSync(path.join(refDir, 'UPDATER', 'core'), { recursive: true });
    fs.writeFileSync(path.join(refDir, 'PROGRAM', 'VERSION.txt'), '1.4.0\n');
    fs.writeFileSync(path.join(refDir, 'PROGRAM', 'tools', 'updater-payload', 'updater.cjs'), '// payload\n');
    fs.copyFileSync(path.join(__dirname, '..', '..', 'UPDATER', 'core', 'journal.cjs'), path.join(refDir, 'UPDATER', 'core', 'journal.cjs'));
    fs.writeFileSync(path.join(refDir, 'UPDATER', 'update-state.json'), JSON.stringify({
      schema: 'librarian.update-state.v1',
      operationId: 'op-mig-1',
      policy: 'migration_required',
      status: 'applying',
      toVersion: '1.4.0',
      steps: [],
      updatedAt: new Date().toISOString()
    }));
    const scheduled = scheduleUpdaterRefresh(refDir, { afterIntegrity: false });
    assert.equal(scheduled, false, 'non-complete status reaches afterIntegrity gate after readCandidate accepts migration_required');
  } finally {
    fs.rmSync(refDir, { recursive: true, force: true });
  }

  // 4. portable_export_stopped EXDEV fallback present & updater download idle timeout present
  const exportSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'portable_export_stopped.cjs'), 'utf8');
  assert.match(exportSrc, /COPYFILE_EXCL/);
  const updaterSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'UPDATER', 'updater.cjs'), 'utf8');
  assert.match(updaterSrc, /DOWNLOAD_IDLE_TIMEOUT_MS/);

  // 5. SDK /v1/flashback/writer in MAINTENANCE_RETRY_ROUTES + isRetryableMaintenanceRoute & .libra choice==='restored'
  const sdkLibraSrc = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.libra.source.js'), 'utf8');
  assert.match(sdkLibraSrc, /MAINTENANCE_RETRY_ROUTES\s*=[\s\S]{0,160}\/v1\/flashback\/writer/);
  assert.match(sdkLibraSrc, /candidate\?\.choice\s*!==\s*'restored'/);

  // Runtime check of 503 maintenance retry on /v1/flashback/writer in SDK
  const sdkFlashSrc = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.flashback.source.js'), 'utf8');
  let writerCalls = 0;
  const store = new Map();
  const url = 'http://127.0.0.1:47630';
  const dataInstanceId = 'C'.repeat(32);
  const host = {
    pluginStorage: { getItem: async k => store.get(k) ?? null, setItem: async (k, v) => { store.set(k, v); return true; }, removeItem: async k => { store.delete(k); return true; }, keys: async () => [...store.keys()] },
    getLocalPluginStorage: async () => host.pluginStorage,
    getArgument: async k => k === 'memory_suite_server_mode' ? 'server_only' : k === 'memory_suite_server_url' ? url : '',
    nativeFetch: async (reqUrl, init) => {
      const u = new URL(reqUrl);
      if (u.pathname === '/bootstrap') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            schema: 'memory-suite.storage.bootstrap.v1',
            token: 'tok-1',
            url,
            version: '1.4.0',
            protocol: { major: 1, minor: 9 },
            namespaces: ['flashback'],
            dataInstanceId,
            dataIdentityContract: 'memory-suite.physical-data-identity.v1',
            resetEpochs: { flashback: 1 },
            capabilities: { 'kv.v1': true, 'keys.v1': true, 'revision.v1': true, 'digest.v1': true, 'idempotency.v1': true, 'tombstone.v1': true, 'readback.v1': true, 'namespace-integrity.v1': true, 'data-instance-binding.v1': true, 'flashback-writer-fence.v1': true, 'conditional-batch.v1': true }
          })
        };
      }
      if (u.pathname === '/v1/flashback/writer') {
        writerCalls += 1;
        const reqBody = JSON.parse(String(init?.body || '{}'));
        if (writerCalls === 1) {
          return { ok: false, status: 503, text: async () => JSON.stringify({ ok: false, error: 'server_maintenance_in_progress' }) };
        }
        if (reqBody.action === 'release') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, dataInstanceId, result: { schema: 'flashback.writer-fence.v1', alias: 'abc', owner: reqBody.owner, epoch: 1, expiresAt: 0 } }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, dataInstanceId, result: { schema: 'flashback.writer-fence.v1', alias: 'abc', owner: reqBody.owner, epoch: 1, expiresAt: Date.now() + 120000 } }) };
      }
      throw new Error('unexpected fetch: ' + reqUrl);
    }
  };
  const createBridge = new Function('risuai', 'URL', 'crypto', sdkFlashSrc + '\nreturn createMemorySuiteStorageBridge;')(host, URL, crypto);
  const bridge = createBridge({ namespace: 'flashback', pluginId: 'flashback_memory', startupDiagnostics: false, managementButton: false, autoMigratePlugin: false, autoMigrateLocal: false });
  try {
    await bridge.bootstrap();
    const outcome = await bridge.withFlashbackWriter('vector_rag_memory:scope:abc:manifest:v2', async () => 'ok_after_503', { forceServer: true });
    assert.equal(outcome, 'ok_after_503');
    assert.equal(writerCalls, 3, '503 server_maintenance_in_progress on /v1/flashback/writer acquire must retry automatically and then release');
  } finally {
    await bridge.dispose();
  }
});
