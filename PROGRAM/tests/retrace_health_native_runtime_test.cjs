'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
const base=process.env.LIB_BASE_PROGRAM||path.join(__dirname,'..');
const {createHayakuRuntime,waitFor}=require(path.join(base,'tests/fixtures/hayaku_runtime_harness.cjs'));
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
(async()=>{const f=await createHayakuRuntime({autoRepair:false});let release;
 try{
  const profile={selectedPersona:0,personas:[{id:'fixture-profile',personaPrompt:'Synthetic persona'}]};f.host.getDatabase=async()=>profile;
  f.host.runLLMModel=async()=>{throw Error('MODEL_FORBIDDEN')};f.host.nativeFetch=async()=>{throw Error('NETWORK_FORBIDDEN')};f.context.fetch=async()=>{throw Error('NETWORK_FORBIDDEN')};
  let source=fs.readFileSync(path.join(base,'plugins/RETRACE.js'),'utf8');source=source.replace('  const RetraceApi = Object.freeze({','  globalThis.retraceHealthTest = { storage:MemorySuiteStorageBridge, Runtime, setBusy, scope:memorySuiteRetraceCurrentScope };\n  const RetraceApi = Object.freeze({');
  const initial=f.host.unloadHandlers.length;vm.runInContext(source,f.context,{filename:'RETRACE-health-test.js'});await waitFor(()=>f.host.unloadHandlers.length>initial,'RETRACE initialized');
  const api=f.context.__RETRACE,health=api.healthRecovery,internals=f.context.retraceHealthTest;assert(health);assert.equal(await internals.storage.getMode(),'plugin_only');assert.equal(internals.storage.storagePolicy,'manager_only');assert.equal(internals.storage.setMode,undefined);
  internals.Runtime.lastPreview={identity:{characterId:f.character.id,chatId:f.chat.id},derived:true};internals.Runtime.compatibilitySuite={derived:true};
  const before=JSON.stringify({plugin:[...f.pluginStorage.values],local:[...f.safeLocalStorage.values],chat:f.chat,profile});
  let writes=0;const set=f.host.pluginStorage.setItem;f.host.pluginStorage.setItem=async(...args)=>{writes++;return set(...args)};
  const ownScope=await internals.scope(),ownKey='memory_session_bridge:hayaku_cold_start:'+ownScope.scopeKey;
  let reads=0;const get=f.host.pluginStorage.getItem;f.host.pluginStorage.getItem=async(...args)=>{reads++;return get(...args)};
  for(const [scope,key] of [[{...ownScope,scopeId:'foreign',scopeKey:'foreign'},ownKey],[ownScope,'memory_session_bridge:hayaku_cold_start:foreign'],[ownScope,'hayaku.v2.ledger.foreign']]){
    const priorReads=reads;await assert.rejects(()=>internals.storage.inspectLocalHealthSnapshot(scope,key,{strictPhysical:true}),/HEALTH_(?:SCOPE|STORAGE_KEY)_UNVERIFIED/);assert.equal(reads,priorReads,'foreign scope/key rejected before storage read');
  }
  assert.match((await internals.storage.inspectLocalHealthSnapshot(ownScope,ownKey,{strictPhysical:true})).binding,/manager_only/);
  const report=await health.inspect(),ticket=await health.preview();assert.equal(report.known,true);assert.equal(ticket.allowed,true);assert.equal(writes,0);
  const gate=deferred();release=gate.resolve;f.host.getDatabase=async()=>{await gate.promise;return profile};const repair=health.repair(ticket);
  await assert.rejects(api.continueToNextSession(),/HEALTH_OPERATION_IN_PROGRESS/);await assert.rejects(api.inspectTransition(),/HEALTH_OPERATION_IN_PROGRESS/);await assert.rejects(internals.storage.managerControl('restore-execute',{}),/HEALTH_OPERATION_IN_PROGRESS/);assert.throws(()=>internals.setBusy(true),/HEALTH_OPERATION_IN_PROGRESS/);
  gate.resolve();assert.equal((await repair).status,'cache_invalidated');assert.equal(writes,0);assert.equal(internals.Runtime.lastPreview,null);assert.equal(internals.Runtime.compatibilitySuite,null);
  assert.equal(JSON.stringify({plugin:[...f.pluginStorage.values],local:[...f.safeLocalStorage.values],chat:f.chat,profile}),before);
  assert.equal((await health.repair(ticket)).status,'blocked');internals.setBusy(true);assert.equal((await health.preview()).allowed,false);internals.setBusy(false);assert.equal((await health.preview()).allowed,true);
  const modeTicket=await health.preview();
  f.pluginStorage.values.set('__memory_suite_internal_scope_routes_v1__:retrace',JSON.stringify({schema:'memory-suite.scope-routing.v1',legacyGlobalModeImported:true,entries:{[ownScope.scopeId]:{scopeId:ownScope.scopeId,scopeKey:ownScope.scopeKey,mode:'server_only',origin:'explicit'}}}));
  const remoteRows=JSON.stringify([...f.pluginStorage.values]);assert.equal((await health.repair(modeTicket)).status,'blocked');assert.equal(JSON.stringify([...f.pluginStorage.values]),remoteRows,'remote authority drift never mutates retained rows');assert.equal(writes,0);f.pluginStorage.values.delete('__memory_suite_internal_scope_routes_v1__:retrace');
  const scopeTicket=await health.preview(),chatId=f.chat.id;f.chat.id='foreign-health-scope';assert.equal((await health.repair(scopeTicket)).status,'blocked');f.chat.id=chatId;assert.equal(writes,0);
  const closeTicket=await health.preview();await api.closeUi();assert.equal((await health.repair(closeTicket)).status,'blocked');assert.equal((await health.repair(await health.preview())).status,'cache_unchanged');await f.dispose();assert.equal((await health.preview()).allowed,false);
  assert.equal(f.llmCalls.length,0);console.log('PASS full RETRACE VM: canonical byte preservation, one-use cache repair, handoff/inspection/restore/UI gates, close/unload, model/network traps');
 }finally{release?.();await f.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1});
