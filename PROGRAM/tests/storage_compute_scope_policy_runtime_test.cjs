'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
const { createMemorySuiteStorageBridge } = new Function(`${source}\nreturn { createMemorySuiteStorageBridge };`)();

const values = new Map();
const pluginStorage = {
  async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return [...values.keys()]; }
};
const api = {
  pluginStorage,
  async getArgument(name) {
    if (String(name) === 'memory_suite_server_mode') return 'plugin_only';
    if (String(name) === 'memory_suite_server_url') return 'http://127.0.0.1:47630';
    return '';
  },
  async setArgument() { return true; }
};

const scopes = {
  local: { scopeId: 'scope-local', scopeKey: 'scope-local', characterId: 'character', chatId: 'local' },
  mirror: { scopeId: 'scope-mirror', scopeKey: 'scope-mirror', characterId: 'character', chatId: 'mirror' },
  server: { scopeId: 'scope-server', scopeKey: 'scope-server', characterId: 'character', chatId: 'server' }
};
values.set('__memory_suite_internal_scope_routes_v1__:policy_test', JSON.stringify({
  schema: 'memory-suite.scope-routing.v1',
  version: 1,
  legacyGlobalModeImported: true,
  updatedAt: Date.now(),
  entries: {
    [scopes.local.scopeId]: { ...scopes.local, mode: 'plugin_only', updatedAt: 1 },
    [scopes.mirror.scopeId]: { ...scopes.mirror, mode: 'mirror', updatedAt: 2 },
    [scopes.server.scopeId]: { ...scopes.server, mode: 'server_only', updatedAt: 3 }
  }
}));

(async () => {
  const previousRisuai = globalThis.risuai;
  globalThis.risuai = api;
  const bridge = createMemorySuiteStorageBridge({
    namespace: 'policy_test',
    pluginId: 'policy_test',
    pluginVersion: 'test',
    api,
    currentScopeProvider: async () => scopes.local,
    startupDiagnostics: false,
    managementButton: false,
    autoMigratePlugin: false,
    autoMigrateLocal: false
  });
  try {
    const local = await bridge.getScopeExecutionPolicy(scopes.local, { force: true });
    const mirror = await bridge.getScopeExecutionPolicy(scopes.mirror, { force: true });
    const server = await bridge.getScopeExecutionPolicy(scopes.server, { force: true });
    assert.equal(local.schema, 'memory-suite.scope-execution-policy.v1');
    assert.deepEqual([local.storageMode, local.configuredRoute, Object.hasOwn(local, 'computeMode')], ['plugin_only', 'local', false]);
    assert.deepEqual([mirror.storageMode, mirror.configuredRoute, Object.hasOwn(mirror, 'computeMode')], ['mirror', 'server', false]);
    assert.deepEqual([server.storageMode, server.configuredRoute, Object.hasOwn(server, 'computeMode')], ['server_only', 'server', false]);
    assert.ok([local, mirror, server].every(item => item.lockedByStorageMode === true));
    const settings = await bridge.getConnectionSettings({ scope: scopes.mirror, force: true });
    // Compute is retired: the policy derives no compute mode.
    assert.equal(Object.hasOwn(settings.executionPolicy, 'computeMode'), false);
    assert.equal(settings.mode, 'mirror');
    process.stdout.write('storage_compute_scope_policy_runtime_test: PASS\n');
  } finally {
    await bridge.dispose();
    if (previousRisuai === undefined) delete globalThis.risuai;
    else globalThis.risuai = previousRisuai;
  }
})().catch(error => {
  process.stderr.write(`storage_compute_scope_policy_runtime_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
