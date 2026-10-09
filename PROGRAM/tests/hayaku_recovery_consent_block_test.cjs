'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{
 const h=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u0',data:'Hello'},{role:'assistant',chatId:'a0',data:hiddenPacketMessage('Alice waits.',createValidPacket({turn:1,subject:'Alice',summary:'Alice waits.'}))},{role:'user',chatId:'u1',data:'Where is Alice?'},{role:'assistant',chatId:'a1',data:'Alice is in the office.'}]});
 try {
  const t=h.hayaku._test,scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope);
  await t.reconcileObservedChatTopology(scope,snapshot,'consent_block_fixture',{prompt:false});
  const ledger=await t.loadStorageLedger(scope),c=t.getHayakuSourceEdits(),set=h.pluginStorage.setItem;
  await t.scanCurrentChatForNativeRecoveryDebts({scope,manualFullScan:true,reason:'lease_fixture'});
  const inspection=await t.inspectRecoveryDebtsForNativeRepair({targetPairIndex:2,limit:1});
  const debt=inspection.debts[0];assert.ok(debt);
  h.pluginStorage.setItem=async(k,v)=>String(k).includes('source-edit.')?false:set.call(h.pluginStorage,k,v);
  try{await c.inspect({scopeKey:scope.key,units:[{key:'99',start:99,end:99,digest:'changed',changed:true}]},{phase:"before",prompt:false});}catch(_){}
  const coverage=t.recoveryCoverageProjection({snapshot,ledger});
  assert.equal(coverage.rows[1].state,'missing');
  assert.equal(coverage.rows[1].recoveryExecutable,false);
  assert.match(coverage.rows[1].recoveryBlockedReason,/SOURCE_EDIT_JOURNAL_/);
  assert.equal(coverage.recoverableDebtCount,0);
  for(let i=0;i<2;i++)await assert.rejects(t.assertHayakuSourceEditConsent(scope.key,2),/SOURCE_EDIT_JOURNAL_(READBACK_FAILED|WRITE_REJECTED)/);
  const result=await t.runNativeMissingTurnBatch({scopeKey:scope.key,targetTurns:[2]});
  assert.equal(result.suspended,true);
  assert.equal(result.failed,0);
  assert.equal(result.memoryOutcome,'suspended');
  assert.equal(result.physicalCalls,0);
  assert.equal(h.llmCalls.length,0);
  const leaseResult=await t.executeNativeRepairDebt(debt,{explicitRetry:true});
  assert.equal(leaseResult.suspended,true);
  const vault=await t.loadRecoveryVault(scope.key,{force:true});
  const retained=vault.records.find(r=>r.recordId===debt.debtId);
  assert.equal(retained.repairAttempts,0);
  assert.equal(retained.nextRepairAt,0);
  assert.ok(!retained.repairLease);
  assert.equal(t.hayakuRecoveryBlocked('SOURCE_EDIT_CONSENT_REQUIRED'),true);
  assert.equal(t.hayakuRecoveryBlocked('selected_turn_source_changed'),true);
  assert.equal(t.hayakuRecoveryBlocked('HAYAKU_NATIVE_LLM_EMPTY'),false);
  console.log('PASS missing fact retained, execution blocked, journal cause stable, manual batch suspended with zero failures/model calls');
 } finally {await h.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
