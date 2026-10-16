'use strict';
// Current successor of the retired Classic/Planner/SGA overlay inspection.
// Planner and SGA renderers no longer exist. Persisted choices normalize to
// Classic; current evidence, request authority and re-entry guards still matter.
// This does not qualify removed brief/draft generation or their semantic gates.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const MARKERS = {
  classic: '[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]',
  planner: '[LIBRA TURN PLANNER — CURRENT TURN ONLY]',
  sga: '[LIBRA SGA DRAFT — CURRENT TURN ONLY]',
  memory: '[LIBRA 장기기억 — 관련 기억만 시간순으로 제공됨]'
};
const clone = value => JSON.parse(JSON.stringify(value));
(async () => {
  const f = await fixture({ args: { memory_suite_server_mode: 'plugin_only' } });
  try {
    assert.equal((await f.run()).completed, 1);
    assert.equal((await f.r.api.retryPendingUnifiedVectors()).ok, true);
    for (const removed of ['debugPlannerFinalOverlay', 'debugSgaFinalOverlay', 'prepareInputWriterEvidence']) {
      assert.equal(typeof f.r.api[removed], 'undefined', `${removed} remains retired`);
    }
    const reports = [];
    for (const requested of ['classic', 'planner', 'sga']) {
      const config = await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: requested });
      const before = f.control.calls.length;
      const input = [{ role: 'user', content: '민아와 은빛 열쇠의 현재 상황은?' }];
      const output = clone(await f.control.hooks.beforeRequest(input, 'model'));
      const context = f.r.api.getLastResponseContext();
      const viewer = f.r.api.getLastMemoryRecallViewer();
      assert.equal(context.route, 'classic', `${requested}: saved legacy selection consumes current Classic`);
      assert.equal((await f.r.api.validateResponseContext(context)).current, true);
      const injected = output.filter(row => row.role === 'system' && row.content.includes(MARKERS.classic));
      assert.equal(injected.length, 1, `${requested}: actual registered hook delivers one block`);
      const block = injected[0].content;
      const delivered = Array.from(viewer.rows).filter(row => row.classicUsed && row.injected);
      assert.ok(delivered.length > 0, 'real canonical evidence reaches the model request');
      for (const row of delivered) assert.ok(block.includes(row.selectedText || row.text), 'actual evidence bytes survive the final hop');
      assert.match(block, /current user input.*priority/i);
      assert.match(block, /Do not mention/);
      assert.equal(output.filter(row => row.role === 'user').at(-1).content, input[0].content);
      assert.equal(f.control.calls.length, before, 'Classic makes no rewriting provider call');
      for (const legacy of ['planner', 'sga']) assert.equal(block.includes(MARKERS[legacy]), false);
      assert.deepEqual(clone(await f.control.hooks.beforeRequest(output, 'model')), output, 're-entry preserves exact prompt');
      reports.push({ requested, actualRoute: context.route, deliveredRows: delivered.length, extraProviderCalls: 0 });
    }
    for (const marker of Object.values(MARKERS)) {
      const input = [{ role: 'system', content: marker + '\nold recorded injection' }, { role: 'user', content: 'Continue' }];
      assert.deepEqual(clone(await f.control.hooks.beforeRequest(input, 'model')), input, 'historical injection markers still prevent duplicate injection');
    }
    const secondary = [{ role: 'user', content: 'Unrelated secondary request' }];
    assert.deepEqual(clone(await f.control.hooks.beforeRequest(secondary, 'secondary')), secondary);
    console.log(JSON.stringify({ test: 'libra_three_mode_feature_inspection', currentContract: 'Classic plus retired-mode normalization',
      historicalGap: 'No Planner/SGA renderer, provider generation, brief/draft schema-echo gate or sidecar contract is claimed', reports }));
    console.log('libra_three_mode_feature_inspection_test: PASS (current successor)');
  } finally { await f.r.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
