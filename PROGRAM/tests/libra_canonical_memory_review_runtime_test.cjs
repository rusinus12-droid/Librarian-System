'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
(async()=>{
 const f=await fixture();try{
  f.chat.message[1].data+=' 도서관 문이 열렸다. 도서관 문이 닫혔다.';
  for(const [i,value] of ['열렸다','닫혔다'].entries()){
   const id='review-conflict-'+i;f.control.artifact.facts.push({tempFactId:id,domain:'world',subjectTempRef:'library',claimKind:'world_state',values:{condition:value},text:'도서관 문이 '+value,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t1-a',quote:'도서관 문이 '+value}],dependsOn:[]});
   f.control.artifact.stateBindings.push({factTempId:id,typedValueField:'condition',stateDomain:'world',stateField:'condition'});
  }
  assert.equal((await f.run()).completed,1);
  const ref=f.getManifest().memories['1'],original=f.r.values.get(ref.key),head=JSON.stringify(f.getHead()),calls=f.control.calls.length;
  let p=await f.r.api.listMemoryReviews();assert.equal(p.rows.length,2);assert.ok(p.rows.every(r=>r.risk==='high'&&r.stateEligible));
  const current=async()=>(await f.r.api.debugLoadContinuityStateForResponse()).head.world.find(r=>r.name==='도서관').state.condition;
  assert.equal(await current(),'닫혔다');
  const formal=await f.r.api.debugLoadContinuityStateForResponse();assert.equal(formal.head.status,'ready');assert.equal(formal.authority.current,true,'reviewable automatic values are usable current state, not last-known-only');
  const close=p.rows.find(r=>r.text.includes('닫혔다'));
  assert.equal((await f.r.api.setMemoryReviewDecision({scopeKey:p.scopeKey,previewDigest:p.previewDigest,ids:[close.id],status:'rejected'})).ok,true);assert.equal(await current(),'열렸다');
  f.r.values.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',pluginId:'LIBRA',legacyGlobalModeImported:true,entries:{[p.scopeKey]:{scopeId:p.scopeKey,scopeKey:p.scopeKey,mode:'plugin_only',origin:'user_explicit',updatedAt:1}}}));
  const graph=await f.r.api.getMemoryGraphProjectionPage({nodeLimit:2048});assert.ok(graph.units.filter(u=>u.family==='canonical').every(u=>u.fact?.tempFactId!=='review-conflict-1'));
  const result=await f.r.api.executeMemoryGraphUnifiedQuery({corpusMode:'window',queryInput:{queryText:'도서관 문이 닫혔다'},semanticPolicy:{mode:'disabled'},consumerPolicy:{maxUnits:16},laneBudget:{maxPages:128,maxBytes:262144}});
  assert.equal(result.modelDispatchEligible,true);assert.ok(result.bundle.items.every(item=>!item.text.includes('도서관 문이 닫혔다')),'the rejected fact is absent from final verified recall even when queried directly');
  assert.equal(f.r.values.get(ref.key),original);assert.equal(JSON.stringify(f.getHead()),head,'projection and review cannot rewrite Canonical/Head bytes');assert.equal(f.control.calls.length,calls);
  assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal(await current(),'열렸다');
  p=await f.r.api.listMemoryReviews();assert.equal(p.rows.find(r=>r.id===close.id).status,'rejected');assert.equal(p.rows.find(r=>r.id===close.id).risk,'high');
  f.chat.message[1].data+=' edited source';assert.equal((await f.r.api.listMemoryReviews()).rows.length,0);
  console.log('PASS Canonical conflicts automatically project with high risk, selective rejection excludes final recall, immutable source/Head and rebuild persistence, stale source exclusion');
 }finally{await f.r.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
