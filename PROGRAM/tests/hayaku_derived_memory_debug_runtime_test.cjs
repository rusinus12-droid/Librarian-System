'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const source='Alice opened the cedar chest and found a blue ribbon.';
const paraphrase='Alice found a blue ribbon in the cedar chest.';
const msg=(role,id,data)=>({role,id,chatId:id,data});
const packet=createValidPacket({turn:2,subject:'Alice',summary:source});
for(const axis of ['entity','world','narrative','planner'])for(const[key,value]of Object.entries(packet[axis]))if(Array.isArray(value))packet[axis][key]=[];
packet.entity.characters=[{name:'Alice'}];packet.world.active_events=[{summary:paraphrase}];
packet.meta.summary_memory={summary:source};
const envelope={schema:'hayaku.native_repair_output.v1',packet,grounding:[
 {path:'entity.characters[0]',source:'target',evidence:[source]},
 {path:'world.active_events[0]',source:'target',evidence:[source]},
 {path:'meta.summary_memory.summary',source:'target',evidence:[source]}
]};
(async()=>{
 const raw=JSON.stringify(envelope);
 const r=await createHayakuRuntime({autoRepair:false,messages:[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Open the chest.'),msg('assistant','a2',source)],llmResponder:async()=>({type:'success',result:raw})});
 try {
  const api=r.hayaku._test;
  const validation=api.validateNativeRepairGrounding(envelope,{targetText:source});
  assert.equal(validation.ok,true);assert.equal(validation.classification,'source_bound_derived');assert.ok(validation.derived.length);
  const invalid=JSON.parse(raw);invalid.grounding[1].evidence=['A quotation missing from the source'];
  assert.equal(api.validateNativeRepairGrounding(invalid,{targetText:source}).ok,false);
  const wrongName=JSON.parse(raw);wrongName.packet.entity.characters[0].name='Bob';
  assert.equal(api.validateNativeRepairGrounding(wrongName,{targetText:source}).ok,false);
  const result=await r.hayaku.recovery.repairNow();
  assert.equal(result.repaired,true);assert.equal(result.ok,true);assert.equal(r.llmCalls.length,1);
  const ledger=await r.hayaku.ledger.inspect({includeRecords:true});
  const row=ledger.records.find(x=>x.captureSource==='bridge_incremental_recovery'&&x.recordState==='active');
  assert.ok(row);const saved=JSON.parse(row.raw);
  assert.equal(saved.meta.record_admission.status,'complete');assert.ok(saved.meta.record_admission.derived.length);assert.equal(saved.meta.stateAuthority,false);
  assert.ok(JSON.stringify(saved).includes(paraphrase));
  const exported=await api.buildHayakuOperationDebugExport();assert.equal(r.llmCalls.length,1,'export never calls a provider');
  console.log('PASS derived memory: quote validation, identity rejection, normal ledger readback, derived diagnostics, one call');
 }finally{await r.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
