'use strict';
const assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
(async()=>{
 const s=await serverFixture();try{
  let f=s.f;f.control.artifact.stateBindings=[];
  f.control.artifact.facts.find(x=>x.tempFactId==='f11').evidenceSpans[0].quote='invalid latest holder';
  const job=await f.run();assert.equal(job.completed,1);const h=s.getHead();assert.equal(h.status,'partial');assert.ok(h.characters.length);assert.ok(h.world.length);assert.ok(h.narrative.threads.length);assert.equal(h.world.find(r=>r.name==='은빛 열쇠').state.holderRef,undefined);assert.ok(h.relationships.length);
  const memory=JSON.stringify(s.getMemory());f=await s.restart();await f.r.api.retryPendingUnifiedState();assert.equal(f.control.calls.length,0);assert.equal(JSON.stringify(s.getMemory()),memory);assert.ok(s.getHead().characters.length);assert.ok(s.getHead().world.length);assert.ok(s.getHead().narrative.threads.length);
  console.log(JSON.stringify({test:'libra_partial_state_projection_server_runtime',passed:2,boundary:'real local HTTP/SQLite commit and reload; controlled provider'}));
 }finally{await s.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
