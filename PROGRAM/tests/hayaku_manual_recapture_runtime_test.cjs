'use strict';

// The manual preview must be a read-only view over the active chat. A recovery
// status refresh is intentionally not used here: that normal UI observer can
// mirror packets independently of this manual action.
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const visiblePacketTurn = (turn, visible, packets) => {
  const carriers = packets.map(packet => typeof packet === 'string'
    ? `<!-- HAYAKU_STATE_PACKET_START ${packet} HAYAKU_STATE_PACKET_END -->`
    : hiddenPacketMessage('', packet)).join('\n');
  return { role: 'assistant', chatId: `assistant-${turn}`, data: `${visible}\n${carriers}` };
};

(async () => {
  const visible1 = 'Alice opened the archive and found a blue ribbon.';
  const visible2 = 'Alice placed the ribbon beside the old map.';
  const normalizedT2 = createValidPacket({ turn: 2, subject: 'Alice', scene: 'map', summary: visible2 });
  const sourceT2 = `${JSON.stringify(normalizedT2).slice(0, -1)},}`;
  const messages = [
    { role: 'user', chatId: 'user-1', data: 'Alice opens the archive.' },
    visiblePacketTurn(1, visible1, [
      createValidPacket({ turn: 1, subject: 'Alice', scene: 'archive', summary: visible1 }),
      createValidPacket({ turn: 1, packetType: 'recovery_snapshot', subject: 'Alice', scene: 'archive', summary: visible1 })
    ]),
    { role: 'user', chatId: 'user-2', data: 'Alice looks at the map.' },
    visiblePacketTurn(2, visible2, [sourceT2])
  ];
  const runtime = await createHayakuRuntime({ autoRepair: false, messages, chatId: 'manual-recapture-preview' });
  try {
    const beforeBytes = [...runtime.pluginStorage.values.entries()].map(([key, value]) => [key, String(value)]).sort(([a], [b]) => a.localeCompare(b));
    let writes = 0;
    const setItem = runtime.pluginStorage.setItem.bind(runtime.pluginStorage);
    runtime.pluginStorage.setItem = async (...args) => { writes += 1; return await setItem(...args); };

    const preview = await runtime.hayaku.ledger.manualRecapture.preview();

    assert.equal(preview.ok, true);
    assert.deepEqual(Array.from(preview.turns, turn => turn.turn), [1, 2], 'all completed U+A packet turns appear in the full scan');
    assert.deepEqual(Array.from(preview.turns[0].packets, packet => packet.packetType), ['current_snapshot', 'recovery_snapshot']);
    assert.ok(preview.turns[0].packets[0].raw.includes('Alice opened the archive and found a blue ribbon.'), 'preview shows actual packet JSON');
    assert.ok(preview.turns[0].packets[1].raw.includes('"packet_type":"recovery_snapshot"'), 'every packet type is shown in full');
    assert.ok(preview.turns[1].packets[0].raw.includes('Alice placed the ribbon beside the old map.'));
    assert.equal(preview.turns[1].packets[0].raw, JSON.stringify(normalizedT2), 'preview primary JSON matches the normalized raw the ledger will store');
    assert.ok(preview.turns[1].packets[0].sourceRaw.endsWith(',}'), 'preview separately identifies repairable source bytes');
    assert.equal(writes, 0, 'preview makes no plugin storage writes');
    assert.deepEqual([...runtime.pluginStorage.values.entries()].map(([key, value]) => [key, String(value)]).sort(([a], [b]) => a.localeCompare(b)), beforeBytes,
      'preview leaves all durable bytes unchanged');
    assert.equal(runtime.llmCalls.length, 0, 'preview does not call a model');
    assert.equal(runtime.fetchCalls.length, 0, 'preview does not call a provider');
    console.log('hayaku_manual_recapture_runtime_test: preview is read-only and exposes full packet bodies by active T# turn');
  } finally {
    await runtime.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
