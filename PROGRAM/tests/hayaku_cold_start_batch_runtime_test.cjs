'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (turn, data = `User attempt for turn ${turn}.`) => ({
  role: 'user',
  chatId: `batch-u${turn}`,
  id: `batch-u${turn}`,
  data
});
const assistant = (turn, data = `Assistant established outcome for turn ${turn}.`) => ({
  role: 'assistant',
  chatId: `batch-a${turn}`,
  id: `batch-a${turn}`,
  data
});
const completedTurns = count => Array.from({ length: count }, (_, index) => {
  const turn = index + 1;
  return [user(turn), assistant(turn)];
}).flat();

const callPromptText = call => (
  Array.isArray(call?.messages)
    ? call.messages.map(message => String(message?.content || '')).join('\n')
    : ''
);
const requestedUnits = call => {
  const prompt = callPromptText(call);
  const batchUnits = Array.from(
    prompt.matchAll(/\[UNIT ORDINAL (\d+) · TURN (\d+) · ([^\]]+)\]/g),
    match => ({ unitOrdinal: Number(match[1]), turn: Number(match[2]), kind: match[3].trim() })
  );
  if (batchUnits.length) return batchUnits;
  const single = prompt.match(/\[Turn (\d+)\]/);
  return single
    ? [{ unitOrdinal: Number(single[1]), turn: Number(single[1]), kind: 'completed_turn' }]
    : [];
};

const batchEnvelopeResponder = async call => {
  const units = requestedUnits(call);
  const packetForUnit = unit => {
    const packet=createValidPacket({turn:unit.turn,scene:'batch-scene-'+unit.turn,summary:'Turn '+unit.turn+' retained as an independent Cold Start packet.'});
    for(const axis of ['entity','world','narrative','planner'])for(const [key,v]of Object.entries(packet[axis]))if(Array.isArray(v))packet[axis][key]=[];
    packet.world.active_events=[{summary:'The established outcome is retained.'}];
    return packet;
  };
  const groundingForUnit=unit=>['world.active_events[0]','meta.summary_memory.summary'].map(path=>({path,source:'target',evidence:['Assistant established outcome for turn '+unit.turn+'.']}));
  if (!callPromptText(call).includes('[COLD START BATCH ENVELOPE')) {
    return { type: 'success', result: JSON.stringify({schema:'hayaku.native_repair_output.v1',packet:packetForUnit(units[0]),grounding:groundingForUnit(units[0])}) };
  }
  return {
    type: 'success',
    result: JSON.stringify({
      schema: 'hayaku.native_cold_start_batch_output.v1',
      packets: units.map(unit => ({
        unitOrdinal: unit.unitOrdinal,
        packet: packetForUnit(unit), grounding:groundingForUnit(unit)
      }))
    })
  };
};

const assertTransportBoundary = calls => {
  for (const call of calls) {
    assert.equal(call.mode, 'otherAx');
    assert.equal(call.allowPlugins, true);
    assert.equal(Object.prototype.hasOwnProperty.call(call, 'staticModel'), false,
      'HAYAKU must leave model selection to RisuAI');
    assert.equal(Array.isArray(call.messages), true);
    assert.equal(call.messages.length, 2);
  }
};

const inspectColdStartRecords = async runtime => {
  const ledger = await runtime.hayaku.ledger.inspect({ includeRecords: true });
  return Array.from(ledger.records).filter(record => (
    record.captureSource === 'bridge_cold_start'
    && record.recordState === 'historical'
    && record.packetType === 'cold_start_snapshot'
  ));
};

const assertIndependentTurnPackets = (records, expectedTurns) => {
  assert.equal(records.length, expectedTurns);
  const packets = records
    .map(record => ({ record, packet: JSON.parse(record.raw) }))
    .sort((left, right) => (
      Number(left.packet.meta?.source_turn_range?.start || 0)
      - Number(right.packet.meta?.source_turn_range?.start || 0)
    ));

  assert.deepEqual(
    packets.map(row => Number(row.packet.meta?.source_turn_range?.start)),
    Array.from({ length: expectedTurns }, (_, index) => index + 1),
    'batched calls must still author one canonical packet per completed U+A turn'
  );
  assert.ok(packets.every(row => (
    Number(row.packet.meta?.source_turn_range?.start)
    === Number(row.packet.meta?.source_turn_range?.end)
  )), 'Cold Start batches must not merge multiple turns into one packet');
  assert.ok(packets.every(row => row.packet.meta?.analysis_status === 'native_otherax_verified'));
  assert.ok(packets.every(row => row.packet.meta?.cold_start_source === 'CHAT_TRANSCRIPT_COLD_START'));
  assert.deepEqual(
    records.map(record => Number(record.historicalOrdinal)).sort((a, b) => a - b),
    Array.from({ length: expectedTurns }, (_, index) => index + 1)
  );
};

const runConfiguredFiveTurnBatch = async () => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: completedTurns(10),
    arguments: { hayaku_cold_start_batch_turns: '5' },
    llmResponder: async call => { const reply = await batchEnvelopeResponder(call); return {...reply, result: "<final>" + reply.result + "</final>"}; }
  });

  try {
    const result = await runtime.hayaku.recovery.coldStart({ resume: true });
    assert.equal(result.ok, true);
    assert.equal(result.completed, true);
    assert.equal(result.packets, 10);
    assert.equal(result.analysisBatchTurns, 5);
    assert.equal(result.analysisBatchCount, 2);
    assert.equal(result.llmCalls, 2);
    assert.equal(runtime.llmCalls.length, 2, '10 completed turns at batch size 5 require two Other Ax calls');
    assert.deepEqual(runtime.llmCalls.map(call => requestedUnits(call).length), [5, 5]);
    assert.deepEqual(
      runtime.llmCalls.flatMap(call => requestedUnits(call).map(unit => unit.unitOrdinal)),
      Array.from({ length: 10 }, (_, index) => index + 1)
    );
    assertTransportBoundary(runtime.llmCalls);
    assert.equal(runtime.fetchCalls.length, 0, 'Cold Start batch analysis must not own provider transport');

    const records = await inspectColdStartRecords(runtime);
    assertIndependentTurnPackets(records, 10);

    const status = await runtime.hayaku.recovery.status();
    assert.equal(status.coldStartRun.run.analysisBatchTurns, 5);
    assert.equal(status.coldStartRun.run.analysisBatchCount, 2);
    assert.equal(status.coldStartRun.run.llmCalls, 2);
    assert.equal(status.coldStartRun.run.chunks.length, 10,
      'checkpoint granularity must remain per turn even when transport calls are batched');
    assert.ok(status.coldStartRun.run.chunks.every(chunk => chunk.status === 'verified'));
  } finally {
    await runtime.dispose();
  }
};

const runExplicitTenTurnBatch = async () => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: completedTurns(11),
    arguments: { hayaku_cold_start_batch_turns: '1' },
    llmResponder: batchEnvelopeResponder
  });

  try {
    const result = await runtime.hayaku.recovery.coldStart({ resume: true, batchTurns: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.completed, true);
    assert.equal(result.packets, 11);
    assert.equal(result.analysisBatchTurns, 10, 'explicit execution option must override the stored default');
    assert.equal(result.analysisBatchCount, 2);
    assert.equal(result.llmCalls, 2);
    assert.equal(runtime.llmCalls.length, 2, '11 completed turns at batch size 10 require two Other Ax calls');
    assert.deepEqual(runtime.llmCalls.map(call => requestedUnits(call).length), [10, 1]);
    assertTransportBoundary(runtime.llmCalls);

    const records = await inspectColdStartRecords(runtime);
    assertIndependentTurnPackets(records, 11);
  } finally {
    await runtime.dispose();
  }
};

(async () => {
  await runConfiguredFiveTurnBatch();
  await runExplicitTenTurnBatch();
  console.log('PASS hayaku_cold_start_batch_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
