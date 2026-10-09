'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const assistantTurn = (turn, visible, packetOrRaw) => ({
  role: 'assistant',
  chatId: `assistant-${turn}`,
  data: `${visible}\n${typeof packetOrRaw === 'string'
    ? `<!-- HAYAKU_STATE_PACKET_START ${packetOrRaw} HAYAKU_STATE_PACKET_END -->`
    : hiddenPacketMessage('', packetOrRaw)}`
});
const storageBytes = storage => Array.from(storage.values.entries(), ([key, value]) => [key, String(value)])
  .sort(([a], [b]) => a.localeCompare(b));

(async () => {
  const visible1 = 'Alice found an amber compass in the archive.';
  const visible2 = 'Bob left a silver telescope beneath the red stair.';
  const t2Packet = createValidPacket({ turn: 2, subject: 'Bob', scene: 'tower', summary: visible2 });
  const t2RepairableSource = `${JSON.stringify(t2Packet).slice(0, -1)},}`;
  const messages = [
    { role: 'user', chatId: 'user-1', data: 'Alice searches the archive.' },
    assistantTurn(1, visible1, createValidPacket({ turn: 1, subject: 'Alice', scene: 'archive', summary: visible1 })),
    { role: 'user', chatId: 'user-2', data: 'Bob returns to the tower.' },
    assistantTurn(2, visible2, t2RepairableSource)
  ];
  let runtime = await createHayakuRuntime({ autoRepair: false, messages, chatId: 'manual-recapture-adoption' });
  const persistentStorage = runtime.pluginStorage;
  try {
    const test = runtime.hayaku._test;
    const scope = await test.currentChatScope();
    const fullSnapshot = test.authoritativeChatSnapshot(scope.chatMessages, scope);
    await test.reconcileObservedChatTopology(scope, {
      ...fullSnapshot,
      conversationPairs: fullSnapshot.conversationPairs.filter(pair => pair.pairIndex === 1)
    }, 'manual_recapture_existing_unselected_record', { prompt: false });
    const ledgerKey = `hayaku.v2.ledger.${scope.key}`;
    const readStoredLedger = () => {
      const value = persistentStorage.values.get(ledgerKey);
      return typeof value === 'string' ? JSON.parse(value) : value;
    };
    const beforeLedger = readStoredLedger();
    const preexistingT1 = beforeLedger.records.find(record => record.targetPairIndex === 1 && record.recordState === 'active');
    assert.ok(preexistingT1, 'fixture starts with a previously stored active unselected turn');
    const preexistingT1Slot = beforeLedger.slotHeads.find(head => head.slotId === preexistingT1.slotId || head.slotId === test.storageRecordSlotId(preexistingT1));
    assert.ok(preexistingT1Slot, 'fixture starts with the T1 slot head');
    const t1SlotBefore = JSON.stringify(preexistingT1Slot);
    const beforeNone = storageBytes(persistentStorage);
    const preview = await runtime.hayaku.ledger.manualRecapture.preview();
    assert.equal(preview.ok, true);
    assert.equal(preview.turns.find(row => row.turn === 2).eligible, true);
    const previewT2 = preview.turns.find(row => row.turn === 2).packets[0];
    assert.equal(previewT2.normalizationChanged, true);
    assert.ok(previewT2.sourceRaw.endsWith(',}'));
    const cancelled = await runtime.hayaku.ledger.manualRecapture.adopt({ previewId: preview.previewId, selection: 'none' });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.adopted, false);
    assert.deepEqual(storageBytes(persistentStorage), beforeNone, 'none selection leaves every durable byte unchanged');

    const selected = await runtime.hayaku.ledger.manualRecapture.adopt({
      previewId: preview.previewId,
      selection: 'selected',
      turns: [2]
    });
    assert.equal(selected.ok, true, JSON.stringify(selected));
    assert.equal(selected.adopted, true);
    assert.equal(selected.durable, true);

    const durable = readStoredLedger();
    assert.ok(durable, 'selected adoption writes a scoped ledger');
    const active = durable.records.filter(record => record.recordState === 'active');
    assert.deepEqual(Array.from(active, record => Number(record.targetPairIndex)).sort(), [1, 2], 'selected T2 is added while prior unselected T1 remains active');
    const durableT1 = active.find(record => Number(record.targetPairIndex) === 1);
    const durableT2 = active.find(record => Number(record.targetPairIndex) === 2);
    assert.equal(durableT1.hash, preexistingT1.hash);
    assert.equal(JSON.stringify(durable.slotHeads.find(head => head.slotId === test.storageRecordSlotId(durableT1))), t1SlotBefore,
      'selected binding preserves the existing unselected T1 slot head');
    assert.equal(durableT2.captureSource, 'live_chat_normalized_mirror', 'repairable adoption uses the established beforeRequest-consumed normalized source');
    assert.equal(durableT2.raw, previewT2.raw, 'repairable packet readback bytes exactly match the JSON shown as the preview primary');
    assert.ok(String(durableT2.raw).includes('silver telescope'), 'the adopted durable primary raw contains the previewed story content');

    await runtime.dispose();
    const recallMessages = messages.map(message => ({
      ...message,
      data: message.role === 'assistant' ? (message.chatId === 'assistant-1' ? visible1 : visible2) : message.data
    }));
    runtime = await createHayakuRuntime({ autoRepair: false, messages: recallMessages, chatId: 'manual-recapture-adoption', pluginStorage: persistentStorage });
    const request = await runtime.callBeforeRequest([
      { role: 'system', content: 'Recall the earlier scene.' },
      { role: 'user', chatId: 'recall-query', content: 'Where did Bob leave the telescope?' }
    ], 'model');
    const recalledText = request.map(message => message.content || message.data || '').join('\n');
    assert.match(recalledText, /silver telescope/i, 'durable selected packet is recalled by the real beforeRequest hook after reload');
    assert.match(recalledText, /amber compass/i, 'previously active unselected T1 remains available to ordinary recall; selection controls adoption, not deletion');
    const reopenedLedger=JSON.parse(persistentStorage.values.get(ledgerKey));
    assert.equal(reopenedLedger.records.find(record=>record.recordState==='active'&&Number(record.targetPairIndex)===1).hash,preexistingT1.hash,'reload preserves the unchanged unselected record');
    assert.equal(runtime.llmCalls.length, 0, 'manual adoption and ordinary recall do not call a model');
    console.log('PASS manual recapture cancellation, selected-turn durable adoption, and beforeRequest recall after reload');
  } finally {
    await runtime.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
