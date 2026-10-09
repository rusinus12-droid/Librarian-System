'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function fetchPayload(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Memory-Suite-Plugin': 'flashback_memory' } });
  const payload = await response.json();
  return { response, payload };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-sdk-test-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previousRisuai = globalThis.risuai;
  const scope = { scopeId: 'sdk-scope-a', scopeKey: 'sdk-scope-a', label: 'SDK Scope A' };
  const remoteKey = key => key;
  let bridge = null;
  let managerBridge = null;
  try {
    globalThis.risuai = {
      async getArgument(name) {
        if (name === 'memory_suite_server_mode') return 'required';
        if (name === 'memory_suite_server_url') return baseUrl;
        return '';
      },
      async nativeFetch(url, init) { return await fetch(url, init); }
    };

    const sdkText = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
    const legacy = memoryStore({
      'suite:test:old': JSON.stringify({ old: true, count: 1 }),
      'suite:test:auto': 'auto-migrate-me',
      'suite:test:embedding_secret': 'local-secret',
      'suite:test:logical::chunk:v1:old:0000': 'legacy-chunk-piece',
      'unrelated:key': 'unrelated-value'
    });
    const localLegacy = memoryStore({
      'suite:local:vector:1': { vector: [1, 2, 3] },
      'suite:local:secret': 'keep-local'
    });
    bridge = createBridge({
      namespace: 'flashback',
      pluginId: 'flashback_memory',
      pluginVersion: '0.11.23',
      pluginPrefixes: ['suite:test:'],
      pluginKeys: ['__proto__'],
      localPrefixes: ['suite:local:vector:'],
      excludedContains: ['embedding_secret', 'suite:local:secret'],
      migrationConcurrency: 2,
      keyPageSize: 3,
      getManyResponseBudgetBytes: 256 * 1024,
      interactiveSetValueBudgetBytes: 4 * 1024 * 1024,
      currentScopeProvider: async () => scope
    });
    const proxy = bridge.createPluginStorageProxy(legacy);
    const localProxy = bridge.createLocalStorageProxy(localLegacy);
    const connection = await bridge.bootstrap();
    assert.equal(connection.protocol.major, 1);
    assert.equal(connection.capabilities['tombstone.v1'], true);
    assert.equal(connection.capabilities['server-namespace-read.v1'], true);
    assert.equal(connection.capabilities['handoff-sync-proof.v1'], true);

    // A first read performs non-destructive lazy migration.
    const old = await proxy.getItem('suite:test:old');
    assert.equal(old, JSON.stringify({ old: true, count: 1 }));
    assert.equal(legacy.map.has('suite:test:old'), true, 'legacy source must remain untouched');
    const oldRemote = await fetchPayload(`${baseUrl}/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(remoteKey('suite:test:old'))}`, connection.token);
    assert.equal(oldRemote.payload.result.exists, true);
    assert.equal(oldRemote.payload.result.value, old);

    // New writes are server-authoritative and are not mirrored back into legacy storage.
    await proxy.setItem('suite:test:new', { serverOnly: true });
    assert.equal(legacy.map.has('suite:test:new'), false);
    assert.deepEqual(await proxy.getItem('suite:test:new'), { serverOnly: true });

    // Local vector sidecars use the same server protocol.
    assert.deepEqual(await localProxy.getItem('suite:local:vector:1'), { vector: [1, 2, 3] });
    await localProxy.setItem('suite:local:vector:2', { vector: [4, 5, 6] });
    assert.equal(localLegacy.map.has('suite:local:vector:2'), false);

    // Excluded credentials remain in the original local/RisuAI storage.
    assert.equal(await proxy.getItem('suite:test:embedding_secret'), 'local-secret');
    await proxy.setItem('suite:test:embedding_secret', 'changed-locally');
    assert.equal(legacy.map.get('suite:test:embedding_secret'), 'changed-locally');
    const excludedRemote = await fetchPayload(`${baseUrl}/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent('suite:test:embedding_secret')}`, connection.token);
    assert.equal(excludedRemote.response.status, 400, 'server independently rejects credential-like keys');

    // Background enumeration migrates the remaining routed legacy key.
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const status = bridge.status().migration.plugin;
      if (['complete', 'partial', 'lazy_only'].includes(status.state)) break;
      await sleep(50);
    }
    const migration = bridge.status().migration.plugin;
    assert.equal(migration.state, 'complete', JSON.stringify(migration));
    assert.ok(migration.scanned >= 2);
    const autoRemote = await fetchPayload(`${baseUrl}/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(remoteKey('suite:test:auto'))}`, connection.token);
    assert.equal(autoRemote.payload.result.value, 'auto-migrate-me');
    const chunkRemote = await fetchPayload(`${baseUrl}/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(remoteKey('suite:test:logical::chunk:v1:old:0000'))}`, connection.token);
    assert.equal(chunkRemote.payload.result.exists, false, 'legacy chunk artifacts must not be promoted');

    // Tombstone blocks resurrection from the untouched legacy source.
    await proxy.removeItem('suite:test:old');
    assert.equal(legacy.map.has('suite:test:old'), true, 'migration/removal must not destroy legacy source');
    assert.equal(await proxy.getItem('suite:test:old'), null);
    const tombstone = await fetchPayload(`${baseUrl}/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent(remoteKey('suite:test:old'))}`, connection.token);
    assert.equal(tombstone.payload.result.tombstone, true);

    const integrity = await bridge.serverIntegrity();
    assert.equal(integrity.ok, true);
    const directRemote = await bridge.serverGet('plugin', remoteKey('suite:test:new'));
    assert.equal(directRemote.exists, true);
    assert.deepEqual(directRemote.value, { serverOnly: true });
    const directKeys = await bridge.serverKeys('plugin', 'suite:test:');
    assert.ok(directKeys.keys.includes(remoteKey('suite:test:new')));

    // The SDK opts into server pagination and reconstructs one logical result.
    const pagedKeys = [];
    for (let index = 0; index < 120; index += 1) {
      const key = `suite:test:paged:${String(index).padStart(3, '0')}`;
      pagedKeys.push(key);
      await proxy.setItem(key, { index, text: `page-${index}` });
    }
    const pagedListing = await bridge.serverKeys('plugin', 'suite:test:paged:');
    assert.deepEqual(pagedListing.keys, pagedKeys);
    assert.ok(Number(pagedListing.page?.pages || 0) >= 3, JSON.stringify(pagedListing.page));

    const batchKeys = [];
    for (let index = 0; index < 3; index += 1) {
      const key = `suite:test:batch:${index}`;
      batchKeys.push(key);
      await proxy.setItem(key, { index, text: 'b'.repeat(180 * 1024) });
    }
    const batch = await bridge.serverGetMany('plugin', batchKeys);
    assert.equal(batch.pages, 3);
    for (const key of batchKeys) assert.equal(batch.values[key].value.text.length, 180 * 1024);

    const oversizedBatchKey = 'suite:test:batch:oversized';
    await proxy.setItem(oversizedBatchKey, { text: 'o'.repeat(300 * 1024) });
    const oversizedBatch = await bridge.serverGetMany('plugin', [oversizedBatchKey]);
    assert.deepEqual(oversizedBatch.oversizedKeys, [oversizedBatchKey]);
    assert.equal(oversizedBatch.values[oversizedBatchKey].value.text.length, 300 * 1024);

    // Opaque owner keys must remain ordinary data even when they match an
    // inherited Object.prototype setter. Both owner and manager batch paths
    // must define an own property without changing the accumulator prototype.
    await proxy.setItem('__proto__', { safeOpaqueKey: true });
    const prototypeBatch = await bridge.serverGetMany('plugin', ['__proto__']);
    assert.equal(Object.getPrototypeOf(prototypeBatch.values), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(prototypeBatch.values, '__proto__'), true);
    assert.deepEqual(prototypeBatch.values.__proto__.value, { safeOpaqueKey: true });
    managerBridge = createBridge({
      namespace: 'retrace',
      pluginId: 'flashback_hayaku_bridge',
      pluginVersion: '1.9.67',
      managementButton: false,
      scopeRouting: false
    });
    await managerBridge.managerConnection();
    const managerPrototypeBatch = await managerBridge.managerServerGetMany('flashback', 'plugin', ['__proto__']);
    assert.equal(Object.getPrototypeOf(managerPrototypeBatch.values), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(managerPrototypeBatch.values, '__proto__'), true);
    assert.deepEqual(managerPrototypeBatch.values.__proto__.value, { safeOpaqueKey: true });

    await assert.rejects(
      () => proxy.setItem('suite:test:too-large', { text: 'x'.repeat((4 * 1024 * 1024) + 1) }),
      error => error?.code === 'MEMORY_SUITE_INTERACTIVE_VALUE_TOO_LARGE'
        && Number(error?.valueBytes || 0) > Number(error?.maxValueBytes || 0)
    );
    const rejectedRemote = await bridge.serverGet('plugin', 'suite:test:too-large');
    assert.equal(rejectedRemote.exists, false, 'oversized interactive values are rejected before network mutation');

    const allKeys = await proxy.keys();
    assert.ok(allKeys.includes('suite:test:new'));
    assert.ok(allKeys.includes('suite:test:auto'));
    assert.ok(!allKeys.includes('suite:test:old'));
    assert.ok(allKeys.includes('unrelated:key'), 'unrouted legacy keys must remain visible to the original plugin API');

    process.stdout.write('sdk_integration_test: PASS\n');
  } finally {
    try { await managerBridge?.dispose?.(); } catch (_) {}
    try { await bridge?.dispose?.(); } catch (_) {}
    if (previousRisuai === undefined) delete globalThis.risuai;
    else globalThis.risuai = previousRisuai;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`sdk_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
