"use strict";
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
  const current=await fixture({snapshot:snap});
  try {
   const text=system(await current.control.hooks.beforeRequest(query,'model'));
   const runtime=current.r.api.getRuntime(),closure=runtime.lastRecallContinuityClosure;
   assert.equal(closure.currentness,'current');
   assert.equal(runtime.lastMemoryRecallViewer.closureInjectedFacts,1);
   assert.ok(!text.includes('CURRENT SESSION'),'inherited closure retains previous-session label at epoch '+epoch);
   assert.equal(closure.facts[0].inheritedSessionHistory,true);
   const layer=runtime.lastResponseContext.values.canonicalLayers.memory.find(row=>row.closure);
   assert.equal(layer.inheritedSessionHistory,true);
   const row=runtime.lastMemoryRecallViewer.rows.find(row=>row.closure);
   assert.equal(row.inheritedSessionHistory,true);
   assert.ok(row.memoryKey&&row.canonicalOriginKey&&row.scopeKey&&row.sourceDigest&&row.artifactDigest,'closure carries source identity');
   assert.equal(row.memoryKey,manifest.memories['6'].key);
   assert.equal(row.canonicalOriginKey,manifest.memories['6'].unifiedOriginDigest);
   console.log('PASS inherited closure epoch '+epoch);
  }finally{await current.r.cleanup();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
