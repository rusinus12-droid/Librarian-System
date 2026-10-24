'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createMemorySuiteServer } = require('../server/server.cjs');

test('Global duplicate storage cleanup test for LIBRA, HAYAKU, and Flashback', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-global-cleanup-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previousRisuai = globalThis.risuai;
  const args = { memory_suite_server_mode: 'server_only', memory_suite_server_url: baseUrl };
  globalThis.risuai = {
    async getArgument(name) { return args[name] || ''; },
    async setArgument(name, value) { args[name] = String(value); return true; },
    async nativeFetch(url, init) { return await fetch(url, init); }
  };

  try {
    const namespaces = ['libra', 'hayaku', 'flashback'];

    for (const ns of namespaces) {
      const sdkFile = ns === 'libra'
        ? path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.libra.source.js')
        : path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.source.js');
      const sdkText = fs.readFileSync(sdkFile, 'utf8');
      const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();

      const scope1 = { scopeId: `chat-alpha-${ns}`, scopeKey: `chat-alpha-${ns}`, label: 'Chat Alpha' };
      const scope2 = { scopeId: `chat-beta-${ns}`, scopeKey: `chat-beta-${ns}`, label: 'Chat Beta' };

      const keyPrefix = ns === 'libra'
        ? 'libra:v1:scope:'
        : (ns === 'flashback' ? 'vector_rag_memory:scope:' : 'hayaku_recall::');

      const key1 = `${keyPrefix}${scope1.scopeId}:memory`;
      const key2 = `${keyPrefix}${scope2.scopeId}:memory`;
      const settingsKey = ns === 'flashback' ? 'vector_rag_memory:settings' : `${ns}:settings`;

      const storeMap = new Map([
        [key1, { content: 'memory of chat alpha', v: 1 }],
        [key2, { content: 'memory of chat beta', v: 2 }],
        [settingsKey, { pluginSettings: true }],
        ['__memory_suite_server_config__', { url: baseUrl, mode: 'server_only' }],
        ['__memory_suite_scope_routing_registry__', {
          schema: 'memory-suite.scope-routing-registry.v1',
          entries: {
            '__plugin_global__': { scopeId: '__plugin_global__', mode: 'server_only' },
            [scope1.scopeId]: { scopeId: scope1.scopeId, mode: 'server_only', origin: 'inherited' },
            [scope2.scopeId]: { scopeId: scope2.scopeId, mode: 'server_only', origin: 'inherited' }
          }
        }]
      ]);

      const legacyStore = {
        async getItem(k) { return storeMap.has(k) ? JSON.stringify(storeMap.get(k)) : null; },
        async setItem(k, v) { storeMap.set(k, typeof v === 'string' ? JSON.parse(v) : v); return true; },
        async removeItem(k) { storeMap.delete(k); return true; },
        async keys() { return Array.from(storeMap.keys()); }
      };

      let currentScope = null; // simulate settings panel opened from RisuAI plugins menu with NO active chat!

      const bridge = createBridge({
        namespace: ns,
        pluginId: ns,
        pluginVersion: '2.0.0',
        pluginPrefixes: [ns === 'libra' ? 'libra:v1:' : (ns === 'flashback' ? 'vector_rag_memory:' : 'hayaku_recall::')],
        currentScopeProvider: async () => currentScope,
        resolveKeyScope: async ({ key }) => {
          if (key.includes(scope1.scopeId)) return { kind: 'scope', ...scope1 };
          if (key.includes(scope2.scopeId)) return { kind: 'scope', ...scope2 };
          return { kind: 'global' };
        }
      });
      bridge.createPluginStorageProxy(legacyStore);

      // Connect to server
      await bridge.setServerUrl(baseUrl);

      // Case 1: Server does not have the records yet -> globalVerifyPreservation MUST fail
      await assert.rejects(
        async () => await bridge.globalVerifyPreservation(),
        /memory_suite_global_preservation_failed/i,
        `${ns}: verify must fail when server does not have the records`
      );

      // Now populate server with matching records
      const token = (await bridge.bootstrap()).token;
      for (const [k, v] of [[key1, { content: 'memory of chat alpha', v: 1 }], [key2, { content: 'memory of chat beta', v: 2 }]]) {
        const res = await fetch(`${baseUrl}/v1/kv/set`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Memory-Suite-Plugin': ns,
            'X-Memory-Suite-Plugin-Version': '1.0.0'
          },
          body: JSON.stringify({
            namespace: ns,
            space: 'plugin',
            key: k,
            value: v,
            operationId: `test-${k}`
          })
        });
        assert.equal(res.status, 200, `set ${k} must return 200`);
      }

      // Case 2: Server has exact matching records -> globalVerifyPreservation MUST succeed
      const verifyResult = await bridge.globalVerifyPreservation();
      assert.equal(verifyResult.ok, true, `${ns}: verify should pass when server has exact data`);
      assert.equal(verifyResult.checked, 2, `${ns}: should have checked both scope records`);

      // Case 3: Execute global deletion
      const deleteResult = await bridge.globalDeletePluginStorageAfterVerification();
      assert.equal(deleteResult.ok, true, `${ns}: delete must succeed`);
      assert.equal(deleteResult.deleted, 2, `${ns}: should delete the 2 duplicate scope records`);

      // Verify local store contents
      assert.equal(storeMap.has(key1), false, `${ns}: key1 must be deleted from local store`);
      assert.equal(storeMap.has(key2), false, `${ns}: key2 must be deleted from local store`);
      assert.equal(storeMap.has(settingsKey), true, `${ns}: settingsKey must be preserved`);
      assert.equal(storeMap.has('__memory_suite_server_config__'), true, `${ns}: server config must be preserved`);
      assert.equal(storeMap.has('__memory_suite_scope_routing_registry__'), true, `${ns}: scope routing registry must be preserved`);

      // Case 4: Verify again when duplicates are already deleted -> 0 items
      const verifyAfter = await bridge.globalVerifyPreservation();
      assert.equal(verifyAfter.ok, true, `${ns}: verify after delete should be ok`);
      assert.equal(verifyAfter.checked, 0, `${ns}: checked count should be 0 when already cleaned`);

      bridge.dispose?.();
    }
  } finally {
    if (previousRisuai === undefined) delete globalThis.risuai; else globalThis.risuai = previousRisuai;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
