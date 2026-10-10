'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const expose=s=>s.replace('const callLLMWithPreset = async','const callLLMWithPreset = globalThis.__nativeGateway = async').replace('const Runtime = {','const Runtime = globalThis.__nativeRuntime = {');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const preset={provider:'ollama_cloud',url:'https://ollama.com/v1/chat/completions',model:'deepseek-v4-flash:0731',key:'synthetic-test-key',max_tokens:24000,context_window:8192,reasoning_effort:'medium',timeout_ms:120000,stream:false,prompt_cache:'off'};
const settings={presets:{direct:preset},defaultPresetName:'direct',stagePresetNames:{librarian:'direct'}};
const results=[];
async function test(name,fn){
 let handler;const calls=[];
 const f=await fixture({transformSource:expose,host:{nativeFetch:async(url,init)=>{
  const call={url,init};calls.push(call);
  // Micro is a separate 45-second request. Inject these transport faults only
  // into the Canonical/probe request whose wait contract this suite exercises.
  if(classifyCall(call)==='micro')return response();
  return await handler(url,init);
 }}});
 const original=f.r.context.setTimeout;
 // Compress only transport timers; the payload still carries the production durations.
 f.r.context.setTimeout=(fn,ms,...args)=>original(fn,ms===600000?180:ms===120000?25:ms,...args);
 const response=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(f.control.artifact)},finish_reason:'stop'}],usage:{prompt_tokens:500,completion_tokens:1000}}),{status:200,headers:{'content-type':'application/json'}});
 const configure=async()=>{const cfg=await f.r.api.getLibraProviderConfig();await f.r.api.saveLibraProviderConfig({defaultPresetName:'native-direct',stagePresetNames:{...cfg.stagePresetNames,librarian:'native-direct'},providerPresets:{...cfg.providerPresets,'native-direct':preset}});};
 try{await configure();await fn({f,calls,response,handle:fn=>handler=fn,configure,gateway:(options={})=>f.r.context.__nativeGateway(settings,'librarian','Return JSON.','Selected source.',{taskKind:'canonical_memory',maxTokens:24000,...options})});results.push(name);}
 finally{f.r.context.setTimeout=original;await f.r.cleanup();}
}
(async()=>{
 await test('slow native cold start survives old timer and durably commits once',async({f,calls,response,handle})=>{
  handle(async()=>{await sleep(75);return response();});const job=await f.run();assert.equal(job.completed,1,JSON.stringify(job));const canonical=calls.filter(a=>classifyCall(a)==='canonical');assert.equal(canonical.length,1);assert.equal(canonical[0].init.requestTimeoutMs,600000);assert.equal(JSON.parse(canonical[0].init.body).max_tokens,24000);assert.equal(f.getMemory().status,'committed');assert.equal(f.getHead().throughTurn,5);assert.equal(f.r.context.__nativeRuntime.lastGenerationInvocation.transportWait.physicalPending,false);
 });
 await test('noncanonical requests retain configured timeout',async({gateway,calls,response,handle})=>{
  handle(async()=>{await sleep(70);return response();});await assert.rejects(()=>gateway({taskKind:'connection_probe'}),e=>e.code==='NATIVE_FETCH_TIMEOUT');assert.equal(calls[0].init.requestTimeoutMs,120000);await sleep(80);
 });
 await test('cancelled request blocks fresh work until physical settlement and discards late output',async({f,calls,response,handle})=>{
  let resolveHost,started;const ready=new Promise(r=>started=r);handle(()=>{started();return new Promise(r=>resolveHost=r);});const first=f.run();await ready;await f.r.api.cancelCanonicalJob({});assert.equal((await first).state,'cancelled');const old=[...f.r.values].filter(([k])=>/:work:|:run:/.test(k));assert.ok(old.length>=2);
  await assert.rejects(()=>f.run(),/CANONICAL_NATIVE_REQUEST_PENDING/);assert.equal(calls.filter(a=>classifyCall(a)==='canonical').length,1);for(const[k,v]of old)assert.equal(f.r.values.get(k),v);resolveHost(response());await sleep(25);assert.equal(f.getMemory(),null);handle(async()=>response());assert.equal((await f.run()).completed,1);assert.equal(calls.filter(a=>classifyCall(a)==='canonical').length,2);for(const[k]of old)assert.equal(f.r.values.has(k),false);
 });
 await test('transport deadline remains bounded and an unresponsive host cannot create duplicate analysis',async({f,calls,response,handle})=>{
  let resolveHost;handle(()=>new Promise(r=>resolveHost=r));const job=await f.run();assert.equal(job.failed,1);assert.equal(f.getMemory(),null);const diagnostic=f.r.context.__nativeRuntime.lastMemoryAnalysisDiagnostic;assert.equal(diagnostic.errorCode,'NATIVE_FETCH_TIMEOUT');assert.equal(diagnostic.provider,'ollama_cloud');assert.equal(diagnostic.model,preset.model);assert.equal(diagnostic.invocation.transportWait.effectiveTimeoutMs,600000);assert.equal(diagnostic.invocation.transportWait.physicalPending,true);await assert.rejects(()=>f.run(),/CANONICAL_NATIVE_REQUEST_PENDING/);assert.equal(calls.filter(a=>classifyCall(a)==='canonical').length,1);
  resolveHost(response());await sleep(25);assert.equal(f.getMemory(),null);handle(async()=>response());assert.equal((await f.run()).completed,1);assert.equal(calls.filter(a=>classifyCall(a)==='canonical').length,2);
 });
 await test('deadline aborts a compliant host even with the canonical caller signal',async({f,calls,response,handle})=>{
  let aborted=false;handle((_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('synthetic host physically aborted'));},{once:true});}));const job=await f.run();assert.equal(job.failed,1);assert.equal(aborted,true);assert.equal(calls.find(a=>classifyCall(a)==='canonical').init.signal.aborted,true);assert.equal(f.r.context.__nativeRuntime.lastGenerationInvocation.transportWait.physicalPending,false);handle(async()=>response());assert.equal((await f.run()).completed,1);assert.equal(calls.filter(a=>classifyCall(a)==='canonical').length,2);
 });
 await test('real host failure is surfaced once without retry or memory commit',async({f,calls,handle})=>{
  handle(async()=>{const e=new Error('synthetic upstream timeout');e.code='UPSTREAM_TIMEOUT';throw e;});const job=await f.run();assert.equal(job.failed,1);assert.equal(calls.filter(a=>classifyCall(a)==='canonical').length,1);assert.equal(f.getMemory(),null);assert.equal(f.r.context.__nativeRuntime.lastGenerationInvocation.transportWait.physicalPending,false);
 });
 console.log(JSON.stringify({test:'libra_canonical_native_wait_runtime',passed:results.length,results,externalCalls:0,timers:'transport timers accelerated; actual host success not verified'}));
})().catch(e=>{console.error(e.message,String(e.stack).split('\n').filter(l=>/^\s+at /.test(l)).join('\n'));process.exitCode=1;});
