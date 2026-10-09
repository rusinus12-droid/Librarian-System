'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer, NAMESPACES } = require('../server/server.cjs');

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch (_) { throw new Error(`Invalid JSON (${response.status}): ${text.slice(0, 300)}`); }
  return { response, payload };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-server-test-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const health = await jsonFetch(`${baseUrl}/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.ok, true);
    assert.deepEqual(health.payload.namespaces, NAMESPACES);
    assert.equal(health.payload.programDataSeparation, true);
    assert.equal(health.payload.dataLayoutSchemaVersion, 1);
    assert.ok(fs.existsSync(path.join(dataDir, 'data-layout.json')));

    const deniedBootstrap = await jsonFetch(`${baseUrl}/bootstrap`);
    assert.equal(deniedBootstrap.response.status, 403);

    const bootstrap = await jsonFetch(`${baseUrl}/bootstrap`, {
      headers: {
        'X-Memory-Suite-Plugin': 'flashback_memory',
        'X-Memory-Suite-Plugin-Version': '0.11.23'
      }
    });
    assert.equal(bootstrap.response.status, 200);
    assert.equal(bootstrap.payload.schema, 'memory-suite.storage.bootstrap.v1');
    const token = bootstrap.payload.token;
    assert.ok(token && token.length >= 32);
    assert.equal(bootstrap.payload.programDataSeparation, true);
    assert.equal(bootstrap.payload.capabilities['portable-data-folder.v1'], true);
    assert.equal(bootstrap.payload.capabilities['automatic-data-migration.v1'], true);
    assert.equal(bootstrap.payload.capabilities['namespace-integrity.v1'], true);
    assert.equal(bootstrap.payload.capabilities['server-namespace-read.v1'], true);
    assert.equal(bootstrap.payload.capabilities['handoff-sync-proof.v1'], true);
    assert.equal(bootstrap.payload.capabilities['keys-pagination.v1'], true);
    assert.equal(bootstrap.payload.capabilities['server-batch-read-budget.v1'], true);
    assert.equal(bootstrap.payload.capabilities['interactive-storage-soft-cap.v1'], true);
    assert.equal(bootstrap.payload.capabilities['scoped-capability-auth.v1'], true);
    assert.equal(bootstrap.payload.capabilities['shutdown-backup.v1'], true);
    assert.equal(bootstrap.payload.capabilities['recovery-safe-mode.v1'], true);
    assert.equal(bootstrap.payload.capabilities['restore-journal.v1'], true);
    assert.equal(bootstrap.payload.capabilities['backup-scrub.v1'], true);
    assert.equal(bootstrap.payload.capabilities['generational-backup-retention.v1'], true);
    assert.equal(bootstrap.payload.capabilities['scope-catalog-fallback.v1'], true);
    assert.equal(bootstrap.payload.capabilities['plugin-bootstrap-key.v1'], undefined);
    assert.equal(bootstrap.payload.authorization.namespace, 'flashback');
    assert.deepEqual(bootstrap.payload.authorization.writeNamespaces, ['flashback']);
    assert.notEqual(token, app.token, 'plugin bootstrap must never expose the admin master token');
    assert.ok(NAMESPACES.includes('retrace'), 'RE:TRACE must have its own isolated server namespace');

    const pluginHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Memory-Suite-Plugin': 'flashback_memory',
      'X-Memory-Suite-Plugin-Version': '0.11.23'
    };
    const adminHeaders = {
      Authorization: `Bearer ${app.token}`,
      'Content-Type': 'application/json',
      'X-Memory-Suite-Admin': '1'
    };

    const request = async (method, route, body, headers = adminHeaders) => {
      const result = await jsonFetch(`${baseUrl}${route}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return result;
    };

    const firstReceipts = {};
    for (let index = 0; index < NAMESPACES.length; index += 1) {
      const namespace = NAMESPACES[index];
      const operationId = `test_${namespace}_set_000001`;
      const value = { namespace, index, text: `value-${namespace}`, nested: { safe: true } };
      const set = await request('POST', '/v1/kv/set', {
        namespace,
        operationId,
        space: 'plugin',
        key: `${namespace}:test:key`,
        value,
        expectedRevision: 0
      });
      if (['lia','retrace'].includes(namespace)) {
        assert.equal(set.response.status,403,'retired legacy namespaces must not regain ordinary writers');
        assert.equal(set.payload.error,'namespace_write_forbidden:'+namespace);
        const removed=await request('POST','/v1/kv/remove',{namespace,operationId:`test_${namespace}_retired_remove`,space:'plugin',key:`${namespace}:test:key`});
        assert.equal(removed.response.status,403,'ordinary remove is also retired');
        const legacy=await request('GET',`/v1/kv/get?namespace=${namespace}&space=plugin&key=${encodeURIComponent(`${namespace}:test:key`)}`);
        assert.equal(legacy.response.status,200,'legacy empty readers stay available');
        assert.equal(legacy.payload.result.exists,false);
        continue;
      }
      assert.equal(set.response.status, 200, JSON.stringify(set.payload));
      assert.equal(set.payload.result.verified, true);
      assert.equal(set.payload.result.revision, 1);
      firstReceipts[namespace] = set.payload.result;

      const get = await request('GET', `/v1/kv/get?namespace=${namespace}&space=plugin&key=${encodeURIComponent(`${namespace}:test:key`)}`, undefined);
      assert.equal(get.response.status, 200);
      assert.deepEqual(get.payload.result.value, value);
      assert.equal(get.payload.result.digest, set.payload.result.digest);

      const dbPath = app.repositories[namespace].filePath;
      assert.equal(path.basename(dbPath), `${namespace}.sqlite`);
      assert.ok(fs.existsSync(dbPath));
    }
    assert.equal(new Set(NAMESPACES.map(ns => app.repositories[ns].filePath)).size, NAMESPACES.length);

    // Same operation id + same payload is idempotent and does not advance revision.
    const replayBody = {
      namespace: 'flashback',
      operationId: 'test_flashback_set_000001',
      space: 'plugin',
      key: 'flashback:test:key',
      value: { namespace: 'flashback', index: 0, text: 'value-flashback', nested: { safe: true } },
      expectedRevision: 0
    };
    const replay = await request('POST', '/v1/kv/set', replayBody);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.payload.result.revision, 1);
    assert.equal(replay.payload.result.digest, firstReceipts.flashback.digest);

    // Same operation id + different payload is rejected.
    const conflict = await request('POST', '/v1/kv/set', { ...replayBody, value: { changed: true } });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.error, 'operation_id_payload_conflict');

    // Migration-style compare-and-set cannot overwrite an existing server record.
    const revisionConflict = await request('POST', '/v1/kv/set', {
      namespace: 'flashback',
      operationId: 'test_flashback_expected_0002',
      space: 'plugin',
      key: 'flashback:test:key',
      value: { shouldNotWin: true },
      expectedRevision: 0
    });
    assert.equal(revisionConflict.response.status, 409);
    assert.equal(revisionConflict.payload.error, 'expected_revision_conflict');

    // Credential-like records are rejected even when a client attempts to route them.
    const sensitive = await request('POST', '/v1/kv/set', {
      namespace: 'libra',
      operationId: 'test_libra_sensitive_0001',
      space: 'plugin',
      key: 'libra:v1:provider-secrets',
      value: { apiKey: 'must-not-be-stored' }
    });
    assert.equal(sensitive.response.status, 400);
    assert.equal(sensitive.payload.error, 'credential_keys_must_remain_in_risuai_local_storage');

    const retraceSensitive = await request('POST', '/v1/kv/set', {
      namespace: 'retrace',
      operationId: 'test_retrace_sensitive_0001',
      space: 'plugin',
      key: 'memory_session_bridge:settings:v1',
      value: { provider: 'must-remain-local' }
    });
    assert.equal(retraceSensitive.response.status, 403);
    assert.equal(retraceSensitive.payload.error, 'namespace_write_forbidden:retrace', 'retired writer is rejected before payload-specific credential policy');

    const keys = await request('GET', '/v1/kv/keys?namespace=flashback&space=plugin&prefix=flashback%3Atest', undefined);
    assert.equal(keys.response.status, 200);
    assert.deepEqual(keys.payload.result.keys, ['flashback:test:key']);

    const clientsDenied = await request('GET', '/v1/clients', undefined, pluginHeaders);
    assert.equal(clientsDenied.response.status, 403);
    const clients = await request('GET', '/v1/clients', undefined, adminHeaders);
    assert.equal(clients.response.status, 200);
    assert.ok(clients.payload.result.some(item => item.plugin === 'flashback_memory'));

    const backup = await request('POST', '/v1/admin/backups/create', { kind: 'manual', label: 'integration' }, adminHeaders);
    assert.equal(backup.response.status, 200, JSON.stringify(backup.payload));
    const backupId = backup.payload.result.id;
    assert.ok(backupId);
    for (const namespace of NAMESPACES) {
      const store = backup.payload.result.stores[namespace];
      assert.ok(store.sha256 && store.sha256.length === 64);
      assert.ok(fs.existsSync(path.join(dataDir, 'backups', 'manual', backupId, store.file)));
    }

    // Mutate two namespaces after backup.
    const flashChanged = await request('POST', '/v1/kv/set', {
      namespace: 'flashback',
      operationId: 'test_flashback_change_0003',
      space: 'plugin',
      key: 'flashback:test:key',
      value: { changedAfterBackup: true }
    });
    assert.equal(flashChanged.response.status, 200);
    const hayakuChanged = await request('POST', '/v1/kv/set', {
      namespace: 'hayaku',
      operationId: 'test_hayaku_change_0003',
      space: 'plugin',
      key: 'hayaku:test:key',
      value: { hayakuChangedAfterBackup: true }
    });
    assert.equal(hayakuChanged.response.status, 200);

    // Selective restore rolls back only Flashback.
    const restore = await request('POST', '/v1/admin/restore', { backupId, namespaces: ['flashback'] }, adminHeaders);
    assert.equal(restore.response.status, 200, JSON.stringify(restore.payload));
    assert.deepEqual(restore.payload.result.namespaces, ['flashback']);
    assert.ok(restore.payload.result.preRestoreBackupId);

    // Restore advances reset epochs (P01): stale clients are fenced with 409
    // MEMORY_SUITE_RESET_RECONNECT_REQUIRED, so a caller must re-bootstrap to
    // pick up the new epochs before reading the restored namespaces.
    const staleRead = await request('GET', '/v1/kv/get?namespace=flashback&space=plugin&key=flashback%3Atest%3Akey', undefined);
    assert.equal(staleRead.response.status, 409, 'stale client must be told to reconnect after restore');
    assert.equal(staleRead.payload.error, 'MEMORY_SUITE_RESET_RECONNECT_REQUIRED');

    const rebooted = await jsonFetch(`${baseUrl}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': '0.11.23' }
    });
    assert.equal(rebooted.payload.resetEpochs.flashback, 1, 'flashback epoch must advance by one after restore');
    const reconnected = { ...adminHeaders, 'X-Memory-Suite-Reset-Epochs': JSON.stringify(rebooted.payload.resetEpochs) };

    const flashAfterRestore = await request('GET', '/v1/kv/get?namespace=flashback&space=plugin&key=flashback%3Atest%3Akey', undefined, reconnected);
    assert.equal(flashAfterRestore.payload.result.value.text, 'value-flashback');
    const hayakuAfterRestore = await request('GET', '/v1/kv/get?namespace=hayaku&space=plugin&key=hayaku%3Atest%3Akey', undefined, reconnected);
    assert.equal(hayakuAfterRestore.payload.result.value.hayakuChangedAfterBackup, true);

    // Delete creates a durable tombstone and hides the value.
    const removed = await request('POST', '/v1/kv/remove', {
      namespace: 'libra',
      operationId: 'test_libra_remove_000001',
      space: 'plugin',
      key: 'libra:test:key'
    });
    assert.equal(removed.response.status, 200);
    assert.equal(removed.payload.result.tombstone, true);
    const libraRead = await request('GET', '/v1/kv/get?namespace=libra&space=plugin&key=libra%3Atest%3Akey', undefined);
    assert.equal(libraRead.payload.result.exists, false);
    assert.equal(libraRead.payload.result.tombstone, true);
    assert.equal(libraRead.payload.result.value, null);

    const namespaceIntegrity = await request('GET', '/v1/integrity?namespace=libra');
    assert.equal(namespaceIntegrity.response.status, 200);
    assert.equal(namespaceIntegrity.payload.result.ok, true);
    assert.equal(namespaceIntegrity.payload.result.result, 'ok');

    const integrity = await request('POST', '/v1/admin/integrity', {}, adminHeaders);
    assert.equal(integrity.response.status, 200);
    assert.equal(integrity.payload.result.ok, true);
    for (const namespace of NAMESPACES) assert.equal(integrity.payload.result.stores[namespace].ok, true);

    process.stdout.write('server_integration_test: PASS\n');
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`server_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
