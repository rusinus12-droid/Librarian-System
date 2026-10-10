'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const expose=s=>s.replace('const callLLMWithPreset = async','const callLLMWithPreset = globalThis.__capGateway = async').replace('const Runtime = {','const Runtime = globalThis.__capRuntime = {').replace('const libraMemoryFailureDiagnostic =','const libraMemoryFailureDiagnostic = globalThis.__capFailure =');
(async()=>{
 const calls=[];let truncated=false;
 const f=await fixture({transformSource:expose,host:{nativeFetch:async(url,init)=>{assert.equal(url,'https://ollama.com/v1/chat/completions');const body=JSON.parse(init.body);calls.push(body);return new Response(JSON.stringify({model:body.model,choices:[{message:{content:truncated?'':'{"ok":true}',...(truncated?{reasoning_content:'synthetic reasoning without a final answer'}:{})},finish_reason:truncated?'length':'stop'}],usage:{prompt_tokens:25670,completion_tokens:truncated?body.max_tokens:40,total_tokens:25670+(truncated?body.max_tokens:40)}}),{status:200,headers:{'content-type':'application/json'}});}}});
 try{
  const preset={provider:'ollama_cloud',url:'https://ollama.com/v1/chat/completions',model:'deepseek-v4-flash:0731',key:'synthetic-test-key',max_tokens:24000,context_window:8192,reasoning_effort:'medium',timeout_ms:5000,stream:false,prompt_cache:'off'};
  const settings={presets:{direct:preset},defaultPresetName:'direct',stagePresetNames:{librarian:'direct'}};
  const source='선택한 원문 그대로 '.repeat(3000).trim(),run=(maxTokens=65536)=>f.r.context.__capGateway(settings,'librarian','Return JSON.',source,{taskKind:'canonical_memory',maxTokens,jsonMode:true,runId:'cap-regression'});
  await run();assert.equal(calls.at(-1).max_tokens,24000,'configured context must not silently shrink the separate output budget to 8192-256');assert.ok(calls.at(-1).messages.some(m=>m.content.includes(source)),'provider message packing retains the entire selected source');
  await run(4096);assert.equal(calls.at(-1).max_tokens,4096,'a smaller explicit caller budget remains binding');
  preset.catalog_max_output_tokens=12000;preset.metadata_model_id=preset.model;await run();assert.equal(calls.at(-1).max_tokens,12000,'matching model output metadata remains binding');delete preset.catalog_max_output_tokens;
  truncated=true;const before=calls.length,result=await run();assert.equal(calls.length,before+1,'no implicit reasoning retry');assert.equal(result.ok,false);assert.equal(result.reason,'output_limit_before_final');assert.equal(result.finishReason,'length');assert.equal(result.completionEnvelope.state,'truncated');assert.equal(result.reasoningOnly,true);assert.equal(f.r.context.__capFailure(result.reason).code,'OUTPUT_LIMIT');assert.equal(f.getMemory(),null);
  const cfg=await f.r.api.getLibraProviderConfig();await f.r.api.saveLibraProviderConfig({defaultPresetName:'cap-direct',stagePresetNames:{...cfg.stagePresetNames,librarian:'cap-direct'},providerPresets:{...cfg.providerPresets,'cap-direct':preset}});
  const job=await f.run();assert.equal(job.failed,1);assert.equal(job.completed,0);assert.equal(f.getMemory(),null);const diagnostic=f.r.context.__capRuntime.lastMemoryAnalysisDiagnostic;
  assert.equal(diagnostic.completionState,'truncated');assert.equal(diagnostic.finishReason,'length');assert.equal(diagnostic.reasoningOnly,true);assert.equal(diagnostic.rawChars,0);assert.equal(diagnostic.outputBudgetTokens,24000);assert.match(diagnostic.error,/output_limit_before_final/);
  console.log(JSON.stringify({test:'libra_canonical_output_cap_runtime',passed:5,wireOutputCaps:calls.map(b=>b.max_tokens),externalModelCalls:0,sourcePreserved:true}));
 }finally{await f.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});

