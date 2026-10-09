'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {classifyCall}=require('./fixtures/libra_provider_call_kinds.cjs');
const expose=s=>s.replace('const callLLMWithPreset = async','const callLLMWithPreset = globalThis.__lengthGateway = async').replace('const Runtime = {','const Runtime = globalThis.__lengthRuntime = {');
(async()=>{
 const wires=[];let f,forceLength=false;
 f=await fixture({transformSource:expose,host:{nativeFetch:async(url,init)=>{
   assert.equal(url,'https://ollama.com/v1/chat/completions');const body=JSON.parse(init.body);wires.push(body);
   // Model the provider default that caused an empty final answer. The fixture
   // is synthetic; this does not assert measured Ollama service behavior.
   const length=forceLength||body.reasoning_effort===undefined;
   return new Response(JSON.stringify({model:body.model,choices:[{message:{content:length?'':JSON.stringify(f.control.artifact),...(length?{reasoning_content:'synthetic provider default thinking'}:{})},finish_reason:length?'length':'stop'}],usage:{prompt_tokens:25656,completion_tokens:length?body.max_tokens:1800}}),{status:200,headers:{'content-type':'application/json'}});
 }}});
 const results=[];
 try{
   const preset={provider:'ollama_cloud',url:'https://ollama.com/v1/chat/completions',model:'deepseek-v4-flash:0731',key:'synthetic-test-key',max_tokens:24000,context_window:8192,reasoning_preset:'auto',reasoning_effort:'none',timeout_ms:120000,stream:false,prompt_cache:'off'};
   const cfg=await f.r.api.getLibraProviderConfig();await f.r.api.saveLibraProviderConfig({defaultPresetName:'length-direct',stagePresetNames:{...cfg.stagePresetNames,librarian:'length-direct'},providerPresets:{...cfg.providerPresets,'length-direct':preset},generationPolicy:{version:1,enabled:true,extraCalls:0,streaming:false}});
   const extra=' 원문 보존 시험'.repeat(3000);f.chat.message[0].data+=extra;
   const job=await f.run();assert.equal(job.completed,1,JSON.stringify(job));
   const canonicalWires=wires.filter(body=>classifyCall([body])==='canonical');
   assert.equal(canonicalWires.length,1);const canonicalWire=canonicalWires[0];
   assert.equal(canonicalWire.reasoning_effort,'none');assert.equal(f.getMemory().status,'committed');assert.equal(f.getHead().throughTurn,5);
   results.push('auto/none is sent explicitly and one canonical request commits through readback');
   const d=f.r.context.__lengthRuntime.lastMemoryAnalysisDiagnostic;
   assert.equal(canonicalWire.max_tokens,24000);assert.equal(d.invocation.preflight.effectiveOutputTokens,24000);assert.equal(d.invocation.preflight.requestedOutputTokens,24000);assert.equal(d.promptBudget.requestedOutputTokens,65536);assert.equal(d.promptBudget.effectiveOutputTokens,24000);assert.ok(d.invocation.plan.requested.visibleHeadroom<=24000);
   results.push('analysis planning, visible reserve and wire use the actual preset cap');
   const input=canonicalWire.messages.map(m=>m.content).join('\n');assert.ok(input.includes(extra));assert.match(input,/COMPACT MEMORY OUTPUT/);assert.match(input,/Use \{factTempId\}/);
   results.push('full selected source remains intact with compact output instructions');
   const settings={presets:{direct:preset},defaultPresetName:'direct',stagePresetNames:{librarian:'direct'},generationPolicy:{version:1,enabled:true}};
   const call=()=>f.r.context.__lengthGateway(settings,'librarian','Return JSON.','Source.',{taskKind:'canonical_memory',maxTokens:65536,structuredTask:true,jsonMode:true});
   preset.reasoning_effort='medium';await call();assert.equal(wires.at(-1).reasoning_effort,'medium');results.push('explicit thinking remains user controlled');
   preset.reasoning_effort='none';preset.model='glm-5.3-flash';await call();assert.equal(wires.at(-1).reasoning_effort,'low');results.push('existing forced-thinking model exception remains low');
   preset.model='deepseek-v4-flash:0731';preset.catalog_max_output_tokens=12000;preset.metadata_model_id=preset.model;await call();assert.equal(wires.at(-1).max_tokens,12000);assert.equal(f.r.context.__lengthRuntime.lastGenerationInvocation.preflight.effectiveOutputTokens,12000);results.push('matching provider model cap remains binding');
   forceLength=true;const before=wires.length;const failed=await call();assert.equal(wires.length,before+1);assert.equal(failed.ok,false);assert.equal(failed.reason,'output_limit_before_final');assert.equal(f.getMemory().status,'committed');results.push('real length termination remains a failure without automatic calls or prior-memory loss');
   console.log(JSON.stringify({test:'libra_canonical_reasoning_off_length_runtime',passed:results.length,results,externalCalls:0,boundary:'full deployed JS and controlled provider; no live Ollama verification'}));
 }finally{await f.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
