'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function main() {
  const previous = globalThis.risuai;
  let networkCalls = 0;
  const scope = { scopeId: 'plugin-only-scope', scopeKey: 'plugin-only-scope', label: 'Plugin Only' };
  try {
    const pluginStorage = memoryStore({
      '__memory_suite_internal_scope_routes_v1__:lia': JSON.stringify({
        schema: 'memory-suite.scope-routes.v1', version: 1, namespace: 'lia', pluginId: 'lia_persona_linker',
        legacyGlobalModeImported: true, updatedAt: Date.now(),
        entries: {
          'plugin-only-scope': { ...scope, mode: 'plugin_only', updatedAt: Date.now() },
          'foreign-server-scope': { scopeId: 'foreign-server-scope', scopeKey: 'foreign-server-scope', label: 'Foreign Mirror', mode: 'mirror', updatedAt: Date.now() }
        }
      })
    });
    globalThis.risuai = {
      pluginStorage,
      async getArgument(name) {
        if (name === 'memory_suite_server_mode') return 'plugin_only';
        if (name === 'memory_suite_server_url') return 'http://127.0.0.1:47630';
        return '';
      },
      async setArgument() { return true; },
      async nativeFetch() {
        networkCalls += 1;
        throw new SyntaxError('Expected double-quoted property name in JSON at position 18 (line 1 column 19)');
      }
    };
    const sdkText = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
    const legacy = memoryStore({
      'scope:item': { local: true },
      'foreign:item': { foreignLocal: true },
      'shared:item': { sharedLocal: true },
      'remove:item': { removable: true }
    });
    const bridge = createBridge({
      namespace: 'lia', pluginId: 'lia_persona_linker', pluginVersion: '0.26.39',
      pluginPrefixes: ['scope:'], managementButton: false, migrationDelayMs: 10,
      currentScopeProvider: async () => scope,
      preResolveKeyScope: true,
      resolveKeyScope: async ({ key }) => {
        if (String(key).startsWith('shared:')) return { kind: 'shared' };
        if (String(key).startsWith('foreign:')) return { kind: 'scope', scopeId: 'foreign-server-scope', scopeKey: 'foreign-server-scope' };
        return { kind: 'scope', ...scope };
      }
    });
    const proxy = bridge.createPluginStorageProxy(legacy);
    assert.deepEqual(await proxy.getItem('scope:item'), { local: true });
    assert.deepEqual(await proxy.getItem('foreign:item'), { foreignLocal: true }, 'foreign mirror key remains local while current scope is plugin-only');
    assert.deepEqual(await proxy.getItem('shared:item'), { sharedLocal: true }, 'shared key remains local while current scope is plugin-only');
    assert.equal(await proxy.setItem('shared:new', { localWrite: true }), true);
    assert.deepEqual(await legacy.getItem('shared:new'), { localWrite: true });
    assert.equal(await proxy.removeItem('remove:item'), true);
    assert.equal(await legacy.getItem('remove:item'), null);
    assert.ok((await proxy.keys()).includes('scope:item'));
    assert.ok((await proxy.keys()).includes('foreign:item'), 'mixed registry must not force remote key enumeration');
    await bridge.setScopeMode(scope, 'plugin_only');
    await delay(1500);
    assert.equal(networkCalls, 0, 'plugin_only get/set/remove/keys/mode apply/startup must stay offline even with foreign mirror scopes');

    await assert.rejects(
      () => bridge.serverGet('plugin', 'scope:item'),
      error => error?.code === 'MEMORY_SUITE_SERVER_UNAVAILABLE' && error?.message === 'memory_suite_server_unavailable'
    );
    assert.equal(networkCalls, 1, 'first explicit server read performs one availability request');

    const peer = createBridge({
      namespace: 'flashback', pluginId: 'flashback_hayaku_bridge:peer:flashback_memory', pluginVersion: '1.9.47',
      managementButton: false, autoMigratePlugin: false, autoMigrateLocal: false, scopeRouting: false,
      startupDiagnostics: false
    });
    await assert.rejects(
      () => peer.serverGet('plugin', 'vector_rag_memory:test'),
      error => error?.code === 'MEMORY_SUITE_SERVER_UNAVAILABLE' && error?.cached === true
    );
    assert.equal(networkCalls, 1, 'a second bridge reuses the shared offline cache instead of probing again');

    const explicitRetry = await peer.testConnection('http://127.0.0.1:47630');
    assert.equal(explicitRetry.ok, false);
    assert.equal(explicitRetry.error, 'memory_suite_server_unavailable');
    assert.equal(networkCalls, 2, 'manual connection test bypasses the automatic offline cache');
    process.stdout.write('plugin_only_network_isolation_test: PASS\n');
  } finally {
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
  }
}

main().catch(error => {
  process.stderr.write(`plugin_only_network_isolation_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
