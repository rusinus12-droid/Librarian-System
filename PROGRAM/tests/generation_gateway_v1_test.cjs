'use strict';
const {assert,createLibraVmHarness,instrument}=require('./fixtures/libra_consumer_test_support.cjs');
const fs=require('node:fs');
let passed=0;const checks=[];const pass=n=>{passed++;checks.push(n);console.log('PASS '+n);};
const exposure=s=>instrument(s).replace('const callLLMWithPreset = async','const callLLMWithPreset = globalThis.__generationGateway = async');
async function fixture(fn, responder, hostResponder){
 const wires=[],host=[];
 const h=await createLibraVmHarness({enable_gui:'false'}, {
  async nativeFetch(url,init){wires.push({url:String(url),body:JSON.parse(init.body)});return responder?await responder(wires.at(-1),wires.length):new Response(JSON.stringify({model:'model',choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:9,total_tokens:16}}),{status:200});},
  async runLLMModel(args){host.push(structuredClone(args));return hostResponder?await hostResponder(args,host.length):{type:'success',result:'{"ok":true}',finish_reason:'stop',usage:{prompt_tokens:7,completion_tokens:9,total_tokens:16}};}
 },{transformSource:exposure});
 try{
 const conf=await h.api.getLibraProviderConfig();
 const preset={provider:'custom',url:'https://test.invalid/v1/chat/completions',model:'model',key:'fixture-only',max_tokens:4096,timeout_ms:5000,stream:false,request_format:'chat_completions',prompt_cache:'off'};
 const settings={...(await h.api.consumerTestInternals().loadSettings({force:true})),defaultPresetName:'gateway-fixture',presets:{...conf.providerPresets,'gateway-fixture':preset},stagePresetNames:{...conf.stagePresetNames,input_assist:'gateway-fixture'}};
 const call=(options={})=>h.context.__generationGateway(settings,'input_assist','Return the requested artifact.','Immutable source.',{taskKind:'connection_probe',maxTokens:256,...options});
 await fn({h,settings,preset,wires,host,call});
 }finally{await h.cleanup();}
}
(async()=>{
 await fixture(async({call,wires})=>{const r=await call();assert.equal(r.ok,true);assert.equal(wires.length,1);assert.ok(wires[0].body.max_tokens<=256);assert.equal(r.execution.requestCount,1);assert.equal(r.completionEnvelope.state,'complete');assert.ok(!r.raw || r.raw.rawResponseStored===false);pass('actual direct gateway validates final wire and emits safe envelope');});
 for(const reason of ['length','content_filter'])await fixture(async({call,wires})=>{const r=await call({extraCalls:1});assert.equal(r.ok,false);assert.equal(wires.length,1);pass('actual gateway '+reason+' makes no automatic additional call');},()=>new Response(JSON.stringify({choices:[{message:{content:'partial'},finish_reason:reason}]}),{status:200}));
 await fixture(async({call,wires})=>{const r=await call({extraCalls:1});assert.equal(r.ok,false);assert.equal(wires.length,1);assert.equal(JSON.stringify(r).includes('DO_NOT_PERSIST_REASONING'),false);pass('reasoning-only output is not persisted or retried');},()=>new Response(JSON.stringify({choices:[{message:{content:'',reasoning_content:'DO_NOT_PERSIST_REASONING'},finish_reason:'stop'}]}),{status:200}));
 await fixture(async({call,wires})=>{await assert.rejects(()=>call({extraCalls:1}));assert.equal(wires.length,1);pass('HTTP 503 never causes nested generation retries');},()=>new Response('{"error":{"message":"unavailable"}}',{status:503}));
 await fixture(async({call,wires})=>{await assert.rejects(()=>call({extraCalls:1}));assert.equal(wires.length,1);pass('unknown network outcome never causes another physical generation');},()=>{throw new Error('network unavailable');});
 await fixture(async({call,preset,wires})=>{preset.extra_body={max_tokens:9000};await assert.rejects(()=>call(),e=>e.code==='OUTPUT_CAP_CONFLICT');assert.equal(wires.length,0);pass('over-cap extra_body rejected before physical submission');});
 await fixture(async({call,preset,wires})=>{preset.extra_body={max_completion_tokens:100};await assert.rejects(()=>call(),e=>e.code==='TOKEN_FIELD_CONFLICT');assert.equal(wires.length,0);pass('conflicting final token aliases rejected before submission');});
 await fixture(async({call,wires})=>{await assert.rejects(()=>call({taskKind:'not_registered'}),e=>e.code==='UNKNOWN_TASK_KIND');assert.equal(wires.length,0);pass('unregistered task never defaults to canonical memory');});
 await fixture(async({call,preset,wires})=>{preset.stream=true;const r=await call();assert.equal(r.ok,true);assert.notEqual(wires[0].body.stream,true);assert.equal(wires.length,1);assert.equal(r.invocationPlan.streaming,false);pass('unverified stream is not submitted; explicit nonstream plan has one call');});
 await fixture(async({call,preset,host,wires})=>{preset.provider='risuai_aux';const r=await call();assert.equal(r.ok,true);assert.equal(wires.length,0);assert.equal(host.length,1);assert.deepEqual(Object.keys(host[0]).sort(),['allowPlugins','messages','mode']);assert.equal(host[0].mode,'otherAx');assert.equal(r.outputBudgetTokens,null);assert.equal(r.invocationPlan.effective.owner,'host-managed');pass('actual OtherAx gateway omits staticModel and reports host-managed applied budget');});
 let resolveFirst,started;const onStart=new Promise(r=>started=r);
 await fixture(async({call,preset,host})=>{
  preset.provider='risuai_aux';const controller=new AbortController();const first=call({signal:controller.signal});await onStart;controller.abort();
  await assert.rejects(()=>first);const second=call();await new Promise(r=>setTimeout(r,25));assert.equal(host.length,1);
  resolveFirst({type:'success',result:'LATE_ARTIFACT',finish_reason:'stop'});const r=await second;assert.equal(host.length,2);assert.equal(r.content,'{"ok":true}');
  pass('OtherAx logical cancellation retains physical queue; late artifact is not adopted');
 },null,async(_args,n)=>{if(n===1){started();return await new Promise(r=>resolveFirst=r);}return{type:'success',result:'{"ok":true}',finish_reason:'stop'};});
 console.log(JSON.stringify({test:'generation_gateway_v1',passed,checks,externalModelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
