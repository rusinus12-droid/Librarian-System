'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const sdkText = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
const createBridge = new Function(`${sdkText}\nreturn createMemorySuiteStorageBridge;`)();

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-restore-transaction-'));
  const app = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir, autoBackup:false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const previous = globalThis.risuai;
  const args = { memory_suite_server_mode:'', memory_suite_server_url:baseUrl };
  try {
    globalThis.risuai = {
      async getArgument(name) { return args[name] || ''; },
      async setArgument(name, value) { args[name] = String(value); return true; },
      async nativeFetch(url, init) { return await fetch(url, init); }
    };

    // A semantic failure must leave a durable lock, keep server_only, and block
    // every path that could make incomplete local data authoritative.
    const scope = { scopeId:'restore:alpha', scopeKey:'restore:alpha', label:'Restore Alpha' };
    const plugin = memoryStore({ 'scope:item':{ id:'alpha', body:'canonical', archiveKey:'archive:layer:immutable' } });
    const local = memoryStore({ 'local:vector':{ id:'alpha', vector:[1,2,3] } });
    let semanticOk = true;
    const validationCalls = [];
    const bridge = createBridge({
      namespace:'flashback', pluginId:'flashback_memory', pluginVersion:'0.11.32', managementButton:false,
      pluginPrefixes:['scope:','shared:','archive:'], localPrefixes:['local:'], migrationDelayMs:100000,
      currentScopeProvider:async()=>scope, preResolveKeyScope:true,
      resolveKeyScope:async({key,currentScope})=>key.startsWith('shared:') ? {kind:'shared'}
        : (key.startsWith('archive:') ? {kind:'scope',scopeId:'archive:immutable',scopeKey:'archive:immutable',label:'Immutable Archive'} : {kind:'scope',...(currentScope || scope)}),
      resolveRestoreDependencies:async context=>{
        const manifestRow=context.serverCandidates.find(row=>row.logicalKey==='scope:item');
        const manifest=manifestRow?await context.serverRead('plugin',manifestRow.remoteKey):null;
        return {dependencies:[
          {space:'plugin',remoteKey:'shared:dependency',reason:'manifest.sharedCatalog'},
          ...(manifest?.value?.archiveKey?[{space:'plugin',remoteKey:manifest.value.archiveKey,reason:'manifest.archiveKey'}]:[])
        ],metrics:{archiveRefs:manifest?.value?.archiveKey?1:0}};
      },
      validateRestore:async context=>{
        validationCalls.push({phase:context.phase,space:context.space,candidates:context.serverCandidates.length});
        if (context.phase !== 'complete') return {ok:true};
        const shared = await context.readback('plugin','shared:dependency');
        const canonical = await context.readback('plugin','scope:item');
        const archive = await context.readback('plugin','archive:layer:immutable');
        const vector = await context.readback('local','local:vector');
        return semanticOk && shared?.catalog === 7 && canonical?.body === 'canonical' && archive?.chunks === 133 && vector?.vector?.length === 3
          ? {ok:true,metrics:{canonical:1,dependencies:2,vectors:1}}
          : {ok:false,errors:['flashback_manifest_archive_semantics_invalid'],metrics:{canonical:canonical?1:0,dependencies:(shared?1:0)+(archive?1:0),vectors:vector?1:0}};
      },
      requireRestoreValidation:true
    });
    const pluginProxy = bridge.createPluginStorageProxy(plugin);
    bridge.createLocalStorageProxy(local);
    await bridge.setMode('server_only');
    await pluginProxy.setItem('shared:dependency', { catalog:7, archive:'durable' });
    await pluginProxy.setItem('shared:unrelated', { mustNotRestore:true });
    const bootstrap = await (await fetch(`${baseUrl}/bootstrap`, {headers:{'X-Memory-Suite-Plugin':'flashback_memory','X-Memory-Suite-Plugin-Version':'0.11.32'}})).json();
    const archiveWrite = await (await fetch(`${baseUrl}/v1/kv/set`, {
      method:'POST', headers:{Authorization:`Bearer ${bootstrap.token}`,'X-Memory-Suite-Plugin':'flashback_memory','X-Memory-Suite-Plugin-Version':'0.11.32','Content-Type':'application/json'},
      body:JSON.stringify({namespace:'flashback',space:'plugin',key:'archive:layer:immutable',value:{chunks:133,digest:'immutable'},operationId:'restore_dependency_archive_seed_0001'})
    })).json();
    assert.equal(archiveWrite.ok,true);
    assert.equal(await bridge.getMode(), 'server_only');

    plugin.map.delete('scope:item');
    plugin.map.delete('shared:dependency');
    plugin.map.delete('archive:layer:immutable');
    plugin.map.delete('shared:unrelated');
    local.map.delete('local:vector');
    semanticOk = false;
    await assert.rejects(
      () => bridge.restorePluginStorage(),
      error => error?.code === 'MEMORY_SUITE_RESTORE_SEMANTIC_VALIDATION_FAILED'
        && error?.recoveryLock?.required === true
    );
    const lock = await bridge.getRecoveryState(scope);
    assert.equal(lock?.required, true, 'failed restore leaves durable recovery_required lock');
    assert.equal(lock?.validation?.ok, false, 'validator evidence is retained in lock');
    assert.deepEqual(lock?.metrics, { canonical:1, dependencies:2, vectors:1 }, 'validator metrics are retained in lock');
    assert.equal(await bridge.getMode(), 'server_only', 'failed restore cannot leave server_only');
    assert.equal(plugin.map.has('scope:item'), false, 'failed semantic validation rolls restored plugin values back');
    assert.equal(plugin.map.has('shared:dependency'), false, 'failed semantic validation rolls explicit shared dependencies back');
    assert.equal(plugin.map.has('archive:layer:immutable'), false, 'failed semantic validation rolls archive dependencies back');
    assert.equal(local.map.has('local:vector'), false, 'failed semantic validation rolls local-space values back');
    await assert.rejects(() => bridge.setMode('plugin_only'), error => error?.code === 'MEMORY_SUITE_RECOVERY_REQUIRED');
    await assert.rejects(() => bridge.setMode('mirror'), error => error?.code === 'MEMORY_SUITE_MIRROR_TRANSITION_ONLY');
    await assert.rejects(() => bridge.configureConnection({mode:'mirror',url:baseUrl}), error => error?.code === 'MEMORY_SUITE_MIRROR_TRANSITION_ONLY');
    await assert.rejects(() => bridge.synchronizeNow(), error => error?.code === 'MEMORY_SUITE_RECOVERY_REQUIRED');
    await assert.rejects(() => bridge.startSynchronizationJob({scope}), error => error?.code === 'MEMORY_SUITE_RECOVERY_REQUIRED');

    const beforeProbe = bridge.status().mode;
    const probe = await bridge.testConnection(baseUrl);
    assert.equal(probe.ok, true);
    assert.equal(bridge.status().mode, beforeProbe, 'connection test is observational and never overwrites scoped mode state');
    assert.equal(await bridge.getMode(), 'server_only');

    semanticOk = true;
    const restored = await bridge.restorePluginStorage();
    assert.equal(restored.ok, true);
    assert.equal(restored.scopeCandidateCount, 2);
    assert.equal(restored.dependencyCandidateCount, 2, 'shared and manifest-referenced owner dependencies are restored with the scope');
    assert.deepEqual(plugin.map.get('scope:item'), {id:'alpha',body:'canonical',archiveKey:'archive:layer:immutable'});
    assert.deepEqual(plugin.map.get('shared:dependency'), {catalog:7,archive:'durable'});
    assert.deepEqual(plugin.map.get('archive:layer:immutable'), {chunks:133,digest:'immutable'});
    assert.deepEqual(local.map.get('local:vector'), {id:'alpha',vector:[1,2,3]});
    assert.equal(plugin.map.has('shared:unrelated'), false, 'unreferenced shared server records are not restored implicitly');
    assert.equal(await bridge.getRecoveryState(scope), null, 'only verified semantic success clears recovery lock');
    assert.ok(validationCalls.some(row => row.phase === 'space_complete' && row.space === 'plugin'));
    assert.ok(validationCalls.some(row => row.phase === 'complete' && row.space === 'all'));

    // An empty server snapshot is not a successful restore.
    const emptyScope = { scopeId:'restore:empty', scopeKey:'restore:empty', label:'Empty' };
    const emptyStore = memoryStore();
    const emptyBridge = createBridge({
      namespace:'hayaku', pluginId:'hayaku', pluginVersion:'2.4.39', managementButton:false,
      pluginPrefixes:['empty:'], migrationDelayMs:100000, currentScopeProvider:async()=>emptyScope
    });
    emptyBridge.createPluginStorageProxy(emptyStore);
    await emptyBridge.setMode('server_only');
    await assert.rejects(() => emptyBridge.restorePluginStorage(), error => error?.code === 'MEMORY_SUITE_RESTORE_SNAPSHOT_EMPTY');
    assert.equal((await emptyBridge.getRecoveryState(emptyScope))?.required, true);
    assert.equal(await emptyBridge.getMode(), 'server_only');

    // A server local-space snapshot cannot be declared restored when the new
    // runtime never attached its local storage adapter.
    const localScope = { scopeId:'restore:local-adapter', scopeKey:'restore:local-adapter', label:'Local Adapter' };
    const registryStore = memoryStore();
    const seedLocal = memoryStore({ 'local:only':{ vector:[9,8,7] } });
    const seedBridge = createBridge({
      namespace:'flashback', pluginId:'flashback_memory', pluginVersion:'1.0.101', managementButton:false,
      pluginPrefixes:['plugin:none:'], localPrefixes:['local:'], migrationDelayMs:100000,
      currentScopeProvider:async()=>localScope
    });
    seedBridge.createPluginStorageProxy(registryStore);
    seedBridge.createLocalStorageProxy(seedLocal);
    await seedBridge.setMode('server_only');
    await seedBridge.dispose();

    const missingAdapterBridge = createBridge({
      namespace:'flashback', pluginId:'flashback_memory', pluginVersion:'1.0.101', managementButton:false,
      pluginPrefixes:['plugin:none:'], localPrefixes:['local:'], migrationDelayMs:100000,
      currentScopeProvider:async()=>localScope
    });
    missingAdapterBridge.createPluginStorageProxy(registryStore);
    await assert.rejects(
      () => missingAdapterBridge.restorePluginStorage(),
      error => error?.code === 'MEMORY_SUITE_RESTORE_ADAPTER_UNAVAILABLE'
    );
    assert.equal((await missingAdapterBridge.getRecoveryState(localScope))?.required, true);
    assert.equal(await missingAdapterBridge.getMode(), 'server_only');

    process.stdout.write('scoped_restore_transaction_test: PASS\n');
  } finally {
    if (previous === undefined) delete globalThis.risuai; else globalThis.risuai = previous;
    await app.close();
    fs.rmSync(dataDir, {recursive:true,force:true});
  }
}

main().catch(error => {
  process.stderr.write(`scoped_restore_transaction_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
