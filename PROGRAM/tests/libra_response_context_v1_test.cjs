'use strict';
const assert=require('node:assert/strict');const {lineageFixture,clone}=require('./fixtures/libra_unified_lineage_fixture.cjs');
const results=[];async function test(name,fn){const f=await lineageFixture();try{await f.run();await fn(f);results.push(name);console.log('PASS',name);}finally{await f.r.cleanup();}}
const info=x=>JSON.stringify(x);
const {isDeepStrictEqual}=require('node:util');
function assertMemoryStableExceptEmbedding(expectedRaw,actualRaw,message){
 const expected=JSON.parse(expectedRaw),actual=JSON.parse(actualRaw),expectedEmbedding=expected.embedding,actualEmbedding=actual.embedding;
 delete expected.embedding;delete actual.embedding;assert.deepEqual(actual,expected,message);
 const embeddingChanged=!isDeepStrictEqual(actualEmbedding,expectedEmbedding);
 if(!embeddingChanged)assert.equal(actualRaw,expectedRaw,`${message}: unchanged embedding retains exact raw bytes`);
 return {embeddingChanged};
}
function verifyMemoryComparatorNegativeControls(){
 const before=JSON.stringify({memoryId:'probe',revision:1,sourceDigest:'source-1',artifactDigest:'artifact-1',canonicalArtifact:{schema:'probe'},embedding:{status:'pending'}});
 const embeddingOnly=JSON.parse(before);embeddingOnly.embedding.status='disabled';
 assert.doesNotThrow(()=>assertMemoryStableExceptEmbedding(before,JSON.stringify(embeddingOnly),'embedding-only probe'));
 for(const field of ['revision','sourceDigest','artifactDigest']){
  const changed=JSON.parse(before);changed[field]=field==='revision'?2:`${changed[field]}-tampered`;
  assert.throws(()=>assertMemoryStableExceptEmbedding(before,JSON.stringify(changed),`negative control ${field}`),assert.AssertionError,
   `the canonical comparison still rejects changed ${field}`);
 }
}
verifyMemoryComparatorNegativeControls();



// Valid synthetic model responses explicitly implement the new request-bound
// production patch contract. Invalid-patch tests remain in their own suites.

function completedHead(f,turn=5){
 const row=[...f.r.values].map(([key,raw])=>{try{return {key,value:JSON.parse(raw)};}catch{return null;}})
  .find(row=>row?.value?.schema==='libra.completed_turn_head.v1' && row.value.turn===turn);
 assert.ok(row,`fixture has completed T${turn} receipt head`);return row;
}

(async()=>{
 await test('value-only ResponseContext getter has zero storage/model/vector side effects and exact seal',async f=>{
  const before=[...f.r.values],calls=f.control.calls.length;const context=await f.r.api.getResponseContext({currentInput:'민아는 누구를 신뢰하나요?'});assert.equal(context.schema,'libra.response_context.v1');assert.equal(context.values.currentHead.characters.length,3);assert.equal(context.values.currentInput,'민아는 누구를 신뢰하나요?');assert.equal((await f.r.api.validateResponseContext(context)).ok,true);assert.deepEqual([...f.r.values],before);assert.equal(f.control.calls.length,calls);
  context.values.currentInput='변조';assert.equal((await f.r.api.validateResponseContext(context)).ok,false);assert.notEqual(f.r.api.getLastResponseContext().values.currentInput,'변조');
 });
 await test('current canonical, State, raw source and worldline changes invalidate a snapshot',async f=>{
  const before=await f.r.api.getResponseContext();const a=f.head().characters[0];await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:a.id,set:{condition:'교정된 현재값'}}]}});assert.equal((await f.r.api.validateResponseContext(before)).ok,false);
  const next=await f.r.api.getResponseContext();f.current().message[0].data+=' 수정';assert.equal((await f.r.api.validateResponseContext(next)).ok,false);
 });
 await test('rolled-back frontier hides future recall from actual Classic and preserves original canonical',async f=>{
  f.appendFive();await f.run();const manifest=f.manifest(),future=manifest.memories['6'],bytes=f.r.values.get(future.key),futureMemory=JSON.parse(bytes);
  const evidenceKey=futureMemory.sourceEvidenceRef?.key,evidenceBytes=f.r.values.get(evidenceKey);assert.ok(evidenceKey,'future memory has a durable source-evidence row');
  await f.r.api.rollbackWorldManagerState({throughTurn:5});
  const context=await f.r.api.getResponseContext({currentInput:'민아의 은빛 열쇠'});assert.equal(context.cutoffTurn,5);assert.equal(context.canonicalRefs.length,1);assert.equal(context.values.currentHead.throughTurn,5);
  const recall=await f.r.api.previewUnifiedMemoryRecall('민아의 은빛 열쇠');assert.ok(recall.memories.every(r=>r.memory.turnRange.end<=5));
  await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'}); const actual=await f.control.hooks.beforeRequest([{role:'user',content:'민아의 은빛 열쇠'}],'model'); assert.ok(actual.some(m=>m.content?.includes('[LIBRA CLASSIC RECALL')),'actual retained Classic consumes admitted recall'); const refreshed=await f.r.api.getResponseContext(); assert.equal(refreshed.cutoffTurn,5); assert.equal(refreshed.canonicalRefs.length,1); assert.equal((await f.r.api.validateResponseContext(refreshed)).ok,true);
  const afterBytes=f.r.values.get(future.key),afterMemory=JSON.parse(afterBytes);
  const comparison=assertMemoryStableExceptEmbedding(bytes,afterBytes,'rollback preserves every canonical field except derived embedding state');
  assert.equal(afterMemory.revision,futureMemory.revision,'rollback preserves canonical revision');
  assert.equal(afterMemory.sourceDigest,futureMemory.sourceDigest,'rollback preserves the source digest');
  assert.equal(afterMemory.artifactDigest,futureMemory.artifactDigest,'rollback preserves the artifact digest');
  assert.equal(f.r.values.get(evidenceKey),evidenceBytes,'rollback preserves the exact persisted source-evidence bytes');
  if(!comparison.embeddingChanged)assert.equal(afterBytes,bytes,'unchanged embedding retains original canonical bytes');
 });
 await test('Classic consumes the same revision-bound canonical projection without raw State injection',async f=>{
  await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});const out=await f.control.hooks.beforeRequest([{role:'user',content:'민아의 은빛 열쇠 소유자'}],'model');assert.ok(out.some(m=>m.content?.includes('[LIBRA CLASSIC RECALL')));
  const context=f.r.api.getLastResponseContext();assert.equal(context.route,'classic');assert.equal(context.canonicalRefs.length,1);assert.equal(context.values.currentHead,null);assert.equal(context.values.canonicalLayers.memory.length>0,true);
  const providerKinds=f.control.calls.map(call=>String(call?.[0]?.messages?.[0]?.content||''));
  assert.equal(providerKinds.filter(text=>text.includes('LIBRA LONG-TERM MEMORY EXTRACTION')).length,1,'one Canonical extraction');
  assert.equal(providerKinds.every(text=>text.includes('LIBRA LONG-TERM MEMORY EXTRACTION')||text.includes('[LIBRA MICRO SOURCE CONTRACT]')),true,'Classic recall makes no extra model call');
 });







 await test('Classic rejects a completed receipt head deleted after projection and before injection',async f=>{
  const {key}=completedHead(f);await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
  const originalGet=f.r.values.get;let changed=false,projected=false;
  f.r.values.get=function(k){
   // The unified route validates the receipt read set after the canonical projection (memory/evidence rows) is read.
   if(String(k).includes(':source-evidence:'))projected=true;
   if(!changed && projected && k===key){
    changed=true;f.r.values.delete(key);
   }
   return originalGet.call(this,k);
  };
  try{
   const input=[{role:'user',content:'민아의 은빛 열쇠 소유자'}];
   const out=await f.control.hooks.beforeRequest(input,'model');
   assert.equal(changed,true,'head changed after the response context was frozen');
   assert.deepEqual(JSON.parse(JSON.stringify(out)),input,'stale Classic context must not be injected');
  }finally{f.r.values.get=originalGet;}
 });


 await test('timed-out final receipt read leaves host prompt unchanged and writes no receipt',async f=>{
  const {key}=completedHead(f);await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
  const originalGet=f.r.values.get;let entered=false,projected=false,release;
  const held=new Promise(resolve=>{release=resolve;});
  f.r.values.get=function(k){
   if(String(k).includes(':source-evidence:'))projected=true;
   if(!entered && projected && k===key){
    entered=true;return held.then(()=>originalGet.call(this,k));
   }
   return originalGet.call(this,k);
  };
  try{
   const before=f.r.storageWrites.filter(row=>String(row.key).includes(':source-receipt:')).length;
   const input=[{role:'user',content:'민아의 은빛 열쇠 소유자'}],out=await f.control.hooks.beforeRequest(input,'model');
   assert.equal(entered,true,'the final receipt read was held');
   assert.deepEqual(JSON.parse(JSON.stringify(out)),input,'final read timeout keeps the host prompt untouched');
   assert.equal(f.r.storageWrites.filter(row=>String(row.key).includes(':source-receipt:')).length,before,
    'final validation does not write a receipt');
   release();await new Promise(resolve=>setTimeout(resolve,20));
   assert.deepEqual(JSON.parse(JSON.stringify(out)),input,'late read cannot inject into the returned prompt');
  }finally{release();f.r.values.get=originalGet;}
 });
 console.log(JSON.stringify({test:'libra_response_context_v1',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
