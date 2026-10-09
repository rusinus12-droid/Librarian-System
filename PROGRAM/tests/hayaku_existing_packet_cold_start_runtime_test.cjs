'use strict';

const assert = require('node:assert/strict');
const {
  createStore,
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const LIVE_T1 = 'LIVE_PACKET_T1_BRASS_KEY';
const COLD_T1 = 'COLD_HISTORY_T1_DUPLICATE';
const COLD_T2 = 'COLD_HISTORY_T2_GREEN_COMET';

const user = turn => ({ role: 'user', chatId: `existing-u${turn}`, id: `existing-u${turn}`, data: `What changed in scene ${turn}?` });
const assistant = (turn, text) => ({ role: 'assistant', chatId: `existing-a${turn}`, id: `existing-a${turn}`, data: text });

const completedTranscript = () => {
  const livePacket = createValidPacket({
    turn: 1,
    subject: 'Alice',
    summary: `Alice kept the brass key on the table. ${LIVE_T1}`
  });
  const liveText = 'Alice kept the brass key on the table.';
  const laterText = 'Bob saw a green comet above the river.';
  return [
    user(1), assistant(1, hiddenPacketMessage(liveText, livePacket)),
    user(2), assistant(2, laterText)
  ];
};

const coldStartResponder = async call => {
  const prompt = Array.isArray(call?.messages)
    ? call.messages.map(message => String(message?.content || '')).join('\n')
    : '';
  const units = Array.from(prompt.matchAll(/\[UNIT ORDINAL (\d+) · TURN (\d+) · ([^\]]+)\]/g), match => ({
    unitOrdinal: Number(match[1]),
    turn: Number(match[2]),
    kind: match[3].trim()
  }));
  const packetFor = turn => {
    const marker = turn === 1 ? COLD_T1 : COLD_T2;
    const summary = turn === 1
      ? `Alice kept the brass key on the table. ${marker}`
      : `Bob saw a green comet above the river. ${marker}`;
    return createValidPacket({ turn, subject: turn === 1 ? 'Alice' : 'Bob', summary });
  };
  const groundingFor = turn => [{
    path: 'world.active_events[0]',
    source: 'target',
    evidence: [turn === 1 ? 'Alice kept the brass key on the table.' : 'Bob saw a green comet above the river.']
  }];
  if (!prompt.includes('[COLD START BATCH ENVELOPE')) {
    const unit = units[0] || { turn: 1 };
    return {
      type: 'success',
      result: JSON.stringify({ schema: 'hayaku.native_repair_output.v1', packet: packetFor(unit.turn), grounding: groundingFor(unit.turn) })
    };
  }
  return {
    type: 'success',
    result: JSON.stringify({
      schema: 'hayaku.native_cold_start_batch_output.v1',
      packets: units.map(unit => ({ unitOrdinal: unit.unitOrdinal, packet: packetFor(unit.turn), grounding: groundingFor(unit.turn) }))
    })
  };
};

(async () => {
  const transcript = completedTranscript();
  const runtime = await createHayakuRuntime({ autoRepair: false, messages: transcript, llmResponder: coldStartResponder });
  try {
    const start = await runtime.hayaku.recovery.coldStart({ resume: true, batchTurns: 5, allowExisting: true });
    assert.equal(start.ok, true, JSON.stringify(start));
    assert.equal(start.packets, 2);

    const request = [
      { role: 'system', content: 'Continue the scene with relevant history.' },
      ...transcript,
      { role: 'user', chatId: 'current-request', id: 'current-request', content: `Recall the brass key, the green comet, and ${COLD_T1}.` }
    ];
    await runtime.callBeforeRequest(request, 'model');
    const diagnostics = runtime.hayaku.lastDebug().lastBeforeRequest;
    assert.equal(diagnostics?.skipped, undefined, 'the real beforeRequest consumer must run');
    const recalledStates = (diagnostics?.viewerRecall?.rows || []).map(row => String(row?.state || ''));
    assert.ok(recalledStates.some(state => state.includes(LIVE_T1)), 'the active inline packet still supplies covered turn 1');
    assert.ok(recalledStates.some(state => state.includes(COLD_T2)), 'the Cold Start record remains available for uncovered turn 2');
    assert.equal(recalledStates.some(state => state.includes(COLD_T1)), false,
      'the historical Cold Start representation must not be selected for turn 1 when its active packet is present');
  } finally {
    await runtime.dispose();
  }

  const inlineOnlyTranscript = completedTranscript();
  const inlineOnlyStorage = createStore();
  const inlineOnlyRuntime = await createHayakuRuntime({
    autoRepair: false,
    messages: inlineOnlyTranscript,
    pluginStorage: inlineOnlyStorage,
    llmResponder: coldStartResponder
  });
  try {
    const beforeStorage = JSON.stringify(Array.from(inlineOnlyStorage.values.entries()));
    const result = await inlineOnlyRuntime.hayaku.recovery.coldStart({ resume: true, batchTurns: 5 });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, 'cold_start_existing_hayaku_memory',
      'direct Cold Start must treat a validated inline packet as existing HAYAKU memory');
    assert.equal(inlineOnlyRuntime.llmCalls.length, 0, 'inline-only existing memory must be rejected before model work');
    assert.equal(JSON.stringify(Array.from(inlineOnlyStorage.values.entries())), beforeStorage,
      'inline-only existing memory rejection must not write storage');
  } finally {
    await inlineOnlyRuntime.dispose();
  }

  const legacyTranscript = completedTranscript();
  const legacyRuntime = await createHayakuRuntime({ autoRepair: false, messages: legacyTranscript, llmResponder: coldStartResponder });
  try {
    const start = await legacyRuntime.hayaku.recovery.coldStart({ resume: true, batchTurns: 5, allowExisting: true });
    assert.equal(start.ok, true, JSON.stringify(start));

    const scope = await legacyRuntime.hayaku._test.currentChatScope();
    const ledger = await legacyRuntime.hayaku._test.loadStorageLedger(scope, { hydrateArchive: false });
    const t1History = ledger.records.find(record => record.captureSource === 'bridge_cold_start'
      && JSON.parse(record.raw)?.meta?.source_turn_range?.start === 1);
    assert.ok(t1History, 'fixture must contain per-turn Cold Start history for turn 1');
    const aggregatePacket = JSON.parse(t1History.raw);
    aggregatePacket.meta.source_turn_range = { start: 1, end: 2 };
    const aggregateRaw = JSON.stringify(aggregatePacket);
    ledger.records = ledger.records.map(record => record.recordId === t1History.recordId
      ? { ...record, raw: aggregateRaw, hash: '' }
      : record);
    const written = await legacyRuntime.hayaku._test.writeStorageLedgerDirect(scope, ledger, 'test_legacy_mixed_cold_range', { preserveExactRecords: true });
    assert.equal(written.durable, true, JSON.stringify(written));

    const request = [
      { role: 'system', content: 'Continue the scene with relevant history.' },
      ...legacyTranscript,
      { role: 'user', chatId: 'legacy-current-request', id: 'legacy-current-request', content: `Recall ${COLD_T1} and ${COLD_T2}.` }
    ];
    await legacyRuntime.callBeforeRequest(request, 'model');
    const diagnostics = legacyRuntime.hayaku.lastDebug().lastBeforeRequest;
    const recalledStates = (diagnostics?.viewerRecall?.rows || []).map(row => String(row?.state || ''));
    assert.ok(recalledStates.some(state => state.includes(LIVE_T1)), 'the live turn 1 packet remains selected');
    assert.ok(recalledStates.some(state => state.includes(COLD_T1)),
      'legacy multi-turn Cold Start history remains available to recall the uncovered turn without destructive packet surgery');
    assert.ok(recalledStates.some(state => state.includes(COLD_T2)), 'native per-turn history for turn 2 remains available');
  } finally {
    await legacyRuntime.dispose();
  }
  console.log('PASS hayaku_existing_packet_cold_start_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
