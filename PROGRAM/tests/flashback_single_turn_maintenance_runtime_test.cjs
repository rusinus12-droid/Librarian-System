'use strict';
// Raw-first fault isolation: T32 remains durable while its zero vector fails;
// the 31 healthy turns stay ready, and only an explicit retry submits again.
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const DIM=16,unit=()=>Array.from({length:DIM},(_,i)=>i===2?1:0),zero=()=>new Array(DIM).fill(0);
const messages=n=>[{role:'user',chatId:'u'+n,data:'Inspect the archive for turn '+n+'.'},{role:'assistant',chatId:'a'+n,data:'For turn '+n+', Alice inspected the archive desk and confirmed that the blue ledger was still sealed. She placed the sealed document beside the wooden box and waited for the visitor to respond.'}];
(async()=>{
 const f=await createFixture();let fail=false,calls=0;
 try{
  const api=f.api,t=api._test;
  const cfg=t.normalizeSettings({...await api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'mock-embed',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:DIM,embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,fallbackHashEmbedding:false,autoEpisodeIndex:false,episodeIndexEnabled:false,autoColdStart:false});
  f.host.nativeFetch=async(_url,init)=>{calls++;const body=JSON.parse(init.body),inputs=Array.isArray(body.input)?body.input:[body.input];return new Response(JSON.stringify({data:inputs.map((text,index)=>({index,embedding:fail&&String(text).includes('turn 32')?zero():unit()}))}),{status:200})};
  await t.saveEmbeddingKeyLocal('offline-fixture-key');await api.saveSettings(cfg);
  f.currentChat.message=Array.from({length:31},(_,i)=>messages(i+1)).flat();f.currentChat.messages=f.currentChat.message;
  await api.ingestLiveChatColdStart({scope:'current',canonical:true,settings:cfg,skipEpisodeRebuild:true,deferEmbedding:true});
  const scope=await api.resolveCurrentScope();
  // Each source gets its own actual durable request/receipt. Finish the
  // bounded public batches rather than treating a 30s provider budget as all-ready.
  let completion,baseline;
  for(let batch=0;batch<31;batch++){
   completion=await api.processPendingEmbeddingQueue({maxSources:4,maxRequests:4});
   assert.equal(completion.failed,0,JSON.stringify(completion));
   baseline=await t.loadScopeRecords(scope.scopeKey);
   const ready=baseline.records.filter(r=>r.embeddingReceipt?.status==='ready').length;
   console.log('PASS actual ready source batch',batch+1,ready,'of 31');
   if(ready===31)break;
   assert.ok(completion.ready>0,'each explicit batch must make measured progress');
  }
  assert.equal(baseline.records.length,31);assert.ok(baseline.records.every(r=>r.vector.length===DIM&&r.embeddingReceipt?.status==='ready'),JSON.stringify(baseline.records.map(r=>({vector:r.vector.length,receipt:r.embeddingReceipt?.status,work:r.embeddingWork}))));
  f.currentChat.message.push(...messages(32));const raw=JSON.stringify(f.currentChat.message);fail=true;
  const result=await api.runMemoryMaintenance('auto',{settings:cfg});const after=await t.loadScopeRecords(scope.scopeKey);
  assert.equal(result.healthy,false);assert.equal(result.after.missingVectors,1);assert.equal(after.records.length,32,'failed embedding never discards T32 raw source');
  const failed=after.records.find(r=>r.embeddingWork?.status==='failed');assert.ok(failed);assert.equal(failed.embeddingWork.lastError.code,'INVALID_RESPONSE');assert.equal(failed.vector.length,0);
  for(const before of baseline.records){const current=after.records.find(r=>r.id===before.id);assert.equal(current.text,before.text);assert.deepEqual(Array.from(current.vector),Array.from(before.vector));assert.equal(current.embeddingReceipt.status,'ready')}
  assert.equal(JSON.stringify(f.currentChat.message),raw);
  assert.match(t.maintenanceResultText(result),/실패 작업 재시도|보류|복구 대기/);
  fail=false;const beforeRetry=calls;
  const noRetry=await api.runMemoryMaintenance('auto',{settings:cfg});assert.equal(noRetry.healthy,false);assert.equal(calls,beforeRetry,'ordinary maintenance cannot retry a failed source');
  const retry=await api.processPendingEmbeddingWork({sourceHash:failed.sourceHash,retryFailed:true});assert.equal(retry.ready,1);
  const final=await t.loadScopeRecords(scope.scopeKey);assert.equal(final.records.length,32);assert.ok(final.records.every(r=>r.vector.length===DIM&&r.embeddingReceipt?.status==='ready'));
  const healthy=await api.runMemoryMaintenance('auto',{settings:cfg});assert.equal(healthy.healthy,true);assert.equal(healthy.after.missingTurns,0);
  // Full rebuild is also raw-first: a new unembedded source is stored without
  // claiming vector completeness or replacing any healthy source/vector.
  f.currentChat.message.push(...messages(33));const beforeRebuildCalls=calls;
  await api.rebuildCurrentChatMemory({settings:cfg,deferEmbedding:true,allowHashFallback:false});
  const rebuilt=await t.loadScopeRecords(scope.scopeKey);assert.equal(rebuilt.records.length,33);assert.equal(calls,beforeRebuildCalls);
  const pending=rebuilt.records.find(r=>Number(r.pairIndex)===33);assert.ok(pending);assert.equal(pending.vector.length,0);assert.equal(pending.embeddingWork.status,'pending');
  for(const before of final.records){const current=rebuilt.records.find(r=>r.id===before.id);assert.equal(current.text,before.text);assert.deepEqual(Array.from(current.vector),Array.from(before.vector))}
  const protectedCommit=rebuilt.manifest.commitId;
  // A valid pending raw job may travel with a strict copy; a missing physical
  // sidecar for a previously ready source must still refuse publication.
  const readySidecar=rebuilt.records.find(r=>r.embeddingReceipt?.status==='ready').vectorRef.storageKey;
  await f.host.safeLocalStorage.removeItem(readySidecar);
  await assert.rejects(()=>t.cloneScopeStorage(scope,{...scope,scopeKey:scope.scopeKey+'|incomplete-vector-copy'},cfg,{mode:'same_chat_persona_recovery'}),e=>e.code==='FLASHBACK_CLONE_SOURCE_VECTOR_INVALID');
  assert.equal((await t.loadScopeRecords(scope.scopeKey)).manifest.commitId,protectedCommit,'failed clone cannot publish over the source');
  console.log('flashback_single_turn_maintenance_runtime_test: PASS (31 healthy + failed raw T32; explicit retry; raw rebuild and strict clone)');
 }finally{await f.dispose()}
})().catch(e=>{console.error(e);process.exitCode=1});
