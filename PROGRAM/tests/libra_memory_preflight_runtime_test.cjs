'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const expose=s=>s.replace('const callLLMWithPreset = async','const callLLMWithPreset = globalThis.__memoryGateway = async').replace('const Runtime = {','const Runtime = globalThis.__memoryRuntime = {');
const response=(content,status=200)=>new Response(JSON.stringify(status===200?{model:'test-model',choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:200,completion_tokens:30}}:{error:{message:'context length exceeded by provider'}}),{status,headers:{'content-type':'application/json'}});
const results=[];
(async()=>{
 let calls=0,body,status=200;
 const f=await fixture({transformSource:expose,host:{nativeFetch:async(url,init)=>{assert.ok(String(url).startsWith('https://test.invalid/'));calls++;body=JSON.parse(init.body);return response('{"ok":true}',status);}}});
 try{
  const preset={provider:'custom',url:'https://test.invalid/v1/chat/completions',model:'test-model',key:'',max_tokens:2048,context_window:2048,timeout_ms:5000,stream:false,request_format:'chat_completions',prompt_cache:'off'};
  const settings={presets:{direct:preset},defaultPresetName:'direct',stagePresetNames:{librarian:'direct'}};
  const source='가나다라'.repeat(600),call=runId=>f.r.context.__memoryGateway(settings,'librarian','Return one JSON object.',source,{runId,taskKind:'canonical_memory',maxTokens:1024,jsonMode:true});
  const r=await call('new-direct');assert.equal(r.ok,true,JSON.stringify(r));assert.equal(calls,1);assert.ok(body.messages.some(m=>m.content===source));
  let d=f.r.context.__memoryRuntime.lastGenerationInvocation;assert.equal(d.runId,'new-direct');assert.equal(d.submitted,true);assert.equal(d.phase,'response');assert.equal(d.preflight.provider,'custom');assert.equal(d.preflight.model,'test-model');assert.equal(d.preflight.contextSource,'user_configured');assert.ok(d.preflight.inputByteBound>2048);assert.equal(d.preflight.inputTokensMeasured,null);assert.equal(d.operation.requestCount,1);
  results.push('a UTF-8 upper bound exceeding configured context does not prevent one direct request; exact source is unchanged');
  status=400;await assert.rejects(()=>call('new-context-error'),/context length exceeded/);d=f.r.context.__memoryRuntime.lastGenerationInvocation;assert.equal(calls,2);assert.equal(d.runId,'new-context-error');assert.equal(d.phase,'error');assert.equal(d.submitted,true);assert.equal(d.preflight.model,'test-model');results.push('provider context rejection belongs to the current run and does not trigger a retry');
  const host={presets:{host:{provider:'risuai_aux',model:'',timeout_ms:1000}},defaultPresetName:'host',stagePresetNames:{librarian:'host'}};
  await assert.rejects(()=>f.r.context.__memoryGateway(host,'librarian','JSON','new source',{runId:'new-expired',taskKind:'canonical_memory',maxTokens:1024,deadlineAt:Date.now()-1}),/deadline|TIMEOUT/i);
  d=f.r.context.__memoryRuntime.lastGenerationInvocation;assert.equal(d.runId,'new-expired');assert.equal(d.submitted,false);assert.equal(d.preflight.contextSource,'host_managed');assert.equal(f.control.calls.length,0);assert.equal(d.completion,undefined);results.push('pre-submission failure clears prior provider completion and identifies the new host run');
 }finally{await f.r.cleanup();}
 const g=await fixture({transformSource:expose});try{
  g.control.onCall=async()=>({type:'success',result:'invalid model output for run A'});await g.run();const first=g.r.context.__memoryRuntime.lastMemoryAnalysisDiagnostic;assert.match(first.rawResponse,/run A/);assert.ok(first.runId);
  g.control.onCall=async()=>({type:'success',result:'invalid model output for run B'});await g.r.api.retryFailedMemoryAnalysis({startTurns:[1]});const next=g.r.context.__memoryRuntime.lastMemoryAnalysisDiagnostic;assert.notEqual(next.runId,first.runId);assert.match(next.rawResponse,/run B/);assert.doesNotMatch(JSON.stringify(next),/run A/);assert.equal(countCalls(g.control).canonical,2);results.push('raw response diagnostics are attached to the fresh analysis and never restored from the failed run');
 }finally{await g.r.cleanup();}
 let directCalls=0,directBody;const direct=await fixture({transformSource:expose,host:{nativeFetch:async(url,init)=>{assert.ok(String(url).startsWith('https://test.invalid/'));directCalls++;directBody=JSON.parse(init.body);return response('분석 결과입니다.\n'+JSON.stringify(direct.control.artifact)+'\n완료.');}}});
 try{
  const c=await direct.r.api.getLibraProviderConfig();await direct.r.api.saveLibraProviderConfig({defaultPresetName:'direct',stagePresetNames:{...c.stagePresetNames,librarian:'direct'},providerPresets:{...c.providerPresets,direct:{provider:'custom',url:'https://test.invalid/v1/chat/completions',model:'test-model',context_window:2048,max_tokens:16384,timeout_ms:5000,stream:false,prompt_cache:'off'}}});
  const job=await direct.run();assert.equal(job.completed,1,JSON.stringify(job));assert.equal(directCalls,1);assert.equal(direct.control.calls.length,0);assert.ok(direct.getMemory());assert.equal(direct.getHead().throughTurn,5);
  const prompt=directBody.messages.map(m=>m.content).join('\n');for(const row of direct.chat.message)assert.ok(prompt.includes(row.data),'exact source row is retained');
  const d=direct.r.context.__memoryRuntime.lastMemoryAnalysisDiagnostic;assert.ok(d.promptBudget.optionalOmitted.includes('previous_state'));assert.match(d.rawResponse,/분석 결과입니다/);results.push('public cold start with the saved direct preset accepts wrapped JSON and commits while optional context is omitted');
 }finally{await direct.r.cleanup();}
 console.log(JSON.stringify({test:'libra_memory_preflight_runtime',passed:results.length,results,externalModelCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
