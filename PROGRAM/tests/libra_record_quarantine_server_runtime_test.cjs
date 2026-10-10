'use strict';
const assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
(async()=>{
 const s=await serverFixture();try{
  let f=s.f;f.control.artifact.facts.find(x=>x.tempFactId==='f11').evidenceSpans[0].quote='invented final holder';
  const job=await f.run();assert.equal(job.completed,1);assert.equal(job.state,'completed_with_warnings');assert.equal(f.control.calls.length,1);
  const memory=s.getMemory();assert.equal(memory.pipeline.status,'partial');assert.equal(memory.canonicalArtifact.facts.length,12);assert.equal(memory.artifactValidation.admission.rejectedFacts,1);assert.ok(memory.recordAdmissionDigest);
  const head=s.getHead();assert.equal(head.status,'partial');assert.equal(head.world.find(x=>x.name==='은빛 열쇠').state.holderRef,undefined);assert.deepEqual(head.characters.find(x=>x.name==='민아').state.knowledge,['상자의 암호']);
  const canonicalBytes=JSON.stringify(memory);f=await s.restart();assert.equal(JSON.stringify(s.getMemory()),canonicalBytes);await f.r.api.retryPendingUnifiedState();assert.equal(f.control.calls.length,0);assert.equal(JSON.stringify(s.getMemory()),canonicalBytes);assert.ok(s.getHead()?.status!=='ready');
  console.log(JSON.stringify({test:'libra_record_quarantine_server',passed:2,storage:'real local HTTP/SQLite plus fixture restart',provider:'controlled synthetic response',canonicalBytesPreserved:true}));
 }finally{await s.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
