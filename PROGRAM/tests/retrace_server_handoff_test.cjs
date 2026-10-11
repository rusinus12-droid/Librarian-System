'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { seedHistoricalInventory, assertRetiredReadOnly } = require('./fixtures/portable_historical_inventory_fixture.cjs');

const root = path.resolve(__dirname, '..');
const readPlugin = name => fs.readFileSync(path.join(root, 'plugins', name), 'utf8');

function memoryStore(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    async getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    async setItem(key, value) { map.set(String(key), value); return true; },
    async removeItem(key) { map.delete(String(key)); return true; },
    async keys() { return Array.from(map.keys()); }
  };
}

function staticContracts() {
  const retrace = readPlugin('RETRACE.js');
  const installedVersion = retrace.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1];
  assert.ok(installedVersion, 'valid RE:TRACE installation header');
  const runtimeVersion = retrace.match(/const PLUGIN_VERSION = ['"]([^'"]+)['"]/ )?.[1];
  assert.equal(runtimeVersion, installedVersion, 'RE:TRACE runtime and header agree');
  const compactRetrace = retrace.replace(/\s+/g, '');
  for (const marker of [
    "namespace:'retrace'",
    'MemorySuitePeerServerBridges',
    'inspectMemorySuitePeerServerData',
    'peerServerRead',
    'memorySuiteStorageReceiptMatches',
    'serverDataDetected',
    "excludedKeys:[LEGACY_PROVIDER_SETTINGS_KEY,LEGACY_PROVIDER_SETTINGS_LOCAL_BACKUP_KEY]",
    "['flashback','flashback_memory']",
    "['hayaku','hayaku_locator_continuity']",
    "['libra','libra']",
    "['lia','lia_persona_linker']"
  ]) assert.ok(compactRetrace.includes(marker.replace(/\s+/g, '')), `RE:TRACE missing ${marker}`);

  // RE:TRACE must require Librarian System synchronization proof from every owner when server data exists.
  for (const ns of ['flashback', 'hayaku', 'libra', 'lia']) {
    assert.ok(retrace.includes(`memorySuiteStorageReceiptMatches(receipt, '${ns}')`)
      || retrace.includes(`memorySuiteStorageReceiptMatches(last, '${ns}')`), `${ns} server sync receipt validation`);
  }

  const owners = {
    'Flashback_Memory.js': ['flashback_before_adopt', 'flashback_after_adopt'],
    'HAYAKU_Locator_Continuity.js': ['hayaku_before_adopt', 'hayaku_after_adopt'],
    'LIBRA.js': ['libra_before_', 'libra_after_'],
    'LIA_Persona_Linker.js': ['lia_before_adopt_chat_handoff', 'lia_after_adopt_chat_handoff']
  };
  for (const [name, markers] of Object.entries(owners)) {
    const text = readPlugin(name);
    assert.ok(text.includes('ensureHandoffReady'), `${name} handoff storage readiness`);
    for (const marker of markers) assert.ok(text.includes(marker), `${name} phase ${marker}`);
    assert.ok(text.includes('memorySuiteStorage'), `${name} receipt must expose Librarian System proof`);
  }

  // Existing immutable-source safety must remain explicit in the RE:TRACE implementation.
  assert.ok(/source.*(?:unchanged|immutable)|immutable.*source/i.test(retrace), 'source immutability contract must remain visible');
}

async function liveServerNamespaceRead() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-retrace-handoff-'));
  const inventory = await seedHistoricalInventory(dataDir, {
    lia: [{ space: 'plugin', key: 'liaPersonaRequestProofV1:test-scope', value: { canonical: 'lia-server-value' } }],
    retrace: [{ space: 'plugin', key: 'memory_session_bridge:hayaku_cold_start:test-session', value: { capsule: true } }]
  });
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previous = globalThis.risuai;
  const args = { memory_suite_server_mode: 'server_only', memory_suite_server_url: baseUrl };
  try {
    const pluginStorage = memoryStore();
    globalThis.risuai = {
      pluginStorage,
      async getArgument(name) { return args[name] || ''; },
      async setArgument(name, value) { args[name] = String(value); return true; },
      async nativeFetch(url, init) { return await fetch(url, init); }
    };
    const sdkText = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();

    const peerCases = [
      { namespace: 'flashback', pluginId: 'flashback_memory', prefix: 'vector_rag_memory:', key: 'vector_rag_memory:scope:test:manifest:v2' },
      { namespace: 'hayaku', pluginId: 'hayaku_locator_continuity', prefix: 'hayaku.v2.ledger.', key: 'hayaku.v2.ledger.test-scope' },
      { namespace: 'lia', pluginId: 'lia_persona_linker', prefix: 'liaPersonaRequestProofV1', key: 'liaPersonaRequestProofV1:test-scope' },
      { namespace: 'libra', pluginId: 'libra', prefix: 'libra:v1:', key: 'libra:v1:scope:test:manifest' }
    ];
    for (const row of peerCases) {
      const owner = createBridge({
        namespace: row.namespace, pluginId: row.pluginId, pluginVersion: 'test',
        pluginPrefixes: [row.prefix], managementButton: false, migrationDelayMs: 100000,
        currentScopeProvider: async () => ({ scopeId: 'test-scope', scopeKey: 'test-scope', label: 'Test Scope' }),
        resolveKeyScope: async ({ currentScope }) => ({ kind: 'scope', ...currentScope })
      });
      owner.createPluginStorageProxy(pluginStorage);
      await owner.setScopeMode({ scopeId: 'test-scope', scopeKey: 'test-scope', label: 'Test Scope' }, 'server_only');
      if (row.namespace === 'lia') {
        await assert.rejects(owner.set('plugin', row.key, { canonical: 'forbidden-new-value' }), /namespace_write_forbidden:lia/,
          'LIA historical peer inventory is readable, but the retired owner cannot publish new data');
      } else {
        await owner.set('plugin', row.key, { canonical: `${row.namespace}-server-value` });
      }

      // This is the same namespace-bound read-only access pattern RE:TRACE uses for server-only peer inspection.
      const retracePeer = createBridge({
        namespace: row.namespace, pluginId: `flashback_hayaku_bridge:peer:${row.pluginId}`, pluginVersion: '1.9.45',
        managementButton: false, autoMigratePlugin: false, autoMigrateLocal: false
      });
      retracePeer.createPluginStorageProxy(pluginStorage);
      const remote = await retracePeer.serverGet('plugin', row.key);
      assert.equal(remote.exists, true, `${row.namespace} peer read exists`);
      assert.deepEqual(remote.value, { canonical: `${row.namespace}-server-value` }, `${row.namespace} peer readback`);
      const integrity = await retracePeer.serverIntegrity();
      assert.equal(integrity.ok, true, `${row.namespace} peer integrity`);
    }

    const retraceOwn = createBridge({
      namespace: 'retrace', pluginId: 'flashback_hayaku_bridge', pluginVersion: '1.9.45',
      pluginPrefixes: ['memory_session_bridge:hayaku_cold_start:'],
      excludedKeys: ['memory_session_bridge:settings:v1', 'memory_session_bridge:settings_local_backup:v1'],
      managementButton: false, migrationDelayMs: 100000,
      currentScopeProvider: async () => ({ scopeId: 'test-session', scopeKey: 'test-session', label: 'Test Session' }),
      resolveKeyScope: async ({ currentScope }) => ({ kind: 'scope', ...currentScope })
    });
    retraceOwn.createPluginStorageProxy(pluginStorage);
    await retraceOwn.setScopeMode({ scopeId: 'test-session', scopeKey: 'test-session', label: 'Test Session' }, 'server_only');
    const ownKey = 'memory_session_bridge:hayaku_cold_start:test-session';
    await assert.rejects(retraceOwn.set('plugin', ownKey, { capsule: 'forbidden-new-value' }), /namespace_write_forbidden:retrace/);
    assert.deepEqual((await retraceOwn.serverGet('plugin', ownKey)).value, { capsule: true });

    const connection = await retraceOwn.bootstrap();
    const rejected = await fetch(`${baseUrl}/v1/kv/set`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': 'application/json',
        'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge'
      },
      body: JSON.stringify({
        namespace: 'retrace', operationId: 'retrace_sensitive_test_0001', space: 'plugin',
        key: 'memory_session_bridge:settings:v1', value: { provider: 'local-only' }
      })
    });
    assert.equal(rejected.status, 403, 'retired RE:TRACE rejects all new server writes, including provider settings');
    assert.equal((await rejected.json()).error, 'namespace_write_forbidden:retrace');
    await assert.rejects(retraceOwn.serverGet('plugin', 'memory_session_bridge:settings:v1'), /credential_keys_must_remain_in_risuai_local_storage/);
    assert.equal(app.repositories.retrace.database.prepare('SELECT COUNT(*) AS n FROM kv WHERE key=?').get('memory_session_bridge:settings:v1').n, 0);
    assertRetiredReadOnly(app, inventory, { sourceUnchanged: true });

    process.stdout.write('retrace_server_handoff_test: PASS\n');
  } finally {
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

staticContracts();
liveServerNamespaceRead().catch(error => {
  process.stderr.write(`retrace_server_handoff_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
