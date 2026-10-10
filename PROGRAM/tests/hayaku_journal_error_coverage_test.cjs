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
  const consent=t.getHayakuSourceEdits(),originalSet=h.pluginStorage.setItem;
  h.pluginStorage.setItem=async(key,value)=>String(key).includes('source-edit.')?false:originalSet.call(h.pluginStorage,key,value);
  const unit={key:'1',start:1,end:1,digest:'fixture',sourceDigest:'fixture',current:true,changed:false,changeKind:'response_variant',oldPacketHashes:[]};
  try{await consent.inspect({scopeKey:scope.key,units:[unit]},{phase:"before",prompt:false});}catch(_){}
  const journalError=consent.status().error;
  assert.match(journalError,/^SOURCE_EDIT_JOURNAL_(WRITE_REJECTED|READBACK_FAILED)$/);
  assert.equal(consent.canWrite(scope.key,1,'fixture'),false,'failed persistence must not grant write permission');
  assert.equal(t.hayakuSourceEditRejectsPacket(scope,1,record.hash),false,'settled variant packet remains readable');
  const filtered=t.filterHayakuEditedSnapshot(snapshot,scope);
  assert.ok(filtered.conversationPairs[0].packetHashes.includes(record.hash));
  const worldline=t.reconcileTurnWorldline(ledger.worldline,filtered,scope);
  const bound=t.bindStorageLedgerToSnapshot({...ledger,worldline},filtered,worldline).ledger;
  const coverage=t.exactHayakuTurnCoverage(filtered,bound,scope.key);
  assert.equal(coverage.rows[0].state,'covered');
  assert.equal(coverage.sourceEditError,journalError);
  assert.equal(t.viewerContinuityModel(bound,coverage).rows[0].state,'ok');
  assert.equal(t.filterHayakuSourceEditTransport([{hash:record.hash}],scope).length,1);
  try{await consent.inspect({scopeKey:scope.key,units:[{...unit,digest:'edited',sourceDigest:'edited',changed:true,current:false,changeKind:'source_changed',oldPacketHashes:[record.hash]}]},{phase:"before",prompt:false});}catch(_){}
  assert.equal(t.hayakuSourceEditRejectsPacket(scope,1,'unapproved-new-packet'),true);
  assert.equal(t.hayakuSourceEditRejectsPacket(scope,1,record.hash),false,'preserve old packet while edit awaits consent');
  assert.equal(h.llmCalls.length,0);
  console.log('PASS journal write rejection preserves verified packet, binding, coverage and transport; unapproved replacement stays blocked; no model calls');
 } finally {await h.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
