'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const visible = 'Alice opened the archive and found a blue ribbon.';
  const current = createValidPacket({ turn: 1, packetType: 'current_snapshot', subject: 'Alice', scene: 'archive', summary: visible });
  const recovery = createValidPacket({ turn: 1, packetType: 'recovery_snapshot', subject: 'Alice', scene: 'archive', summary: visible });
  const messages = [
    { role: 'user', chatId: 'user-1', data: 'Alice opens the archive.' },
    { role: 'assistant', chatId: 'assistant-1', data: `${visible}\n${hiddenPacketMessage('', current)}\n${hiddenPacketMessage('', recovery)}` }
  ];
  const runtime = await createHayakuRuntime({ autoRepair: false, messages, chatId: 'manual-recapture-tombstone-policy' });
  try {
    const test = runtime.hayaku._test;
    const scope = await test.currentChatScope();
    const snapshot = test.authoritativeChatSnapshot(scope.chatMessages, scope);
    await test.reconcileObservedChatTopology(scope, snapshot, 'manual_recapture_policy_fixture', { prompt: false });
    const ledger = await test.loadStorageLedger(scope, { hydrateArchive: false });
    const currentRecord = ledger.records.find(record => record.targetPairIndex === 1 && record.packetType === 'current_snapshot');
    assert.ok(currentRecord, 'fixture establishes an ordinary stored current packet before tombstoning it');
    const forgotten = await runtime.hayaku.ledger.forget({ hash: currentRecord.hash });
    assert.equal(forgotten.forgotten, true);

    const preview = await runtime.hayaku.ledger.manualRecapture.preview();
    const turn = preview.turns.find(row => row.turn === 1);
    assert.equal(turn.packets.find(packet => packet.packetType === 'current_snapshot').eligible, false, 'the suppressed current packet is blocked');
    assert.equal(turn.packets.find(packet => packet.packetType === 'recovery_snapshot').eligible, true, 'the distinct recovery variant remains individually visible');
    assert.equal(turn.eligible, false, 'a T# selection cannot use another packet type to bypass a suppressed sibling');
    const beforeRejectedAdoption = Array.from(runtime.pluginStorage.values.entries(), ([key, value]) => [key, String(value)])
      .sort(([a], [b]) => a.localeCompare(b));
    const rejected = await runtime.hayaku.ledger.manualRecapture.adopt({
      previewId: preview.previewId,
      selection: 'selected',
      turns: [1]
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'selected_turn_not_eligible');
    assert.deepEqual(Array.from(runtime.pluginStorage.values.entries(), ([key, value]) => [key, String(value)])
      .sort(([a], [b]) => a.localeCompare(b)), beforeRejectedAdoption, 'rejected T1 selection cannot resurrect the user-suppressed variant');
    console.log('PASS manual recapture blocks mixed-eligibility turns when a visible sibling packet is tombstoned');
  } finally {
    await runtime.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
