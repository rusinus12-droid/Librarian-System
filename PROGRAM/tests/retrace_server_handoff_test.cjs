'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { seedHistoricalInventory, assertRetiredReadOnly } = require('./fixtures/portable_historical_inventory_fixture.cjs');

let diagnosticPhase = 'static-contracts';
let diagnosticSequence = 0;
const originalFetch = globalThis.fetch;
const sanitizedUrl = value => {
  try { const parsed = new URL(String(value)); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
  catch (_) { return '[invalid-url]'; }
};
const sanitizedText = value => String(value || '').replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
  .replace(/https?:\/\/[^\s)]+/g, url => sanitizedUrl(url));
function diagnosticError(error, depth = 0) {
  if (!error || depth > 3) return null;
  const result = {};
  for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'address', 'port', 'stack']) {
    if (error[key] !== undefined) result[key] = typeof error[key] === 'number' ? error[key] : sanitizedText(error[key]);
  }
  if (error.cause) result.cause = diagnosticError(error.cause, depth + 1);
  if (Array.isArray(error.errors)) result.errors = error.errors.map(item => diagnosticError(item, depth + 1));
  return result;
}
const diagnostic = fields => process.stderr.write(JSON.stringify({ test: 'retrace_server_handoff_diagnostic', phase: diagnosticPhase, ...fields }) + '\n');
async function diagnosticFetch(url, init = {}, transport = 'nativeFetch') {
  const sequence = ++diagnosticSequence, started = Date.now();
  const context = { sequence, transport, url: sanitizedUrl(url), method: String(init.method || 'GET').toUpperCase(), phase: diagnosticPhase };
  diagnostic({ ...context, event: 'request', abortSignalPresent: !!init.signal, signalAborted: init.signal?.aborted === true });
  try {
    const response = await originalFetch(url, init);
    diagnostic({ ...context, event: 'response', status: response.status, ok: response.ok, elapsedMs: Date.now() - started });
    return response;
  } catch (error) {
    diagnostic({ ...context, event: 'request-error', elapsedMs: Date.now() - started, error: diagnosticError(error) });
    throw error;
  }
}

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
  diagnosticPhase = 'seed-historical-inventory';
  const inventory = await seedHistoricalInventory(dataDir, {
    lia: [{ space: 'plugin', key: 'liaPersonaRequestProofV1:test-scope', value: { canonical: 'lia-server-value' } }],
    retrace: [{ space: 'plugin', key: 'memory_session_bridge:hayaku_cold_start:test-session', value: { capsule: true } }]
  });
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  diagnosticPhase = 'server-listen';
  diagnostic({event:'listen-start',host:'127.0.0.1',requestedPort:0});
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  diagnostic({event:'listen-ready',baseUrl:sanitizedUrl(baseUrl),address:address.address,family:address.family,port:address.port});
  const previous = globalThis.risuai;
  const args = { memory_suite_server_mode: 'server_only', memory_suite_server_url: baseUrl };
  try {
    const pluginStorage = memoryStore();
    globalThis.risuai = {
      pluginStorage,
      async getArgument(name) { return args[name] || ''; },
      async setArgument(name, value) { args[name] = String(value); return true; },
      async nativeFetch(url, init) { return await diagnosticFetch(url, init); }
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
      diagnosticPhase = `${row.namespace}:owner-create`;
      const owner = createBridge({
        namespace: row.namespace, pluginId: row.pluginId, pluginVersion: 'test',
        pluginPrefixes: [row.prefix], managementButton: false, migrationDelayMs: 100000,
        currentScopeProvider: async () => ({ scopeId: 'test-scope', scopeKey: 'test-scope', label: 'Test Scope' }),
        resolveKeyScope: async ({ currentScope }) => ({ kind: 'scope', ...currentScope })
      });
      owner.createPluginStorageProxy(pluginStorage);
      diagnosticPhase = `${row.namespace}:owner-server-only-mode`;
      await owner.setScopeMode({ scopeId: 'test-scope', scopeKey: 'test-scope', label: 'Test Scope' }, 'server_only');
      diagnosticPhase = `${row.namespace}:owner-write-or-retired-refusal`;
      if (row.namespace === 'lia') {
        await assert.rejects(owner.set('plugin', row.key, { canonical: 'forbidden-new-value' }), /namespace_write_forbidden:lia/,
          'LIA historical peer inventory is readable, but the retired owner cannot publish new data');
      } else {
        await owner.set('plugin', row.key, { canonical: `${row.namespace}-server-value` });
      }

      // This is the same namespace-bound read-only access pattern RE:TRACE uses for server-only peer inspection.
      diagnosticPhase = `${row.namespace}:peer-create`;
      const retracePeer = createBridge({
        namespace: row.namespace, pluginId: `flashback_hayaku_bridge:peer:${row.pluginId}`, pluginVersion: '1.9.45',
        managementButton: false, autoMigratePlugin: false, autoMigrateLocal: false
      });
      retracePeer.createPluginStorageProxy(pluginStorage);
      diagnosticPhase = `${row.namespace}:peer-read`;
      const remote = await retracePeer.serverGet('plugin', row.key);
      assert.equal(remote.exists, true, `${row.namespace} peer read exists`);
      assert.deepEqual(remote.value, { canonical: `${row.namespace}-server-value` }, `${row.namespace} peer readback`);
      diagnosticPhase = `${row.namespace}:peer-integrity`;
      const integrity = await retracePeer.serverIntegrity();
      assert.equal(integrity.ok, true, `${row.namespace} peer integrity`);
    }

    diagnosticPhase = 'retrace:owner-create';
    const retraceOwn = createBridge({
      namespace: 'retrace', pluginId: 'flashback_hayaku_bridge', pluginVersion: '1.9.45',
      pluginPrefixes: ['memory_session_bridge:hayaku_cold_start:'],
      excludedKeys: ['memory_session_bridge:settings:v1', 'memory_session_bridge:settings_local_backup:v1'],
      managementButton: false, migrationDelayMs: 100000,
      currentScopeProvider: async () => ({ scopeId: 'test-session', scopeKey: 'test-session', label: 'Test Session' }),
      resolveKeyScope: async ({ currentScope }) => ({ kind: 'scope', ...currentScope })
    });
    retraceOwn.createPluginStorageProxy(pluginStorage);
    diagnosticPhase = 'retrace:owner-server-only-mode';
    await retraceOwn.setScopeMode({ scopeId: 'test-session', scopeKey: 'test-session', label: 'Test Session' }, 'server_only');
    const ownKey = 'memory_session_bridge:hayaku_cold_start:test-session';
    diagnosticPhase = 'retrace:retired-write-refusal';
    await assert.rejects(retraceOwn.set('plugin', ownKey, { capsule: 'forbidden-new-value' }), /namespace_write_forbidden:retrace/);
    diagnosticPhase = 'retrace:historical-read';
    assert.deepEqual((await retraceOwn.serverGet('plugin', ownKey)).value, { capsule: true });

    diagnosticPhase = 'retrace:bootstrap-before-direct-sensitive-write';
    const connection = await retraceOwn.bootstrap();
    diagnosticPhase = 'retrace:direct-sensitive-write-refusal';
    const rejected = await diagnosticFetch(`${baseUrl}/v1/kv/set`, {
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
    }, 'direct-sensitive-write-fetch');
    assert.equal(rejected.status, 403, 'retired RE:TRACE rejects all new server writes, including provider settings');
    assert.equal((await rejected.json()).error, 'namespace_write_forbidden:retrace');
    diagnosticPhase = 'retrace:credential-read-refusal';
    await assert.rejects(retraceOwn.serverGet('plugin', 'memory_session_bridge:settings:v1'), /credential_keys_must_remain_in_risuai_local_storage/);
    assert.equal(app.repositories.retrace.database.prepare('SELECT COUNT(*) AS n FROM kv WHERE key=?').get('memory_session_bridge:settings:v1').n, 0);
    diagnosticPhase = 'retrace:durable-retired-inventory-unchanged';
    assertRetiredReadOnly(app, inventory, { sourceUnchanged: true });

    process.stdout.write('retrace_server_handoff_test: PASS\n');
  } catch (error) {
    diagnostic({event:'case-error-before-cleanup',error:diagnosticError(error)});
    throw error;
  } finally {
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
    diagnosticPhase = 'server-close';
    diagnostic({event:'close-start'});
    await app.close();
    diagnostic({event:'close-complete'});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  staticContracts();
  await liveServerNamespaceRead();
  await require('./fixtures/storage_sdk_initial_scope_url.cjs').verifyInitialScopeUrl({ allControls: true });
}

if (require.main === module) main().catch(error => {
  diagnostic({event:'root-error',error:diagnosticError(error)});
  process.stderr.write(`retrace_server_handoff_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
