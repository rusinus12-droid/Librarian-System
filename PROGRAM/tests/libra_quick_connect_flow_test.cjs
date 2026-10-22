'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
(async()=>{
 const f=await createLibraVmHarness({live_context_enabled:'true',classic_live_tail_enabled:'true'}, {runLLMModel:async()=>{throw Error('retirement checks cannot call a model');}});
 try{
  const before=await f.api.getLibraProviderConfig();
  assert.equal(before.liveContext.enabled,false);assert.equal(before.liveContext.classicEnabled,false);
  await f.api.saveLibraProviderConfig({liveContext:{enabled:true,classicEnabled:true}});
  const after=await f.api.getLibraProviderConfig();
  assert.equal(after.liveContext.enabled,false,'legacy config imports cannot re-enable raw dialogue');
  assert.equal(after.liveContext.classicEnabled,false);
  for(const route of ['classic','planner','sga'])assert.equal(f.api.debugBuildLiveTailContext(
   [{turn:1,user:{text:'raw user'},assistant:{text:'raw assistant'}}],{},
   {liveContextEnabled:true,classicLiveTailEnabled:true},route),null,'retired helper is inert for '+route);
  const view=f.api.debugProvideRecentDialogueFromReceipts({receiptSet:{status:'verified',scopeKey:'test',requestedTurns:[1],refs:[],gaps:[],pairs:[{turn:1,user:{text:'도서관 이용 규칙을 물었다.'},assistant:{text:'도서관은 정숙 구역이다.'}}]},settings:{liveContextEnabled:false,classicLiveTailEnabled:false}});
  assert.equal(view.liveTail,null,'raw injection remains retired');
  assert.match(view.queryScene,/도서관 이용 규칙/,'retrieval context is independent of retired injection');
  assert.match(view.queryScene,/도서관은 정숙 구역/);
  console.log('libra_quick_connect_flow_test: PASS (legacy flags and imported flags stay disabled; all compatibility routes are inert)');
 }finally{await f.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
