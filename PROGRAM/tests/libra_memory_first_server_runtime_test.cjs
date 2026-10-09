'use strict';
const assert=require('node:assert/strict');
const {serverFixture,fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
(async()=>{
 const s=await serverFixture();try{
  let f=s.f;fiveMore(f);const later=f.clone(f.control.artifact);
  f.control.onCall=async()=>({type:'success',result:f.control.calls.length===1?'bad JSON':JSON.stringify(later)});
  const one=await f.run();assert.equal(one.completed,1,JSON.stringify(one));assert.equal(s.getMemory(),null);assert.ok(s.getMemory(6));assert.equal(s.getHead(),undefined);assert.equal(countCalls(f.control).canonical,2);
  const canonicalBytes=JSON.stringify(s.getMemory(6));const restart=await s.restart();f=restart;fiveMore(f);f.control.artifact=artifact();
  const two=await f.r.api.retryFailedMemoryAnalysis({startTurns:[1]});assert.equal(two.completed,1,JSON.stringify(two));assert.equal(s.getHead()?.throughTurn,10);assert.equal(countCalls(f.control).canonical,1);assert.equal(JSON.stringify(s.getMemory(6)),canonicalBytes);
  assert.ok(![...s.local.keys()].some(k=>k.includes(':continuity-state')),'server mode must not duplicate current State locally');
  const before=JSON.stringify(s.getHead());await f.r.api.retryPendingUnifiedState();assert.equal(countCalls(f.control).canonical,1);assert.equal(s.getHead()?.throughTurn,10);assert.equal(s.getMemory(6).status,'committed');
  console.log(JSON.stringify({test:'libra_memory_first_server_runtime',passed:1,scenario:'gap memory persists across restart and fills into contiguous T10 with one fresh model request',storage:'real local HTTP/SQLite',provider:'controlled synthetic boundary',canonicalBytesPreserved:true}));
 }finally{await s.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
