'use strict';
const assert=require('node:assert/strict'),{fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
// Manual cold start / source reanalysis consumes existing completed pairs; it does not invoke
// the separate completion-capture Micro producer. Count both provider kinds explicitly.
const {countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');
const results=[];async function test(name,fn){await fn();results.push(name);console.log('PASS '+name);}
const reanalyzeOne = async f => {
 const inv = await f.r.api.listReanalysisRanges();
 return await f.r.api.reanalyzeSelectedRanges({...inv, ranges: inv.ranges.filter(r => r.batchStart === 1)});
};
const prepareCandidate = async f => {
 assert.equal((await f.run()).completed,1);
 const manifestKey=f.getRecords('libra.manifest.v1')[0].key,manifestR1=f.r.values.get(manifestKey);
 const headKey=f.getRecords('libra.continuity_state.v2')[0].key,headR1=f.r.values.get(headKey);
 const regKey=f.getRecords('libra.entity_registry.v2')[0].key,regR1=f.r.values.get(regKey);
 f.control.artifact.facts.find(x=>x.tempFactId==='f10').text='민아는 지호를 분명히 신뢰한다고 말했다.';
 const out=await reanalyzeOne(f);assert.equal(out.ok,true);
 const r2Ref=f.getManifest().memories['1'],r2Key=r2Ref.key,r2=JSON.parse(f.r.values.get(r2Key));
 r2.status='candidate';f.r.values.set(r2Key,JSON.stringify(r2));
 f.r.values.set(manifestKey,manifestR1);f.r.values.set(headKey,headR1);f.r.values.set(regKey,regR1);
 const idxRow=f.getRecords('libra.canonical_variant_index.v1')[0];
 const idx=JSON.parse(f.r.values.get(idxRow.key)),slot=idx.slots['1'];
 const v1=slot.variants.find(v=>v.revision===1),v2=slot.variants.find(v=>v.revision===2);
 v1.status='active';v2.status='candidate';slot.activeVariantId=v1.variantId;
 f.r.values.set(idxRow.key,JSON.stringify(idx));
 return await f.r.api.selectCanonicalVariant({variantId:v2.variantId});
};
(async()=>{
 await test('explicit v4 reanalysis is one new call, prior revision stays retained in history, and State replays locally even with old Observer off',async()=>{
  const f=await fixture({args:{state_enabled:false}});try{
   assert.equal((await f.run()).completed,1);const original=f.getMemory(),ref=f.getManifest().memories['1'],raw=f.r.values.get(ref.key),originalEvidence=JSON.parse(raw).sourceEvidenceRef,evidenceBytes=f.r.values.get(originalEvidence.key);
   await assert.rejects(()=>f.r.api.regenerateCanonicalMemory({memoryId:original.memoryId,revision:original.revision,startTurn:1}),/LIBRA_REANALYSIS_ENTRY_RETIRED|폐기/);
   f.control.artifact.facts.find(x=>x.tempFactId==='f10').text='민아는 지호를 분명히 신뢰한다고 말했다.';
   const out=await reanalyzeOne(f);
   assert.equal(out.ok,true,JSON.stringify(out));assert.equal(countCalls(f.control).canonical,2);assert.equal(countCalls(f.control).micro,0);
   assert.equal(f.getMemory().revision,2);assert.equal(f.getHead().status,'ready',JSON.stringify(out));assert.equal(f.getHead().unifiedApplied.revision,2);
   const retainedOriginal=JSON.parse(f.r.values.get(ref.key)),originalPayload=JSON.parse(raw);assert.equal(retainedOriginal.revision,originalPayload.revision);assert.equal(retainedOriginal.artifactDigest,originalPayload.artifactDigest);
   assert.deepEqual(retainedOriginal.canonicalArtifact,originalPayload.canonicalArtifact);assert.deepEqual(retainedOriginal.turnRange,originalPayload.turnRange);
   assert.deepEqual(retainedOriginal.sourceEvidenceRef,originalEvidence);assert.equal(retainedOriginal.sourceEvidenceRef.payloadDigest,originalEvidence.payloadDigest);assert.equal(f.r.values.get(originalEvidence.key),evidenceBytes);
   const recall=await actualClassicPacket(f,'민아 지호 신뢰',f.getManifest().scopeKey);assert.ok(recall.actualClassic.deliveredRows.some(x=>x.revision===2));
  }finally{await f.r.cleanup();}
 });
 await test('embedding-only manifest drift survives reanalysis replacement and fresh storage readback',async()=>{
  const f=await fixture({args:{state_enabled:false}});let fresh;
  try{
   await f.run();const activeRef=f.getManifest().memories['1'],oldMemoryKey=activeRef.key;
   const oldMemory=JSON.parse(f.r.values.get(oldMemoryKey)),evidenceKey=oldMemory.sourceEvidenceRef.key,evidenceBytes=f.r.values.get(evidenceKey);
   const manifestRecord=f.getRecords('libra.manifest.v1')[0],changedManifest=JSON.parse(f.r.values.get(manifestRecord.key));
   Object.assign(changedManifest.memories['1'],{embeddingStatus:'disabled',retrievalVersion:'libra.retrieval_projection.v2',vectorCount:7,updatedAt:'2026-09-28T00:00:00.000Z'});
   f.r.values.set(manifestRecord.key,JSON.stringify(changedManifest));
   oldMemory.embedding={...oldMemory.embedding,status:'disabled',vectorCount:7};
   const oldMemoryBytes=JSON.stringify(oldMemory);f.r.values.set(oldMemoryKey,oldMemoryBytes);
   f.control.artifact.facts.find(x=>x.tempFactId==='f10').text='민아는 지호를 분명히 신뢰한다고 말했다.';
   const out=await reanalyzeOne(f);
   assert.equal(out.ok,true,JSON.stringify(out));assert.equal(f.getMemory().revision,2);
   const committed=f.getManifest();assert.ok(committed.memories['1'].history.some(row=>row.key===oldMemoryKey));
   assert.equal(f.r.values.get(oldMemoryKey),oldMemoryBytes);assert.equal(f.r.values.get(evidenceKey),evidenceBytes);
   fresh=await fixture({snapshot:{chat:f.chat,values:[...f.r.values.entries()]}});
   assert.equal(fresh.getManifest().memories['1'].revision,2);assert.ok(fresh.getManifest().memories['1'].history.some(row=>row.key===oldMemoryKey));
   assert.equal(fresh.r.values.get(oldMemoryKey),oldMemoryBytes);assert.equal(JSON.parse(fresh.r.values.get(oldMemoryKey)).embedding.status,'disabled');
   assert.equal(fresh.r.values.get(evidenceKey),evidenceBytes);
  }finally{await fresh?.r.cleanup();await f.r.cleanup();}
 });
 await test('canonical authority ref change after candidate preview rejects adoption',async()=>{
  const f=await fixture();try{
   const job=await prepareCandidate(f);assert.equal(job.state,'awaiting_choice');
   const row=f.getRecords('libra.manifest.v1')[0],manifest=JSON.parse(f.r.values.get(row.key));manifest.memories['1'].sourceEvidenceDigest+=':changed';
   f.r.values.set(row.key,JSON.stringify(manifest));
   await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'}),/UNIFIED_CANONICAL_BASELINE_CHANGED/);
   assert.equal(f.getManifest().memories['1'].revision,1);
  }finally{await f.r.cleanup();}
 });
 await test('State head change after candidate preview rejects adoption',async()=>{
  const f=await fixture();try{
   const job=await prepareCandidate(f);assert.equal(job.state,'awaiting_choice');
   const row=f.getRecords('libra.continuity_state.v2')[0],head=JSON.parse(f.r.values.get(row.key));head.updatedAt='2026-09-28T00:00:01.000Z';f.r.values.set(row.key,JSON.stringify(head));
   await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'}),/UNIFIED_STATE_BASELINE_CHANGED/);
   assert.equal(f.getManifest().memories['1'].revision,1);
  }finally{await f.r.cleanup();}
 });
 await test('worldline authority change after candidate preview rejects adoption',async()=>{
  const f=await fixture();try{
   const job=await prepareCandidate(f);assert.equal(job.state,'awaiting_choice');
   const scopeKey=f.getManifest().scopeKey,row=f.getRecords('libra.state_worldline_meta.v1').find(item=>item.value.scopeKey===scopeKey),worldlineKey=row?.key||`libra:v1:scope:${scopeKey}:state-worldline-meta:v1`;
   const meta=row?JSON.parse(f.r.values.get(worldlineKey)):{schema:'libra.state_worldline_meta.v1',scopeKey,activeWorldlineId:'main',worldlines:{main:{worldlineId:'main',cutoffTurn:null}},revision:0};
   meta.activeWorldlineId='branch-mutated';meta.revision=Number(meta.revision||0)+1;f.r.values.set(worldlineKey,JSON.stringify(meta));
   await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'}),/UNIFIED_WORLDLINE_CHANGED/);
   assert.equal(f.getManifest().memories['1'].revision,1);
  }finally{await f.r.cleanup();}
 });
 await test('candidate rejected by user preserves active canonical and never adds a reviewer call',async()=>{
  const f=await fixture();try{
   const job=await prepareCandidate(f);const active=f.getMemory();assert.equal(active.revision,1);assert.equal(job.state,'awaiting_choice',JSON.stringify(job));
   await f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'keep'});
   assert.equal(f.getMemory().artifactDigest,active.artifactDigest);assert.equal(f.getMemory().revision,1);
   assert.equal(countCalls(f.control).canonical,2);assert.equal(countCalls(f.control).micro,0);
  }finally{await f.r.cleanup();}
 });
 await test('changed source after preview rejects adoption and keeps prior active revision',async()=>{
  const f=await fixture();try{
   const job=await prepareCandidate(f);assert.equal(job.state,'awaiting_choice');
   f.chat.message[1].data+=' 실제 변경';
   await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'adopt'}),/source|precondition/i);
   assert.equal(f.getMemory().revision,1);assert.equal(countCalls(f.control).canonical,2);assert.equal(countCalls(f.control).micro,0);
  }finally{await f.r.cleanup();}
 });
 console.log(JSON.stringify({test:'libra_librarian_candidate',passed:results.length,results,boundary:'actual deployed JS; controlled host/model'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
