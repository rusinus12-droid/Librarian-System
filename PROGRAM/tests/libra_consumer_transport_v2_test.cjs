'use strict';
// Input Writer retired; shared transport is exercised by the retained translator.
const {assert,createLibraVmHarness,expose:instrument,hostData}=require('./fixtures/libra_retained_contract_probe.cjs');
const checks=[];function pass(name){checks.push(name);console.log('PASS '+name);}
(async()=>{
 for(const kind of ['success','default_reasoning','explicit_reasoning_no_retry','auth401','returned_truncated']){
  const calls=[]; const h=await createLibraVmHarness({enable_gui:'false'}, {async nativeFetch(url,init){
   assert.ok(String(url).startsWith('https://test.invalid/'));const body=JSON.parse(init.body);calls.push(body);
   if(kind==='auth401')return new Response(JSON.stringify({error:{message:'test invalid credential'}}),{status:401,headers:{'content-type':'application/json'}});
   const reasoning=(kind==='default_reasoning' || kind==='explicit_reasoning_no_retry') && calls.length===1;
   return new Response(JSON.stringify({model:'test-model',choices:[{message:{content:reasoning?'':'The door is closed.',...(reasoning?{reasoning_content:'Synthetic reasoning-only response'}:{})},finish_reason:kind==='returned_truncated'?'length':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}),{status:200,headers:{'content-type':'application/json'}});
  }},{transformSource:instrument});
  try{
   const conf=await h.api.getLibraProviderConfig();
   await h.api.saveLibraProviderConfig({defaultPresetName:'test-input',responseConsumerPolicy:{schema:'libra.response_consumer_policy.v1',extraCalls:{input_translation:kind==='explicit_reasoning_no_retry'?1:0}},providerPresets:{...conf.providerPresets,'test-input':{provider:'custom',url:'https://test.invalid/v1/chat/completions',model:'test-model',key:'',max_tokens:5000,timeout_ms:5000,stream:false,request_format:'chat_completions',prompt_cache:'off'}}});
   const c=await h.api.getLibraProviderConfig();const settings=await h.context.__retainedOuter().loadSettings({force:true});
   const translate=()=>h.context.__retainedOuter().translateInputAssistReviewText('문이 닫혀 있다.',{...settings,defaultPresetName:'test-input',stagePresetNames:{...c.stagePresetNames,input_assist:'test-input'},presets:c.providerPresets});
   if(kind==='success')assert.equal(await translate(),'The door is closed.');else await assert.rejects(translate());
   assert.equal(calls.length,1);
   assert.equal(calls.some(b=>b.messages.some(m=>m.content.includes('Return the final response draft now.'))),false);
   const op=h.api.getResponseConsumerOperations().input_translation;
   assert.equal(op.submissions,calls.length);
   if(kind!=='auth401') {assert.equal(op.usage.inputTokens,calls.length*100);assert.equal(op.usage.outputTokens,calls.length*20);}

   pass('direct transport '+kind+' has exact bounded submissions and no role-changing inner retry');
  }finally{await h.cleanup();}
 }
 let resolveHost,submitted;const start=new Promise(r=>submitted=r),calls=[];
 const data=hostData(),h=await createLibraVmHarness({enable_gui:'false'},{...data.host,async runLLMModel(options){calls.push(options);submitted();return await new Promise(r=>resolveHost=r);}},{transformSource:instrument});
 try{
  const settings=await h.context.__retainedOuter().loadSettings();
  const translate=()=>h.context.__retainedOuter().translateInputAssistReviewText('문이 닫혀 있다.',settings);
  const pending=translate().then(value=>({value}),error=>({error}));await start;
  assert.equal(h.api.cancelResponseConsumer('input_translation').cancelled,true);
  const timed=await Promise.race([pending,new Promise(r=>setTimeout(()=>r('not_settled'),1000))]);assert.notEqual(timed,'not_settled');assert(timed.error);
  let op=h.api.getResponseConsumerOperations().input_translation;assert.equal(op.hostPending,true);assert.equal(op.submissions,1);
  await assert.rejects(translate(),/CONSUMER_HOST_REQUEST_STILL_PENDING/);assert.equal(calls.length,1);
  resolveHost({type:'success',result:'The door is closed.',usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});
  await new Promise(r=>setTimeout(r,20));op=h.api.getResponseConsumerOperations().input_translation;
  assert.equal(op.hostPending,false);assert.equal(op.attempts[0].status,'late_result_discarded');assert.equal(op.usage.inputTokens,100);
  pass('OtherAx cancellation preserves physical ownership, rejects duplicates, discards late result and records usage');
 }finally{await h.cleanup();}
 console.log(JSON.stringify({test:'consumer_transport_v2',passed:checks.length,results:checks,externalModelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
