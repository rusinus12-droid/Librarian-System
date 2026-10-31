'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
test('a live classic recall drains a background batch before reserving source I/O',async()=>{
  const x=await fixture({includeMicro:false,transformSource:source=>source.replace(
    'const prewarmVolatileMemoryGraphCorpus =',
    'globalThis.__scheduleGraphBuild=scheduleVolatileMemoryGraphCorpus; globalThis.__graphBackground=volatileMemoryGraphCorpus; const prewarmVolatileMemoryGraphCorpus =')});
  const backend=x.f.r.context.risuai.pluginStorage,read=backend.getItem;
  let release;const gate=new Promise(resolve=>release=resolve);let held=0,blocking=true;
  try{
    backend.getItem=async key=>{
      if(blocking&&x.f.r.context.__graphBackground().running&&/:(?:source-receipt-head|micro-memory-head):/.test(String(key))){held++;await gate;}
      return read.call(backend,key);
    };
    x.f.r.context.__scheduleGraphBuild(0);
    const deadline=Date.now()+5000;
    while(held<4&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(held,4,'the real background prefetch holds all four payload reservations');
    let settled=false;
    const pending=x.f.control.hooks.beforeRequest([{role:'user',content:QUOTE}],'model').then(value=>{settled=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(settled,false,'the foreground drains existing I/O instead of failing admission');
    blocking=false;release();
    const out=await pending,meta=x.f.r.api.getRuntime().lastMemoryInjectionMeta;
    assert.equal(meta.injected,true,JSON.stringify(meta));
    assert.equal(meta.finalVerification.status,'verified');
    assert.ok(out.some(row=>String(row.content).includes('LIBRA')));
    assert.ok(x.f.r.core.state.lastRecallRuntime.phases.some(row=>row.label==='before_background_drain'&&row.ok));
    assert.equal(x.f.r.context.__graphBackground().interactiveReaders,0);
  }finally{blocking=false;release();backend.getItem=read;await x.cleanup();}
});
