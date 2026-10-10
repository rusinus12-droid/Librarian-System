'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const results=[];
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
const fact=(f,id)=>f.control.artifact.facts.find(x=>x.tempFactId===id);
const admitted=(f,id)=>f.getMemory().canonicalArtifact.facts.some(x=>x.tempFactId===id);
const receipt=f=>f.getMemory().artifactValidation.admission;
(async()=>{
 await test('unknown top/entity/fact/value fields are dropped without losing valid facts',async f=>{
  f.control.artifact.extra='ignored';f.control.artifact.entities[0].confidence=.9;fact(f,'f5').confidence=.9;fact(f,'f5').values.explanation='ignored';
  const job=await f.run();assert.equal(job.completed,1);assert.equal(job.state,'completed_with_warnings');assert.equal(f.getMemory().canonicalArtifact.facts.length,13);assert.equal(receipt(f).droppedFields.length,4);assert.equal(f.getHead().status,'ready');assert.equal(f.control.calls.length,1);
 });
 await test('one bad fact is absent from canonical and recall while unrelated knowledge survives',async f=>{
  fact(f,'f1').values={parentRef:'nonexistent'};await f.run();assert.ok(!admitted(f,'f1'));assert.ok(admitted(f,'f9'));assert.equal(receipt(f).rejectedFacts,1);assert.equal(f.getMemory().pipeline.status,'partial');
  const recall=await f.r.api.previewUnifiedMemoryRecall('민아 상자 암호');assert.ok(recall.memories.some(x=>x.memory.memoryId===f.getMemory().memoryId));assert.deepEqual(f.getHead().characters.find(x=>x.name==='민아').state.knowledge,['상자의 암호']);
 });
 await test('rejected latest possession cannot promote an older holder',async f=>{
  fact(f,'f11').evidenceSpans[0].quote='not present';await f.run();assert.ok(!admitted(f,'f11'));assert.ok(admitted(f,'f7'));assert.ok(admitted(f,'f8'));
  assert.equal(f.getHead().world.find(x=>x.name==='은빛 열쇠').state.holderRef,undefined);assert.deepEqual(f.getHead().characters.find(x=>x.name==='민아').state.knowledge,['상자의 암호']);assert.equal(f.getHead().status,'partial');
 });
 await test('invalid entity rejects its dependent facts and keeps independent records',async f=>{
  f.control.artifact.entities.find(x=>x.tempId==='key').name='not in source';await f.run();assert.equal(receipt(f).rejectedEntities,1);for(const id of ['f6','f7','f8','f11'])assert.ok(!admitted(f,id));assert.ok(admitted(f,'f9'));
 });
 await test('ambiguous duplicate entities are all quarantined instead of choosing first',async f=>{
  f.control.artifact.entities.push(f.clone(f.control.artifact.entities.find(x=>x.tempId==='key')));await f.run();assert.equal(receipt(f).rejectedEntities,2);assert.ok(!admitted(f,'f11'));
 });
 await test('duplicate fact identifiers and transitive dependents are quarantined',async f=>{
  f.control.artifact.facts.push(f.clone(fact(f,'f1')));fact(f,'f2').dependsOn=['f1'];fact(f,'f3').dependsOn=['f2'];await f.run();for(const id of ['f1','f2','f3'])assert.ok(!admitted(f,id));assert.ok(admitted(f,'f9'));assert.equal(receipt(f).rejectedFacts,4);
 });
 await test('cyclic dependencies and their followers are removed independently of order',async f=>{
  fact(f,'f1').dependsOn=['f2'];fact(f,'f2').dependsOn=['f1'];fact(f,'f3').dependsOn=['f2'];f.control.artifact.facts.reverse();await f.run();for(const id of ['f1','f2','f3'])assert.ok(!admitted(f,id));assert.ok(admitted(f,'f9'));
 });
 await test('one invalid evidence span leaves another grounded span usable',async f=>{
  fact(f,'f9').evidenceSpans.push({ref:'t4-a',quote:'invented quote'});await f.run();assert.ok(admitted(f,'f9'));assert.equal(receipt(f).rejectedFacts,0);assert.equal(f.getMemory().canonicalArtifact.facts.find(x=>x.tempFactId==='f9').evidenceSpans.length,1);
 });
 await test('broken rule exception rejects the rule rather than broadening its scope',async f=>{
  fact(f,'f4').values.rule.exceptions.push({locationTempRef:'missing',condition:'only here',effect:'exception'});await f.run();assert.ok(!admitted(f,'f4'));assert.ok(admitted(f,'f9'));
 });
 await test('primitive garbage record is quarantined without crashing normalization',async f=>{
  f.control.artifact.facts.push(null,42);const r=await f.run();assert.equal(r.completed,1);assert.equal(receipt(f).rejectedFacts,2);assert.equal(f.getHead().status,'partial');
 });
 await test('zero valid facts remains a failure with no canonical or State',async f=>{
  for(const x of f.control.artifact.facts)x.evidenceSpans=[{ref:'t1-a',quote:'invented'}];const r=await f.run();assert.equal(r.completed,0);assert.equal(f.getMemory(),null);assert.equal(f.getHead(),null);assert.equal(f.control.calls.length,1);
 });
 await test('wrong root schema remains a failure without automatic model repair',async f=>{
  f.control.artifact.schema='unknown';assert.equal((await f.run()).completed,0);assert.equal(f.getMemory(),null);assert.equal(f.control.calls.length,1);
 });
 await test('stored admission tampering blocks State replay',async f=>{
  fact(f,'f11').evidenceSpans[0].quote='invented';await f.run();const before=JSON.stringify(f.getHead());const ref=f.getManifest().memories['1'];const mem=f.getMemory();mem.artifactValidation.admission.stateBlocks=[];f.r.values.set(ref.key,JSON.stringify(mem));await f.r.api.retryPendingUnifiedState();assert.equal(JSON.stringify(f.getHead()),before);assert.equal(f.control.calls.length,1);
 });
 await test('strict validator still rejects a malformed stored artifact',async f=>{
  const batch=[];for(let t=1;t<=5;t++)batch.push({turn:t,user:{text:f.chat.messages[t*2-2].data},assistant:{text:f.chat.messages[t*2-1].data}});
  fact(f,'f1').values={unknown:'bad'};assert.equal(f.r.api.debugValidateUnifiedArtifact(f.control.artifact,batch).ok,false);
 });
 await test('admission survives restart and does not call the model to repair State',async f=>{
  fact(f,'f11').evidenceSpans[0].quote='invented';await f.run();const bytes=JSON.stringify(f.getMemory());const restored=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});
  try{assert.equal(JSON.stringify(restored.getMemory()),bytes);await restored.r.api.retryPendingUnifiedState();assert.equal(restored.control.calls.length,0);assert.ok(restored.getHead()?.status!=='ready');}finally{await restored.r.cleanup();}
 });
 console.log(JSON.stringify({test:'libra_record_quarantine_runtime',passed:results.length,results,boundary:'full plugin, controlled provider, KV fault/restart fixture; no external model calls'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
