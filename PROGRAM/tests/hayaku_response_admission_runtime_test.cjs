'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const s=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');const c=vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteExecutionContract.source.js'),'utf8'),c);
vm.runInContext(s.slice(s.indexOf('  const extractSingleHayakuJsonObject ='),s.indexOf('  let NativeOtherAxCallQueue'))+'globalThis.parse=parseNativeJsonObject;',c);
for(const v of ['{"data":"unchanged"}','```json\n{"data":"unchanged"}\n```','<final>{"data":"unchanged"}</final>','<think>format planning</think><output>{"data":"unchanged"}</output>','Result:\n{"data":"unchanged"}\nDone.'])assert.equal(c.parse(v).data,'unchanged');
for(const [v,reason]of [['','typed_response_empty'],['<Thoughts>thinking only without json</Thoughts>','typed_response_reasoning_only'],['{"x":','typed_response_incomplete_object'],['{"x":1} {"x":2}',null],['{"x":1,"x":2}',null],['[{}]','typed_response_root_not_object'],['<think>unfinished','typed_response_reasoning_unclosed']]){
 let error;try{c.parse(v)}catch(e){error=e}assert(error,v);assert(error.code);assert.equal(error.validation.kind,'native_json_format');assert.equal(error.validation.rawChars,v.length);if(reason)assert.equal(error.message,reason);
 if(reason==='typed_response_empty')assert.equal(error.code,'HAYAKU_NATIVE_RESPONSE_EMPTY');
 if(reason==='typed_response_reasoning_only')assert.equal(error.code,'HAYAKU_NATIVE_REASONING_ONLY');
}
assert.deepEqual(JSON.parse(JSON.stringify(c.parse('{"facts":[],"unknown":42}'))),{facts:[],unknown:42},'parser never invents or drops data before schema validation');
assert(s.includes('candidate = parseNativeResponseForAdmission(llm.content)'));// Full regular/recovery admission is exercised by hayaku_common_admission_runtime_test.
const prompt=s.slice(s.indexOf('  const nativePacketAuthoringPrompt ='),s.indexOf('  const nativeAnalysisRunKey ='));assert(prompt.includes('HAYAKU_NATIVE_MEMORY_EXTRACTION_GUIDANCE'));

(async()=>{
 const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
 const targetText='Alice opened the door and handed Bob the key.';
 const msg=(role,id,data)=>({role,id,chatId:id,data});
 const makeEnvelope=()=>{
  const packet=createValidPacket({turn:2,subject:'Alice',summary:targetText});
  for(const axis of ['entity','world','narrative','planner'])for(const[key,value]of Object.entries(packet[axis]))if(Array.isArray(value))packet[axis][key]=[];
  packet.entity.characters=[{name:'Alice'}];
  packet.meta.summary_memory={summary:targetText};
  return {schema:'hayaku.native_repair_output.v1',packet,grounding:[{path:'entity.characters[0]',source:'target',evidence:[targetText]},{path:'meta.summary_memory.summary',source:'target',evidence:[targetText]}]};
 };

 // 1. Recovery prompts include reasoning cap and prohibited keys; wrapped valid envelope is rescued
 const rescuedRuntime=await createHayakuRuntime({
  arguments:{hayaku_debug:'true'},
  autoRepair:false,
  messages:[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Check door.'),msg('assistant','a2',targetText)],
  llmResponder:async()=>({type:'success',result:'<Thoughts>brief plan\n'+JSON.stringify(makeEnvelope())+'\n</Thoughts>'})
 });
 try{
  for(const kind of ['incremental_recovery','after_request_recovery','cold_start']){
   const p=String(rescuedRuntime.hayaku._test.nativePacketAuthoringPrompt(kind,{memoryLanguage:'source'})?.primary||'');
   assert(!p.includes('strictly under 120 words'),`${kind} prompt no longer imposes 120-word reasoning cap`);
   assert(/Never include keys named reasoning, analysis, thought/i.test(p),`${kind} prompt forbids reasoning/analysis/thought keys`);
  }
  const rescued=await rescuedRuntime.hayaku.recovery.repairNow();
  assert.equal(rescued.repaired,true,'complete valid envelope trapped inside <Thoughts> is rescued cleanly');
 }finally{await rescuedRuntime.dispose();}

 // 2. Prose-only <Thoughts> with no JSON envelope fails distinctly with HAYAKU_NATIVE_REASONING_ONLY
 const proseOnlyRuntime=await createHayakuRuntime({
  arguments:{hayaku_debug:'true'},
  autoRepair:false,
  messages:[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Check door.'),msg('assistant','a2',targetText)],
  llmResponder:async()=>({type:'success',result:'<Thoughts>Just prose thinking, no json envelope at all.</Thoughts>'})
 });
 try{
  const failed=await proseOnlyRuntime.hayaku.recovery.repairNow();
  assert.equal(failed.repaired,false);
  const out=await proseOnlyRuntime.hayaku._test.buildHayakuOperationDebugExport({includeAnalysisDetails:true});
  assert.equal(out.analysisDiagnostics.summaries[0]?.diagnosisCode,'REASONING_ONLY');
  assert.equal(out.analysisDiagnostics.summaries[0]?.cause?.[0]?.code,'HAYAKU_NATIVE_REASONING_ONLY');
 }finally{await proseOnlyRuntime.dispose();}

 console.log('PASS shared response admission: wrappers, single object, malformed/empty/duplicate rejection, reasoning-only diagnosis, trapped-envelope rescue, and prompt locks');
})().catch(error=>{console.error(error);process.exitCode=1;});
