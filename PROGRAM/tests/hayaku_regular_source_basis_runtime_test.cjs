'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
async function scenario(changeDuringGeneration=false){
 const p1=createValidPacket({turn:1,subject:'Alice',summary:'Alice opened the door.'});
 const h=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Open the door.'},{role:'assistant',chatId:'a1',data:hiddenPacketMessage('Alice opened the door.',p1)}]});
 try{
  const t=h.hayaku._test;
  async function current(){const scope=await t.currentChatScope();return {scope,snapshot:t.authoritativeChatSnapshot(scope.chatMessages,scope)};}
  let c=await current();await t.reconcileObservedChatTopology(c.scope,c.snapshot,'basis_initial',{prompt:false});
  h.chat.message[1].data=hiddenPacketMessage('Alice closed the door.',p1);
  c=await current();await t.reconcileObservedChatTopology(c.scope,c.snapshot,'basis_edit',{prompt:false});
  h.chat.message.push({role:'user',chatId:'u2',data:'What happens next?'});
  c=await current();const lineage=t.issueRequestGenerationIdentity(c.scope,t.requestLineageFor(c.scope.chatMessages,c.snapshot,c.scope,(await t.loadStorageLedger(c.scope)).worldline));
  assert.equal(lineage.targetPairIndex,2);
  const pending=t.registerPendingCapture(c.scope,lineage,'model',c.snapshot);
  assert.equal(pending.requestSourcePrefix.length,1);
  if(changeDuringGeneration)h.chat.message[1].data=hiddenPacketMessage('Alice locked the door.',p1);
  const packet=createValidPacket({turn:2,subject:'Alice',summary:'Alice waited outside.'});
  const constants=JSON.parse(t.buildPacketRuntimeSkeletonInstruction({requestLineage:lineage}).split('\n').find(s=>s.startsWith('{')));
  packet.meta.lineage=constants.lineage;
  const body=hiddenPacketMessage('Alice waited outside.',packet);
  h.chat.message.push({role:'assistant',chatId:'a2',data:body});
  c=await current();const pair=c.snapshot.conversationPairs.at(-1),inspection=t.packetCaptureInspectionFromText(body);
  const result=await t.persistCapturedPackets(pending,[...inspection.packets,...inspection.repairablePackets],'risu_chat_output',{authoritativePair:true,pair});
  assert.equal(result.durable,true,JSON.stringify(result));
  let ledger=await t.loadStorageLedger(c.scope),record=ledger.records.find(r=>r.targetPairIndex===2);
  assert.equal(record.sourceRevisionOrigin,'regular_request');assert(record.sourceRevisionBasis);
  let units=(await t.hayakuSourceEditSnapshot(c.scope,c.snapshot,ledger)).units;
  assert.equal(units.find(u=>u.key==='1').changed,true);
  assert.equal(units.find(u=>u.key==='2').changed,changeDuringGeneration,'only packets generated from the current prefix are exempt');
  if(!changeDuringGeneration){
   await t.reconcileObservedChatTopology(c.scope,c.snapshot,'basis_commit',{prompt:false});
   ledger=await t.loadStorageLedger(c.scope);record=ledger.records.find(r=>r.targetPairIndex===2&&r.recordState==='active');assert(record,JSON.stringify({records:ledger.records.map(r=>({turn:r.targetPairIndex,state:r.recordState,reason:r.divergenceReason,basis:r.sourceRevisionBasis})),status:h.hayaku.getSourceEditSyncStatus()}));
   const basis=record.sourceRevisionBasis;
   h.chat.message[3].data=body+'\n<!-- other plugin bookkeeping -->\n<lb-xnai>{{inlay::illustration}}</lb-xnai>';
   c=await current();assert.equal(c.snapshot.conversationPairs.at(-1).assistantVisibleHash,pair.assistantVisibleHash);
   await t.reconcileObservedChatTopology(c.scope,c.snapshot,'basis_metadata',{prompt:false});
   ledger=await t.loadStorageLedger(c.scope);record=ledger.records.find(r=>r.targetPairIndex===2&&r.recordState==='active');assert.equal(record.sourceRevisionBasis,basis);
   units=(await t.hayakuSourceEditSnapshot(c.scope,c.snapshot,ledger)).units;assert.equal(units.find(u=>u.key==='2').changed,false);
   h.chat.message[1].data=hiddenPacketMessage('Alice locked the door.',p1);
   c=await current();units=(await t.hayakuSourceEditSnapshot(c.scope,c.snapshot,ledger)).units;assert.equal(units.find(u=>u.key==='2').changed,true,'later real changes still invalidate the old basis');
  }
  assert.equal(h.llmCalls.length,0);
 }finally{await h.dispose();}
}
(async()=>{await scenario();await scenario(true);console.log('PASS regular generation prefix provenance, durable readback, known presentation carriers, real later/mid-generation changes');})().catch(e=>{console.error(e);process.exitCode=1;});
