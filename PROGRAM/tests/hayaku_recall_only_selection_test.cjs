'use strict';
// HAYAKU's selection for another reader: the same recall the response model gets, no packet-writing
// instructions, and no writes.
//
// Run: node tests/hayaku_recall_only_selection_test.cjs
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const FACT = 'silver spindle', QUERY = 'What is inside the Aurora vault?';
const summary = 'The Aurora vault stores a silver spindle.';
const messages = Array.from({ length: 3 }, (_, i) => [
  { role: 'user', chatId: 'u' + i, data: 'Inspect the Aurora vault.' },
  { role: 'assistant', chatId: 'a' + i, data: hiddenPacketMessage(summary, createValidPacket({ turn: i + 1, subject: 'Archivist', summary })) }
]).flat();
const PACKET_INSTRUCTIONS = /HAYAKU_STATE_PACKET_START|SIDE-WRITE FINAL REMINDER|current_snapshot/;

(async () => {
  const runtime = await createHayakuRuntime({ messages, autoRepair: false });
  try {
    const request = () => [{ role: 'user', content: QUERY }];
    // The first ordinary request binds the chat's packets to the ledger, as in normal use.
    await runtime.callBeforeRequest(request(), 'model');
    const before = JSON.stringify([...runtime.pluginStorage.values]);
    const selected = await runtime.hayaku._test.handleBeforeRequest(request(), 'model', { recallOnly: true });
    assert.equal(Array.isArray(selected), false, 'recallOnly returns a selection, not an outgoing request');
    assert.ok(selected.recallPrompt.includes(FACT), 'recall prompt: ' + selected.recallPrompt.slice(0, 400));
    assert.doesNotMatch(selected.recallPrompt, PACKET_INSTRUCTIONS);
    assert.equal(JSON.stringify([...runtime.pluginStorage.values]), before, 'selecting writes nothing');
    assert.equal(runtime.llmCalls.length, 0);

    const outgoing = await runtime.callBeforeRequest(request(), 'model');
    const body = outgoing.map(row => String(row.content || '')).join('\n');
    assert.match(body, PACKET_INSTRUCTIONS, 'the response model still gets the packet instructions');
    assert.ok(body.includes(selected.recallPrompt), 'the hook always delivers its own recall prompt independently');
  } finally { await runtime.dispose(); }
  console.log('hayaku_recall_only_selection_test: PASS');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
