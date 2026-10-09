'use strict';
const assert=require('node:assert/strict'),{fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
// Micro runs its own provider job once per completed U+A; count the two kinds separately.
const {countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const results=[];async function test(name,fn){await fn();results.push(name);console.log('PASS '+name);}
(async()=>{
 await test('explicit v4 regeneration is one new call, candidate stays inactive, adoption replays locally even with old Observer off',async()=>{
  const f=await fixture({args:{state_enabled:false}});try{
   assert.equal((await f.run()).completed,1);const original=f.getMemory(),ref=f.getManifest().memories['1'],raw=f.r.values.get(ref.key),originalEvidence=JSON.parse(raw).sourceEvidenceRef,evidenceBytes=f.r.values.get(originalEvidence.key);
   f.control.artifact.facts.find(x=>x.tempFactId==='f10').text='민아는 지호를 분명히 신뢰한다고 말했다.';
   const job=await f.r.api.regenerateCanonicalMemory({memoryId:original.memoryId,revision:original.revision,startTurn:1});
   assert.equal(job.state,'awaiting_choice',JSON.stringify(job));assert.equal(countCalls(f.control).canonical,2);assert.equal(countCalls(f.control).micro,5);assert.equal(f.getMemory().revision,1);assert.equal(f.r.values.get(ref.key),raw);
   const adopted=await f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'});
   assert.ok(['completed','completed_with_warnings'].includes(adopted.state),JSON.stringify(adopted));assert.equal(f.getMemory().revision,2);assert.equal(f.getHead().status,'ready',JSON.stringify(adopted));assert.equal(f.getHead().unifiedApplied.revision,2);assert.equal(countCalls(f.control).canonical,2);assert.equal(countCalls(f.control).micro,5);
   const retainedOriginal=JSON.parse(f.r.values.get(ref.key)),originalPayload=JSON.parse(raw);assert.equal(retainedOriginal.revision,originalPayload.revision);assert.equal(retainedOriginal.artifactDigest,originalPayload.artifactDigest);
   assert.deepEqual(retainedOriginal.canonicalArtifact,originalPayload.canonicalArtifact);assert.deepEqual(retainedOriginal.turnRange,originalPayload.turnRange);
   assert.deepEqual(retainedOriginal.sourceEvidenceRef,originalEvidence);assert.equal(retainedOriginal.sourceEvidenceRef.payloadDigest,originalEvidence.payloadDigest);assert.equal(f.r.values.get(originalEvidence.key),evidenceBytes);
   const recall=await f.r.api.previewUnifiedMemoryRecall('민아 지호 신뢰');assert.ok(recall.memories.some(x=>x.memory.revision===2));
  }finally{await f.r.cleanup();}
 });
 await test('embedding-only manifest drift survives candidate adoption and fresh storage readback',async()=>{
  const f=await fixture({args:{state_enabled:false}});let fresh;
  try{
   await f.run();const original=f.getMemory(),activeRef=f.getManifest().memories['1'],oldMemoryKey=activeRef.key;
   const oldMemory=JSON.parse(f.r.values.get(oldMemoryKey)),evidenceKey=oldMemory.sourceEvidenceRef.key,evidenceBytes=f.r.values.get(evidenceKey);
   f.control.artifact.facts.find(x=>x.tempFactId==='f10').text='민아는 지호를 분명히 신뢰한다고 말했다.';
   const job=await f.r.api.regenerateCanonicalMemory({memoryId:original.memoryId,revision:original.revision,startTurn:1});assert.equal(job.state,'awaiting_choice');
   const manifestRecord=f.getRecords('libra.manifest.v1')[0],changedManifest=JSON.parse(f.r.values.get(manifestRecord.key));
   Object.assign(changedManifest.memories['1'],{embeddingStatus:'disabled',retrievalVersion:'libra.retrieval_projection.v2',vectorCount:7,updatedAt:'2026-09-28T00:00:00.000Z'});
   f.r.values.set(manifestRecord.key,JSON.stringify(changedManifest));
   oldMemory.embedding={...oldMemory.embedding,status:'disabled',vectorCount:7};
   const oldMemoryBytes=JSON.stringify(oldMemory);f.r.values.set(oldMemoryKey,oldMemoryBytes);
   const adopted=await f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'});
   assert.ok(['completed','completed_with_warnings'].includes(adopted.state),JSON.stringify(adopted));assert.equal(f.getMemory().revision,2);
   const committed=f.getManifest();assert.ok(committed.memories['1'].history.some(row=>row.key===oldMemoryKey));
   assert.equal(f.r.values.get(oldMemoryKey),oldMemoryBytes);assert.equal(f.r.values.get(evidenceKey),evidenceBytes);
   fresh=await fixture({snapshot:{chat:f.chat,values:[...f.r.values.entries()]}});
   assert.equal(fresh.getManifest().memories['1'].revision,2);assert.ok(fresh.getManifest().memories['1'].history.some(row=>row.key===oldMemoryKey));
   assert.equal(fresh.r.values.get(oldMemoryKey),oldMemoryBytes);assert.equal(JSON.parse(fresh.r.values.get(oldMemoryKey)).embedding.status,'disabled');
   assert.equal(fresh.r.values.get(evidenceKey),evidenceBytes);
  }finally{await fresh?.r.cleanup();await f.r.cleanup();}
 });
 await test('canonical authority ref change after candidate preview still rejects adoption',async()=>{
  const f=await fixture();try{
   await f.run();const original=f.getMemory(),job=await f.r.api.regenerateCanonicalMemory({startTurn:1});assert.equal(job.state,'awaiting_choice');
   const row=f.getRecords('libra.manifest.v1')[0],manifest=JSON.parse(f.r.values.get(row.key));manifest.memories['1'].sourceEvidenceDigest+=':changed';
   f.r.values.set(row.key,JSON.stringify(manifest));
   await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'}),/UNIFIED_CANONICAL_BASELINE_CHANGED/);
   assert.equal(f.getManifest().memories['1'].revision,1);assert.equal(f.getMemory().revision,1);
  }finally{await f.r.cleanup();}
 });
 await test('State head change after candidate preview still rejects adoption',async()=>{
  const f=await fixture();try{
   await f.run();const job=await f.r.api.regenerateCanonicalMemory({startTurn:1});assert.equal(job.state,'awaiting_choice');
   const row=f.getRecords('libra.continuity_state.v2')[0],head=JSON.parse(f.r.values.get(row.key));head.updatedAt='2026-09-28T00:00:01.000Z';f.r.values.set(row.key,JSON.stringify(head));
   await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'}),/UNIFIED_STATE_BASELINE_CHANGED/);
   assert.equal(f.getManifest().memories['1'].revision,1);
  }finally{await f.r.cleanup();}
 });
 await test('worldline authority change after candidate preview still rejects adoption',async()=>{
  const f=await fixture();try{
   await f.run();const job=await f.r.api.regenerateCanonicalMemory({startTurn:1});assert.equal(job.state,'awaiting_choice');
   const scopeKey=f.getManifest().scopeKey,row=f.getRecords('libra.state_worldline_meta.v1').find(item=>item.value.scopeKey===scopeKey),worldlineKey=row?.key||`libra:v1:scope:${scopeKey}:state-worldline-meta:v1`;
   const meta=row?JSON.parse(f.r.values.get(worldlineKey)):{schema:'libra.state_worldline_meta.v1',scopeKey,activeWorldlineId:'main',worldlines:{main:{worldlineId:'main',cutoffTurn:null}},revision:0};
   meta.activeWorldlineId='branch-mutated';meta.revision=Number(meta.revision||0)+1;f.r.values.set(worldlineKey,JSON.stringify(meta));
   await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'}),/UNIFIED_WORLDLINE_CHANGED/);
   assert.equal(f.getManifest().memories['1'].revision,1);
  }finally{await f.r.cleanup();}
 });
 await test('candidate rejected by user preserves old canonical and never adds a reviewer call',async()=>{
  const f=await fixture();try{await f.run();const original=f.getMemory();const job=await f.r.api.regenerateCanonicalMemory({startTurn:1});assert.equal(job.state,'awaiting_choice',JSON.stringify(job));await f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'keep'});assert.equal(f.getMemory().artifactDigest,original.artifactDigest);assert.equal(f.getMemory().revision,original.revision);assert.equal(countCalls(f.control).canonical,2);assert.equal(countCalls(f.control).micro,5);}finally{await f.r.cleanup();}
 });
 await test('changed source after preview rejects adoption and keeps prior active revision',async()=>{
  const f=await fixture();try{await f.run();const job=await f.r.api.regenerateCanonicalMemory({startTurn:1});assert.equal(job.state,'awaiting_choice');f.chat.message[1].data+=' 실제 변경';await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'}),/source|precondition/i);assert.equal(f.getMemory().revision,1);assert.equal(countCalls(f.control).canonical,2);assert.equal(countCalls(f.control).micro,5);}finally{await f.r.cleanup();}
 });
 console.log(JSON.stringify({test:'libra_librarian_candidate',passed:results.length,results,boundary:'actual deployed JS; controlled host/model'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
