'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const msg=(role,id,data)=>({role,id,chatId:id,data});
const visible='Alice waited by the door. She asked Bob to wait until tomorrow.';
const metadata='MODEL_METADATA_SENTINEL has a secret plan.';
const messages=[msg('user','u1','Enter.'),msg('assistant','a1',hiddenPacketMessage('Alice entered.',createValidPacket({turn:1}))),msg('user','u2','Continue.'),msg('assistant','a2','<reasoning>'+metadata+'</reasoning>\r\nAlice  waited by the door.\n\n\nShe asked Bob to wait until tomorrow.')];
const packet=createValidPacket({turn:2,subject:'Alice',summary:visible});
for(const axis of ['entity','world','narrative','planner'])for(const[k,v]of Object.entries(packet[axis]))if(Array.isArray(v))packet[axis][k]=[];
packet.entity.characters=[{name:'Alice'}];
packet.planner.continuity_locks=[{lock:'Bob should wait until tomorrow.',detail:'Alice asked for a delay.'},'Alice requested a delay.'];
packet.planner.open_invitations=[{invitation:'Bob has yet to respond.',status:'open'}];
packet.planner.do_not_resolve_yet=[{item:'Whether Bob will wait.',reason:'No response yet.'}];
packet.meta.summary_memory={summary:visible};
const paths=['entity.characters[0]','planner.continuity_locks[0]','planner.continuity_locks[1]','planner.open_invitations[0]','planner.do_not_resolve_yet[0]','meta.summary_memory.summary'];
const envelope={schema:'hayaku.native_repair_output.v1',packet,grounding:paths.map(path=>({path,source:'target',evidence:['Alice waited by the door.','She asked Bob to wait until tomorrow.']}))};
(async()=>{
const r=await createHayakuRuntime({autoRepair:false,messages,llmResponder:async()=>({type:'success',result:JSON.stringify({answer:envelope})})});
try{
 const api=r.hayaku._test;
 for(const tag of ['think','Thoughts','reasoning','analysis']){
  assert.equal(api.nativeAnalysisSourceText('<'+tag+'>'+metadata+'</'+tag+'> Alice waited.'),'Alice waited.');
 }
 assert.equal(api.nativeAnalysisSourceText('The AI Narrator waited by the door.'),'The AI Narrator waited by the door.','visible fictional narrator must not be blacklisted');
 const result=await r.hayaku.recovery.repairNow();
 assert.equal(result.partialMemory?.saved,true,JSON.stringify(result));assert.equal(result.partialMemory.durable,true);
 assert.equal(result.reason,'partial_memory_saved');assert.equal(result.repaired,false);
 assert.equal(result.recordAdmission.rejected.length,0,'declared planner fields are not missing anchors');
 assert.ok(!JSON.stringify(r.llmCalls).includes(metadata),'metadata never enters provider request');
 const scope=await api.currentChatScope();
 assert.ok((await api.searchAcceptedPartialMemory(scope,'tomorrow')).length);
 assert.ok(r.chat.message[3].data.includes(metadata),'physical original is unchanged');
 const failures=await r.hayaku.recovery.failedAnalysis.list();
 const payload=(await r.hayaku.recovery.failedAnalysis.read(failures.entries[0].failureId)).payload;
 // Equivalent formatting is admissible; an actual content change is not.
 payload.source.text=payload.source.text.replace('Alice waited','Alice   waited').replaceAll('\n','\r\n');
 assert.equal((await api.saveAcceptedPartialMemory(payload)).saved,true);
 payload.source.text=payload.source.text.replace('tomorrow','yesterday');
 assert.equal((await api.saveAcceptedPartialMemory(payload)).saved,false);
 const contaminated=JSON.parse(JSON.stringify(envelope));
 contaminated.packet.world.active_events=[{summary:metadata}];
 contaminated.grounding.push({path:'world.active_events[0]',source:'target',evidence:[metadata]});
 const check=api.validateNativeRepairGrounding(contaminated,{targetText:'<reasoning>'+metadata+'</reasoning>\n'+visible});
 assert.equal(check.ok,false);assert.ok(check.errors.some(e=>e.includes('grounding_quote_not_in_target')));
 const dependency=JSON.parse(JSON.stringify(packet));dependency.entity.characters=[{name:'Alice',id:'same'},{name:'Bob',id:'same'}];dependency.entity.secrets=[{summary:'A private fact.',holderEntityIds:['Alice']}];
 assert.equal(api.prepareNativePacketRecords(dependency,'cold_start',{turn:2,text:visible},{}).entity.secrets.length,0); // Preserve independent planner records, isolate restricted dependencies.
 assert.equal(r.llmCalls.length,1);
 console.log('PASS visible source: metadata exclusion, immutable transcript, whitespace binding, real edits rejected, planner schema, dependency arrays, partial readback');
 }finally{await r.dispose();}
 for(const batchTurns of [1,5]){
   const cold=await createHayakuRuntime({autoRepair:false,messages:[msg('user','c1','Continue.'),msg('assistant','c2','<think>'+metadata+'</think> '+visible)],llmResponder:async()=>({type:'success',result:JSON.stringify(packet)})});
   try {await cold.hayaku.recovery.coldStart({resume:true,batchTurns});assert.ok(cold.llmCalls.length);assert.ok(!JSON.stringify(cold.llmCalls).includes(metadata),'cold-start input excludes metadata');assert.ok(cold.chat.message[1].data.includes(metadata));}
   finally{await cold.dispose();}
 }
 console.log('PASS single and batch cold-start metadata projection');
})().catch(error=>{console.error(error);process.exitCode=1;});
