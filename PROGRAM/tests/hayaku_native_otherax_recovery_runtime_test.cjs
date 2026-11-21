'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });
const messagesWithMissingTurn2 = () => {
  const packet = createValidPacket({
    turn: 1,
    subject: 'Alice',
    scene: 'workshop',
    summary: 'Alice entered the workshop.'
  });
  return [
    user('u1', 'I enter the workshop.'),
    assistant('a1', hiddenPacketMessage('Alice entered the workshop.', packet)),
    user('u2', 'I turn the brass valve.'),
    assistant('a2', 'Alice turned the brass valve and steam began flowing through the blue pipe.')
  ];
};

const groundedRecoveryEnvelope = summary => {
  const packet = createValidPacket({ turn: 2, subject: 'Alice', scene: 'workshop', summary });
  packet.entity.characters = [{ name: 'Alice' }];
  packet.planner.continuity_locks = [summary];
  const grounding = [];
  const walk = (value, base) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item != null && (typeof item !== 'string' || item.trim())) grounding.push({ path: `${base}[${index}]`, source: 'target', evidence: [summary] });
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, nested]) => walk(nested, base ? `${base}.${key}` : key));
  };
  for (const axis of ['entity', 'world', 'narrative', 'planner']) walk(packet[axis], axis);
  grounding.push({ path: 'meta.summary_memory.summary', source: 'target', evidence: [summary] });
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding };
};

const assertOtherAxCalls = runtime => {
  for (const call of runtime.llmCalls) {
    assert.equal(call.mode, 'otherAx');
    assert.equal(call.allowPlugins, true);
    assert.equal(Object.prototype.hasOwnProperty.call(call, 'staticModel'), false);
    assert.ok(Array.isArray(call.messages) && call.messages.length >= 2);
  }
  assert.equal(runtime.fetchCalls.length, 0);
};

(async () => {
  const successRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: messagesWithMissingTurn2()
  });

  try {
    successRuntime.setLlmResponder(async () => ({
      type: 'success',
      result: 'Result:\n' + JSON.stringify(groundedRecoveryEnvelope('Alice turned the brass valve and steam began flowing through the blue pipe.'))
    }));

    const repaired = await successRuntime.hayaku.recovery.repairNow({ reason: 'runtime_success_test' });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.repaired, true);
    assert.equal(successRuntime.llmCalls.length, 1, 'each approved background repair gets exactly one physical Other Ax call');
    assertOtherAxCalls(successRuntime);
    const ledger = await successRuntime.hayaku.ledger.inspect({ includeRecords: true });
    const recovered = ledger.records.find(record => (
      record.packetType === 'recovery_snapshot'
      && record.recordState === 'active'
      && Number(record.targetPairIndex || 0) === 2
      && record.captureSource === 'bridge_incremental_recovery'
    ));
    assert.ok(recovered, 'explicitly accepted canonical preview must be durably adopted into the exact missing turn');

    const after = await successRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: true, limit: 8 });
    assert.equal(Array.from(after.debts || []).length, 0, 'verified durable repair must discharge Recovery Vault debt');
  } finally {
    await successRuntime.dispose();
  }

  const failureRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: messagesWithMissingTurn2(),
    llmResponder: async () => ({ type: 'success', result: 'still-not-json' })
  });

  try {
    const failure = await failureRuntime.hayaku.recovery.repairNow({ reason: 'runtime_failure_test' });
    assert.equal(failure.ok, false);
    assert.equal(failure.awaitingUserReview, false, 'a new validation failure is not a retired review workflow');
    assert.equal(failure.failureId, '', 'default diagnostics do not persist full failed responses');
    const summaries = await failureRuntime.hayaku.recovery.failedAnalysis.summaries();
    assert.ok(summaries.some(row => row.turn === 2 && row.physicalCalls === 1), 'a source-free failure summary retains the observed call count');
    assert.equal(failureRuntime.llmCalls.length, 1);
    assertOtherAxCalls(failureRuntime);

    const ledger = await failureRuntime.hayaku.ledger.inspect({ includeRecords: true });
    const activeRecovery = ledger.records.filter(record => (
      record.packetType === 'recovery_snapshot'
      && record.recordState === 'active'
      && Number(record.targetPairIndex || 0) === 2
    ));
    assert.equal(activeRecovery.length, 0, 'failed analysis must not create a raw/skeleton recovery packet');

    const debtState = await failureRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({
      includeEvidence: true,
      limit: 8
    });
    assert.equal(debtState.totalActiveDebts, 1, 'failed debt must remain active during review');
    assert.equal(debtState.reason, 'packet_debt_available');
    assert.deepEqual(Array.from(debtState.awaitingReviewTurns || []), []);
    assert.equal(Number(debtState.nextRetryAt || 0), 0, 'review-pending debt must not schedule another automatic provider call');

    const vault = await failureRuntime.hayaku._test.loadRecoveryVault(debtState.scopeKey, { force: true });
    const debt = Array.from(vault.records || []).find(row => Number(row.pairIndex || 0) === 2);
    assert.ok(debt, 'exact U+A evidence must remain in Recovery Vault after failed analysis');
    assert.ok(String(debt.user?.text || '').includes('brass valve'));
    assert.ok(String(debt.assistant?.text || '').includes('steam began flowing'));
    assert.equal(Number(debt.repairAttempts || 0), 0, 'user review is not counted as an automatic retry failure');
    assert.equal(Number(debt.nextRepairAt || 0), 0);

    const callsBeforeStatusRefresh = failureRuntime.llmCalls.length;
    const recoveryStatus = await failureRuntime.hayaku.recovery.status({ includeDebts: true, refreshDebts: true });
    assert.equal(recoveryStatus.repairRun.available, true);
    assert.equal(recoveryStatus.repairRun.run.state, 'failed');
    assert.ok(recoveryStatus.lastError || recoveryStatus.repairRun.run.error);
    assert.equal(failureRuntime.llmCalls.length, callsBeforeStatusRefresh, 'status refresh must not call runLLMModel');
    assert.equal(recoveryStatus.debt.coverage.mode, 'incremental_missing');
    assert.deepEqual(Array.from(recoveryStatus.debt.coverage.missingTurns || []), [2]);
    assert.deepEqual(Array.from(recoveryStatus.debt.coverage.backoffTurns || []), []);
    assert.deepEqual(Array.from(recoveryStatus.debt.coverage.awaitingReviewTurns || []), []);
    assert.deepEqual(Array.from(recoveryStatus.debt.coverage.repairableTurns || []), [2]);
  } finally {
    await failureRuntime.dispose();
  }

  const multiGapRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('gap-u1', 'Covered turn one.'),
      assistant('gap-a1', hiddenPacketMessage('Covered assistant one.', createValidPacket({ turn: 1 }))),
      user('gap-u2', 'Missing turn two.'),
      assistant('gap-a2', 'Missing assistant two.'),
      user('gap-u3', 'Covered turn three.'),
      assistant('gap-a3', hiddenPacketMessage('Covered assistant three.', createValidPacket({ turn: 3 }))),
      user('gap-u4', 'Missing turn four.'),
      assistant('gap-a4', 'Missing assistant four.'),
      user('gap-pending', 'Pending user row.')
    ]
  });
  try {
    const gapStatus = await multiGapRuntime.hayaku.recovery.status({ includeDebts: true, refreshDebts: true });
    assert.equal(multiGapRuntime.llmCalls.length, 0, 'coverage scan must not call runLLMModel');
    assert.equal(gapStatus.debt.coverage.mode, 'incremental_missing');
    assert.equal(gapStatus.debt.coverage.completedTurns, 4);
    assert.deepEqual(Array.from(gapStatus.debt.coverage.transcriptCoveredTurns || []), [1, 3]);
    assert.deepEqual(Array.from(gapStatus.debt.coverage.coveredTurns || []), [1, 3]);
    assert.deepEqual(Array.from(gapStatus.debt.coverage.missingTurns || []), [2, 4]);
    assert.equal(gapStatus.debt.coverage.activeDebtCount, 2);
    assert.equal(gapStatus.debt.coverage.recoverableDebtCount, 2);
    assert.deepEqual(Array.from(gapStatus.debt.coverage.repairableTurns || []), [2, 4]);
  } finally {
    await multiGapRuntime.dispose();
  }

  const coldStartRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('cold-u1', 'First completed user turn.'),
      assistant('cold-a1', 'First completed assistant turn.'),
      user('cold-u2', 'Second completed user turn.'),
      assistant('cold-a2', 'Second completed assistant turn.'),
      user('cold-u3', 'Third completed user turn.'),
      assistant('cold-a3', 'Third completed assistant turn.'),
      user('cold-pending', 'This user row is still pending.')
    ]
  });
  try {
    const coldStatus = await coldStartRuntime.hayaku.recovery.status({ includeDebts: true, refreshDebts: true });
    assert.equal(coldStartRuntime.llmCalls.length, 0, 'Cold Start status must not call runLLMModel');
    assert.equal(coldStatus.debtScan, null, 'recordless sessions must not be materialized as incremental Packet Debt');
    assert.equal(coldStatus.debt.coverage.mode, 'cold_start');
    assert.equal(coldStatus.debt.coverage.completedTurns, 3, 'pending user row must be excluded');
    assert.equal(coldStatus.debt.coverage.activeDebtCount, 0);
    assert.equal(coldStatus.debt.coverage.recoverableDebtCount, 0);
    assert.deepEqual(Array.from(coldStatus.debt.coverage.coldStartTargetTurns || []), [1, 2, 3]);
    assert.deepEqual(Array.from(coldStatus.debt.coverage.missingTurns || []), []);
    assert.equal(coldStartRuntime.hayaku._test.viewerFormatTurnList([1, 2, 3, 5, 7, 8, 9]), '1–3, 5, 7–9');
  } finally {
    await coldStartRuntime.dispose();
  }

  // Tag-filter multi-shard regression: when a missing turn was scanned before and after
  // sourceInputControls tag filter changes, older stale debt shards sharing ownerTurnNodeId
  // must be superseded and manual/incremental recovery must verify against the current live turn.
  const filterShardRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('flt-u1', 'I enter the workshop.'),
      assistant('flt-a1', hiddenPacketMessage('Alice entered the workshop.', createValidPacket({ turn: 1, subject: 'Alice', scene: 'workshop', summary: 'Alice entered the workshop.' }))),
      user('flt-u2', 'I turn the brass valve.'),
      assistant('flt-a2', '◈CG_MARKER◈\nAlice turned the brass valve and steam began flowing through the blue pipe.\n[LBDATA]\nmeta:1\n[/LBDATA]')
    ]
  });
  try {
    // 1. Scan before tag filters are added -> creates initial debt shard with unfiltered assistantHash
    const preFilterStatus = await filterShardRuntime.hayaku.recovery.status({ includeDebts: true, refreshDebts: true });
    assert.deepEqual(Array.from(preFilterStatus.debt.coverage.missingTurns || []), [2]);
    const preVault = await filterShardRuntime.hayaku._test.loadRecoveryVault(preFilterStatus.scopeKey, { force: true });
    const oldDebt = Array.from(preVault.records || []).find(r => Number(r.pairIndex) === 2 && r.worldlineStatus === 'active');
    assert.ok(oldDebt, 'pre-filter debt shard should exist');

    // 2. Add custom tag filter for [LBDATA] and inline pattern for ◈...◈
    // Also inject a pre-existing stale active debt shard with an older createdAt and the same ownerTurnNodeId
    // to simulate an existing vault that already accumulated multiple active shards for the same turn before this fix.
    const staleLegacyShard = {
      ...oldDebt,
      recordId: 'debt:2:h640000000000001',
      assistantHash: 'h640000000000001',
      createdAt: Math.max(1, Number(oldDebt.createdAt || Date.now()) - 100000),
      updatedAt: Math.max(1, Number(oldDebt.updatedAt || Date.now()) - 100000),
      worldlineStatus: 'active',
      status: 'deterministic_fallback'
    };
    await filterShardRuntime.hayaku._test.writeRecoveryVaultDirect(preFilterStatus.scopeKey, {
      ...preVault,
      records: [staleLegacyShard, ...Array.from(preVault.records || [])]
    }, 'inject_legacy_stale_shard');

    await filterShardRuntime.hayaku.setSourceEditRules({
      tagRules: [{ tag: 'LBDATA', enabled: true }],
      inlineRules: [{ open: '◈', close: '◈', enabled: true }]
    });

    // 3. Repair turn 2 after filter changes: must NOT fail with recovery_evidence_live_pair_unavailable
    filterShardRuntime.setLlmResponder(async () => ({
      type: 'success',
      result: 'Result:\n' + JSON.stringify(groundedRecoveryEnvelope('Alice turned the brass valve and steam began flowing through the blue pipe.'))
    }));
    const repairedAfterFilter = await filterShardRuntime.hayaku.recovery.repairSelected({
      targetTurns: [2]
    });
    assert.equal(repairedAfterFilter.ok, true, `expected repair after tag filter change to succeed, got: ${JSON.stringify(repairedAfterFilter)}`);
    assert.equal(repairedAfterFilter.repaired, 1);

    const postVault = await filterShardRuntime.hayaku._test.loadRecoveryVault(preFilterStatus.scopeKey, { force: true });
    const remainingActiveT2 = Array.from(postVault.records || []).filter(r => Number(r.pairIndex) === 2 && r.worldlineStatus === 'active');
    assert.equal(remainingActiveT2.length, 0, 'all stale and current T2 debt shards must be superseded or discharged');
    const postInspect = await filterShardRuntime.hayaku._test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: true, limit: 8 });
    assert.equal(Array.from(postInspect.debts || []).length, 0, 'turn 2 debt must be discharged after tag-filter recovery');
  } finally {
    await filterShardRuntime.dispose();
  }

  console.log('PASS hayaku_native_otherax_recovery_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
