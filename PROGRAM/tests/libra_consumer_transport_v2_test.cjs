'use strict';
const {assert,createLibraVmHarness,instrument,choices,hostData,withHarness,evidence,sample}=require('./fixtures/libra_consumer_test_support.cjs');
const checks=[];function pass(name){checks.push(name);console.log('PASS '+name);}
(async()=>{
 for(const kind of ['default_reasoning','explicit_reasoning_no_retry','auth401','returned_truncated']){
  const calls=[]; const h=await createLibraVmHarness({enable_gui:'false'}, {async nativeFetch(url,init){
   assert.ok(String(url).startsWith('https://test.invalid/'));const body=JSON.parse(init.body);calls.push(body);
   if(kind==='auth401')return new Response(JSON.stringify({error:{message:'test invalid credential'}}),{status:401,headers:{'content-type':'application/json'}});
   const reasoning=(kind==='default_reasoning' || kind==='explicit_reasoning_no_retry') && calls.length===1;
   return new Response(JSON.stringify({model:'test-model',choices:[{message:{content:reasoning?'':JSON.stringify(choices()),...(reasoning?{reasoning_content:'Synthetic reasoning-only response'}:{})},finish_reason:kind==='returned_truncated'?'length':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}),{status:200,headers:{'content-type':'application/json'}});
  }},{transformSource:instrument});
  try{
   const conf=await h.api.getLibraProviderConfig();
   await h.api.saveLibraProviderConfig({defaultPresetName:'test-input',responseConsumerPolicy:{schema:'libra.response_consumer_policy.v1',extraCalls:{input_writer:kind==='explicit_reasoning_no_retry'?1:0}},providerPresets:{...conf.providerPresets,'test-input':{provider:'custom',url:'https://test.invalid/v1/chat/completions',model:'test-model',key:'',max_tokens:5000,timeout_ms:5000,stream:false,request_format:'chat_completions',prompt_cache:'off'}}});
   const c=await h.api.getLibraProviderConfig();const settings=await h.api.consumerTestInternals().loadSettings({force:true});
   const r=await h.api.debugGenerateInputWriterChoices({originalInput:'금고를 열지 않는다.',settings:{...settings,inputWriterMode:'rp',defaultPresetName:'test-input',stagePresetNames:{...c.stagePresetNames,input_assist:'test-input'},presets:c.providerPresets},evidencePacket:{terminal_scene:sample},scope:{scopeKey:'test-input'}});
   assert.equal(calls.length,1);assert.equal(r.ok,false);
   assert.equal(calls.some(b=>b.messages.some(m=>m.content.includes('Return the final response draft now.'))),false);
   const op=r.operation || h.api.getResponseConsumerOperations().input_writer;
   assert.equal(op.submissions,calls.length);
   if(kind!=='auth401') {assert.equal(op.usage.inputTokens,calls.length*100);assert.equal(op.usage.outputTokens,calls.length*20);}

   pass('direct transport '+kind+' has exact bounded submissions and no role-changing inner retry');
  }finally{await h.cleanup();}
 }
 let resolveHost,submitted; const start=new Promise(r=>submitted=r);
 await withHarness({},async(h,data,calls,c)=>{
  const pre=await h.api.prepareInputWriterEvidence('기다린다.');const pending=h.api.debugGenerateInputWriterChoices(pre);
  await start;const cancel=h.api.cancelResponseConsumer('input_writer');assert.equal(cancel.cancelled,true);
  const timed=await Promise.race([pending,new Promise(r=>setTimeout(()=>r('not_settled'),1000))]);assert.notEqual(timed,'not_settled');assert.equal(timed.ok,false);
  const live=h.api.getResponseConsumerOperations().input_writer;assert.equal(live.hostPending,true);assert.equal(live.submissions,1);
  const again=await h.api.debugGenerateInputWriterChoices(pre);assert.equal(again.ok,false);assert.equal(calls.length,1);
  resolveHost(choices());await new Promise(r=>setTimeout(r,20));
  const done=h.api.getResponseConsumerOperations().input_writer;assert.equal(done.hostPending,false);assert.equal(done.attempts[0].status,'late_result_discarded');assert.equal(done.usage.inputTokens,100);
  pass('OtherAx logical cancellation returns promptly, keeps physical owner, blocks duplicate, records late usage without adoption');
 },async()=>{submitted();return await new Promise(r=>resolveHost=r);});
 console.log(JSON.stringify({test:'consumer_transport_v2',passed:checks.length,results:checks,externalModelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
