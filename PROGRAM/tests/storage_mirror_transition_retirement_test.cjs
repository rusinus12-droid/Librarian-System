'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const PROGRAM=path.resolve(__dirname,'..');
const plugins=[['flashback','flashback_memory'],['hayaku','hayaku_locator_continuity'],['libra','libra'],['lia','lia_persona_linker'],['retrace','flashback_hayaku_bridge']];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function run(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-retirement-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:root,autoBackup:false});
 const {port}=await app.listen(),url=`http://127.0.0.1:${port}`,previous=globalThis.risuai;let passed=0;
 try {for(const [namespace,pluginId] of plugins){
  const source=fs.readFileSync(path.join(PROGRAM,'sdk',namespace==='libra'?'MemorySuiteStorageClient.libra.source.js':'MemorySuiteStorageClient.source.js'),'utf8');
  const create=new Function(source+'\nreturn createMemorySuiteStorageBridge')();
  const scope={scopeId:namespace+'-a',scopeKey:namespace+'-a',chatId:namespace+'-a',label:'A'},other={scopeId:namespace+'-b',scopeKey:namespace+'-b',chatId:namespace+'-b',label:'B'};
  const key=namespace+'.a.memory',peer=namespace+'.b.memory',registryKey='__memory_suite_internal_scope_routes_v1__:'+namespace;
  const values=new Map([[key,{n:1}],[peer,{peer:true}]]);let network=0,gate=null,entered=null,holdReads=false,failLocal=false,rejectRegistry=false;
  const store={getItem:async k=>{if(holdReads&&k===key)await gate.promise;return values.get(k)??null;},setItem:async(k,v)=>{if((failLocal&&k===key)||(rejectRegistry&&k===registryKey))return false;values.set(k,v);return true;},removeItem:async k=>{values.delete(k);return true;},keys:async()=>[...values.keys()]};
  const api={pluginStorage:store,getArgument:async n=>n.includes('url')?url:'plugin_only',setArgument:async()=>true,nativeFetch:async(u,i)=>{network++;return fetch(u,i);}};
  globalThis.risuai=api;
  const opts={namespace,pluginId,pluginVersion:'retirement-test',defaultUrl:url,managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,pluginPrefixes:[namespace+'.'],currentScopeProvider:async()=>scope,resolveKeyScope:async({key:k})=>({kind:'scope',scope:k.includes('.b.')?other:scope})};
  let bridge=create(opts),proxy=bridge.createPluginStorageProxy(store);
  try {
   assert.deepEqual(bridge.getStorageModeContract().operationalModes,['plugin_only','server_only']);
   const bootstrap=await (await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':pluginId}})).json();
   assert.deepEqual(bootstrap.storageModeContract.operationalModes,['plugin_only','server_only']);assert.equal(bootstrap.storageModeContract.mirrorSelectable,false);
   const before=new Map(values),count=network;
   for(const alias of ['mirror','dual','coexist','coexistence','plugin_server','plugin+server','plugin_and_server']){
    for(const action of [()=>bridge.setMode(alias),()=>bridge.setScopeMode(scope,alias),()=>bridge.setGlobalMode(alias),()=>bridge.configureConnection({mode:alias,url}),()=>bridge.startConnectionConfigurationJob({mode:alias,url})]){
     await assert.rejects(action,e=>e.code==='MEMORY_SUITE_MIRROR_TRANSITION_ONLY');passed++;
    }
   }
   assert.equal(network,count,'retired selection must fail before any network access');assert.deepEqual(values,before,'retired selection must not persist anything');
   entered=deferred();gate=deferred();
   const change=bridge.setMode('server_only',{onProgress:p=>{if(p.phase==='sync_local'&&gate){holdReads=true;entered.resolve();}}});
   // Hold a local read inside the migration so concurrent requests observe the real transfer phase.
   // The first migration inventory may already be running: use progress to prove it was entered.
   await entered.promise;
   const state=await bridge.getScopeMode(scope);assert.equal(state.mode,'plugin_only');assert.equal(state.storagePhase,'mirror');assert.equal(state.transition.toMode,'server_only');
   await assert.rejects(()=>proxy.setItem(key,{lost:true}),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
   await assert.rejects(()=>bridge.setMode('plugin_only'),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
   const duringTransfer=new Map(values);
   for(const action of [()=>bridge.setGlobalMode('plugin_only'),()=>bridge.clearGlobalMode(),()=>bridge.setServerUrl(url),()=>bridge.configureConnection({mode:'plugin_only',url}),()=>bridge.startConnectionConfigurationJob({mode:'plugin_only',url}),()=>bridge.startSynchronizationJob(),()=>bridge.startRestoreJob(),()=>bridge.ownerLegacyWrite('plugin',key,{lost:true}),()=>bridge.ownerLegacyRemove('plugin',key)]){
    await assert.rejects(action,e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
   }
   assert.deepEqual(values,duringTransfer,'concurrent configuration and maintenance must not change source data or routing');
   await assert.rejects(()=>bridge.restorePluginStorage(),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
   await assert.rejects(()=>bridge.ensureHandoffReady(),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
   holdReads=false;const release=gate;gate=null;release.resolve();const changed=await change;
   assert.equal(changed.to,'server_only');assert.equal(changed.transition.phase,'completed');assert.equal((await bridge.getScopeMode(scope)).transition,null);
   const completedSettings=await bridge.getConnectionSettings({force:true});assert.equal(completedSettings.status.transition,null,'owner IPC status must clear completed transfer');assert.equal(completedSettings.status.storagePhase,'server_only');
   assert.deepEqual((await bridge.serverGet('plugin',key)).value,{n:1});assert.equal((await bridge.serverGet('plugin',peer)).exists,false);assert.deepEqual(values.get(peer),{peer:true});passed++;
   await proxy.setItem(key,{n:2});assert.deepEqual(values.get(key),{n:1},'server endpoint does not update recovery copy');
   await bridge.dispose();bridge=create(opts);proxy=bridge.createPluginStorageProxy(store);
   assert.equal(await bridge.getMode(),'server_only');assert.deepEqual(await proxy.getItem(key),{n:2});
   failLocal=true;await assert.rejects(()=>bridge.setMode('plugin_only'));assert.equal(await bridge.getMode(),'server_only');assert.deepEqual(values.get(key),{n:1});failLocal=false;passed++;
   await bridge.restorePluginStorage();await bridge.setMode('plugin_only');assert.deepEqual(await proxy.getItem(key),{n:2});
   await bridge.dispose();bridge=create(opts);proxy=bridge.createPluginStorageProxy(store);assert.equal(await bridge.getMode(),'plugin_only');assert.deepEqual(await proxy.getItem(key),{n:2});passed++;
   // Stored mirror is an upgrade fixture, never created through the new mode-selection API.
   const registry=JSON.parse(values.get(registryKey));registry.entries[scope.scopeId]={...registry.entries[scope.scopeId],mode:'mirror',origin:'user_explicit',updatedAt:Date.now()+100};
   values.set(registryKey,JSON.stringify(registry));await bridge.dispose();bridge=create(opts);proxy=bridge.createPluginStorageProxy(store);
   const legacy=await bridge.getConnectionSettings({force:true});assert.equal(legacy.mode,'mirror');assert.equal(legacy.migrationRequired,true);assert.equal(legacy.modeRole,'transition');
   await assert.rejects(()=>bridge.ensureHandoffReady(),e=>e.code==='MEMORY_SUITE_MIRROR_TRANSITION_ONLY');
   await assert.rejects(()=>bridge.verifyNativeBranchSourceDurability({scope}),e=>e.code==='MEMORY_SUITE_MIRROR_TRANSITION_ONLY');
   const connection=await bridge.bootstrap();
   const inserted=await fetch(url+'/v1/kv/set',{method:'POST',headers:{Authorization:'Bearer '+connection.token,'X-Memory-Suite-Plugin':pluginId,'Content-Type':'application/json'},body:JSON.stringify({namespace,space:'plugin',key:namespace+'.a.remote-only',value:{recovered:true},operationId:namespace+'_remote_only_'+Date.now(),expectedRevision:0})});assert.equal(inserted.ok,true);
   await bridge.setMode('plugin_only');assert.deepEqual(values.get(namespace+'.a.remote-only'),{recovered:true});assert.equal(await bridge.getMode(),'plugin_only');passed++;
   values.set(key,{conflict:true});await assert.rejects(()=>bridge.setMode('server_only'),e=>e.code==='MEMORY_SUITE_SCOPE_SYNC_INCOMPLETE');assert.equal(await bridge.getMode(),'plugin_only');assert.deepEqual(values.get(key),{conflict:true});assert.deepEqual((await bridge.serverGet('plugin',key)).value,{n:2});values.set(key,{n:2});passed++;
   // A failed registry cutover cannot report the new authority as applied.
   rejectRegistry=true;await assert.rejects(()=>bridge.setMode('server_only'));rejectRegistry=false;
   await bridge.dispose();bridge=create(opts);proxy=bridge.createPluginStorageProxy(store);assert.equal(await bridge.getMode(),'plugin_only');passed++;
   const pendingScope={scopeId:namespace+'-pending',scopeKey:namespace+'-pending',chatId:namespace+'-pending',label:'Pending'};
   const pendingValues=new Map([[namespace+'.pending.memory',{pending:true}]]);
   const pendingStore={getItem:async k=>pendingValues.get(k)??null,setItem:async(k,v)=>{pendingValues.set(k,v);return true;},removeItem:async k=>pendingValues.delete(k),keys:async()=>[...pendingValues.keys()]};
   globalThis.risuai={...api,pluginStorage:pendingStore,nativeFetch:async(u,i)=>{if(String(u).endsWith('/v1/kv/set'))throw Error('injected_upload_unavailable');return fetch(u,i);}};
   const pendingOptions={...opts,currentScopeProvider:async()=>pendingScope,resolveKeyScope:async()=>({kind:'scope',scope:pendingScope})};
   let pendingBridge=create(pendingOptions);pendingBridge.createPluginStorageProxy(pendingStore);
   try {
    const globalResult=await pendingBridge.setGlobalMode('server_only');assert.equal(globalResult.failed.length,1);
    assert.equal((await pendingBridge.getGlobalMode()).mode,'server_only');assert.equal((await pendingBridge.getScopeMode(pendingScope)).mode,'plugin_only','failed follower keeps its source authority');
    await pendingBridge.dispose();pendingBridge=create(pendingOptions);pendingBridge.createPluginStorageProxy(pendingStore);
    assert.equal((await pendingBridge.getScopeMode(pendingScope)).mode,'plugin_only','failed follower source survives a fresh bridge');
    const pendingSettings=await pendingBridge.getConnectionSettings({force:true});assert.equal(pendingSettings.migrationRequired,true);assert.equal(pendingSettings.transition.toMode,'server_only');assert.equal(pendingSettings.status.transition.phase,'pending');
    await assert.rejects(()=>pendingBridge.ensureHandoffReady(),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
    await assert.rejects(()=>pendingBridge.verifyNativeBranchSourceDurability({scope:pendingScope}),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
    assert.deepEqual(await pendingBridge.get('plugin',namespace+'.pending.memory',()=>pendingStore.getItem(namespace+'.pending.memory')),{pending:true});passed++;
   }finally{await pendingBridge.dispose();globalThis.risuai=api;}
   console.log('PASS '+namespace+' retired selection, real transfer, reload, failure rollback, legacy completion');
  } finally {gate?.resolve();await bridge.dispose();}
 }}finally{globalThis.risuai=previous;await app.close();fs.rmSync(root,{recursive:true,force:true});}
 console.log(JSON.stringify({test:'storage_mirror_transition_retirement',passed,namespaces:plugins.map(p=>p[0]),server:'real HTTP + SQLite',liveRisuAI:'NOT_RUN'}));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
