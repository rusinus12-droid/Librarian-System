'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {configure,syntheticFetch}=require('./helpers/unload_recall_contract_fixture.cjs');
const {waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const OLD='Alice signed the agreement.',NEW='Alice did not sign the agreement.';
// Observe actual scheduler acceptance without replacing timers, storage or work.
const source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8')
 .replace('const schedulePendingEmbeddingWork = (scopeKey, options = {}) => {','const nativeSchedulePendingEmbeddingWork = (scopeKey, options = {}) => {')
 .replace('const scheduleCapturedTurnRemoteReembed =',`const schedulePendingEmbeddingWork=(scopeKey,options={})=>{
   const accepted=nativeSchedulePendingEmbeddingWork(scopeKey,options);
   (globalThis.__fixtureSchedules||=[]).push({scopeKey,reason:options.reason,accepted});return accepted;
 };\n  const scheduleCapturedTurnRemoteReembed =`);
async function start(settings={}){
 const f=await createFixture({source,chat:{message:[{role:'user',chatId:'u1',data:'What happened?'},{role:'assistant',chatId:'a1',data:OLD}]}});
 try{
  await waitFor(()=>f.api.uiStatus().registered.after,'Flashback startup');
  let calls=0,hold=null;
  f.host.nativeFetch=async(...args)=>{calls++;if(hold)await hold;return syntheticFetch(...args);};
  await configure(f,'configured');
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  await f.api.processPendingEmbeddingQueue({maxSources:8,maxRequests:8});
  const scope=await f.api.resolveCurrentScope(),records=async()=>(await f.api._test.loadScopeRecords(scope.scopeKey)).records;
  assert.ok((await records()).every(row=>row.embeddingReceipt?.status==='ready'),'setup uses actual provider receipts');
  await f.api.saveSettings({...await f.api.loadSettings(),embeddingAutoProcess:true,...settings});
  f.currentChat.message[1].data=NEW;
  f.context.__fixtureSchedules=[];const baseline=calls;
  return {f,records,calls:()=>calls-baseline,schedules:()=>Array.from(f.context.__fixtureSchedules),
   hold:promise=>{hold=promise;},run:async()=>f.api.reanalyzeSelectedRanges(await f.api.listReanalysisRanges())};
 }catch(error){await f.dispose();throw error;}
}
test('Flashback raw reanalysis reports a real automatic reservation, then embeds the new source separately',async()=>{
 const s=await start();let release;const gate=new Promise(resolve=>{release=resolve;});s.hold(gate);
 try{
  const result=await s.run();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.rawSaved,true);assert.equal(result.remoteEmbeddingQueued,true);
  assert.equal(s.calls(),0,'raw-save operation does not dispatch a model request');
  assert.deepEqual(s.schedules().map(row=>[row.reason,row.accepted]),[['explicit_reanalysis_published',true]],'one reservation after verified reanalysis, no premature ingest reservation');
  const raw=await s.records();assert.ok(raw.some(row=>row.text.includes(NEW)));assert.ok(raw.every(row=>row.embeddingReceipt?.status!=='ready'),'reservation is not embedding completion');
  await waitFor(()=>s.calls()===1,'automatic provider request');release();
  let ready=await s.records();
  for(let i=0;ready.some(row=>row.embeddingReceipt?.status!=='ready');i++){
   assert.ok(i<200,'automatic work must publish validated receipts');await new Promise(resolve=>setTimeout(resolve,10));ready=await s.records();
  }
  assert.equal(s.calls(),1);assert.ok(ready.length>0);
  for(const row of ready){
   const pending=raw.find(item=>item.id===row.id);assert.ok(pending);assert.ok(row.text.includes(NEW));assert.equal(row.vector.length,3);
   assert.equal(row.sourceHash,pending.sourceHash);assert.equal(row.embeddingReceipt.sourceRevision,pending.embeddingWork.sourceRevision);assert.equal(row.embeddingReceipt.jobId,pending.embeddingWork.jobId);
  }
 }finally{release();await s.f.dispose();}
});
for(const [name,settings]of[
 ['automatic processing disabled',{embeddingAutoProcess:false}],
 ['model unconfigured',{embeddingProvider:'hash',embeddingModel:'hash-v1'}],
 ['embedding disabled',{embeddingEnabled:false}]
])test('Flashback '+name+' saves raw without reserving automatic embedding',async()=>{
 const s=await start(settings);try{
  const result=await s.run();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.rawSaved,true);assert.equal(result.remoteEmbeddingQueued,false);
  assert.deepEqual(s.schedules().map(row=>[row.reason,row.accepted]),[['explicit_reanalysis_published',false]]);
  assert.equal(s.calls(),0);const raw=await s.records();assert.ok(raw.some(row=>row.text.includes(NEW)));assert.ok(raw.every(row=>row.embeddingReceipt?.status!=='ready'));
 }finally{await s.f.dispose();}
});
test('Flashback failed reanalysis preserves the old source and never reserves automatic embedding',async()=>{
 const s=await start();try{
  const set=s.f.pluginStorage.setItem.bind(s.f.pluginStorage);let fail=true;
  s.f.pluginStorage.setItem=async(key,value)=>{if(fail&&String(key).endsWith(':turn_worldline:v1')){fail=false;throw Error('fixture failed worldline commit');}return set(key,value);};
  const result=await s.run();assert.equal(result.ok,false);assert.equal(fail,false);assert.equal(s.schedules().length,0);assert.equal(s.calls(),0);
  const raw=await s.records();assert.ok(raw.some(row=>row.text.includes(OLD)));assert.ok(raw.every(row=>!row.text.includes(NEW)));
 }finally{await s.f.dispose();}
});
