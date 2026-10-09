'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const results=[];
function responseShape(f){
 const a=f.control.artifact;
 a.stateBindings=a.stateBindings.filter(b=>b.factTempId==='f5');
 a.facts.find(f=>f.tempFactId==='f13').claimKind='unrecognized_thread';
 const source=a.facts.find(f=>f.tempFactId==='f1');
 a.facts.push({...f.clone(source),tempFactId:'event_one',domain:'event',claimKind:'event',values:{detail:'서재를 확인했다.'},text:'서재를 확인했다.'});
}
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
(async()=>{
 await test('missing all redundant bindings still projects typed fields in every State domain',async f=>{
  f.control.artifact.stateBindings=[];await f.run();const h=f.getHead();assert.equal(h.status,'ready');assert.equal(h.characters.length,3);assert.ok(h.world.length>=5);assert.equal(h.relationships.length,1);assert.equal(h.narrative.threads.length,1);assert.equal(countCalls(f.control).canonical,1);assert.deepEqual(f.getMemory().canonicalArtifact.stateBindings,[],'saved artifact is immutable');
 });
 await test('partial response with sparse bindings preserves cards and chronology while only rejected fields wait',async f=>{
  responseShape(f);await f.run();const h=f.getHead();assert.equal(h.status,'partial');assert.equal(h.characters.length,3);assert.ok(h.world.length>=5);assert.equal(h.relationships.length,1);assert.equal(h.narrative.threads.length,0,'rejected thread cannot be invented');assert.equal(h.narrative.events.length,1);assert.equal(h.narrative.events[0].turn,1);assert.ok(h.unifiedApplied.pending.some(p=>p.reason==='memory_record_quarantined'));assert.deepEqual(h.characters.find(r=>r.name==='민아').state.knowledge,['상자의 암호']);
  const narrative=await f.r.api.getWorldManagerNarrative();assert.equal(narrative.events.length,1,'GUI snapshot normalization must retain chronology');
  const bytes=JSON.stringify(f.getMemory());await f.r.api.retryPendingUnifiedState();assert.equal(JSON.stringify(f.getMemory()),bytes);assert.equal(f.getHead().narrative.events.length,1);assert.equal(countCalls(f.control).canonical,1);
 });
 await test('wrong optional destination cannot remap a typed fact or block its valid fixed field',async f=>{
  f.control.artifact.stateBindings.find(b=>b.factTempId==='f5').stateField='ownerRef';await f.run();const h=f.getHead(),mina=h.characters.find(r=>r.name==='민아');assert.equal(mina.state.locationRef,h.world.find(r=>r.name==='서재').id);assert.equal(mina.state.ownerRef,undefined);assert.equal(h.status,'ready');
 });
 await test('reported facts and events stay out of current cards and chronology',async f=>{
  responseShape(f);f.control.artifact.facts.find(x=>x.tempFactId==='event_one').temporalRole='reported';f.control.artifact.facts.find(x=>x.tempFactId==='f9').temporalRole='reported';await f.run();assert.equal(f.getHead().characters.find(r=>r.name==='민아').state.knowledge,undefined);assert.equal(f.getHead().narrative.events?.length||0,0);
 });
 // Simulate the deployed pre-fix replay barrier to create an authentic pending
 // journal/commit through the public API, then reload those bytes with the fix.
 let old=await fixture({transformSource:s=>s.replace('head=nextHead;registry=syncUnifiedRegistryIdentity(candidate.registry,head);typedCount++;',"if(allowIncompletePrefix && asArray(nextHead.unifiedApplied?.pending).length){pendingBoundary={reason:'state_bindings_pending'};break;} head=nextHead;registry=syncUnifiedRegistryIdentity(candidate.registry,head);typedCount++;" )});
 let snapshot,canonical;
 try{responseShape(old);await old.run();assert.equal(old.getHead(),null);canonical=JSON.stringify(old.getMemory());snapshot={chat:old.chat,values:[...old.r.values]};}finally{await old.r.cleanup();}
 const recovered=await fixture({snapshot});try{
  for(let i=0;i<100&&!recovered.getHead();i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(recovered.getHead()?.characters.length,'startup must automatically recover the pending journal');assert.ok(recovered.getHead().world.length);assert.equal(recovered.getHead().narrative.events.length,1);assert.equal(JSON.stringify(recovered.getMemory()),canonical);assert.equal(recovered.control.calls.length,0);results.push('previous pending journal automatically recovers after reload without changing canon or calling AI');
 }finally{await recovered.r.cleanup();}
 console.log(JSON.stringify({test:'libra_partial_state_projection_runtime',passed:results.length,results,boundary:'full plugin, synthetic provider and physical KV readback; live RisuAI untested'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
