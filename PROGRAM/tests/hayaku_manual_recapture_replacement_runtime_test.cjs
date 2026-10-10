'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const assistantTurn = (turn, visible, packets) => ({
  role: 'assistant',
  chatId: `assistant-${turn}`,
  data: `${visible}\n${packets.map(packet => hiddenPacketMessage('', packet)).join('\n')}`
});

(async () => {
  const visible1 = 'Alice found an amber compass in the archive.';
  const visible2 = 'Bob left a silver telescope beneath the red stair.';
  const t1Packet = createValidPacket({ turn: 1, subject: 'Alice', scene: 'archive', summary: visible1 });
  const oldCurrent = createValidPacket({ turn: 2, subject: 'Bob', scene: 'tower', summary: visible2 });
  oldCurrent.entity.characters[0].current_state = 'OLD_STATE_SENTINEL_A19D';
  const recovery = createValidPacket({ turn: 2, packetType: 'recovery_snapshot', subject: 'Bob', scene: 'tower', summary: visible2 });
  const detectedCurrent = createValidPacket({ turn: 2, subject: 'Bob', scene: 'tower', summary: visible2 });
  detectedCurrent.entity.characters[0].current_state = 'NEW_STATE_SENTINEL_E63B';
  const messages = [
    { role: 'user', chatId: 'user-1', data: 'Alice searches the archive.' },
    assistantTurn(1, visible1, [t1Packet]),
    { role: 'user', chatId: 'user-2', data: 'Bob returns to the tower.' },
    assistantTurn(2, visible2, [oldCurrent, recovery])
  ];
  let runtime = await createHayakuRuntime({ autoRepair: false, messages, chatId: 'manual-recapture-replacement' });
  const persistentStorage = runtime.pluginStorage;
  try {
    const test = runtime.hayaku._test;
    const scope = await test.currentChatScope();
    const initialSnapshot = test.authoritativeChatSnapshot(scope.chatMessages, scope);
    await test.reconcileObservedChatTopology(scope, initialSnapshot, 'manual_recapture_replacement_seed', { prompt: false });
    const storageKey = `hayaku.v2.ledger.${scope.key}`;
    const readLedger = () => JSON.parse(runtime.pluginStorage.values.get(storageKey));
    const before = readLedger();
    const pair2 = initialSnapshot.conversationPairs.find(pair => pair.pairIndex === 2);
    const oldPacketHash = pair2.validPackets.find(packet => packet.packetType === 'current_snapshot').hash;
    const recoveryHash = pair2.validPackets.find(packet => packet.packetType === 'recovery_snapshot').hash;
    const oldCurrentRecord = before.records.find(record => record.hash === oldPacketHash && record.targetPairIndex === 2);
    const recoveryRecord = before.records.find(record => record.hash === recoveryHash && record.targetPairIndex === 2);
    const t1Record = before.records.find(record => record.targetPairIndex === 1 && record.recordState === 'active');
    assert.equal(oldCurrentRecord?.recordState, 'active', 'fixture starts with an active current packet for T2');
    assert.equal(recoveryRecord?.recordState, 'active', 'fixture starts with a separate active recovery packet for T2');
    assert.ok(t1Record, 'fixture has an unselected active T1');
    const currentSlotId = test.storageRecordSlotId(oldCurrentRecord);
    const recoverySlotId = test.storageRecordSlotId(recoveryRecord);
    const t1SlotId = test.storageRecordSlotId(t1Record);
    const t1HeadBefore = before.slotHeads.find(head => head.slotId === t1SlotId);

    runtime.setMessages([
      ...messages.slice(0, 3),
      assistantTurn(2, visible2, [detectedCurrent, recovery])
    ]);
    const preview = await runtime.hayaku.ledger.manualRecapture.preview();
    const previewTurn = preview.turns.find(turn => turn.turn === 2);
    assert.equal(preview.ok, true);
    assert.equal(previewTurn.eligible, true, 'the newly detected valid inline packet is eligible for T2 adoption');
    const detectedHash = previewTurn.packets.find(packet => packet.packetType === 'current_snapshot').hash;
    assert.notEqual(detectedHash, oldPacketHash, 'the detected packet is a distinct variant in the same packet slot');

    const adopted = await runtime.hayaku.ledger.manualRecapture.adopt({
      previewId: preview.previewId,
      selection: 'selected',
      turns: [2]
    });
    assert.equal(adopted.ok, true, JSON.stringify(adopted));
    assert.equal(adopted.durable, true);

    const after = readLedger();
    const newCurrent = after.records.find(record => record.hash === detectedHash && record.targetPairIndex === 2);
    const archivedOldCurrent = after.records.find(record => record.hash === oldPacketHash && record.targetPairIndex === 2);
    const preservedRecovery = after.records.find(record => record.hash === recoveryHash && record.targetPairIndex === 2);
    assert.equal(newCurrent?.recordState, 'active', 'the current inline packet becomes the canonical active record');
    assert.equal(archivedOldCurrent?.recordState, 'superseded', 'the old current packet is retained as an inactive variant');
    assert.equal(archivedOldCurrent?.auditRetained, true, 'the old packet remains in audit history');
    assert.equal(archivedOldCurrent?.supersededByHash, detectedHash, 'audit history identifies the selected replacement');
    assert.equal(test.storageRecordSlotId(newCurrent), currentSlotId, 'the new current variant replaces the same current-packet slot');
    assert.equal(after.slotHeads.find(head => head.slotId === currentSlotId)?.selectedVariantHash, detectedHash,
      'the slot head follows the current inline packet');
    assert.equal(preservedRecovery?.recordState, 'active', 'the separate recovery packet type remains active');
    assert.equal(after.slotHeads.find(head => head.slotId === recoverySlotId)?.selectedVariantHash, recoveryHash,
      'the separate packet-type slot retains its own selected packet');
    assert.equal(after.records.find(record => record.recordId === t1Record.recordId)?.recordState, 'active',
      'the unselected T1 remains active');
    assert.equal(after.slotHeads.find(head => head.slotId === t1SlotId)?.selectedVariantHash, t1HeadBefore.selectedVariantHash,
      'the unselected T1 slot head remains unchanged');
    assert.equal(runtime.llmCalls.length, 0, 'manual replacement does not call a model');

    await runtime.dispose();
    const reloadMessages = [
      { role: 'user', chatId: 'user-1', data: 'Alice searches the archive.' },
      { role: 'assistant', chatId: 'assistant-1', data: visible1 },
      { role: 'user', chatId: 'user-2', data: 'Bob returns to the tower.' },
      { role: 'assistant', chatId: 'assistant-2', data: visible2 }
    ];
    runtime = await createHayakuRuntime({
      autoRepair: false,
      messages: reloadMessages,
      chatId: 'manual-recapture-replacement',
      pluginStorage: persistentStorage
    });
    const request = await runtime.callBeforeRequest([
      { role: 'system', content: 'Answer from the selected continuity state.' },
      { role: 'user', chatId: 'recall-query', content: 'Which T2 continuity packet is selected?' }
    ], 'model');
    const recalledText = request.map(message => message.content || message.data || '').join('\n');
    assert.match(recalledText, /NEW_STATE_SENTINEL_E63B/, 'the actual beforeRequest consumer injects the newly selected packet after reload');
    assert.doesNotMatch(recalledText, /OLD_STATE_SENTINEL_A19D/, 'the superseded packet is absent from actual recalled context');
    assert.equal(runtime.llmCalls.length, 0, 'beforeRequest recall does not call a model');
    console.log('PASS manual recapture makes the selected T2 packet canonical and injects it through beforeRequest after reload');
  } finally {
    await runtime.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
