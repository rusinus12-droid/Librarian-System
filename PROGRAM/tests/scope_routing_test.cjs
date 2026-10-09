'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-scope-routing-'));
  const app = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir, autoBackup:false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previous = globalThis.risuai;
  const args = { memory_suite_server_mode:'mirror', memory_suite_server_url:baseUrl };
  const A = { scopeId:'scope:alpha', scopeKey:'scope:alpha', label:'Alpha' };
  const B = { scopeId:'scope:beta', scopeKey:'scope:beta', label:'Beta' };
  const C = { scopeId:'scope:gamma', scopeKey:'scope:gamma', label:'Gamma' };
  let current = A;
  try {
    globalThis.risuai = {
      async getArgument(name) { return args[name] || ''; },
      async setArgument(name, value) { args[name] = String(value); return true; },
      async nativeFetch(url, init) { return await fetch(url, init); }
    };
    const sdkText = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
    const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();
    const legacy = memoryStore({
      'scoped:container': { version:1, scopes:{ [A.scopeId]:{ value:'A-local' }, [B.scopeId]:{ value:'B-local' } } },
      'scope:a:record': { value:'a-record' },
      'scope:b:record': { value:'b-record' },
      'global:ui': { panel:true },
      'shared:meta': { scopes:[A.scopeId, B.scopeId] }
    });
    const containerRoute = scope => ({
      kind:'scope', ...scope, scopedContainer:true,
      projectValue(value) {
        const row = value?.scopes?.[scope.scopeId];
        return { version:Number(value?.version || 1), scopes:row ? { [scope.scopeId]:row } : {} };
      },
      mergeValue(remote, local) {
        return { ...(local || {}), ...(remote || {}), scopes:{ ...(local?.scopes || {}), ...(remote?.scopes || {}) } };
      },
      removeValue(local) {
        const scopes = { ...(local?.scopes || {}) };
        delete scopes[scope.scopeId];
        return { ...(local || {}), scopes };
      }
    });
    const bridge = createBridge({
      namespace:'lia', pluginId:'lia_persona_linker', pluginVersion:'0.26.39', managementButton:false,
      pluginKeys:['scoped:container','shared:meta'], pluginPrefixes:['scope:'], migrationDelayMs:100000,
      currentScopeProvider:async()=>current,
      resolveKeyScope:async({key,currentScope})=>{
        if (key === 'scoped:container') return containerRoute(currentScope);
        if (key === 'shared:meta') return { kind:'shared' };
        if (key.startsWith('scope:a:')) return { kind:'scope', ...A };
        if (key.startsWith('scope:b:')) return { kind:'scope', ...B };
        return { kind:'global' };
      }
    });
    const proxy = bridge.createPluginStorageProxy(legacy);

    // 0.2.6's global mode is imported once into the active scope only.
    assert.equal(await bridge.getMode(), 'mirror');
    assert.equal(args.memory_suite_server_mode, 'plugin_only');
    current = B;
    assert.equal(await bridge.getMode(), 'plugin_only');
    current = C;
    assert.equal(await bridge.getMode(), 'plugin_only');
    current = A;

    // Alpha's scoped container is projected into a separate opaque server record.
    await proxy.setItem('scoped:container', legacy.map.get('scoped:container'));
    const alphaRemoteKey = `scoped:container::memory-suite-scope:v1:${encodeURIComponent(A.scopeId)}`;
    const betaRemoteKey = `scoped:container::memory-suite-scope:v1:${encodeURIComponent(B.scopeId)}`;
    const alphaRemote = await bridge.serverGet('plugin', alphaRemoteKey);
    assert.equal(alphaRemote.exists, true);
    assert.deepEqual(Object.keys(alphaRemote.value.scopes), [A.scopeId]);
    assert.equal((await bridge.serverGet('plugin', betaRemoteKey)).exists, false);

    // Beta can become server-only without altering Alpha's mirror route.
    current = B;
    await bridge.setMode('server_only');
    assert.equal(await bridge.getMode(), 'server_only');
    const betaRemote = await bridge.serverGet('plugin', betaRemoteKey);
    assert.equal(betaRemote.exists, true);
    assert.deepEqual(Object.keys(betaRemote.value.scopes), [B.scopeId]);
    current = A;
    assert.equal(await bridge.getMode(), 'mirror');
    assert.deepEqual(Object.keys((await bridge.serverGet('plugin', alphaRemoteKey)).value.scopes), [A.scopeId]);

    // Deleting Beta's local server-backed data removes only Beta from the shared local container.
    current = B;
    const deleted = await bridge.deletePluginStorageAfterServerVerification();
    assert.equal(deleted.ok, true);
    assert.equal(legacy.map.get('scoped:container').scopes[B.scopeId], undefined);
    assert.deepEqual(legacy.map.get('scoped:container').scopes[A.scopeId], { value:'A-local' });
    assert.equal(legacy.map.has('scope:a:record'), true);
    assert.deepEqual(legacy.map.get('shared:meta'), { scopes:[A.scopeId, B.scopeId] }, 'shared infrastructure must never be deleted by one scope');

    // The routing registry itself is retained outside current-scope payload deletion.
    const registryKey = '__memory_suite_internal_scope_routes_v1__:lia';
    assert.equal(legacy.map.has(registryKey), true);
    current = A;
    assert.equal(await bridge.getMode(), 'mirror');
    current = B;
    assert.equal(await bridge.getMode(), 'server_only');
    current = C;
    assert.equal(await bridge.getMode(), 'plugin_only');

    // A tombstone from another scope must never hide this plugin-only scope's local container.
    legacy.map.set('scoped:container', { version:1, scopes:{ [C.scopeId]:{ value:'C-local' } } });
    current = A;
    await proxy.removeItem('scoped:container');
    current = C;
    assert.deepEqual(await proxy.getItem('scoped:container'), { version:1, scopes:{ [C.scopeId]:{ value:'C-local' } } });
    assert.ok((await proxy.keys()).includes('scoped:container'), 'foreign-scope tombstone must not leak into current scope enumeration');

    process.stdout.write('scope_routing_test: PASS\n');
  } finally {
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
    await app.close();
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
}
main().catch(error => { process.stderr.write(`scope_routing_test: FAIL\n${error.stack || error}\n`); process.exitCode = 1; });
