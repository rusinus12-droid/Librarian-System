'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const family=key=>(String(key).match(/:(source-receipt-head|source-receipt|micro-memory-head|micro-memory|micro-work):/)||[])[1]||'other';
for(const mode of (process.env.RECALL_PERF_MODES||'plugin_only,mirror,server_only').split(','))test(`${mode}: classic recall reads a request-local corpus once and physically verifies delivery`,async()=>{
  const x=await fixture({mode,microCount:3,transformSource:source=>source.replace(
    'const readMemoryGraphProjectionOnce = async (options = {}, collect = null, resources = null) => {',
    'const readMemoryGraphProjectionOnce = async (options = {}, collect = null, resources = null) => { if(resources?.inspect().limits.maxRetainedBytes===128*1024*1024)globalThis.__recallEnumerations=(globalThis.__recallEnumerations||0)+1;')});
  try{
    const api=x.f.r.api,counts={},server=x.server;
    let measuring=false,transportCalls=0;
    const observe=key=>{const name=family(key);counts[name]=(counts[name]||0)+1;};
    if(server){
      server.hooks.beforeServerRequest=async(url,init)=>{
        if(!measuring)return;
        transportCalls++;
        if(url.includes('/v1/kv/get?'))observe(new URL(url).searchParams.get('key'));
        if(url.endsWith('/v1/kv/get-many'))for(const key of JSON.parse(init.body).keys)observe(key);
        if(process.env.RECALL_IO_DELAY_MS)await new Promise(resolve=>setTimeout(resolve,Number(process.env.RECALL_IO_DELAY_MS)));
      };
    }else{
      const read=x.f.r.context.risuai.pluginStorage.getItem;
      x.f.r.context.risuai.pluginStorage.getItem=async key=>{if(measuring){transportCalls++;observe(key);}return read(key);};
    }
    x.f.r.context.__recallEnumerations=0;
    measuring=true;const started=performance.now();
    const out=await x.f.control.hooks.beforeRequest([{role:'user',content:QUOTE}],'model');
    const elapsedMs=Math.round(performance.now()-started);measuring=false;
    const recall=api.getLastMemoryRecall(),meta=api.getRuntime().lastMemoryInjectionMeta;
    assert.equal(meta.injected,true,JSON.stringify(meta));
    assert.equal(meta.finalVerification.status,'verified');
    assert.ok(out.some(row=>String(row.content).includes(QUOTE)));
    const report={mode,elapsedMs,transportCalls,counts,enumerations:x.f.r.context.__recallEnumerations,corpusMode:recall.corpusRead.mode,
      ownerProof:recall.corpusRead.currentnessVerification||null,
      phases:x.f.r.core.state.lastRecallRuntime.phases};
    console.log('RECALL_MEASUREMENT '+JSON.stringify(report));
    if(!process.env.RECALL_PERF_BASELINE){
      assert.equal(recall.corpusRead.nativeReprojectionRequired,false);
      assert.equal(x.f.r.context.__recallEnumerations,1,'one source window is projected once; delivery rechecks owner proofs and consumed bodies');
    }
  }finally{await x.cleanup();}
});
