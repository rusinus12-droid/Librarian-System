'use strict';
// A rejected provider fact has no stored value. It must not hold a whole State domain
// back, and a place filed under the person-only "location" kind is reclassified instead
// of rejected. Full plugin with a synthetic provider and physical KV readback.
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const results=[];
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
const evidenceOf=(f,id)=>f.clone(f.control.artifact.facts.find(x=>x.tempFactId===id).evidenceSpans);
(async()=>{
 await test('a place described with the person location kind is stored as world memory, not rejected',async f=>{
  const a=f.control.artifact;a.stateBindings=[];
  a.facts.push({tempFactId:'fp_self',domain:'world',subjectTempRef:'study',claimKind:'location',values:{locationRef:'study'},text:'서재는 조용한 열람 공간이다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:evidenceOf(f,'f1')});
  a.facts.push({tempFactId:'fp_parent',domain:'world',subjectTempRef:'hall',claimKind:'location',values:{locationRef:'library'},text:'공연실은 도서관 안에 있다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:evidenceOf(f,'f2')});
  await f.run();
  const memory=f.getMemory(),admission=memory.artifactValidation.admission;
  assert.ok(!admission.rejected.some(r=>['fp_self','fp_parent'].includes(r.id)),'reclassified place facts are not rejected');
  const stored=Object.fromEntries(memory.canonicalArtifact.facts.map(x=>[x.tempFactId,x]));
  assert.equal(stored.fp_self.claimKind,'world_state');assert.equal(stored.fp_self.values.condition,'서재는 조용한 열람 공간이다.');
  assert.equal(stored.fp_parent.claimKind,'containment');assert.equal(stored.fp_parent.values.parentRef,'library');
  assert.equal(admission.normalizedFields.filter(r=>r.reason==='place_location_reclassified').length,2);
  const head=f.getHead();assert.equal(head.world.find(r=>r.name==='서재').state.condition,'서재는 조용한 열람 공간이다.');
 });
 await test('a rejected fact stays listed but leaves its domain ready and creates no review row',async f=>{
  const a=f.control.artifact;
  // A person-only kind filed under the relationship domain cannot be repaired and is rejected.
  a.facts.push({tempFactId:'fx',domain:'relationship',subjectTempRef:'junho',claimKind:'location',values:{locationRef:'hall'},text:'준호는 공연실에 있다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:evidenceOf(f,'f8')});
  await f.run();
  const admission=f.getMemory().artifactValidation.admission,rejected=admission.rejected.find(r=>r.id==='fx');
  assert.equal(rejected?.reason,'UNIFIED_FACT_KIND_INVALID');assert.equal(rejected.text,'준호는 공연실에 있다.','the rejected statement is kept for the result view');
  const head=f.getHead();
  assert.ok(head.unifiedApplied.pending.some(p=>p.fact==='fx'&&p.reason==='memory_record_quarantined'),'the rejection remains visible');
  assert.equal(head.domainStatus.characters.status,'ready','a rejected fact no longer marks the whole character domain stale');
  assert.equal(head.status,'ready');
  assert.equal(head.characters.find(r=>r.name==='민아').state.locationRef,head.world.find(r=>r.name==='서재').id,'other facts of the batch still apply');
  const review=await f.r.api.listMemoryReviews();
  assert.equal(review.rows.length,0,'a fact that was never stored is not offered for review');
  assert.equal(review.unavailable.length,0);
 });
 console.log(JSON.stringify({test:'libra_rejected_fact_state_readiness',passed:results.length,results,boundary:'full plugin, synthetic provider and physical KV readback; live RisuAI untested'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
