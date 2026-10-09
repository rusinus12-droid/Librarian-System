'use strict';
const assert=require('node:assert/strict');const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
(async()=>{const s=await serverFixture();try{
 let f=s.f;const earlier=f.clone(f.control.artifact.facts.find(x=>x.tempFactId==='f11'));earlier.tempFactId='earlier_holder';earlier.values.holderRef='jiho';f.control.artifact.facts.push(earlier);
 const r=await f.run();assert.equal(r.completed,1);assert.equal(s.getHead().status,'ready');assert.ok(s.getHead().unifiedApplied.supersededFacts.includes('earlier_holder'));await f.r.api.retryPendingUnifiedVectors();const before=JSON.stringify(s.getMemory());
 f=await s.restart();const replay=await f.r.api.rebuildWorldManagerState();assert.equal(replay.ok,true);assert.equal(s.getHead().status,'ready');assert.equal(JSON.stringify(s.getMemory()),before);assert.equal(f.control.calls.length,0);assert.equal(s.getHead().world.find(r=>r.name==='은빛 열쇠').state.holderRef,s.getHead().characters.find(r=>r.name==='민아').id);
 console.log(JSON.stringify({test:'libra_state_binding_selection_server_runtime',passed:2,storage:'actual local HTTP/SQLite',canonicalBytesUnchanged:true,extraAnalysisCalls:0,liveProvider:false}));
}finally{await s.cleanup();}})().catch(e=>{console.error(e);process.exitCode=1;});
