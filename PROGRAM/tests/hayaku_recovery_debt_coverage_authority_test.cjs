'use strict';
// P0-E contract: the authority that decides "is this turn still owed a repair?"
// must be exact coverage ALONE, in both the inspect and the lease step.
//
// Regression being locked down: a turn whose packet hash exists but is invalid /
// unbound is exact-missing. Before the fix, inspect materialized a durable debt
// (coverage-aware) and the very next lease reconcile discharged it again using
// loose packet-hash presence, so a manual repair reported
//   0/N, stage lease_acquire, reason recovery_debt_not_active
// with zero model calls.
//
// Asserted here:
//   1. invalid/stale packet presence with exact missing coverage retains the debt
//      and an active lease; a coverage-less reconcile records any withheld discharge
//   2. valid exact packet coverage discharges the debt without a model call
//   3. four selected missing turns materialize and execute four selected repairs
//   4. source mutation after scan stops selected repair with stale diagnostics and
//      zero model calls
const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });

const createNativeRepairEnvelope = (packet, quote) => {
  const grounding = [];
  const walk = (value, base) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item != null && (typeof item !== 'string' || item.trim())) grounding.push({ path: `${base}[${index}]`, source: 'target', evidence: [quote] });
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, nested]) => walk(nested, base ? `${base}.${key}` : key));
  };
  for (const axis of ['entity', 'world', 'narrative', 'planner']) walk(packet[axis], axis);
  if (packet.meta?.summary_memory?.summary) grounding.push({ path: 'meta.summary_memory.summary', source: 'target', evidence: [quote] });
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding };
};

const invalidPacket = () => ({ meta: { schema: 'broken' }, entity: [], world: 'invalid', narrative: 0, planner: null });

const selectedBatchMessages = count => {
  const rows = [];
  for (let turn = 1; turn <= count; turn += 1) {
    const visible = `Assistant turn ${turn}.`;
    rows.push(user(`u${turn}`, `User turn ${turn}.`));
    rows.push(assistant(`a${turn}`, turn === 1
      ? hiddenPacketMessage(visible, createValidPacket({ turn, subject: 'Alice', summary: visible }))
      : visible));
  }
  return rows;
};


(async () => {
  // Turn 1 is properly covered. Turn 2 carries a hidden packet that is present
  // (so a hash exists) but structurally invalid, which is exactly the
  // packet_format_or_content_invalid shape the handoff calls out.
  const goodPacket = createValidPacket({ turn: 1, subject: 'Alice', scene: 'library', summary: 'Alice entered the library.' });
  const brokenPacket = invalidPacket();

  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the library.'),
      assistant('a1', hiddenPacketMessage('Alice entered the library.', goodPacket)),
      user('u2', 'I take the silver key.'),
      assistant('a2', hiddenPacketMessage('Alice took the key.', brokenPacket))
    ],
    llmResponder: async () => { throw new Error('no model call expected in this contract test'); }
  });

  try {
    const t = runtime.hayaku._test;

    // The durable debt is created by the coverage scan; inspection alone only reads existing vault state.
    const scan = await t.scanCurrentChatForNativeRecoveryDebts({ reason: 'fixture', manualFullScan: true });
    assert.equal(scan.ok, true, `coverage scan failed: ${scan.reason || ''}`);
    const inspection = await t.inspectRecoveryDebtsForNativeRepair({ includeEvidence: true, limit: 16 });
    assert.equal(inspection.available, true, `debt inspection unavailable: ${inspection.reason || ''}`);
    const debts = Array.from(inspection.debts || []);
    assert.ok(debts.length, `coverage scan did not materialize an active debt: ${inspection.reason || ''}`);

    assert.equal(inspection.coverage.rows.find(row => row.turn === 2)?.state, 'missing');
    assert.equal(inspection.coverage.rows.find(row => row.turn === 2)?.reason, 'packet_format_or_content_invalid');
    const debt = debts[0];
    assert.ok(debt.debtId || debt.recordId, 'the debt carries an id');
    const debtId = debt.debtId || debt.recordId;
    const scope = await t.currentChatScope();
    const snapshot = t.authoritativeChatSnapshot(scope.chatMessages, scope);
    const ledger = await t.loadStorageLedger(scope, { hydrateArchive: false, authoritativeSnapshot: snapshot });
    const worldline = t.reconcileTurnWorldline(ledger.worldline, snapshot, scope);

    // ---- acquire a lease, then reconcile WITHOUT coverage ----
    const lease = await t.acquireRecoveryDebtLeaseForNativeRepair({
      debtId,
      runId: 'p0e-contract-run',
      scopeKey: inspection.scopeKey || debt.scopeKey || ''
    });
    assert.equal(lease.acquired, true, JSON.stringify(lease));
    const staleSnapshot = JSON.parse(JSON.stringify(snapshot));
    const stalePair = staleSnapshot.conversationPairs.find(pair => Number(pair.pairIndex) === 2);
    stalePair.packetHashes = ['stale-packet-hash'];
    const loose = await t.reconcileRecoveryVaultWorldlineLifecycleDirect(
      scope, staleSnapshot, worldline, { force: true, reason: 'p0e_contract_no_coverage' }
    );
    const retained = Array.from(loose.vault?.records || []).find(record => record.recordId === debtId);
    assert.ok(retained, 'a coverage-less reconcile must retain the materialized debt');
    assert.equal(retained.repairLease?.leaseId, lease.lease?.leaseId, 'a coverage-less reconcile must retain the active lease');
    assert.ok(loose.dischargeAudit?.some(row => row.recordId === debtId && row.withheld === 'coverage_absent_loose_packet_presence'),
      'the old loose packet-presence discharge must be recorded as withheld');
    assert.equal(runtime.llmCalls.length, 0, 'no model call may happen while establishing or reconciling a lease');
  } finally {
    await runtime.dispose();
  }

  // ---- a valid exact packet coverage may discharge the debt ----
  const dischargeRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the library.'),
      assistant('a1', hiddenPacketMessage('Alice entered the library.', createValidPacket({ turn: 1, subject: 'Alice', scene: 'library', summary: 'Alice entered the library.' }))),
      user('u2', 'I take the silver key.'),
      assistant('a2', hiddenPacketMessage('Alice took the key.', invalidPacket()))
    ],
    llmResponder: async () => { throw new Error('no model call expected while exact coverage discharges'); }
  });
  try {
    const t = dischargeRuntime.hayaku._test;
    await t.scanCurrentChatForNativeRecoveryDebts({ reason: 'valid_coverage_fixture', manualFullScan: true });
    const before = await t.inspectRecoveryDebtsForNativeRepair({ limit: 8 });
    assert.ok(before.debts.some(debt => Number(debt.pairIndex) === 2));
    dischargeRuntime.setMessages([
      user('u1', 'I enter the library.'),
      assistant('a1', hiddenPacketMessage('Alice entered the library.', createValidPacket({ turn: 1, subject: 'Alice', scene: 'library', summary: 'Alice entered the library.' }))),
      user('u2', 'I take the silver key.'),
      assistant('a2', hiddenPacketMessage('Alice took the key.', createValidPacket({ turn: 2, subject: 'Alice', scene: 'library', summary: 'Alice took the key.' })))
    ]);
    const after = await t.inspectRecoveryDebtsForNativeRepair({ limit: 8 });
    assert.equal(after.coverage.rows.find(row => row.turn === 2)?.state, 'covered');
    assert.ok(['verified_stored_packet', 'validated_live_packet'].includes(after.coverage.rows.find(row => row.turn === 2)?.reason));
    assert.equal(after.debts.some(debt => Number(debt.pairIndex) === 2), false, 'valid exact coverage discharges the debt');
    assert.equal(dischargeRuntime.llmCalls.length, 0);
  } finally {
    await dischargeRuntime.dispose();
  }

  // ---- four selected missing turns are materialized and repaired exactly once ----
  const repairQueue = [];
  for (let turn = 2; turn <= 5; turn += 1) {
    const quote = `Assistant turn ${turn}.`;
    repairQueue.push(createNativeRepairEnvelope(
      createValidPacket({ turn, subject: 'Alice', scene: 'library', summary: quote }), quote
    ));
  }
  const batchRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: selectedBatchMessages(5),
    llmResponder: async () => {
      const envelope = repairQueue.shift();
      return { type: 'success', result: JSON.stringify(envelope) };
    }
  });
  try {
    const t = batchRuntime.hayaku._test;
    const scan = await t.scanCurrentChatForNativeRecoveryDebts({ reason: 'selected_batch_fixture', manualFullScan: true });
    assert.deepEqual(Array.from(scan.coverage.missingTurns), [2, 3, 4, 5]);
    const inspection = await t.inspectRecoveryDebtsForNativeRepair({ limit: 16 });
    assert.equal(inspection.debts.length, 4);
    const result = await t.runNativeMissingTurnBatch({
      scopeKey: inspection.scopeKey,
      targetTurns: [2, 3, 4, 5],
      rows: inspection.coverage.rows.filter(row => row.turn >= 2)
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.completed, 4);
    assert.equal(result.physicalCalls, 4);
    assert.equal(result.llmCalled, true);
    assert.equal(batchRuntime.llmCalls.length, 4);
    assert.ok(result.results.every(row => row.ok === true && row.repaired === true));
    const after = await t.inspectRecoveryDebtsForNativeRepair({ limit: 16 });
    assert.deepEqual(Array.from(after.coverage.missingTurns), []);
    assert.equal(after.debts.length, 0);
  } finally {
    await batchRuntime.dispose();
  }

  // ---- source mutation after scan stops selected repair before any model call ----
  const staleRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: selectedBatchMessages(2),
    llmResponder: async () => ({ type: 'success', result: JSON.stringify(createNativeRepairEnvelope(createValidPacket({ turn: 2 }), 'must not run')) })
  });
  try {
    const t = staleRuntime.hayaku._test;
    await t.scanCurrentChatForNativeRecoveryDebts({ reason: 'stale_source_fixture', manualFullScan: true });
    const inspection = await t.inspectRecoveryDebtsForNativeRepair({ limit: 8 });
    const rows = JSON.parse(JSON.stringify(inspection.coverage.rows));
    const changedMessages = selectedBatchMessages(2);
    changedMessages[3].data = 'Changed after the coverage scan.';
    staleRuntime.setMessages(changedMessages);
    const result = await staleRuntime.hayaku.recovery.repairSelected({
      targetTurns: [2], scopeKey: inspection.scopeKey, rows
    });
    assert.equal(result.reason, 'selected_turn_source_changed', JSON.stringify(result));
    assert.equal(result.stage, 'selection_check');
    assert.equal(result.llmCalled, false);
    assert.equal(result.physicalCalls, 0);
    assert.equal(staleRuntime.llmCalls.length, 0);
    assert.ok(result.diagnostic?.sourceComparison);
  } finally {
    await staleRuntime.dispose();
  }

  console.log(JSON.stringify({
    test: 'hayaku_recovery_debt_coverage_authority',
    result: 'pass',
    cases: ['invalid_hash_retains_debt_and_lease', 'valid_exact_coverage_discharges', 'four_selected_repairs', 'stale_source_zero_model_calls']
  }));

})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
