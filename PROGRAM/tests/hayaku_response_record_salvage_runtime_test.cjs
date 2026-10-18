'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const text='Alice waited by the door. Bob waited by the gate.';
const make=name=>{
 const packet=createValidPacket({turn:2,subject:name,summary:text});
 for(const axis of ['entity','world','narrative','planner'])for(const[key,value]of Object.entries(packet[axis]))if(Array.isArray(value))packet[axis][key]=[];
 packet.entity.characters=[{name}];packet.meta.summary_memory={summary:text};
 return {schema:'hayaku.native_repair_output.v1',packet,grounding:[{path:'entity.characters[0]',source:'target',evidence:[text]},{path:'meta.summary_memory.summary',source:'target',evidence:[text]}]};
};
const msg=(role,id,data)=>({role,id,chatId:id,data});
(async()=>{
 const a=make('Alice'),b=make('Bob');const invalid=make('Missing Person');
 const cases=[
  {label:'nested conflicting schema',raw:JSON.stringify({answer:{schema:'different-wrapper-version',packet:a.packet,grounding:a.grounding},note:'extra metadata'}),names:['Alice']},
  {label:'multiple candidates',raw:JSON.stringify({choices:[a,invalid,b]}),names:['Alice','Bob']},
  {label:'separate JSON objects',raw:JSON.stringify(a)+'\n'+JSON.stringify(b),names:['Alice','Bob']},
  {label:'malformed sibling',raw:JSON.stringify(a)+'\n{"unfinished":',names:['Alice']},
  {label:'no usable records',raw:JSON.stringify({answer:invalid}),names:[]},
 ];
 for(const scenario of cases){
  const r=await createHayakuRuntime({arguments:{hayaku_debug:'true'},autoRepair:false,messages:[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Continue.'),msg('assistant','a2',text)],llmResponder:async()=>({type:'success',result:scenario.raw})});
  try{
   const result=await r.hayaku.recovery.repairNow();assert.equal(r.llmCalls.length,1);
   assert.equal(result.repaired,false,'salvage never claims complete turn');
   assert.equal(result.reason,scenario.names.length?'partial_memory_saved':'no_storable_memory',scenario.label+JSON.stringify(result));
   const scope=await r.hayaku._test.currentChatScope();
   const recalled=JSON.stringify(await r.hayaku._test.searchAcceptedPartialMemory(scope,'Alice Bob Missing Person'));
   for(const name of scenario.names)assert.ok(recalled.includes(name),scenario.label+recalled);
   assert.ok(!recalled.includes('Missing Person'));
   const out=await r.hayaku._test.buildHayakuOperationDebugExport({includeAnalysisDetails:true});
   assert.equal(out.analysisDiagnostics.artifacts[0].attempts[0].rawResponse,scenario.raw);
  }finally{await r.dispose();}
 }
 console.log('PASS response salvage: nested/schema differences, multiple objects, malformed sibling, valid records retained, invalid record isolated, no-memory status, raw preservation, one call');
})().catch(error=>{console.error(error);process.exitCode=1;});
