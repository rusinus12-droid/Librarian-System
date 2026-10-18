'use strict';
// The packet list, worldline and detail label every record with the HAYAKU path that wrote it
// and its real turn. Cold-start records keep targetPairIndex 0 and carry their turns in the
// packet's source range; they must not collapse into one "T0" or appear as "과거 #n".
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');

const coldRaw = (start, end = start) => {
  const packet = createValidPacket({ turn: start, summary: `cold ${start}` });
  packet.meta.packet_type = 'cold_start_snapshot';
  packet.meta.source_turn_range = { start, end };
  return JSON.stringify(packet);
};

(async () => {
  const runtime = await createHayakuRuntime({ autoRepair: false });
  try {
    const t = runtime.hayaku._test;
    const cold = { captureSource: 'bridge_cold_start', coldStartEpochId: 'epoch', inheritedSessionHistory: true, historicalOrdinal: 3, targetPairIndex: 0, recordState: 'historical', packetType: 'cold_start_snapshot', raw: coldRaw(2) };
    const coldRange = { ...cold, raw: coldRaw(5, 7) };
    const canonical = { captureSource: 'risu_chat_output', targetPairIndex: 6, recordState: 'active', packetType: 'current_snapshot' };
    const automatic = { ...canonical, targetPairIndex: 7, packetAuthor: 'after_request_repair' };
    const manual = { captureSource: 'bridge_incremental_recovery', targetPairIndex: 8, recordState: 'active', packetType: 'recovery_snapshot' };
    const inherited = { captureSource: 'risu_chat_output', inheritedSessionHistory: true, historicalOrdinal: 4, targetPairIndex: 0, recordState: 'historical' };

    assert.equal(t.viewerRecordPairLabel(cold), 'T2', 'a cold-start record shows its real turn');
    assert.equal(t.viewerRecordPairLabel(coldRange), 'T5–T7', 'a multi-turn cold-start record shows its range');
    assert.equal(t.viewerRecordPairLabel(canonical), 'T6');
    assert.equal(t.viewerRecordPairLabel(inherited), '과거 #4', 'records inherited from another chat keep their ordinal');

    assert.deepEqual([cold, canonical, automatic, manual, inherited].map(record => t.viewerRecordOrigin(record).label),
      ['콜드스타트', '정본 패킷', '자동 복구', '누락 복구', '이전 채팅']);
    assert.deepEqual(['active', 'historical', 'tombstoned', 'unbound'].map(t.viewerRecordStateLabel), ['활성', '과거 기억', '대체됨', '결속 대기']);
    assert.deepEqual(['current_snapshot', 'recovery_snapshot', 'cold_start_snapshot'].map(t.viewerPacketTypeLabel), ['턴 패킷', '복구 패킷', '콜드스타트 패킷']);
    console.log('PASS hayaku_gui_record_origin_test');
  } finally { await runtime.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
