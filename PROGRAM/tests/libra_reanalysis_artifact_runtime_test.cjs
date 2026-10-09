'use strict';
// Public runtime contract, reusable against Full or Min through LIBRA_TEST_PLUGIN.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
test('built LIBRA public API performs one-click current-source replacement and preserves prior body',async()=>{
 const f=await fixture();try{
  console.log('ARTIFACT_RUNTIME_LOAD '+JSON.stringify({path:process.env.LIBRA_TEST_PLUGIN||'source',sha256:require('node:crypto').createHash('sha256').update(f.r.source).digest('hex')}));
  assert.equal(typeof f.r.api.getSourceEditSyncStatus,'undefined');assert.equal(typeof f.r.api.setSourceEditTrackingMode,'undefined');
  assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();
  const prior={...f.getManifest().memories['1']},bytes=f.r.values.get(prior.key);
  f.chat.message[0].data+=' Edited current source.';
  const selection=await f.r.api.listCanonicalBatchRanges();
  assert.equal(selection.ranges[0].status,'saved');
  const result=await f.r.api.startSelectedCanonicalBatches({scopeKey:selection.scopeKey,mode:'source_edit',ranges:selection.ranges});
  assert.equal(result.ok,true,JSON.stringify(result));assert.ok(f.getManifest().memories['1'].revision>prior.revision);assert.equal(f.r.values.get(prior.key),bytes);
  await f.r.api.setSourceEditRules({version:1,ignoredTags:['decoration'],unwrapTags:['wrapper'],sourceTags:[],controls:[]});
  assert.deepEqual(Array.from(f.r.api.getSourceEditRules().ignoredTags),['decoration']);
  assert.equal([...f.r.values.keys()].some(k=>k.includes(':source-edit-consent:')),false);
 }finally{await f.r.cleanup();}
});
