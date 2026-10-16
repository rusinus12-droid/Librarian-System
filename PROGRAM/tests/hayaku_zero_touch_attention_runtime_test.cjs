'use strict';
// Zero-touch attention: HAYAKU shows one chat button only while the user has
// something to do, picks the most important cause, and removes it afterwards.
const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });

(async () => {
  // Pure decision: priority aux > cold start > missing > placement.
  {
    const runtime = await createHayakuRuntime({ messages: [] });
    try {
      const decide = runtime.hayaku._test.hayakuAttentionDecision;
      assert.equal(decide({ aux: 'ready', mode: 'complete' }).kind, '', 'nothing to do, no button');
      assert.equal(decide({ aux: 'unknown', mode: 'empty' }).kind, '');
      assert.equal(decide({ aux: 'failed', mode: 'complete' }).kind, 'aux', 'a failed connection always needs the user');
      assert.equal(decide({ aux: 'unavailable', mode: 'complete' }).kind, '', 'an unavailable API is silent until something needs it');
      assert.equal(decide({ aux: 'unavailable', mode: 'incremental_missing', missing: 2 }).kind, 'aux');
      const cold = decide({ aux: 'ready', mode: 'cold_start', completedTurns: 12 });
      assert.equal(cold.kind, 'cold_start'); assert.match(cold.name, /지난 12턴 기억 만들기/); assert.equal(cold.subtab, 'cold');
      const missing = decide({ aux: 'unknown', mode: 'incremental_missing', missing: 3, placementWarning: 'x' });
      assert.equal(missing.kind, 'missing'); assert.match(missing.name, /기억 없는 턴 3개/);
      assert.equal(decide({ aux: 'ready', mode: 'complete', placementWarning: 'ambiguous_output_slot_use_verified_override' }).kind, 'placement');
      assert.equal(decide({ aux: 'ready', mode: 'complete', placementWarning: 'w', placementDismissed: true }).kind, '', 'placement is shown once');
      assert.match(runtime.hayaku._test.hayakuPlacementWarningLabel('ambiguous_output_slot_use_verified_override'), /응답 끝/);
    } finally { await runtime.dispose(); }
  }

  // Installing into an existing chat: Cold Start button in the chat area, no provider call.
  const runtime = await createHayakuRuntime({
    messages: [user('u1', 'I open the gate.'), assistant('a1', 'The gate creaks open.'),
      user('u2', 'I step inside.'), assistant('a2', 'Cold air fills the hall.')]
  });
  try {
    const registered = [], removed = [];
    const registerButton = runtime.host.registerButton.bind(runtime.host);
    runtime.host.registerButton = async (spec, handler) => { registered.push({ spec, handler }); return registerButton(spec, handler); };
    const unregister = runtime.host.unregisterUIPart.bind(runtime.host);
    runtime.host.unregisterUIPart = async id => { removed.push(id); return unregister(id); };
    const t = runtime.hayaku._test;
    t.startHayakuAttention();
    t.HayakuAttention.started = true;
    const callsBefore = runtime.llmCalls.length;
    const state = await t.refreshHayakuAttention();
    assert.equal(state.kind, 'cold_start', JSON.stringify(state));
    assert.equal(state.completedTurns, 2);
    const button = registered.at(-1);
    assert.equal(button.spec.location, 'chat');
    assert.equal(button.spec.id, 'hayaku-locator-continuity-attention');
    assert.match(button.spec.name, /지난 2턴 기억 만들기/);
    assert.equal(runtime.llmCalls.length, callsBefore, 'checking attention never calls the provider');
    // Same state: the button is not re-registered.
    await t.refreshHayakuAttention();
    assert.equal(registered.length, 1);

    // A failed auxiliary model outranks Cold Start.
    runtime.setLlmResponder(async () => { throw new Error('no auxiliary model configured'); });
    const probe = await t.runNativeAuxiliaryProbe();
    assert.equal(probe.ok, false);
    assert.equal(t.hayakuAuxiliaryReadiness(), 'failed');
    const aux = await t.refreshHayakuAttention();
    assert.equal(aux.kind, 'aux');
    assert.deepEqual(removed, ['hayaku-locator-continuity-attention'], 'old button removed before the new one');
    assert.match(registered.at(-1).spec.name, /보조 모델 연결 필요/);

    // A successful probe clears the aux cause and Cold Start comes back.
    runtime.setLlmResponder(async () => ({ type: 'success', result: 'HAYAKU OK' }));
    assert.equal((await t.runNativeAuxiliaryProbe()).ok, true);
    assert.equal(t.hayakuAuxiliaryReadiness(), 'ready');
    assert.equal((await t.refreshHayakuAttention()).kind, 'cold_start');

    // Unload removes the button.
    await t.stopHayakuAttention();
    assert.equal(removed.at(-1), 'hayaku-locator-continuity-attention');
    assert.equal(t.HayakuAttention.buttonSignature, '');
  } finally {
    await runtime.dispose();
  }
  console.log('PASS hayaku_zero_touch_attention_runtime_test');
})().catch(error => { console.error(error); process.exit(1); });
