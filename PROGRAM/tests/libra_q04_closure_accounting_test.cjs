"use strict";
// Retirement contract (commit 9c03c35): the Classic "continuity closure" projection
// (closureInjectedFacts / projectionOmittedFacts / closureSkipReasons) no longer exists.
// Lifecycle successors are ordinary canonical memories served by the unified engine;
// this test pins that the retired accounting is gone and the replacement accounting
// (units/sources of the unified evidence packet) is honest.
const assert=require('node:assert/strict');
const {generated,query,system}=require('./fixtures/libra_q04_thread_fixture.cjs');
const RETIRED=/^closure|ProjectionOmitted|^classic(Memories|EvidenceRows|EvidenceChars|EvidenceTokens)$|^processorMemories$|^sourceMemories$/;
const header=text=>{const m=text.match(/units=(\d+) sources=(\d+)/);assert.ok(m,'unified evidence header present');return {units:Number(m[1]),sources:Number(m[2])};};
(async()=>{
 const f=await generated(undefined,'','multi_fact');
 try {
  const text=system(await f.control.hooks.beforeRequest(query,'model'));
  const runtime=f.r.api.getRuntime(),d=runtime.lastMemoryRecallViewer;
  assert.equal(runtime.lastRecallContinuityClosure,undefined,'retired closure result is not produced');
  assert.deepEqual(Object.keys(d).filter(k=>RETIRED.test(k)),[],'retired closure/classic accounting keys are gone');
  assert.equal(d.servedEngine,'unified');
  assert.ok(d.rows.every(row=>row.injected&&!('closure' in row)));
  const h=header(text);
  assert.equal(h.units,d.rows.length,'header unit count equals delivered viewer rows');
  assert.equal(d.injectedMemories,d.rows.length);
  // memory 6 (the successor with three facts) contributes every fact as its own canonical unit
  const succ=f.getMemory(6).canonicalArtifact.facts;
  assert.equal(succ.length,3);
  for(const fact of succ) assert.ok(text.includes(fact.text),'successor fact delivered: '+fact.text);
  assert.equal(new Set(d.rows.filter(r=>r.family==='canonical').map(r=>r.memoryId)).size,2,'two source memories back the canonical units');
  assert.equal(d.rows.filter(r=>r.memoryId===f.getMemory(6).memoryId).length,3,'three successor facts are three units of one memory');
  console.log('PASS successor facts are ordinary unified units; retired closure accounting is absent');
 }finally{await f.r.cleanup();}
 const capped=await generated(undefined,'','projection_cap');
 try {
  const api=capped.r.api,settings=await api.getLibraMemorySettings();
  await api.saveLibraMemorySettings({...settings,recallMaxChars:12000});
  const text=system(await capped.control.hooks.beforeRequest(query,'model'));
  const runtime=api.getRuntime(),d=runtime.lastMemoryRecallViewer,maxUnits=(await api.getLibraMemorySettings()).unifiedMaxUnits;
  assert.equal(runtime.lastRecallContinuityClosure,undefined);
  assert.deepEqual(Object.keys(d).filter(k=>RETIRED.test(k)),[]);
  assert.ok(Number.isInteger(maxUnits)&&maxUnits>0);
  const h=header(text);
  assert.equal(h.units,d.rows.length);
  assert.ok(d.rows.length<=maxUnits,'delivery is bounded by the common unifiedMaxUnits setting');
  assert.equal(h.sources,2,'42 facts across two memories report two sources, not one source per fact');
  assert.ok(text.includes(capped.getMemory(6).canonicalArtifact.facts[0].text),'the directly queried fulfilment stays in the bounded evidence set');
  assert.ok(!text.includes('continuity coverage is incomplete'),'retired closure warning text is not emitted');
  console.log('PASS bounded unified delivery reports units/sources honestly');
 }finally{await capped.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
