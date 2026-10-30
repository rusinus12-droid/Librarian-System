'use strict';
// Shipped request handler and SQLite repository, with in-process HTTP transport.
// No live RisuAI, user DATA or external provider is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer,mockFetch}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-consent-health-'));
 const app=createMemorySuiteServer({dataDir,autoBackup:false,port:0}),address=await app.listen();
 const f=await createFixture({pauseScheduledTimers:true,exposeStorageBridge:true,
  arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`},nativeFetch:mockFetch,
  chat:{message:[{role:'user',chatId:'u1',data:'Where is the compass?'},{role:'assistant',chatId:'a1',data:'The amber compass remains inside the cedar cabinet.'}]}});
 try{
  await f.api.saveSettings({...await f.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,
   embeddingAutoProcess:false,autoEpisodeIndex:false,episodeIndexEnabled:false,autoColdStart:false});
  const scope=await f.api.resolveCurrentScope(false);
  await f.context.__fixtureStorageBridge.setScopeMode({scopeId:scope.scopeKey,scopeKey:scope.scopeKey},'server_only');
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true,skipEpisodeRebuild:true});
  const repo=app.repositories.flashback,prefix=`vector_rag_memory:scope:${scope.storageHash}:`;
  const seed=(name,value,operationId)=>{
   const key=prefix+name,owner='consent-health-fixture-owner',fence=repo.writerFence.command({key,owner,action:'acquire'});
   try{return repo.mutate({kind:'set',space:'plugin',key,value:JSON.stringify(value),operationId,fence});}
   finally{repo.writerFence.command({key,owner,action:'release',epoch:fence.epoch});}
  };
  const consent={schema:'memory-suite.source-edit-consent.v1',owner:'FLASHBACK',scopeKey:scope.scopeKey,tasks:{},revision:1};
  seed('source-edit-consent:v1',consent,'consent_health_seed_0001');
  const dump=()=>JSON.stringify(repo.database.prepare('SELECT * FROM kv ORDER BY space,key').all());
  let before=dump();const plan=await f.api.inspectMemoryMaintenance();
  assert.equal(plan.inspection.complete,true,JSON.stringify(plan.inspection));assert.equal(plan.storedRecords,1);assert.equal(dump(),before);
  assert.equal(repo.get('plugin',prefix+'source-edit-consent:v1').value,JSON.stringify(consent));
  seed('unknown:future',{scopeKey:scope.scopeKey,private:'PRIVATE_SENTINEL'},'consent_health_unknown_0001');
  before=dump();const incomplete=await f.api.inspectMemoryMaintenance();
  assert.equal(incomplete.inspection.complete,false);assert.equal(incomplete.automatic.blocked,true);assert(incomplete.inspection.reasons.includes('unsupported_scope_record'));
  const debug=await f.api.debugState();assert(debug.maintenanceInspection,'incomplete inspection must survive debug export');
  assert.equal(debug.maintenanceInspection.scopeKey,scope.scopeKey);assert.equal(debug.maintenanceInspection.inspection.complete,false);
  assert.deepEqual(Array.from(debug.maintenanceInspection.inspection.reasons),Array.from(incomplete.inspection.reasons));
  assert(!JSON.stringify(debug.maintenanceInspection).includes('PRIVATE_SENTINEL'));assert.equal(dump(),before);
  incomplete.inspection.reasons.push('caller_modified');
  assert(!(await f.api.debugState()).maintenanceInspection.inspection.reasons.includes('caller_modified'),'diagnostic evidence must not alias caller-owned plans');
  console.log(JSON.stringify({test:'flashback_server_inspection_consent_runtime',passed:['consent_supported_end_to_end','unknown_key_still_blocks','incomplete_debug_evidence_preserved','diagnostics_detached_from_plan'],transport:'in_process_http',sqlite:true,userDataWrites:0,providerCalls:0,liveRisuAI:false}));
 }finally{await f.dispose();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
