'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const {createMemorySuiteServer} = require('../server/server.cjs');
const source = fs.readFileSync(process.env.LIBRA_CAPTURE_REPAIR_SDK || path.join(__dirname, '../sdk/MemorySuiteStorageClient.libra.source.js'), 'utf8');
const createBridge = new Function(source + '\nreturn createMemorySuiteStorageBridge;')();
const scope = {scopeId: 'capture-sdk-scope', scopeKey: 'capture-sdk-scope', available: true};
const key = 'libra:v1:scope:capture-sdk-scope:source-receipt-capture:wl_sdk:e0:t1:revision1';
const expected = JSON.stringify({schema: 'libra.completed_turn_capture.v1', exact: 'raw bytes 한글😀', variants: ['retired']});
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-capture-sdk-repair-'));
  const app = createMemorySuiteServer({host: '127.0.0.1', port: 0, dataDir: dir, autoBackup: false});
  const prior = globalThis.risuai, bridges = [];
  let mode = 'mirror', hook = null, passed = 0;
  try {
    const address = await app.listen(), url = `http://127.0.0.1:${address.port}`;
    globalThis.risuai = {getArgument: async name => name === 'memory_suite_server_url' ? url : name === 'memory_suite_server_mode' ? mode : '',
      nativeFetch: async (u, init) => {await hook?.(u, init); return fetch(u, init);}};
    const make = (namespace = 'libra', resolveKeyScope = ({currentScope}) => ({kind: 'scope', ...currentScope}), ownerScope = scope) => {
      const local = new Map(), writes = [];
      const backend = {getItem: async k => local.get(k) ?? null, setItem: async (k, v) => {writes.push({key: k, value: v}); local.set(k, v); return true;},
        removeItem: async k => {local.delete(k); return true;}, keys: async () => [...local.keys()]};
      const bridge = createBridge({namespace, pluginId: namespace, pluginPrefixes: ['libra:'], localPrefixes: ['libra:'],
        managementButton: false, startupDiagnostics: false, autoMigratePlugin: false, autoMigrateLocal: false,
        currentScopeProvider: async () => ownerScope, resolveKeyScope});
      bridges.push(bridge);
      const proxy = bridge.createPluginStorageProxy(backend);
      bridge.createLocalStorageProxy(backend);
      return {bridge, proxy, local, writes};
    };
    const test = async (name, fn) => {await fn(); passed++; console.log('PASS', name);};
    const f = make();
    await f.proxy.setItem(key, expected);
    const repair = extra => ({scope, completedTurnCaptureRepair: {expectedServerValue: expected, assertCurrent: async () => {}, ...extra}});
    const get = (options = repair()) => f.bridge.get('plugin', key, () => f.local.get(key) ?? null, null, null, options);

    await test('opt-in exact server capture repairs a missing local copy without advancing server revision', async () => {
      const before = await f.bridge.serverGet('plugin', key);
      f.local.delete(key);
      assert.equal(await get(), expected);
      assert.equal(f.local.get(key), expected);
      assert.equal((await f.bridge.serverGet('plugin', key)).revision, before.revision);
    });
    await test('late local appearance during currentness validation is retained without a physical set', async () => {
      f.local.delete(key);
      const appeared = JSON.stringify({rawVariants: ['concurrent-retired-variant']});
      const before = f.writes.length;
      await assert.rejects(() => get(repair({assertCurrent: async () => {f.local.set(key, appeared);}})), /LOCAL_CHANGED/);
      assert.equal(f.local.get(key), appeared);
      assert.equal(f.writes.length, before);
    });
    await test('ordinary mirror get retains its existing server-authoritative behavior without the opt-in guard', async () => {
      assert.equal(await get({scope}), expected);
      assert.equal(f.local.get(key), expected);
    });
    await test('exact-equal local arrival is accepted as the same physical capture', async () => {
      f.local.delete(key);
      assert.equal(await get(repair({assertCurrent: async () => {f.local.set(key, expected);}})), expected);
      assert.equal(f.local.get(key), expected);
    });
    await test('changed server payload rejects before touching a missing local copy', async () => {
      await f.proxy.setItem(key, expected + ' changed-authority');
      f.local.delete(key);
      const before = f.writes.length;
      await assert.rejects(() => get(), /SERVER_CHANGED/);
      assert.equal(f.local.has(key), false);
      assert.equal(f.writes.length, before);
      await f.proxy.setItem(key, expected);
    });
    await test('server authority changed during currentness validation rejects before physical local copy', async () => {
      f.local.delete(key);
      const before = f.writes.length;
      const boot = await fetch(url + '/bootstrap', {headers: {'X-Memory-Suite-Plugin': 'libra'}}).then(r => r.json());
      const advance = async () => {
        const row = await f.bridge.serverGet('plugin', key);
        const response = await fetch(url + '/v1/kv/batch', {method: 'POST', headers: {
          Authorization: 'Bearer ' + boot.token, 'X-Memory-Suite-Plugin': 'libra', 'Content-Type': 'application/json'},
          body: JSON.stringify({namespace: 'libra', operationId: 'capture_external_' + Date.now(), mutations: [
            {space: 'plugin', key, kind: 'set', value: expected + ' concurrent-server-capture',
              expectedExists: row.exists, expectedTombstone: row.tombstone, expectedRevision: row.revision, expectedDigest: row.digest}]})});
        assert.equal(response.status, 200);
      };
      await assert.rejects(() => get(repair({assertCurrent: advance})), /SERVER_CHANGED/);
      assert.equal(f.local.has(key), false);
      assert.equal(f.writes.length, before);
      assert.equal((await f.bridge.serverGet('plugin', key)).value, expected + ' concurrent-server-capture');
      await f.proxy.setItem(key, expected);
    });
    await test('server tombstone rejects while retaining local-only capture bytes', async () => {
      await f.proxy.removeItem(key);
      f.local.set(key, 'retained-local-only');
      const before = f.writes.length;
      await assert.rejects(() => get(), /SERVER_CHANGED/);
      assert.equal(f.local.get(key), 'retained-local-only');
      assert.equal(f.writes.length, before);
      await f.proxy.setItem(key, expected);
    });
    await test('read-only snapshot, foreign scope, wrong key family and local space deny opt-in repair', async () => {
      const before = f.writes.length;
      await assert.rejects(() => get({...repair(), readOnlySnapshot: true}), /ROUTE_DENIED/);
      await assert.rejects(() => get({...repair(), scope: {scopeId: 'foreign', scopeKey: 'foreign'}}), /ROUTE_DENIED/);
      await assert.rejects(() => f.bridge.get('plugin', 'libra:v1:scope:capture-sdk-scope:source-receipt:wl_sdk:e0:t1:revision1', null, null, null, repair()), /ROUTE_DENIED/);
      await assert.rejects(() => f.bridge.get('local', key, null, null, null, repair()), /ROUTE_DENIED/);
      assert.equal(f.writes.length, before);
    });
    await test('wrong namespace and shared routes deny opt-in repair', async () => {
      const other = make('flashback'), shared = make('libra', () => ({kind: 'shared'}));
      await assert.rejects(() => other.bridge.get('plugin', key, null, null, null, repair()), /ROUTE_DENIED/);
      await assert.rejects(() => shared.bridge.get('plugin', key, null, null, null, repair()), /ROUTE_DENIED/);
      assert.equal(other.local.has(key), false);
      assert.equal(shared.local.has(key), false);
    });
    await test('canonical scope keys containing colons still admit exact mirror capture repair', async () => {
      const ownerScope = {scopeId: 'dc2caca0_0:0', scopeKey: 'dc2caca0_0:0', available: true};
      const x = make('libra', undefined, ownerScope), colonKey = 'libra:v1:scope:dc2caca0_0:0:source-receipt-capture:wl_sdk:e0:t1:revision1';
      await x.proxy.setItem(colonKey, expected);
      const revision = (await x.bridge.serverGet('plugin', colonKey)).revision;
      x.local.delete(colonKey);
      assert.equal(await x.bridge.get('plugin', colonKey, () => x.local.get(colonKey) ?? null, null, null,
        {...repair(), scope: ownerScope}), expected);
      assert.equal(x.local.get(colonKey), expected);
      assert.equal((await x.bridge.serverGet('plugin', colonKey)).revision, revision);
    });
    await test('a capture address routed to a different scope denies opt-in repair', async () => {
      const x = make('libra', () => ({kind: 'scope', scopeId: 'different-route-scope', scopeKey: 'different-route-scope'}));
      await assert.rejects(() => x.bridge.get('plugin', key, null, null, null, repair()), /ROUTE_DENIED/);
      assert.equal(x.local.has(key), false);
    });
    for (const rejected of ['plugin_only', 'server_only']) await test(`${rejected} mode denies capture repair without altering physical data`, async () => {
      mode = rejected;
      const x = make();
      await assert.rejects(() => x.bridge.get('plugin', key, null, null, null, repair()), /ROUTE_DENIED/);
      assert.equal(x.local.has(key), false);
    });
    console.log(JSON.stringify({test: 'libra_capture_mirror_sdk_repair', passed, realModelCalls: 0,
      boundary: 'real LIBRA SDK, loopback HTTP/SQLite, controlled native local store'}));
  } finally {
    for (const bridge of bridges) await bridge.dispose();
    globalThis.risuai = prior;
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
