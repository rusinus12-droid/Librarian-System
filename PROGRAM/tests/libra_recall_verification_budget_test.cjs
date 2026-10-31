'use strict';
// Real classic hook/graph/physical validation with a controlled elapsed clock.
// This verifies budget behavior, not device latency or live provider performance.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');

for(const mode of ['plugin_only','mirror','server_only'])test(`${mode}: recall can finish physical validation after 40 seconds and remains bounded`,async()=>{
  let offset=0;
  class TestDate extends Date { static now(){return Date.now()+offset;} }
  const x=await fixture({mode,contextGlobals:{Date:TestDate,__advanceRecallClock:()=>{offset+=41000;}},
    transformSource:source=>source.replace('let lensRecall = null;','globalThis.__advanceRecallClock?.(); let lensRecall = null;')});
  try{
    const api=x.f.r.api;
    const out=await x.f.control.hooks.beforeRequest([{role:'user',content:QUOTE}],'model');
    let meta=api.getRuntime().lastMemoryInjectionMeta;
    assert.equal(meta.injected,true,JSON.stringify(meta));
    assert.ok(out.some(row=>String(row.content).includes('LIBRA')));
    const runtime=x.f.r.core.state.lastRecallRuntime;
    assert.equal(runtime.budgetMs,90000);
    assert.ok(runtime.elapsedMs>=41000);
    assert.ok(runtime.phases.some(row=>row.label==='unified_final_consumer'&&row.ok));
    assert.ok(runtime.phases.some(row=>row.label==='graph_select_and_validate'&&row.ok));
    assert.ok(runtime.phases.every(row=>Number.isFinite(row.startedOffsetMs)));
    x.f.r.context.__advanceRecallClock=()=>{offset+=91000;};
    const rejected=await x.f.control.hooks.beforeRequest([{role:'user',content:QUOTE}],'model');
    meta=api.getRuntime().lastMemoryInjectionMeta;
    assert.equal(meta.injected,false);
    assert.equal(meta.errorCode,'LIBRA_RECALL_DEADLINE');
    assert.equal(rejected.length,1,'expired validation never delivers memory');
  }finally{await x.cleanup();}
});
