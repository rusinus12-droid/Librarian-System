'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const C=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteExecutionContract.source.js'),'utf8')+';MemorySuiteExecutionContract',{URL,TextEncoder,TextDecoder,setTimeout,clearTimeout});
const sse=rows=>rows.map(x=>'data: '+(typeof x==='string'?x:JSON.stringify(x))+'\r\n\r\n').join('');
const fixtures={
 chat:sse([{choices:[{index:0,delta:{content:'{"한":"🌱"}'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:5,completion_tokens:7}},'[DONE]']),
 responses:sse([{type:'response.output_text.delta',delta:'{"한":"🌱"}'},{type:'response.completed',response:{usage:{input_tokens:5,output_tokens:7}}}]),
 anthropic:sse([{type:'message_start',message:{usage:{input_tokens:5}}},{type:'content_block_delta',delta:{type:'text_delta',text:'{"한":"🌱"}'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:7}},{type:'message_stop'}]),
 gemini:sse([{candidates:[{content:{parts:[{text:'{"한":"🌱"}'}]}}]},{candidates:[{finishReason:'STOP'}],usageMetadata:{promptTokenCount:5,candidatesTokenCount:7}}]),
 ollama:JSON.stringify({message:{content:'{"한":"🌱"}'},done:false})+'\n'+JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:5,eval_count:7})+'\n'
};
const response=(str,size)=>{const bytes=new TextEncoder().encode(str);let i=0;return new Response(new ReadableStream({pull(c){if(i>=bytes.length)return c.close();c.enqueue(bytes.slice(i,i+=size));}}));};
(async()=>{
 let count=0;
 for(const [protocol,raw] of Object.entries(fixtures))for(const size of [1,2,7,65536]){const r=await C.receiveGenerationStream(response(raw,size),protocol);assert.equal(r.content,'{"한":"🌱"}');assert.equal(C.completion(r).state,'complete');assert.ok(r.usage);count++;}
 await assert.rejects(()=>C.receiveGenerationStream(response(sse([{choices:[{delta:{content:'{"ok":true}'}}]}]),1),'chat'),e=>e.code==='STREAM_TERMINAL_MISSING');count++;
 await assert.rejects(()=>C.receiveGenerationStream(response(sse([{type:'error',error:{type:'overloaded_error'}}]),1),'anthropic'),e=>e.code==='STREAM_PROVIDER_ERROR');count++;
 await assert.rejects(()=>C.receiveGenerationStream(response(fixtures.chat,1),'chat',{maxContentChars:128,maxBytes:1024,deadlineAt:Date.now()-1}));count++;
 const hanging=new Response(new ReadableStream({pull(){return new Promise(()=>{});}}));
 await assert.rejects(()=>C.receiveGenerationStream(hanging,'chat',{deadlineAt:Date.now()+25}),e=>e.code==='OUTCOME_UNKNOWN_TIMEOUT');count++;
 await assert.rejects(()=>C.receiveGenerationStream(response(sse([{choices:[{delta:{content:'x'.repeat(200)}}]}]),20),'chat',{maxContentChars:128}),e=>e.code==='STREAM_CONTENT_LIMIT');count++;
 const refusal=await C.receiveGenerationStream(response(sse([{choices:[{delta:{refusal:'no'},finish_reason:'content_filter'}]},'[DONE]']),1),'chat');assert.equal(C.completion(refusal).state,'refusal');count++;
 const wires=[];let streaming=false,changeSource=false;
 const h=await createLibraVmHarness({enable_gui:'false'},{async nativeFetch(url,init){const body=JSON.parse(init.body);wires.push(body);if(streaming)return response(fixtures.chat,1);return new Response(JSON.stringify({choices:[{message:{content:wires.length===1?'partial':'{"ok":true}'},finish_reason:wires.length===1?'length':'stop'}],usage:{prompt_tokens:11,completion_tokens:wires.length===1?65536:10,total_tokens:wires.length===1?65547:21}}));}},
 {transformSource:src=>src.replace('const loadSettings = async','const loadSettings = globalThis.__streamSettings = async').replace('const callLLMWithPreset = async','const callLLMWithPreset = globalThis.__gateway = async').replace('const callMemoryProvider = async','const callMemoryProvider = globalThis.__memoryProvider = async').replace('const createCanonicalProviderBudget = (','const createCanonicalProviderBudget = globalThis.__budget = (')});
 try{
   const settings=await h.context.__streamSettings({force:true});
   const preset={provider:'custom',url:'https://test.invalid/v1/chat/completions',model:'fixture',key:'fixture',max_tokens:98304,timeout_ms:5000,stream:false,request_format:'chat_completions',prompt_cache:'off'};
   Object.assign(settings,{generationPolicy:{version:1,enabled:true,extraCalls:1,streaming:false},defaultPresetName:'remaining',presets:{...settings.presets,remaining:preset},stagePresetNames:{...settings.stagePresetNames,librarian:'remaining',input_assist:'remaining'}});
   const call=()=>h.context.__memoryProvider('librarian','system','unchanged source',{maxTokens:65536,taskSettingsSnapshot:settings,providerBudget:h.context.__budget(['librarian'],{},Date.now(),{generationPolicy:settings.generationPolicy}),validateRecoverySource:async()=>!changeSource});
   const result=await call();assert.equal(result.ok,true);assert.deepEqual(wires.map(x=>x.max_tokens),[65536,98304]);assert.equal(result.execution.requestCount,2);assert.equal(result.providerBudget.totalCalls,2);count++;
   wires.length=0;changeSource=true;await assert.rejects(call);assert.equal(wires.length,1);count++;
   wires.length=0;changeSource=false;preset.max_tokens=65536;const capped=await call();assert.equal(capped.ok,false);assert.equal(wires.length,1);count++;
   wires.length=0;streaming=true;settings.generationPolicy.streaming=true;preset.stream=true;
   const streamed=await h.context.__gateway(settings,'input_assist','system','source',{taskKind:'connection_probe',maxTokens:256});assert.equal(streamed.ok,true);assert.equal(wires[0].stream,true);assert.equal(streamed.invocationPlan.streaming,true);assert.equal(streamed.content,'{"한":"🌱"}');count++;
   wires.length=0;preset.catalog_max_output_tokens=128;preset.metadata_model_id=preset.model;
   await h.context.__gateway(settings,'input_assist','system','source',{taskKind:'connection_probe',maxTokens:256});assert.equal(wires[0].max_tokens,128);count++;
   wires.length=0;preset.context_window=1;
   await assert.rejects(()=>h.context.__gateway(settings,'input_assist','system','source',{taskKind:'connection_probe',maxTokens:256}),e=>e.code==='REQUEST_BUDGET_EXHAUSTED');assert.equal(wires.length,0);count++;
   await h.api.saveLibraProviderConfig({generationPolicy:{version:1,enabled:true,extraCalls:1,streaming:true}});
   const saved=await h.api.getLibraProviderConfig();assert.equal(saved.generationPolicy.extraCalls,1);assert.equal(saved.generationPolicy.enabled,true);count++;
 }finally{await h.cleanup();}
 console.log(JSON.stringify({test:'remaining_generation_stream_runtime',passed:count,externalModelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
