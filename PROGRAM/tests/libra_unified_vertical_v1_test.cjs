'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
(async()=>{const f=await fixture();try{
 const result=await f.run();assert.equal(result.completed,1,JSON.stringify(result));
 const lineage=await f.r.api.getHostLineageStatus();
 const scope={scopeKey:lineage.scopeKey,scopeId:lineage.scopeKey,characterId:f.character.id,chatId:f.chat.id};
 for(let turn=1;turn<=5;turn++){
  const active=await f.r.api.debugReadActiveCompletedTurnReceipt(turn);
  assert.equal(active.status,'verified',`T${turn}: completed receipt is durable before manual retry`);
  const retry=await f.r.api.retryMicroAnalysis({scope,receiptRef:active.receiptKey,
    revision:active.receipt.revisionId,digest:active.receipt.sourceDigest,expectedGeneration:0});
  assert.equal(retry.status,'verified',`T${turn}: explicit historical Micro retry`);
 }
 const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
 await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===5,15000);
 const microCalls=f.control.calls.filter(args=>JSON.stringify(args).includes('LIBRA MICRO SOURCE CONTRACT'));
 assert.equal(microCalls.length,5,'one independent Micro job per completed U+A');
 assert.equal(f.control.calls.length,6,'five Micro jobs and one Canonical job');
 const m=f.getMemory();assert.equal(m.artifactSchema,'libra.canonical_artifact.v4');assert.equal(m.text,f.r.api.debugRenderUnifiedArtifact(m.canonicalArtifact));
 const h=f.getHead();assert.equal(h.status,'ready');assert.equal(h.throughTurn,5);
 const mina=h.characters.find(x=>x.name==='민아'),key=h.world.find(x=>x.name==='은빛 열쇠');
 assert.equal(key.state.holderRef,mina.id);assert.equal(key.state.ownerRef,mina.id);assert.equal(h.relationships.length,1);assert.equal(h.relationships[0].subjectId,mina.id);
 assert.deepEqual(mina.state.knowledge,['상자의 암호']);assert.equal(h.characters.find(x=>x.name==='준호').state.knowledge,undefined);
 assert.ok(h.narrative.threads.some(t=>t.summary.includes('공연')));assert.ok(!h.narrative.threads.some(t=>t.summary.includes('반환')));
 assert.equal(f.getRecords('libra.state_pipeline_receipt.v1')[0].value.providerCalls,0);
 assert.equal(f.getRecords('libra.unified_basis_snapshot.v1').length,0);assert.equal(m.unifiedBasis.head,undefined);assert.equal(m.unifiedBasis.registry,undefined);
 const recall=await f.r.api.previewUnifiedMemoryRecall('민아 은빛 열쇠 소유 반환 약속');assert.ok(recall.memories.some(r=>r.memory.artifactDigest===m.artifactDigest));assert.equal(f.control.calls.length,6);
 const read=f.r.api.getUnifiedStateReadProjection(h);assert.ok(!/ce_(?:person|world)_[0-9a-f]{8}/.test(JSON.stringify(read)));assert.equal(read.world.find(x=>x.name==='은빛 열쇠').state.holder,'민아');
 const study=f.r.api.getUnifiedWorldReadContext(h,'서재'),hall=f.r.api.getUnifiedWorldReadContext(h,'공연실');
 assert.equal(study.path.join('/'),'서재/도서관');assert.equal(study.rules.length,1);assert.equal(study.rules[0].conditionalExceptions.length,0);
 assert.equal(hall.rules[0].conditionalExceptions[0].conditionStatus,'not_evaluated');assert.equal(f.r.api.getUnifiedWorldReadContext(h,'없는 곳').status,'unknown');
 const headBefore=JSON.stringify(f.getHead()),memoryBefore=JSON.stringify(f.getMemory());
 await f.r.api.retryPendingUnifiedState();assert.equal(JSON.stringify(f.getHead()),headBefore);assert.equal(f.control.calls.length,6);assert.equal(f.getMemory().artifactDigest,m.artifactDigest);
 assert.ok(memoryBefore.includes('libra.canonical_artifact.v4'));
 console.log(JSON.stringify({test:'libra_unified_vertical_v1',scenario:'five pairs -> canonical/current State/actual recall',publicJob:'runManualColdStart',providerBoundary:'controlled synthetic output, not external model',ariadneDispatch:1,normalObserverDispatch:0,actualRecall:true,worldRules:'conditional, not inferred'}));
 }finally{await f.r.cleanup();}})().catch(e=>{console.error(e);process.exitCode=1});
