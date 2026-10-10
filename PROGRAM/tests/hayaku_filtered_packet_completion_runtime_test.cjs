'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const source='Alice opened the cedar chest in the hall and found a blue ribbon.';
const packet=createValidPacket({turn:2,subject:'Alice',summary:source});
for(const axis of ['entity','world','narrative','planner'])for(const [key,v]of Object.entries(packet[axis]))if(Array.isArray(v))packet[axis][key]=[];
packet.entity.characters=[{name:'Alice',location:'The entrance hall',current_state:'Examining the discovery'}];
packet.world.active_events=[{summary:'A blue ribbon was discovered in the chest.'}];
packet.narrative.conflict_traces=[{summary:'Ungrounded item must not survive.'}];
packet.meta.summary_memory={summary:source};
const envelope={schema:'hayaku.native_repair_output.v1',packet,grounding:['entity.characters[0]','world.active_events[0]','meta.summary_memory.summary'].map(path=>({path,source:'target',evidence:[source]}))};
const msg=(role,id,data)=>({role,id,chatId:id,data});
(async()=>{
const r=await createHayakuRuntime({autoRepair:false,messages:[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Open it.'),msg('assistant','a2',source)],llmResponder:async()=>({type:'success',result:JSON.stringify(envelope)})});
try{
 const result=await r.hayaku.recovery.repairNow();assert.equal(result.repaired,true,JSON.stringify(result));assert.equal(result.ok,true);
 const ledger=await r.hayaku.ledger.inspect({includeRecords:true});
 const row=ledger.records.find(x=>x.captureSource==='bridge_incremental_recovery'&&x.recordState==='active');assert(row,'normal durable ledger row');
 const saved=JSON.parse(row.raw);assert.equal(saved.meta.record_admission.status,'complete');assert.equal(saved.meta.stateAuthority,false);assert.equal(saved.narrative.conflict_traces.length,0);
 assert(saved.meta.record_admission.rejected.some(x=>x.path==='narrative.conflict_traces[0]'));assert(saved.meta.record_admission.derived.length>0);
 assert(saved.world.active_events.some(x=>x.summary.includes('blue ribbon')));
 const status=await r.hayaku.recovery.status({includeDebts:true,refreshDebts:true});assert(!status.debt.coverage.missingTurns.includes(2));
 await r.hayaku.recovery.repairNow();assert.equal(r.llmCalls.length,1,'completed turn does not call model again');
 console.log('PASS filtered packet: one ungrounded item isolated, paraphrase retained, normal ledger readback, coverage completed, no repeated call, State authority false');
}finally{await r.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
