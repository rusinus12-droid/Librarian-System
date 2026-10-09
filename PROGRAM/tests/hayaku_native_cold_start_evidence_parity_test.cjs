'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');


// Transport fixtures carry only the source-supported event; placeholder planner locks are not evidence.
const coldPacket = options => { const p=createValidPacket(options); p.entity={};p.world={};p.narrative={};p.planner={};p.meta.summary_memory={summary:options.summary};return {schema:'hayaku.native_repair_output.v1',packet:p,grounding:[{path:'meta.summary_memory.summary',source:'target',evidence:[options.summary]}]}; };
const msg = (role, id, data) => ({ role, chatId: id, id, data });

(async () => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      msg('system', 's1', 'SYSTEM CONTEXT: The observatory is on Mars.'),
      msg('assistant', 'a0', 'Alice wakes beneath a red dawn before anyone speaks.'),
      msg('user', 'u1', 'I light the brass lamp.'),
      msg('assistant', 'a1', 'Alice lights the brass lamp; its green flame reveals a map.'),
      msg('user', 'u-pending', 'I tear the map in half.')
    ]
  });

  try {
    runtime.setLlmResponder(async (_options, callIndex) => ({
      type: 'success',
      result: JSON.stringify(coldPacket({
        turn: Math.max(1, callIndex),
        subject: 'Alice',
        scene: 'observatory',
        summary: callIndex === 1
          ? 'Alice wakes beneath a red dawn before anyone speaks.'
          : 'Alice lights the brass lamp; its green flame reveals a map.'
      }))
    }));

    const result = await runtime.hayaku.recovery.coldStart({ resume: true });
    assert.equal(result.ok, true);
    assert.equal(result.packets, 2, 'assistant opening + completed U+A must both become historical evidence');
    assert.equal(result.assistantOnlyUnits, 1);
    assert.equal(runtime.llmCalls.length, 2);

    const prompts = runtime.llmCalls.map(call => call.messages.map(row => String(row.content || '')).join('\n'));
    assert.ok(prompts[0].includes('SYSTEM CONTEXT: The observatory is on Mars.'), 'system message must be available as context-only evidence');
    assert.ok(prompts[0].includes('[CONTEXT ONLY'), 'system message must not be presented as target evidence');
    assert.ok(prompts[0].includes('Alice wakes beneath a red dawn'), 'assistant opening must be analyzed as historical evidence');
    assert.ok(prompts[1].includes('I light the brass lamp.'), 'completed user+assistant turn must be analyzed');
    assert.ok(prompts[1].includes('green flame reveals a map'));
    assert.ok(prompts.every(text => !text.includes('I tear the map in half.')), 'trailing pending User input must not be promoted into Cold Start evidence');

    const ledger = await runtime.hayaku.ledger.inspect({ includeRecords: true });
    const coldRecords = ledger.records.filter(record => (
      record.captureSource === 'bridge_cold_start'
      && record.recordState === 'historical'
      && record.packetType === 'cold_start_snapshot'
    ));
    assert.equal(coldRecords.length, 2);
    const parsed = coldRecords.map(record => JSON.parse(record.raw));
    const opening = parsed.find(packet => Number(packet.meta?.source_turn_range?.start) === 0);
    const turn1 = parsed.find(packet => Number(packet.meta?.source_turn_range?.start) === 1);
    assert.ok(opening, 'assistant opening must retain source turn 0 instead of impersonating turn 1');
    assert.equal(opening.meta.source_unit_kind, 'assistant_only');
    assert.ok(turn1);
    assert.equal(turn1.meta.source_unit_kind, 'completed_turn');
    assert.ok(parsed.every(packet => !JSON.stringify(packet).includes('tear the map in half')));

    console.log('PASS hayaku_native_cold_start_evidence_parity_test');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
