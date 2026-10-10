'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const source='Alice opened the archive door and found a blue ribbon.';
const make=()=>{const p=createValidPacket({turn:1,subject:'Alice',summary:source});for(const axis of ['entity','world','narrative','planner'])for(const [k,v] of Object.entries(p[axis]))p[axis][k]=Array.isArray(v)?[]:typeof v==='string'?'':v;p.meta.summary_memory={summary:source};return p;};
(async()=>{
 const h=await createHayakuRuntime({autoRepair:false});
 try {
  const t=h.hayaku._test,packet=make(),grounding=[{path:'meta.summary_memory.summary',source:'target',evidence:[source]}];
  for(const kind of ['after_request_recovery','incremental_recovery','cold_start']){
   const result=t.admitHayakuPacketRecords(packet,kind,{turn:1,text:source},{},{schema:'hayaku.native_repair_output.v1',packet,grounding});
   assert.equal(result.meta.record_admission.status,'complete');assert.equal(result.meta.stateAuthority,false);
  }
  const regular=t.admitRegularPacket(packet,source);assert.equal(regular.ok,true);
  const mixed=make();mixed.entity.characters=[{name:'Alice',current_state:'Examining the ribbon'}];mixed.entity.relations=[{from:'Alice'}];
  mixed.entity.pov_memories=[{text:'Alice remembers the ribbon.',ownerEntityId:'Unknown'}];
  const filtered=t.admitRegularPacket(mixed,source);assert.equal(filtered.ok,true);
  assert.equal(filtered.packet.entity.relations.length,0);
  assert.equal(filtered.packet.meta.stateAuthority,false);
  assert(filtered.admission.rejected.length>0);
  const body=hiddenPacketMessage(source,mixed),capture=t.packetCaptureInspectionFromText(body);
  const row=[...capture.packets,...capture.repairablePackets][0];assert(row);
  const history=t.historyPacketDiagnosticsFromBody(body)[0];assert.equal(row.hash,history.hash);assert.equal(row.raw,history.raw);
  assert.equal(JSON.parse(row.raw).entity.relations.length,0);
  const second=t.packetCaptureInspectionFromText(hiddenPacketMessage(source,JSON.parse(row.raw)));
  const secondRow=[...second.packets,...second.repairablePackets][0];assert.equal(row.hash,secondRow.hash,'canonical packet is stable on readback');
  const explicit=make();explicit.meta.record_grounding=[{...grounding[0],evidence:['A quote from a different source.']}];
  assert.equal(t.admitRegularPacket(explicit,source).ok,false,'invalid explicit evidence cannot authorize the only memory');
  const empty=make();empty.meta.summary_memory.summary='';assert.equal(t.admitRegularPacket(empty,source).ok,false);
  const historical=make();historical.meta.packet_type='recovery_snapshot';historical.meta.record_grounding=explicit.meta.record_grounding;
  assert.equal(t.admitRegularPacket(historical,'An unrelated current response.').ok,true,'historical packet is not tested against the current response');
  console.log('PASS common summary/item admission, isolation, explicit evidence checks, stable capture/history hashes and empty rejection');
 }finally{await h.dispose();}
 const r=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Open the archive door.'}]});
 try{
  const t=r.hayaku._test,scope=await t.currentChatScope(),snap=t.authoritativeChatSnapshot(scope.chatMessages,scope);
  const lineage=t.issueRequestGenerationIdentity(scope,t.requestLineageFor(scope.chatMessages,snap,scope,{nodes:[]}));
  const pending=t.registerPendingCapture(scope,lineage,'model',snap);
  const c=t.getHayakuSourceEdits(),set=r.pluginStorage.setItem;
  r.pluginStorage.setItem=async(k,v)=>String(k).includes('source-edit.')?false:set.call(r.pluginStorage,k,v);
  try{await c.inspect({scopeKey:scope.key,units:[{key:'99',start:99,end:99,digest:'changed',changed:true}]},{phase:"before",prompt:false})}catch(_){}
  const before=[...r.pluginStorage.values.keys()];
  assert.equal(await t.repairCurrentPacketInsideAfterRequest(source,'model'),source);
  assert.equal(pending.afterRequestRepair.outcome,'suspended');assert.equal(pending.afterRequestRepair.attempted,false);assert.equal(pending.afterRequestRepair.physicalCalls,0);
  assert.equal(pending.inlineRepairFailure,null);
  await t.repairCurrentPacketInsideAfterRequest(source,'model');assert.equal(r.llmCalls.length,0);
  const added=[...r.pluginStorage.values.keys()].filter(k=>!before.includes(k));assert(!added.some(k=>/candidate|failed-analysis/.test(k)));
  console.log('PASS afterRequest no-call hold: no candidate, failure artifact, retry or response mutation');
 }finally{await r.dispose();}
 const storedPacket=make();storedPacket.entity.characters=[{name:'Alice'}];storedPacket.entity.relations=[{from:'Alice'}];
 const chatBody=hiddenPacketMessage(source,storedPacket);
 const live=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Open the archive door.'},{role:'assistant',chatId:'a1',data:chatBody}]});
 try{
  const t=live.hayaku._test,scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope);
  await t.reconcileObservedChatTopology(scope,snapshot,'common_admission_readback',{prompt:false});
  const ledger=await t.loadStorageLedger(scope),row=ledger.records.find(r=>r.targetPairIndex===1&&r.recordState==='active');assert(row);
  assert.equal(JSON.parse(row.raw).entity.relations.length,0);
  assert.equal(t.exactHayakuTurnCoverage(snapshot,ledger,scope.key).rows[0].state,'covered');
  await t.reconcileObservedChatTopology(scope,snapshot,'common_admission_repeat',{prompt:false});
  const reloaded=await t.loadStorageLedger(scope);assert.equal(reloaded.records.filter(r=>r.recordState==='active').length,1);
  assert.equal(live.chat.message[1].data,chatBody,'host response remains byte-identical');
  console.log('PASS filtered regular packet durable readback, active binding/coverage, repeat without duplicate');
 }finally{await live.dispose();}
 const changed=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Open the archive door.'}]});
 try{
  const t=changed.hayaku._test,scope=await t.currentChatScope(),snap=t.authoritativeChatSnapshot(scope.chatMessages,scope);
  const lineage=t.issueRequestGenerationIdentity(scope,t.requestLineageFor(scope.chatMessages,snap,scope,{nodes:[]})),pending=t.registerPendingCapture(scope,lineage,'model',snap);
  changed.setLlmResponder(async()=>{changed.chat.message[0].data='Close the door instead.';return {type:'success',result:JSON.stringify({schema:'hayaku.native_repair_output.v1',packet:make(),grounding:[{path:'meta.summary_memory.summary',source:'target',evidence:[source]}]})};});
  assert.equal(await t.repairCurrentPacketInsideAfterRequest(source,'model'),source);
  assert.equal(pending.afterRequestRepair.outcome,'suspended');assert.equal(pending.afterRequestRepair.physicalCalls,1);assert.equal(pending.afterRequestRepair.attempted,true);
  assert.equal(pending.inlineRepairFailure,null);
  await t.repairCurrentPacketInsideAfterRequest(source,'model');assert.equal(changed.llmCalls.length,1);
  console.log('PASS changed source after model call is not attached or stored as a dormant failure candidate; no repeat call');
 }finally{await changed.dispose();}

 for(const hostState of ['unchanged_previous_response','new_response_committed','unrelated_edit']){
  const reroll=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Open the archive door.'},{role:'assistant',chatId:'a1',data:'Alice stayed outside the closed archive.'}]});
  try{
   const t=reroll.hayaku._test,scope=await t.currentChatScope(),snap=t.authoritativeChatSnapshot(scope.chatMessages,scope);
   const lineage=t.issueRequestGenerationIdentity(scope,{...t.requestLineageFor(scope.chatMessages,snap,scope,{nodes:[]}),mode:'reroll',targetPairIndex:1}),pending=t.registerPendingCapture(scope,lineage,'model',snap);
   reroll.setLlmResponder(async()=>{
    if(hostState!=='unchanged_previous_response')reroll.chat.message[1].data=hostState==='new_response_committed'?source:'Alice went home without entering.';
    return {type:'success',result:JSON.stringify({schema:'hayaku.native_repair_output.v1',packet:make(),grounding:[{path:'meta.summary_memory.summary',source:'target',evidence:[source]}]})};
   });
   const result=await t.repairCurrentPacketInsideAfterRequest(source,'model');
   assert.equal(reroll.llmCalls.length,1);
   if(hostState==='unrelated_edit'){assert.equal(result,source);assert.equal(pending.afterRequestRepair.outcome,'suspended');}
   else{
    assert.match(result,/HAYAKU_STATE_PACKET_START/,hostState);
    const inspection=t.packetCaptureInspectionFromText(result),row=[...inspection.packets,...inspection.repairablePackets][0];
    assert.equal(row.requestNonce,lineage.requestNonce);assert.equal(row.packetType,'current_snapshot');
    assert.equal(JSON.parse(row.raw).meta.cold_start_source,undefined,'afterRequest is not cold start');
    await t.repairCurrentPacketInsideAfterRequest(result,'model');
    await t.repairCurrentPacketInsideAfterRequest(source,'model');
    assert.equal(reroll.llmCalls.length,1,'usable-packet observation must retain the prior physical-call count');
   }
  }finally{await reroll.dispose();}
 }
 console.log('PASS reroll baseline or committed current response accepted; unrelated source edit held');
})().catch(e=>{console.error(e);process.exitCode=1;});
