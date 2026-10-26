'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');

(async()=>{
 const f=await fixture();try{
  await f.run();
  const ref=f.getManifest().memories['1'],original=f.r.values.get(ref.key),head=JSON.stringify(f.getHead()),calls=f.control.calls.length;
  for(const [failedCheck,change] of [
   ['renderedText',memory=>{memory.text+=' physical corruption';}],
   ['sourcePairs',memory=>{memory.sourcePairs[0].assistantChatId='foreign-message';}]
  ]){
   const memory=JSON.parse(original);change(memory);f.r.values.set(ref.key,JSON.stringify(memory));
   await assert.rejects(()=>f.r.api.getCanonicalReaderChapter({memoryId:ref.memoryId,revision:ref.revision}),error=>{
    assert.equal(error.code,'UNIFIED_REPLAY_ARTIFACT_MISMATCH');
    assert.match(error.message,new RegExp(failedCheck));return true;
   });
   const diagnostic=f.r.context.__fixtureNativeMemoryCore.state.lastUnifiedReplayValidation;
   assert.equal(diagnostic.ok,false);assert.equal(diagnostic.failedCheck,failedCheck);
   assert.equal(diagnostic.checks[failedCheck],false);
   assert.equal(diagnostic.memoryId,ref.memoryId);
   assert.ok(!JSON.stringify(diagnostic).includes(memory.text),'diagnostics do not export memory/source text');
   assert.equal(JSON.stringify(f.getHead()),head,'reader failure never rewrites State');
   assert.equal(f.control.calls.length,calls,'diagnosis does not pay for generation');
   f.r.values.set(ref.key,original);
  }
  const chapter=await f.r.api.getCanonicalReaderChapter({memoryId:ref.memoryId,revision:ref.revision});
  assert.equal(chapter.text,JSON.parse(original).text,'valid original still reads');
  assert.equal(f.r.values.get(ref.key),original,'canonical bytes stay immutable');
  console.log('PASS replay diagnostics: render/source-pair mismatch separated; invalid bytes rejected; original, State and model count preserved');
 }finally{await f.r.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
