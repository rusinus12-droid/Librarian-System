'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const PROGRAM=path.resolve(__dirname,'..');
const plugins=[['flashback','flashback_memory'],['hayaku','hayaku_locator_continuity'],['libra','libra'],['lia','lia_persona_linker'],['retrace','flashback_hayaku_bridge']];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

// Current retired owners are deliberately covered, not removed from the matrix.
// These are synthetic historical records in the test's own ephemeral SQLite store.
async function verifyRetiredOwner({namespace,create,opts,values,store,scope,other,key,peer,registryKey,app,networkCount,setFailLocal}){
 const policy=namespace==='lia'?'local_only':'manager_only',jobKey='__memory_suite_internal_sync_job_v1__:'+namespace;
 const ownerOptions={...opts,storagePolicy:policy,...(namespace==='retrace'?{scopeRouting:false}:{})};
 const historicalJob=JSON.stringify({schema:'memory-suite.sync-job.v1',namespace,kind:'connection_config',scopeId:scope.scopeId,status:'paused',phase:'waiting_for_server',sourceMode:'plugin_only',targetMode:'server_only',historicalUnknown:{keep:true}});
 const registryFor=mode=>JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace,legacyGlobalModeImported:true,entries:{[scope.scopeId]:{...scope,mode,origin:'user_explicit',updatedAt:1}},historicalUnknown:{keep:true}});
 values.set(registryKey,registryFor('server_only'));values.set(jobKey,historicalJob);
 const repo=app.repositories[namespace],historicalValue={historical:namespace,unknown:{keep:true}},serialized=JSON.stringify(historicalValue);
 assert.equal(repo.legacyReadOnly,true);assert.equal(repo.ephemeral,true,'synthetic fixture must never seed an existing user store');
 repo.database.prepare('INSERT INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES(?,?,?,0,1,?,1)').run('plugin',key,serialized,require('node:crypto').createHash('sha256').update(serialized).digest('hex'));
 const serverBefore=repo.database.prepare('SELECT * FROM kv ORDER BY space,key').all();
 const before=new Map(values),count=networkCount();let bridge=create(ownerOptions),proxy;
 try{
  const bootstrap=await (await fetch(opts.defaultUrl+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':opts.pluginId}})).json();
  assert.deepEqual(bootstrap.storageModeContract.operationalModes,['plugin_only','server_only']);assert.equal(bootstrap.storageModeContract.mirrorSelectable,false);
  assert.deepEqual(bootstrap.authorization.roles,namespace==='lia'?['legacy_reader']:['manager']);assert.deepEqual(bootstrap.authorization.writeNamespaces,[]);
  // RETIRED_POLICY_SURFACE: no ordinary server authority may be enabled.
  assert.equal(bridge.storagePolicy,policy);assert.equal(await bridge.getMode(),'plugin_only');assert.equal(bridge.getSyncJob(),null);
  const settings=await bridge.getConnectionSettings({force:true});assert.equal(settings.mode,'plugin_only');assert.equal(settings.serverStorage,false);assert.equal(settings.transition,null);assert.equal(settings.migrationRequired,false);
  if(namespace==='lia'){
   proxy=bridge.createPluginStorageProxy(store);
   assert.deepEqual(bridge.getStorageModeContract().operationalModes,['plugin_only']);assert.equal(bridge.getStorageModeContract().mirrorSelectable,false);assert.equal(bridge.getStorageModeContract().legacyMirrorReadable,false);
   for(const mode of ['server_only','mirror','dual','coexist','coexistence','plugin_server','plugin+server','plugin_and_server']){
    for(const action of [()=>bridge.setMode(mode),()=>bridge.setScopeMode(scope,mode),()=>bridge.setGlobalMode(mode),()=>bridge.configureConnection({mode,url:opts.defaultUrl}),()=>bridge.startConnectionConfigurationJob({mode,url:opts.defaultUrl})]){
     await assert.rejects(action,e=>e.code==='MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY');
    }
   }
   for(const action of [()=>bridge.clearGlobalMode(),()=>bridge.setServerUrl(opts.defaultUrl),()=>bridge.startSynchronizationJob(),()=>bridge.startRestoreJob(),()=>bridge.restorePluginStorage(),()=>bridge.deletePluginStorageAfterServerVerification()]){
    await assert.rejects(action,e=>e.code==='MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY');
   }
   assert.equal((await bridge.resumePendingSyncJob()).reason,'local_only_owner_policy');
  }else{
   for(const method of ['getStorageModeContract','getScopeMode','set','remove','setMode','setScopeMode','setGlobalMode','clearGlobalMode','setServerUrl','configureConnection','startConnectionConfigurationJob','createPluginStorageProxy','startSynchronizationJob','startRestoreJob','restorePluginStorage','ownerLegacyWrite','ownerLegacyRemove','ensureHandoffReady','verifyNativeBranchSourceDurability','resumePendingSyncJob']){
    assert.equal(bridge[method],undefined,'manager-only client has no own writer or migration surface '+method);
   }
   for(const method of ['managerControl','managerPortable','managerServerGet','managerListScopes','managerPlanScopeDeletion','readLegacyValue'])assert.equal(typeof bridge[method],'function',method+' remains');
  }
  assert.equal(networkCount(),count,'retired writer selection must not connect');assert.deepEqual(values,before,'retired owner policy must retain historical route, journal and source bytes');
  // RETIRED_SERVER_READ_ONLY: public repository writes refuse over nonempty history.
  const refused=await fetch(opts.defaultUrl+'/v1/kv/set',{method:'POST',headers:{Authorization:'Bearer '+bootstrap.token,'X-Memory-Suite-Plugin':opts.pluginId,'Content-Type':'application/json'},body:JSON.stringify({namespace,space:'plugin',key,value:{lost:true},operationId:namespace+'_retired_http',expectedRevision:1})});
  assert.equal(refused.status,403);assert.equal((await refused.json()).error,'namespace_write_forbidden:'+namespace);
  assert.throws(()=>repo.mutate({kind:'set',space:'plugin',key,value:{lost:true},operationId:namespace+'_retired_write',expectedRevision:1}),/retired_storage_owner_read_only/);
  assert.throws(()=>repo.applyConditionalBatch([{kind:'set',space:'plugin',key,value:{lost:true},expectedRevision:1}],{operationId:namespace+'_retired_batch'}),/retired_storage_owner_read_only/);
  assert.deepEqual(repo.get('plugin',key).value,historicalValue);assert.equal(repo.get('plugin',peer).exists,false);assert.deepEqual(repo.database.prepare('SELECT * FROM kv ORDER BY space,key').all(),serverBefore);
  if(namespace==='lia'){
   // LIA_LOCAL_POSITIVE: current authority writes locally; the peer and old server remain intact.
   await proxy.setItem(key,{n:2});assert.deepEqual(await proxy.getItem(key),{n:2});assert.deepEqual(values.get(key),{n:2});assert.deepEqual(values.get(peer),{peer:true});
   const recoveryKey=namespace+'.a.recovered';
   await assert.rejects(()=>bridge.publishLocalRecovery({records:[{key,value:{lost:true},expectedValue:{n:1}}],validate:async()=>true}),/LIA_RECOVERY_LOCAL_CONFLICT/);assert.deepEqual(values.get(key),{n:2});
   setFailLocal(true);
   try{await assert.rejects(()=>bridge.publishLocalRecovery({records:[{key,value:{lost:true},expectedValue:{n:2}}],validate:async()=>true}),/LIA_RECOVERY_LOCAL_READBACK_FAILED/);}finally{setFailLocal(false);}
   assert.deepEqual(values.get(key),{n:2});assert.deepEqual(repo.get('plugin',key).value,historicalValue);
   await assert.rejects(()=>bridge.publishLocalRecovery({records:[{key:recoveryKey,value:{recovered:true},expectedValue:null}],validate:async()=>false}),/LIA_RECOVERY_VALIDATION_FAILED/);assert.equal(values.has(recoveryKey),false);
   const recovered=await bridge.publishLocalRecovery({records:[{key:recoveryKey,value:{recovered:true},expectedValue:null}],validate:async()=>true});
   assert.equal(recovered.verified,true);assert.equal(recovered.serverWrites,0);assert.equal(recovered.serverDeletes,0);assert.deepEqual(values.get(recoveryKey),{recovered:true});assert.deepEqual(values.get(peer),{peer:true});
   assert.equal(networkCount(),count,'LIA explicit local publication has no server side effects');
  }
  // RETIRED_HISTORICAL_RELOAD: old server/mirror and pending job carriers are never replayed.
  for(const mode of ['server_only','mirror']){
   await bridge.dispose();values.set(registryKey,registryFor(mode));const rawRegistry=values.get(registryKey);bridge=create(ownerOptions);
   if(namespace==='lia')proxy=bridge.createPluginStorageProxy(store);
   assert.equal(await bridge.getMode(),'plugin_only');assert.equal(bridge.getSyncJob(),null);
   const freshSettings=await bridge.getConnectionSettings({force:true});assert.equal(freshSettings.transition,null);assert.equal(freshSettings.migrationRequired,false);assert.equal(freshSettings.serverStorage,false);
   assert.equal(values.get(registryKey),rawRegistry);assert.equal(values.get(jobKey),historicalJob);
   if(namespace==='lia'){
    assert.deepEqual(await proxy.getItem(key),{n:2});assert.deepEqual(await proxy.getItem(namespace+'.a.recovered'),{recovered:true});assert.equal(networkCount(),count);
    const handoff=await bridge.ensureHandoffReady();assert.equal(handoff.verified,true);assert.equal(handoff.mode,'plugin_only');
    const durability=await bridge.verifyNativeBranchSourceDurability({scope});assert.equal(durability.verified,true);assert.equal(durability.mode,'plugin_only');
   }else{
    assert.deepEqual(await bridge.readLegacyValue('plugin',key,scope),mode==='mirror'?{n:1}:historicalValue,'manager reads the retained historical source without acquiring a writer');
    assert.deepEqual(values.get(key),{n:1});
   }
   assert.deepEqual(values.get(peer),{peer:true});assert.equal(values.get(registryKey),rawRegistry);assert.equal(values.get(jobKey),historicalJob);
   assert.deepEqual(repo.database.prepare('SELECT * FROM kv ORDER BY space,key').all(),serverBefore);
  }
  console.log('PASS '+namespace+' current '+policy+' refusal, legacy retention, reload and read-only server');
 }finally{setFailLocal(false);await bridge.dispose();}
}

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
  if(namespace==='lia'||namespace==='retrace'){await verifyRetiredOwner({namespace,create,opts,values,store,scope,other,key,peer,registryKey,app,networkCount:()=>network,setFailLocal:value=>{failLocal=value;}});passed++;continue;}
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
   // AGGREGATE_COMPLETE_INVENTORY: include every synthetic local/remote scope already used above.
   const pendingScope={scopeId:namespace+'-pending',scopeKey:namespace+'-pending',chatId:namespace+'-pending',label:'Pending'};
   const pendingKey=namespace+'.pending.memory',jobKey='__memory_suite_internal_sync_job_v1__:'+namespace;
   const knownScopes=[scope,other,pendingScope],scopeByKey=new Map([[key,scope],[peer,other],[namespace+'.a.remote-only',scope],[pendingKey,pendingScope]]);
   const pendingValues=new Map(values);pendingValues.set(pendingKey,{pending:true});
   const pendingStore={getItem:async k=>pendingValues.get(k)??null,setItem:async(k,v)=>{pendingValues.set(k,v);return true;},removeItem:async k=>pendingValues.delete(k),keys:async()=>[...pendingValues.keys()]};
   const catalog={characters:[{chaId:namespace+'-synthetic-owner',chats:knownScopes.map(row=>({id:row.chatId}))}]};
   let uploadFaultHits=0;
   globalThis.risuai={...api,pluginStorage:pendingStore,getDatabase:async()=>JSON.parse(JSON.stringify(catalog)),nativeFetch:async(u,i={})=>{
    const body=i.body?JSON.parse(i.body):{};
    if(String(u).endsWith('/v1/kv/set')&&body.key===pendingKey){uploadFaultHits++;throw Error('injected_upload_unavailable');}
    return fetch(u,i);
   }};
   const discoverGlobalScopes=async({hostScopes,registries,records})=>{
    const blockers=[],ids=new Set(knownScopes.map(row=>row.scopeId));
    if(hostScopes.length!==knownScopes.length||hostScopes.some(row=>!ids.has(row.chatId)))blockers.push({code:'synthetic_host_catalog_mismatch'});
    for(const registry of registries)for(const row of Object.values(registry.entries||{}))if(row.scopeId!=='__memory_suite_global__'&&!row.removed&&!ids.has(row.scopeId))blockers.push({code:'synthetic_registry_scope_unknown',scopeId:row.scopeId});
    const classified=records.map(row=>{
     const owner=scopeByKey.get(row.logicalKey);
     if(!owner)blockers.push({code:'synthetic_record_owner_unknown',key:row.logicalKey});
     return {...row,classification:'scope',scopeId:owner?.scopeId||''};
    });
    return {scopes:knownScopes.map(row=>({...row,characterId:catalog.characters[0].chaId})),records:classified,blockers,completeKnownScopes:blockers.length===0};
   };
   const pendingOptions={...opts,currentScopeProvider:async()=>pendingScope,resolveKeyScope:async({key:k})=>({kind:'scope',scope:scopeByKey.get(k)}),discoverGlobalScopes};
   let pendingBridge=create(pendingOptions),pendingProxy=pendingBridge.createPluginStorageProxy(pendingStore);
   try {
    const inventory=await pendingBridge.previewGlobalMode('server_only');assert.equal(inventory.completeKnownScopes,true);assert.equal(inventory.discoveredScopes,3);assert.deepEqual(inventory.blockers,[]);assert.equal(uploadFaultHits,0);
    // AGGREGATE_REAL_UPLOAD_FAULT: preserve the failed payload copy, not missing-discovery refusal.
    let uploadFailure;await assert.rejects(()=>pendingBridge.setGlobalMode('server_only'),e=>{uploadFailure=e;return e.code==='MEMORY_SUITE_SCOPE_SYNC_INCOMPLETE'&&uploadFaultHits>0;});
    assert.equal(uploadFailure.result.failures.length,1);assert.equal(uploadFailure.result.failures[0].key,pendingKey);
    assert.ok(uploadFaultHits>0,'the injected pending payload upload must actually be attempted');
    const job=JSON.parse(pendingValues.get(jobKey));assert.equal(job.kind,'global_mode');assert.equal(job.status,'paused');assert.equal(job.phase,'recovery_pending');assert.equal(job.targetMode,'server_only');assert.equal(job.discoveredScopes,3);
    assert.equal(job.globalPlan.scopes.length,3);assert.equal(job.globalPlan.scopes.find(row=>row.scopeId===pendingScope.scopeId).sourceMode,'plugin_only');assert.equal(job.checkpoints[pendingScope.scopeId],undefined);
    assert.equal(job.currentScopeId,pendingScope.scopeId);assert.equal(job.verifiedScopes,2);assert.equal(job.checkpoints[scope.scopeId].scopeId,scope.scopeId);assert.equal(job.checkpoints[other.scopeId].scopeId,other.scopeId);
    assert.equal((await pendingBridge.getGlobalMode()).mode,'plugin_only','global target is unpublished until all known scopes verify');
    const pendingRegistry=JSON.parse(pendingValues.get(registryKey));assert.notEqual(pendingRegistry.entries.__memory_suite_global__?.mode,'server_only');
    const remoteRegistry=await pendingBridge.serverGet('plugin','__memory_suite_scope_routes_v1__:'+namespace);
    if(remoteRegistry.exists){const raw=typeof remoteRegistry.value==='string'?JSON.parse(remoteRegistry.value):remoteRegistry.value;assert.notEqual(raw.entries?.__memory_suite_global__?.mode,'server_only');}
    assert.equal((await pendingBridge.getScopeMode(pendingScope)).mode,'plugin_only','failed follower keeps its source authority');
    assert.deepEqual(await pendingStore.getItem(pendingKey),{pending:true});assert.deepEqual(pendingValues.get(key),{n:2});assert.deepEqual(pendingValues.get(peer),{peer:true});
    assert.equal((await pendingBridge.serverGet('plugin',pendingKey)).exists,false,'failed upload must not fabricate a remote target');
    // AGGREGATE_READ_FREEZE: both owner reads and writes refuse; physical source remains readable.
    await assert.rejects(()=>pendingBridge.get('plugin',namespace+'.pending.memory',()=>pendingStore.getItem(namespace+'.pending.memory')),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
    await assert.rejects(()=>pendingProxy.setItem(pendingKey,{lost:true}),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
    await pendingBridge.dispose();pendingBridge=create(pendingOptions);pendingProxy=pendingBridge.createPluginStorageProxy(pendingStore);
    // The frozen read loads the durable journal before checking settings; it does not resume it.
    await assert.rejects(()=>pendingBridge.get('plugin',namespace+'.pending.memory',()=>pendingStore.getItem(namespace+'.pending.memory')),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
    assert.equal((await pendingBridge.getScopeMode(pendingScope)).mode,'plugin_only','failed follower source survives a fresh bridge');
    const pendingSettings=await pendingBridge.getConnectionSettings({force:true});assert.equal(pendingSettings.syncJob.kind,'global_mode');assert.equal(pendingSettings.syncJob.status,'paused');assert.equal(pendingSettings.syncJob.targetMode,'server_only');assert.equal(pendingSettings.syncJob.phase,'resume_pending');
    assert.equal(pendingSettings.syncJob.jobId,job.jobId);assert.equal(JSON.parse(pendingValues.get(jobKey)).status,'paused');assert.equal((await pendingBridge.getGlobalMode()).mode,'plugin_only');
    assert.deepEqual(await pendingStore.getItem(pendingKey),{pending:true});assert.deepEqual(pendingValues.get(key),{n:2});assert.deepEqual(pendingValues.get(peer),{peer:true});
    // RETAINED_PENDING_SAFETY: these exact original obligations may expose a product defect.
    await assert.rejects(()=>pendingBridge.ensureHandoffReady(),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
    await assert.rejects(()=>pendingBridge.verifyNativeBranchSourceDurability({scope:pendingScope}),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
    passed++;
   }finally{await pendingBridge.dispose();globalThis.risuai=api;}
   console.log('PASS '+namespace+' retired selection, real transfer, reload, failure rollback, legacy completion');
  } finally {gate?.resolve();await bridge.dispose();}
 }}finally{globalThis.risuai=previous;await app.close();fs.rmSync(root,{recursive:true,force:true});}
 console.log(JSON.stringify({test:'storage_mirror_transition_retirement',passed,namespaces:plugins.map(p=>p[0]),server:'real HTTP + SQLite',liveRisuAI:'NOT_RUN'}));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
