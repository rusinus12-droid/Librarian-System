'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });
const groundedEnvelope = (packet, quote) => {
  packet.entity.characters = packet.entity.characters.map(row => ({ name: row.name }));
  packet.planner.continuity_locks = [quote];
  const grounding = [];
  const walk = (value, base) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item != null && (typeof item !== 'string' || item.trim())) {
          grounding.push({ path: `${base}[${index}]`, source: 'target', evidence: [quote] });
        }
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, nested]) => walk(nested, base ? `${base}.${key}` : key));
  };
  for (const axis of ['entity', 'world', 'narrative', 'planner']) walk(packet[axis], axis);
  grounding.push({ path: 'meta.summary_memory.summary', source: 'target', evidence: [quote] });
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding };
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await wait(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const initialMessages = () => [
  user('u1', 'I enter the workshop.'),
  assistant('a1', hiddenPacketMessage('Alice entered the workshop.', createValidPacket({
    turn: 1, subject: 'Alice', scene: 'workshop', summary: 'Alice entered the workshop.'
  }))),
  user('u2', 'I open the copper cabinet.'),
  assistant('a2', hiddenPacketMessage('Alice opened the copper cabinet and found a silver key.', createValidPacket({
    turn: 2, subject: 'Alice', scene: 'workshop', summary: 'Alice opened the copper cabinet and found a silver key.'
  })))
];

(async () => {
  const runtime = await createHayakuRuntime({ autoRepair: false, messages: initialMessages() });
  try {
    runtime.setLlmResponder(async () => {
      const quote = 'Alice opened the copper cabinet and found a silver key.';
      const packet = createValidPacket({
        turn: 2,
        subject: 'Alice',
        scene: 'workshop',
        summary: quote
      });
      return { type: 'success', result: JSON.stringify(groundedEnvelope(packet, quote)) };
    });

    const result = await runtime.hayaku.recovery.regenerateTurns({ targetTurns: [2] });
    assert.equal(result.ok, true);
    assert.equal(result.regenerated, 1);
    assert.equal(runtime.llmCalls.length, 1, 'one targeted turn must make one Other Ax call');
    assert.equal(runtime.llmCalls[0].mode, 'otherAx');
    assert.equal(runtime.llmCalls[0].allowPlugins, true);
    assert.equal(runtime.fetchCalls.length, 0, 'targeted regeneration must not call nativeFetch/provider code');

    const ledger = await runtime.hayaku.ledger.inspect({ includeRecords: true });
    const turn2 = ledger.records.filter(row => Number(row.targetPairIndex || 0) === 2);
    const oldCurrent = turn2.find(row => row.packetType === 'current_snapshot');
    const replacement = turn2.find(row => row.packetType === 'recovery_snapshot' && row.recordState === 'active');
    assert.ok(oldCurrent, 'existing current packet must still be auditable');
    assert.equal(oldCurrent.recordState, 'tombstoned', 'existing packet must be explicitly replaced, not silently overwritten');
    assert.ok(replacement, 'regenerated packet must be active');
    assert.ok(String(replacement.raw || '').includes('silver key'));
    assert.ok(Array.isArray(result.results?.[0]?.replacementRecordIds) && result.results[0].replacementRecordIds.includes(oldCurrent.recordId));

  } finally {
    await runtime.dispose();
  }

  // A single legacy/recovery record may cover a multi-turn range. Rebuilding
  // that record must analyze every covered turn first, then atomically tombstone
  // the one old range record only after all replacement packets validate.
  const rangeRuntime = await createHayakuRuntime({ autoRepair: false, messages: initialMessages() });
  try {
    let ledger = await rangeRuntime.hayaku.ledger.inspect({ includeRecords: true });
    const scopeKey = ledger.scopeKey;
    const rangePacket = createValidPacket({
      turn: 2,
      packetType: 'recovery_snapshot',
      subject: 'Alice',
      scene: 'workshop',
      summary: 'Legacy range packet covering the first two turns.'
    });
    rangePacket.meta.source_turn_range = { start: 1, end: 2 };
    rangePacket.meta.source_turn_index = 2;
    const rangeBody = JSON.stringify(rangePacket);
    const seeded = await rangeRuntime.hayaku._test.adoptBridgeIncrementalRecoveryCapsule({
      schema: 'memory-session-bridge-hayaku-incremental-recovery-v1',
      scopeKey,
      recoveryId: 'range-regeneration-seed',
      runId: 'range-regeneration-seed',
      sourceHash: 'h64-range-regeneration-seed',
      packetCount: 1,
      createdAt: Date.now(),
      packets: [{
        ordinal: 1,
        startTurn: 1,
        endTurn: 2,
        targetPairIndex: 2,
        chunkHash: 'h64-range-regeneration-chunk',
        body: rangeBody
      }]
    });
    assert.equal(seeded.ok, true);
    ledger = await rangeRuntime.hayaku.ledger.inspect({ includeRecords: true });
    const oldRange = ledger.records.find(row => row.incrementalRecoveryRunId === 'range-regeneration-seed');
    assert.ok(oldRange, 'seeded multi-turn range record must be durable before regeneration');

    rangeRuntime.setLlmResponder(async (_options, callNumber) => {
      const quote = callNumber === 1
        ? 'Alice entered the workshop.'
        : 'Alice opened the copper cabinet and found a silver key.';
      const packet = createValidPacket({
        turn: callNumber,
        packetType: 'recovery_snapshot',
        subject: 'Alice',
        scene: 'workshop',
        summary: quote
      });
      return { type: 'success', result: JSON.stringify(groundedEnvelope(packet, quote)) };
    });
    const replaced = await rangeRuntime.hayaku.recovery.regenerateTurns({
      targetTurns: [1, 2],
      replacementRecordIds: [oldRange.recordId],
      replaceExisting: true
    });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.regenerated, 2);
    assert.equal(replaced.awaitingChoice, true);
    assert.equal(replaced.replacedRecords, 0);
    assert.equal(rangeRuntime.llmCalls.length, 2, 'a two-turn range replacement must make one Other Ax call per target turn');

    ledger = await rangeRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.equal(ledger.records.find(row => row.recordId === oldRange.recordId)?.recordState, 'active', 'range candidate must be staged without changing the old range');
    const rangeAdopted = await rangeRuntime.hayaku.recovery.resolveRegenerationChoice('adopt_regenerated', { runId: replaced.runId });
    assert.equal(rangeAdopted.ok, true);
    assert.equal(rangeAdopted.replacedRecords, 1);
    ledger = await rangeRuntime.hayaku.ledger.inspect({ includeRecords: true });
    const oldAfter = ledger.records.find(row => row.recordId === oldRange.recordId);
    assert.equal(oldAfter?.recordState, 'tombstoned', 'old range record must be tombstoned only after atomic adoption');
    const activeReplacementTurns = ledger.records
      .filter(row => row.packetType === 'recovery_snapshot' && row.recordState === 'active' && row.incrementalRecoveryRunId !== 'range-regeneration-seed')
      .map(row => Number(row.targetPairIndex || 0))
      .filter(Boolean)
      .sort((a, b) => a - b);
    assert.equal(activeReplacementTurns.join(','), '1,2', 'atomic replacement must materialize one verified packet for each covered turn');
    const regeneratedRecords = ledger.records.filter(row => row.packetType === 'recovery_snapshot' && row.recordState === 'active' && row.incrementalRecoveryRunId !== 'range-regeneration-seed');
    const oldSelected = await rangeRuntime.hayaku.ledger.selectVariant({ recordId: oldRange.recordId });
    assert.equal(oldSelected.ok, true, 'the tombstoned range packet must be selectable again');
    ledger = await rangeRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.equal(ledger.records.find(row => row.recordId === oldRange.recordId)?.recordState, 'active');
    assert.ok(regeneratedRecords.every(row => ledger.records.find(item => item.recordId === row.recordId)?.recordState === 'tombstoned'));
    const regeneratedSelected = await rangeRuntime.hayaku.ledger.selectVariant({ recordId: regeneratedRecords[0].recordId });
    assert.equal(regeneratedSelected.ok, true, 'selecting one packet from a regeneration set must atomically restore the whole set');
    assert.equal(regeneratedSelected.selectedRecordIds.length, 2);
    ledger = await rangeRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.equal(ledger.records.find(row => row.recordId === oldRange.recordId)?.recordState, 'tombstoned');
    assert.ok(regeneratedRecords.every(row => ledger.records.find(item => item.recordId === row.recordId)?.recordState === 'active'));
    const recordIdsBeforeDecline = ledger.records.map(row => row.recordId).sort();
    rangeRuntime.setLlmResponder(async () => {
      const quote = 'Alice entered the workshop.';
      const packet = createValidPacket({ turn: 1, packetType: 'recovery_snapshot', subject: 'Alice', scene: 'workshop', summary: quote });
      return { type: 'success', result: JSON.stringify(groundedEnvelope(packet, quote)) };
    });
    const declinedCandidate = await rangeRuntime.hayaku.recovery.regenerateTurns({
      targetTurns: [1],
      replacementRecordIds: [regeneratedRecords.find(row => Number(row.targetPairIndex || 0) === 1).recordId],
      replaceExisting: true
    });
    assert.equal(declinedCandidate.awaitingChoice, true);
    const kept = await rangeRuntime.hayaku.recovery.resolveRegenerationChoice('keep_original', { runId: declinedCandidate.runId });
    assert.equal(kept.ok, true);
    assert.equal(kept.keptOriginal, true);
    ledger = await rangeRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.equal(ledger.records.find(row => row.recordId === regeneratedRecords.find(item => Number(item.targetPairIndex || 0) === 1).recordId)?.recordState, 'active', 'keep_original must leave the ledger unchanged');
    assert.deepEqual(ledger.records.map(row => row.recordId).sort(), recordIdsBeforeDecline, 'keep_original must not add a staged candidate to the ledger');
  } finally {
    await rangeRuntime.dispose();
  }

  // A current-chat Cold Start packet is historical but not permanent session
  // history. The old RE:TRACE viewer allowed regenerating it, so native HAYAKU
  // must keep that ability while continuing to protect inherited/permanent data.
  const coldRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the workshop.'),
      assistant('a1', 'Alice entered the workshop.'),
      user('u2', 'I open the copper cabinet.'),
      assistant('a2', 'Alice opened the cabinet.')
    ]
  });
  try {
    coldRuntime.setLlmResponder(async (_options, callNumber) => ({
      type: 'success',
      result: JSON.stringify(groundedEnvelope(createValidPacket({turn:callNumber,subject:'Alice',scene:'workshop',summary:callNumber===1?'Alice entered the workshop.':'Alice opened the cabinet.'}),callNumber===1?'Alice entered the workshop.':'Alice opened the cabinet.'))
    }));
    const cold = await coldRuntime.hayaku.recovery.coldStart({ resume: true });
    assert.equal(cold.ok, true);
    let ledger = await coldRuntime.hayaku.ledger.inspect({ includeRecords: true });
    const coldRecord = ledger.records.find(row => row.captureSource === 'bridge_cold_start' && Number(coldRuntime.hayaku._test.storageRecordTurnRange(row).turnStart) === 1);
    assert.ok(coldRecord, 'Cold Start must create a regeneratable current-chat historical record');
    const callsBefore = coldRuntime.llmCalls.length;
    coldRuntime.setLlmResponder(async () => {
      const quote = 'Alice entered the workshop.';
      const packet = createValidPacket({ turn: 1, packetType: 'recovery_snapshot', subject: 'Alice', scene: 'workshop', summary: quote });
      return { type: 'success', result: JSON.stringify(groundedEnvelope(packet, quote)) };
    });
    const regeneratedCold = await coldRuntime.hayaku.recovery.regenerateTurns({
      targetTurns: [1],
      replacementRecordIds: [coldRecord.recordId],
      replaceExisting: true
    });
    assert.equal(regeneratedCold.ok, true);
    assert.equal(regeneratedCold.awaitingChoice, true);
    assert.equal(coldRuntime.llmCalls.length - callsBefore, 1);
    ledger = await coldRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.equal(ledger.records.find(row => row.recordId === coldRecord.recordId)?.recordState, 'historical');
    const coldAdopted = await coldRuntime.hayaku.recovery.resolveRegenerationChoice('adopt_regenerated', { runId: regeneratedCold.runId });
    assert.equal(coldAdopted.ok, true);
    ledger = await coldRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.equal(ledger.records.find(row => row.recordId === coldRecord.recordId)?.recordState, 'tombstoned');
    assert.ok(ledger.records.some(row => row.packetType === 'recovery_snapshot' && row.recordState === 'active' && Number(row.targetPairIndex || 0) === 1));
  } finally {
    await coldRuntime.dispose();
  }

  // Soft cancellation waits for the in-flight Other Ax response, then discards
  // it before candidate persistence or ledger adoption.
  const cancelRuntime = await createHayakuRuntime({ autoRepair: false, messages: initialMessages() });
  let releaseCancelledLlm;
  try {
    cancelRuntime.setLlmResponder(async () => await new Promise(resolve => {
      releaseCancelledLlm = () => {
        const quote = 'Alice opened the copper cabinet and found a silver key.';
        const packet = createValidPacket({ turn: 2, packetType: 'recovery_snapshot', subject: 'Alice', scene: 'workshop', summary: quote });
        resolve({ type: 'success', result: JSON.stringify(groundedEnvelope(packet, quote)) });
      };
    }));
    const pendingCancelled = cancelRuntime.hayaku.recovery.regenerateTurns({ targetTurns: [2] });
    await waitFor(() => cancelRuntime.llmCalls.length === 1 && typeof releaseCancelledLlm === 'function', 'cancellable Other Ax call');
    assert.equal(cancelRuntime.hayaku.recovery.cancelJob(), true);
    releaseCancelledLlm();
    const cancelled = await pendingCancelled;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.reason, 'native_regeneration_cancelled');
    const ledger = await cancelRuntime.hayaku.ledger.inspect({ includeRecords: true });
    assert.equal(ledger.records.some(row => row.packetType === 'recovery_snapshot' && Number(row.targetPairIndex || 0) === 2), false);
  } finally {
    await cancelRuntime.dispose();
  }

  // Reroll while Other Ax is in flight: the stale result must never replace the
  // newly active Assistant variant.
  const raceRuntime = await createHayakuRuntime({ autoRepair: false, messages: initialMessages() });
  let releaseLlm;
  try {
    raceRuntime.setLlmResponder(async () => await new Promise(resolve => {
      releaseLlm = () => {
        const quote = 'Alice opened the copper cabinet and found a silver key.';
        const packet = createValidPacket({
          turn: 2,
          subject: 'Alice',
          scene: 'workshop',
          summary: quote
        });
        resolve({ type: 'success', result: JSON.stringify(groundedEnvelope(packet, quote)) });
      };
    }));

    const pending = raceRuntime.hayaku.recovery.regenerateTurns({ targetTurns: [2] });
    await waitFor(() => raceRuntime.llmCalls.length === 1 && typeof releaseLlm === 'function', 'targeted Other Ax call');
    const concurrent = await raceRuntime.hayaku.recovery.regenerateTurns({ targetTurns: [2] });
    assert.equal(concurrent.ok, false);
    assert.equal(concurrent.skipped, true);
    assert.equal(concurrent.reason, 'native_recovery_busy', 'targeted regeneration must serialize with the native repair worker');
    assert.equal(raceRuntime.llmCalls.length, 1, 'busy rejection must not start a duplicate Other Ax call');

    raceRuntime.setMessages([
      user('u1', 'I enter the workshop.'),
      assistant('a1', hiddenPacketMessage('Alice entered the workshop.', createValidPacket({
        turn: 1, subject: 'Alice', scene: 'workshop', summary: 'Alice entered the workshop.'
      }))),
      user('u2', 'I open the copper cabinet.'),
      assistant('a2-reroll', hiddenPacketMessage('Alice left the cabinet closed and walked away.', createValidPacket({
        turn: 2, subject: 'Alice', scene: 'workshop', summary: 'Alice left the cabinet closed and walked away.'
      })))
    ]);
    releaseLlm();
    const raced = await pending;
    assert.equal(raced.ok, false);
    assert.equal(Number(raced.failedTurn), 2);
    assert.equal(raced.reason, 'target_changed_before_adoption');

    const ledger = await raceRuntime.hayaku.ledger.inspect({ includeRecords: true });
    const staleRecovery = ledger.records.filter(row => (
      row.packetType === 'recovery_snapshot'
      && row.recordState === 'active'
      && Number(row.targetPairIndex || 0) === 2
    ));
    assert.equal(staleRecovery.length, 0, 'stale branch result must not be adopted after reroll');
    console.log('PASS hayaku_native_targeted_regeneration_runtime_test');
  } finally {
    await raceRuntime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
