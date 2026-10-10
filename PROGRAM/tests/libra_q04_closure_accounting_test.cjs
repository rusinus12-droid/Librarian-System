"use strict";
const assert=require('node:assert/strict');
const {generated,query,system}=require('./fixtures/libra_q04_thread_fixture.cjs');
(async()=>{
 const f=await generated(undefined,'','multi_fact');
 try {
  const text=system(await f.control.hooks.beforeRequest(query,'model'));
  const runtime=f.r.api.getRuntime(),d=runtime.lastMemoryRecallViewer;
  assert.equal(d.closureInjectedFacts,3);
  assert.equal(d.rows.filter(row=>row.injected).length,4);
  assert.equal(d.sourceMemories,2);
  assert.equal(d.classicMemories,2);
  assert.equal(d.processorMemories,2);
  assert.equal(d.injectedMemories,2);
  assert.equal(d.classicEvidenceRows,4);
  assert.ok(text.includes(f.getMemory(6).canonicalArtifact.facts[0].text));
  console.log('PASS three successor facts count as one source memory');
 }finally{await f.r.cleanup();}
 const capped=await generated(undefined,'','projection_cap');
 try {
  const settings=await capped.r.api.getLibraMemorySettings();
  await capped.r.api.saveLibraMemorySettings({...settings,recallMaxChars:12000});
  const text=system(await capped.control.hooks.beforeRequest(query,'model'));
  const runtime=capped.r.api.getRuntime(),closure=runtime.lastRecallContinuityClosure,d=runtime.lastMemoryRecallViewer;
  assert.equal(closure.diagnostics.closureCount,42);
  assert.equal(closure.currentness,'current','canonical chain was current when verified');
  assert.equal(closure.closureComplete,true,'resolver chain proof remains separate from delivery');
  assert.equal(closure.facts.length,40);
  assert.equal(closure.projectionComplete,false);
  assert.equal(closure.projectionOmittedFacts,2);
  assert.equal(d.closureProjectionOmittedFacts,2);
  assert.equal(d.closureInjectedFacts,40);
  assert.equal(d.classicMemories,2);
  assert.equal(d.closureDeliveryComplete,false);
  assert.ok(d.closureSkipReasons.includes('closure_projection_fact_limit'));
  assert.ok(!text.includes(capped.getMemory(6).canonicalArtifact.facts[0].text),'known fulfillment was beyond projection cap');
  assert.ok(text.includes('continuity coverage is incomplete'));
  assert.ok(text.includes('open, resolved, or closed statuses are last-known evidence only'));
  console.log('PASS bounded projection reports two omitted transitions honestly');
 }finally{await capped.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
