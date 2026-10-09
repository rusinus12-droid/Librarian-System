'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
const base=process.env.LIB_BASE_PROGRAM||path.join(__dirname,'..');
const {createHayakuRuntime,waitFor}=require(path.join(base,'tests/fixtures/hayaku_runtime_harness.cjs'));
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
(async()=>{const f=await createHayakuRuntime({autoRepair:false});let release;
 try{
  const profile={selectedPersona:0,personas:[{id:'fixture-profile',personaPrompt:'Synthetic persona'}]};f.host.getDatabase=async()=>profile;
  f.host.runLLMModel=async()=>{throw Error('MODEL_FORBIDDEN')};f.host.nativeFetch=async()=>{throw Error('NETWORK_FORBIDDEN')};f.context.fetch=async()=>{throw Error('NETWORK_FORBIDDEN')};
  let source=fs.readFileSync(path.join(base,'plugins/RETRACE.js'),'utf8');source=source.replace('  const RetraceApi = Object.freeze({','  globalThis.retraceHealthTest = { storage:MemorySuiteStorageBridge, Runtime, setBusy };\n  const RetraceApi = Object.freeze({');
  const initial=f.host.unloadHandlers.length;vm.runInContext(source,f.context,{filename:'RETRACE-health-test.js'});await waitFor(()=>f.host.unloadHandlers.length>initial,'RETRACE initialized');
  const api=f.context.__RETRACE,health=api.healthRecovery,internals=f.context.retraceHealthTest;assert(health);await internals.storage.setMode('plugin_only');
  internals.Runtime.lastPreview={identity:{characterId:f.character.id,chatId:f.chat.id},derived:true};internals.Runtime.compatibilitySuite={derived:true};
  const before=JSON.stringify({plugin:[...f.pluginStorage.values],local:[...f.safeLocalStorage.values],chat:f.chat,profile});
  let writes=0;const set=f.host.pluginStorage.setItem;f.host.pluginStorage.setItem=async(...args)=>{writes++;return set(...args)};
  const report=await health.inspect(),ticket=await health.preview();assert.equal(report.known,true);assert.equal(ticket.allowed,true);assert.equal(writes,0);
  const gate=deferred();release=gate.resolve;f.host.getDatabase=async()=>{await gate.promise;return profile};const repair=health.repair(ticket);
  await assert.rejects(api.continueToNextSession(),/HEALTH_OPERATION_IN_PROGRESS/);await assert.rejects(api.inspectTransition(),/HEALTH_OPERATION_IN_PROGRESS/);await assert.rejects(internals.storage.startRestoreJob(),/HEALTH_OPERATION_IN_PROGRESS/);assert.throws(()=>internals.setBusy(true),/HEALTH_OPERATION_IN_PROGRESS/);
  gate.resolve();assert.equal((await repair).status,'cache_invalidated');assert.equal(writes,0);assert.equal(internals.Runtime.lastPreview,null);assert.equal(internals.Runtime.compatibilitySuite,null);
  assert.equal(JSON.stringify({plugin:[...f.pluginStorage.values],local:[...f.safeLocalStorage.values],chat:f.chat,profile}),before);
  assert.equal((await health.repair(ticket)).status,'blocked');internals.setBusy(true);assert.equal((await health.preview()).allowed,false);internals.setBusy(false);assert.equal((await health.preview()).allowed,true);
  const closeTicket=await health.preview();await api.closeUi();assert.equal((await health.repair(closeTicket)).status,'blocked');assert.equal((await health.repair(await health.preview())).status,'cache_unchanged');await f.dispose();assert.equal((await health.preview()).allowed,false);
  assert.equal(f.llmCalls.length,0);console.log('PASS full RETRACE VM: canonical byte preservation, one-use cache repair, handoff/inspection/restore/UI gates, close/unload, model/network traps');
 }finally{release?.();await f.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1});
