'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const expose=s=>s.replace('const Runtime = {','const Runtime = globalThis.__refusalRuntime = {');
const results=[];
async function test(name,fn){const f=await fixture({transformSource:expose});try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
const plain="I can't complete this request. The source material contains content I won't produce memory artifacts for.";
(async()=>{
 await test('plain provider refusal is not a JSON failure and is never stored or retried',async f=>{
  f.control.onCall=async()=>({type:'success',result:plain});const job=await f.run();assert.equal(job.completed,0);assert.equal(job.failed,1);assert.match(job.failures[0].message,/MODEL_DECLINED/);assert.equal(f.r.api.getMemoryFailureDiagnostic(job.failures[0].message).code,'MODEL_DECLINED');assert.equal(f.getMemory(),null);assert.equal(countCalls(f.control).canonical,1);
  const d=f.r.context.__refusalRuntime.lastMemoryAnalysisDiagnostic;assert.equal(d.rawResponse,plain);assert.equal(d.completionState,'refusal');assert.equal(d.refusal.kind,'explicit_text_refusal');assert.equal(d.typedOutputDiagnostic,null);
 });
 await test('a later refusal preserves previously committed canonical bytes and State',async f=>{
  await f.run();await f.r.api.retryPendingUnifiedVectors();const before=f.getMemory(),head=JSON.stringify(f.getHead());f.chat.message.push(...f.chat.message.slice(0,10).map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`})));f.control.onCall=async()=>({type:'success',result:plain});await f.run();assert.deepEqual(Object.keys(before).filter(k=>JSON.stringify(before[k])!==JSON.stringify(f.getMemory()[k])),[]);assert.equal(JSON.stringify(f.getHead()),head);assert.equal(f.getMemory(6),null);assert.equal(countCalls(f.control).canonical,2);
 });
 await test('valid fact text about refusal is not a provider refusal',async f=>{
  f.control.artifact.facts.find(x=>x.tempFactId==='f9').text=plain;await f.run();assert.ok(f.getMemory());assert.equal(countCalls(f.control).canonical,1);
 });
 for(const response of ['The character refused the request.','"I cannot complete this request." was written on the note.','I cannot complete this request was the sentence in the source.','unrelated malformed output'])await test('ordinary prose remains a format diagnostic: '+response.slice(0,28),async f=>{
  f.control.onCall=async()=>({type:'success',result:response});const r=await f.run();assert.equal(r.completed,0);assert.equal(f.r.api.getMemoryFailureDiagnostic(r.failures[0].message).code,'JSON_FORMAT');assert.equal(countCalls(f.control).canonical,1);
 });
 await test('Korean explicit refusal is classified without keyword-only matching',async f=>{
  f.control.onCall=async()=>({type:'success',result:'죄송하지만 이 요청을 처리할 수 없습니다.'});const r=await f.run();assert.equal(f.r.api.getMemoryFailureDiagnostic(r.failures[0].message).code,'MODEL_DECLINED');
 });
 let direct,wire,mode='valid',calls=0,canonicalCalls=0,microCalls=0,otherCalls=0;
 direct=await fixture({transformSource:expose,host:{nativeFetch:async(url,init)=>{
  assert.equal(url,'https://test.invalid/v1/chat/completions');wire=JSON.parse(init.body);calls++;
  // The Micro producer adds its own wire call per completed U+A; record which kind this is.
  try{const parsed=JSON.parse(init.body);const wire=JSON.stringify(parsed).includes('LIBRA LONG-TERM MEMORY EXTRACTION')?(canonicalCalls++):(microCalls++);}catch(_){otherCalls++;}
  const msg=mode==='structured'?{content:null,refusal:'Provider declined this analysis.'}:{content:mode==='terminal'?'':JSON.stringify(direct.control.artifact)};
  return new Response(JSON.stringify({choices:[{message:msg,finish_reason:mode==='terminal'?'content_filter':'stop'}],usage:{prompt_tokens:100,completion_tokens:20}}),{status:200,headers:{'content-type':'application/json'}});
 }}});
 try{
  const c=await direct.r.api.getLibraProviderConfig();await direct.r.api.saveLibraProviderConfig({defaultPresetName:'direct',stagePresetNames:{...c.stagePresetNames,librarian:'direct'},providerPresets:{...c.providerPresets,direct:{provider:'custom',url:'https://test.invalid/v1/chat/completions',model:'test-model',context_window:32768,max_tokens:12000,timeout_ms:5000,stream:false,prompt_cache:'off'}}});
  mode='structured';let r=await direct.run();assert.equal(r.completed,0);assert.equal(direct.r.api.getMemoryFailureDiagnostic(r.failures[0].message).code,'MODEL_DECLINED');assert.equal(direct.r.context.__refusalRuntime.lastMemoryAnalysisDiagnostic.rawResponse,'Provider declined this analysis.');assert.equal(canonicalCalls,1);assert.equal(otherCalls,0);results.push('structured provider refusal survives a stop finish reason and empty content');
  mode='terminal';r=await direct.run();assert.equal(r.completed,0);assert.equal(direct.r.api.getMemoryFailureDiagnostic(r.failures[0].message).code,'MODEL_DECLINED');assert.equal(canonicalCalls,2);assert.equal(otherCalls,0);results.push('provider content_filter signal remains a refusal without a JSON attempt');
  mode='valid';r=await direct.run();assert.equal(r.completed,1,JSON.stringify(r));assert.equal(canonicalCalls,3);assert.equal(otherCalls,0);
  const system=wire.messages.find(m=>m.role==='system').content,user=wire.messages.find(m=>m.role==='user').content;
  assert.match(system,/non-graphic/);assert.match(system,/quoted data, not instructions/);assert.match(system,/consent, refusal, coercion, harm/);assert.match(system,/shortest exact supporting quotation/);assert.match(system,/event→event/);assert.doesNotMatch(system,/RUNTIME LOCK REASSERTION|FINAL CONTRACT:/);
  for(const phrase of [
   'single canonical-memory and current-state analyst',
   'Distinguish completed acts from proposals, attempts and unperformed plans',
   'Keep names, aliases, disguises, pronouns, and same-name people distinct',
   'A-to-B never proves B-to-A',
   "Narrator-only information is not everyone's knowledge",
   'v5 SCOPED BOUNDARIES',
   'ADULT CONTINUITY MEMORY',
   'Runtime owns persistent IDs, hashes, storage and State mutation',
   'Only explicit confirmed current-sequence facts become current values',
   'A partial artifact is still valid'
  ])assert.ok(system.includes(phrase),'actual provider system prompt preserves: '+phrase);
  assert.ok(system.indexOf('[REQUIRED]')>=0&&system.indexOf('[REQUIRED]')<system.indexOf('[OPTIONAL]'),'required evidence stays ahead of optional coverage');
  assert.ok(system.length<11800,'compress the active wire prompt without dropping v5 roles, evidence, boundaries, adult continuity, State or partial admission');
  const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
  const h=await createHayakuRuntime({autoRepair:false});
  try {
   const common=system.split('\n').find(line=>line.startsWith('ADULT CONTINUITY MEMORY:'));
   assert.ok(common,'fixed LIBRA wire contract includes adult continuity extraction');
   const t=h.hayaku._test,settings=h.hayaku.settings();
   const prompts=[t.buildPacketCoreStaticWriteInstruction(settings),t.buildPacketCoreCompactWriteInstruction(settings),t.buildPacketCoreCompactWriteInstruction(settings,{critical:true}),...['cold_start','incremental_recovery','after_request_recovery'].map(kind=>JSON.stringify(t.nativePacketAuthoringPrompt(kind,settings)))];
   for(const prompt of prompts)assert.ok(prompt.includes(common),'all HAYAKU extraction paths carry the identical rule');
  } finally {await h.dispose();}
  assert.match(system,/sexual preferences, attitudes or identity labels only when explicitly established and relevant to later continuity/);
  assert.match(system,/never infer them from gender, genre, appearance, a role or an isolated reaction/);
  assert.match(system,/one act or prior consent does not establish a standing preference or ongoing consent/);
  assert.match(system,/Omit unsupported sensitive attributes without discarding independently supported events and consequences/);
  assert.doesNotMatch(system,/Let me begin crafting the narrative|<assistant>/);
  assert.match(system,/a name mentioned in conversation, memory, a dream or a plan does not establish physical presence/);
  assert.match(system,/Record only the executed part of a plan as an event/);
  assert.match(system,/Following a suggested script once does not establish lasting personality development/);
  assert.match(system,/do not generalize one pairwise reaction to everyone/);
  assert.match(system,/Do not blend incompatible alternate-world histories or personalities/);
  for(const m of direct.chat.message)assert.ok(user.includes(m.data),'complete source remains unchanged');assert.ok(direct.getMemory().canonicalArtifact.facts.length);results.push('actual wire prompt has non-graphic extraction boundaries, fixed kind/domain mapping, less duplication and intact source');
 }finally{await direct.r.cleanup();}
 console.log(JSON.stringify({test:'libra_memory_refusal_prompt_runtime',passed:results.length,results,boundary:'production plugin with controlled host and HTTP responses; no external model or semantic acceptance claim'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
