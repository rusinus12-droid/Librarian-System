'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const results=[];const fact=(f,id)=>f.control.artifact.facts.find(x=>x.tempFactId===id),receipt=f=>f.getMemory().artifactValidation.admission;
const expose=s=>s.replace('const Runtime = {','const Runtime = globalThis.__normalizationRuntime = {');
async function test(name,fn){const f=await fixture({transformSource:expose});try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
const missing=f=>{for(const row of f.control.artifact.facts)delete row.text;};
const saved=(f,id)=>f.getMemory()?.canonicalArtifact.facts.find(x=>x.tempFactId===id);
(async()=>{
 await test('missing text on every typed fact and claim-name domain alias commit without extra AI',async f=>{
  missing(f);fact(f,'f9').domain='knowledge';const original=JSON.stringify(f.control.artifact);const job=await f.run();
  assert.equal(job.completed,1,JSON.stringify(job));assert.equal(countCalls(f.control).canonical,1);assert.equal(f.getHead().status,'ready');assert.equal(f.getMemory().canonicalArtifact.facts.length,13);
  assert.equal(receipt(f).normalizedTextCount,13);assert.equal(receipt(f).normalizedDomainCount,1);assert.equal(receipt(f).rejectedFacts,0);assert.equal(saved(f,'f9').domain,'character');assert.equal(saved(f,'f9').text,'상자의 암호');
  assert.equal(JSON.stringify(f.control.artifact),original);assert.equal(f.r.context.__normalizationRuntime.lastMemoryAnalysisDiagnostic.rawResponse,original);
  for(const row of f.control.artifact.facts)assert.deepEqual(saved(f,row.tempFactId).values,row.values);
  assert.match(saved(f,'f4').text,/허가된 공연 중/);assert.match(saved(f,'f4').text,/공연실/);assert.match(saved(f,'f12').text,/resolved/);
 });
 await test('event, current condition and scene time summaries copy supplied values exactly',async f=>{
  const row=f.chat.message[9];row.data+=' 지금은 오후 세 시이며 민아는 피곤하다.';
  const base={temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t5-a',quote:'지금은 오후 세 시이며 민아는 피곤하다.'}]};
  for(const [id,domain,subject,kind,values] of [['event1','event','mina','event',{detail:'민아는 피곤한 상태로 오후 세 시를 맞았다.'}],['condition1','character','mina','character_state',{condition:'피곤하다'}],['time1','world','library','scene_time',{sceneTime:'오후 세 시'}]])f.control.artifact.facts.push({...f.clone(base),tempFactId:id,domain,subjectTempRef:subject,claimKind:kind,values});
  await f.run();assert.equal(saved(f,'event1').text,'민아는 피곤한 상태로 오후 세 시를 맞았다.');assert.equal(saved(f,'condition1').text,'피곤하다');assert.equal(saved(f,'time1').text,'오후 세 시');assert.equal(receipt(f).normalizedTextCount,3);assert.equal(countCalls(f.control).canonical,1);
 });
 await test('existing text is retained and a missing domain is filled from the known claim',async f=>{
  const original=fact(f,'f9').text;delete fact(f,'f9').domain;await f.run();assert.equal(saved(f,'f9').text,original);assert.equal(receipt(f).normalizedTextCount,0);assert.equal(receipt(f).normalizedDomainCount,1);
 });
 await test('blank text is recoverable while a non-text value is not overwritten',async f=>{
  fact(f,'f9').text='  ';fact(f,'f10').text=42;await f.run();assert.equal(saved(f,'f9').text,'상자의 암호');assert.equal(saved(f,'f10'),undefined);assert.equal(receipt(f).rejectedFacts,1);
 });
 await test('conflicting valid domains and unknown domain typos are quarantined rather than rewritten',async f=>{
  fact(f,'f9').domain='world';fact(f,'f10').domain='relatonship';await f.run();assert.equal(saved(f,'f9'),undefined);assert.equal(saved(f,'f10'),undefined);assert.equal(receipt(f).normalizedDomainCount,0);assert.ok(saved(f,'f11'));
 });
 await test('a forged quote remains rejected after text normalization and holds stale State',async f=>{
  missing(f);fact(f,'f11').evidenceSpans=[{ref:'t5-a',quote:'invented final holder'}];await f.run();assert.equal(saved(f,'f11'),undefined);assert.ok(saved(f,'f9'));assert.equal(f.getHead().world.find(x=>x.name==='은빛 열쇠').state.holderRef,undefined);assert.equal(f.getHead().status,'partial');
 });
 await test('invalid entity and fact dependencies stay isolated after normalization',async f=>{
  missing(f);f.control.artifact.entities.find(x=>x.tempId==='key').name='unsupported name';fact(f,'f9').dependsOn=['f11'];await f.run();assert.equal(saved(f,'f11'),undefined);assert.equal(saved(f,'f9'),undefined);assert.ok(saved(f,'f10'));assert.equal(receipt(f).rejectedEntities,1);
 });
 await test('broken scoped rules cannot be rescued by their generated summary',async f=>{
  missing(f);fact(f,'f4').values.rule.exceptions[0].locationTempRef='missing';await f.run();assert.equal(saved(f,'f4'),undefined);assert.ok(saved(f,'f9'));assert.equal(receipt(f).rejectionReasons.UNIFIED_RULE_EXCEPTION_INVALID,1);
 });
 await test('empty typed values and oversize existing text are not silently replaced',async f=>{
  delete fact(f,'f9').text;fact(f,'f9').values.knowledge=[];fact(f,'f10').text='x'.repeat(2001);await f.run();assert.equal(saved(f,'f9'),undefined);assert.equal(saved(f,'f10'),undefined);assert.ok(saved(f,'f11'));
 });
 await test('all-invalid facts report post-normalization counts without storing or retrying',async f=>{
  missing(f);for(const row of f.control.artifact.facts)row.evidenceSpans=[{ref:'t1-a',quote:'fabricated'}];const job=await f.run();assert.equal(job.completed,0);assert.equal(f.getMemory(),null);assert.equal(f.getHead(),null);assert.equal(countCalls(f.control).canonical,1);
  assert.match(job.failures[0].message,/accepted=0:rejected=13:normalized=13/);assert.equal(f.r.api.getMemoryFailureDiagnostic(job.failures[0].message).code,'NO_VALID_FACTS');
  const diagnostic=f.r.context.__normalizationRuntime.lastMemoryAnalysisDiagnostic;assert.equal(diagnostic.admission.acceptedFacts,0);assert.equal(diagnostic.admission.rejectedFacts,13);assert.equal(diagnostic.admission.normalizedTextCount,13);
  const reloaded=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});try{assert.equal(reloaded.getMemory(),null);assert.equal(reloaded.getHead(),null);assert.equal(reloaded.control.calls.length,0);}finally{await reloaded.r.cleanup();}
 });
 await test('normalization provenance survives restart and canonical byte readback',async f=>{
  missing(f);await f.run();await f.r.api.retryPendingUnifiedVectors();const bytes=JSON.stringify(f.getMemory());const g=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});try{assert.equal(JSON.stringify(g.getMemory()),bytes);await g.r.api.retryPendingUnifiedState();assert.equal(g.control.calls.length,0);assert.equal(JSON.stringify(g.getMemory()),bytes);assert.equal(g.getHead().status,'ready');}finally{await g.r.cleanup();}
 });
 await test('normalization receipt tampering fails integrity readback',async f=>{
  missing(f);await f.run();const before=JSON.stringify(f.getHead()),mem=f.getMemory(),ref=f.getManifest().memories['1'];mem.artifactValidation.admission.normalizedTextCount=0;f.r.values.set(ref.key,JSON.stringify(mem));await f.r.api.retryPendingUnifiedState();assert.equal(JSON.stringify(f.getHead()),before);assert.equal(countCalls(f.control).canonical,1);
 });
 await test('strict stored-artifact validator never performs provider normalization',async f=>{
  missing(f);const batch=[];for(let t=1;t<=5;t++)batch.push({turn:t,user:{text:f.chat.messages[t*2-2].data},assistant:{text:f.chat.messages[t*2-1].data}});const original=JSON.stringify(f.control.artifact);assert.equal(f.r.api.debugValidateUnifiedArtifact(f.control.artifact,batch).ok,false);assert.equal(JSON.stringify(f.control.artifact),original);
 });
 console.log(JSON.stringify({test:'libra_record_normalization_runtime',passed:results.length,results,boundary:'synthetic source and provider; full plugin and KV readback, no live model calls'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
