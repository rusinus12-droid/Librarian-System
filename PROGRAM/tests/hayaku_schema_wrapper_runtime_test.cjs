'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const schema='hayaku.native_repair_output.v1';
const source='Alice opened the cedar chest and found a blue ribbon.';
const packet=createValidPacket({turn:2,subject:'Alice',summary:source});
for(const axis of ['entity','world','narrative','planner'])for(const[k,v]of Object.entries(packet[axis]))if(Array.isArray(v))packet[axis][k]=[];
packet.entity.characters=[{name:'Alice'}];packet.world.active_events=[{summary:'Alice found a blue ribbon in the cedar chest.'}];packet.meta.summary_memory={summary:source};
const grounding=['entity.characters[0]','world.active_events[0]','meta.summary_memory.summary'].map(path=>({path,source:'target',evidence:[source]}));
const wrapped={[schema]:{packet,grounding}};
const msg=(role,id,data)=>({role,id,chatId:id,data});
(async()=>{
 const r=await createHayakuRuntime({autoRepair:false,messages:[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Open.'),msg('assistant','a2',source)],llmResponder:async()=>({type:'success',result:JSON.stringify(wrapped)})});
 try{
  const api=r.hayaku._test,before=JSON.stringify(wrapped);
  for(const input of [wrapped,{[schema]:{schema,packet,grounding}}]){
   const out=api.normalizeNativeRepairEnvelope(input);assert.equal(out.schema,schema);assert.equal(out.packet.meta.response_admission.reason,'explicit_schema_wrapper');assert.equal(api.validateNativeRepairGrounding(out,{targetText:source}).ok,true);
  }
  assert.equal(JSON.stringify(wrapped),before,'original provider object is immutable');
  for(const input of [{[schema]:{schema:'wrong',packet,grounding}}, {...wrapped,other:{}},{[schema]:{packet,grounding:'invalid'}},{[schema]:wrapped},{[schema]:{packet,grounding,other:{}}}]){
   const out=api.normalizeNativeRepairEnvelope(input);assert.equal(api.validateNativeRepairGrounding(out,{targetText:source}).ok,false,'ambiguous or conflicting wrappers fail');
  }
  const invalid=JSON.parse(before);invalid[schema].grounding[1].evidence=['absent source quote'];assert.equal(api.validateNativeRepairGrounding(api.normalizeNativeRepairEnvelope(invalid),{targetText:source}).ok,false);
  const result=await r.hayaku.recovery.repairNow();assert.equal(result.outcome,'completed',JSON.stringify(result));assert.equal(result.adoption.verified,true);assert.equal(result.adoption.durable,true);assert.equal(r.llmCalls.length,1);
  const ledger=await r.hayaku.ledger.inspect({includeRecords:true});assert(ledger.records.some(row=>row.captureSource==='bridge_incremental_recovery'&&row.recordState==='active'));assert.equal(JSON.stringify(wrapped),before,'provider wrapper remains immutable after commit');
  console.log('PASS schema wrapper: runtime admission, durable verified adoption, original response, conflict/ambiguity/invalid grounding rejection, one call');
 }finally{await r.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
