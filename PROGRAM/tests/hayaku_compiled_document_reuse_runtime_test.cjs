'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
test('unchanged compiled eligible records reuse their owned terms beyond the smaller document LRU without increasing either bound',async()=>{
  const h=await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_TEST_SOURCE,autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,
    arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('MODEL_PROHIBITED');}});
  try{
    const rows=Array.from({length:4500},(_,i)=>({id:'r'+i,axis:'world',packetHash:'source'+Math.floor(i/3),publicText:'registry fixture delta'+i}));
    const rank=()=>h.hayaku._test.localRecallRank(rows,['delta4499']);
    assert.equal(rank()[0].id,'r4499');
    const cold=h.hayaku.lastDebug().localRecallRank;assert.equal(cold.documentTokenizations,rows.length);
    assert.equal(rank()[0].id,'r4499');
    const warm=h.hayaku.lastDebug().localRecallRank;
    assert.equal(warm.documentTokenizations,0,'the existing compiled corpus already owns exact source/body terms; the smaller4096 LRU must not cause full retokenization');
    assert.equal(warm.fullTermScans,0);assert.equal(warm.compiledIndexHit,true);
    rows[4499]={...rows[4499],publicText:rows[4499].publicText.replace('delta4499','sigma4499')};
    assert.equal(h.hayaku._test.localRecallRank(rows,['sigma4499'])[0].id,'r4499');
    const edit=h.hayaku.lastDebug().localRecallRank;assert.equal(edit.documentTokenizations,1);assert.equal(edit.compiledIndexHit,false);
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
