'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{
 const h=await createHayakuRuntime({autoRepair:false,messages:[
  {role:'user',chatId:'u1',data:'Where is Alice?'},
  {role:'assistant',chatId:'a1',data:hiddenPacketMessage('Alice is in the office.',createValidPacket({turn:1,subject:'Alice',summary:'Alice is in the office.'}))}
 ]});
 try {
  const t=h.hayaku._test,scope=await t.currentChatScope();
  const snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope);
  await t.reconcileObservedChatTopology(scope,snapshot,'journal_error_fixture',{prompt:false});
  const ledger=await t.loadStorageLedger(scope),record=ledger.records.find(r=>r.targetPairIndex===1);
  assert.ok(record);
  const before=JSON.stringify(ledger.records),oldEvidence=record.sourceEvidenceRef,oldBytes=h.pluginStorage.values.get(oldEvidence.key);
  h.chat.message[1].data=hiddenPacketMessage('Alice left the office.',createValidPacket({turn:1,subject:'Alice',summary:'Alice is in the office.'}));
  const ticket=await h.hayaku.previewSourceEdits(['1']);assert.equal(ticket.allowed,true,JSON.stringify(ticket));
  const originalSet=h.pluginStorage.setItem;
  h.pluginStorage.setItem=async(key,value)=>String(key).startsWith('hayaku.v2.source-evidence.')?false:originalSet.call(h.pluginStorage,key,value);
  const result=await h.hayaku.applySourceEdits(ticket);assert.equal(result.ok,false);assert.match(result.reason,/SOURCE_EVIDENCE_(WRITE_REJECTED|READBACK_FAILED)/);
  assert.equal(h.llmCalls.length,0,'failed evidence persistence cannot grant a model dispatch or publication permit');
  const after=await t.loadStorageLedger(scope);assert.equal(JSON.stringify(after.records),before,'prior canonical records remain unchanged');
  assert.equal(h.pluginStorage.values.get(oldEvidence.key),oldBytes,'verified historical source evidence stays byte-identical');
  const oldUnit=t.hayakuReviewUnit(scope,snapshot.conversationPairs[0]);
  assert.equal((await t.getHayakuSourceEvidence().get(scope.key,oldUnit,{original:false})).available,true);
  const coverage=t.exactHayakuTurnCoverage(snapshot,after,scope.key);assert.equal(coverage.rows[0].state,'covered');
  assert.equal(t.viewerContinuityModel(after,coverage).rows[0].state,'ok');
  console.log('PASS failed explicit evidence persistence preserves canonical records, prior raw evidence, binding and coverage; no model calls');
 } finally {await h.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
