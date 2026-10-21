"use strict";
// Retirement contract (commit 9c03c35): the separate inherited "closure" layer is retired.
// An inherited-session lifecycle chain is served as ordinary canonical rows of the unified
// engine; each delivered row must still carry the exact source identity of its stored
// memory (key, scope, digests, origin session epoch), for epochs 0, 2 and -1.
const assert=require('node:assert/strict');
const {generated,fixture,query,system}=require('./fixtures/libra_q04_thread_fixture.cjs');
(async()=>{
 const f=await generated();
 const snapshot={chat:f.clone(f.chat),values:[...f.r.values]};
 await f.r.cleanup();
 for(const epoch of [0,2,-1]) {
  const snap=JSON.parse(JSON.stringify(snapshot)),values=new Map(snap.values);
  const [key,raw]=[...values].find(([key])=>key.endsWith(':manifest')),manifest=JSON.parse(raw);
  for(const ref of Object.values(manifest.memories)) {
   ref.inheritedSessionHistory=true;ref.sessionEpoch=epoch;
   const memory=JSON.parse(values.get(ref.key));
   memory.inheritedSessionHistory=true;memory.sessionEpoch=epoch;
   values.set(ref.key,JSON.stringify(memory));
  }
  values.set(key,JSON.stringify(manifest));snap.values=[...values];
  const before=JSON.stringify([...values]);
  const current=await fixture({snapshot:snap});
  try {
   const text=system(await current.control.hooks.beforeRequest(query,'model'));
   const runtime=current.r.api.getRuntime(),d=runtime.lastMemoryRecallViewer;
   assert.equal(runtime.lastRecallContinuityClosure,undefined,'retired closure result is not produced');
   assert.ok(!text.includes('CURRENT SESSION'),'inherited rows are not labelled as current session at epoch '+epoch);
   assert.equal(d.rows.length,2);
   assert.ok(d.rows.every(row=>row.family==='canonical'&&row.injected&&!('closure' in row)));
   for(const num of ['1','6']) {
    const ref=manifest.memories[num],row=d.rows.find(r=>r.memoryId===ref.memoryId);
    assert.ok(row,'memory '+num+' delivered');
    assert.ok(text.includes(row.text),'memory '+num+' text reaches the final prompt');
    assert.equal(row.memoryKey,ref.key);
    assert.equal(row.sessionEpoch,epoch,'origin session epoch preserved');
    assert.ok(row.scopeKey&&row.sourceDigest&&row.artifactDigest&&row.nodeId,'row carries source identity');
    assert.equal(row.sourceDigest,ref.sourceDigest);
    assert.equal(row.artifactDigest,ref.artifactDigest);
   }
   const layer=runtime.lastResponseContext.values.canonicalLayers.memory;
   assert.deepEqual(layer.map(r=>r.memoryKey).sort(),d.rows.map(r=>r.memoryKey).sort(),'response context layer matches delivered rows');
   assert.equal(JSON.stringify([...current.r.values]),before,'recall does not mutate stored bytes');
   assert.equal(current.control.calls.length,0,'recall never calls the provider');
   console.log('PASS inherited lifecycle rows keep source identity at epoch '+epoch);
  }finally{await current.r.cleanup();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
