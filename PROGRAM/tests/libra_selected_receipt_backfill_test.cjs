'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const clone = x => JSON.parse(JSON.stringify(x));
function appendTo40(f) {
  const base = clone(f.chat.message);
  for (let batch = 2; batch <= 8; batch++) {
    f.chat.message.push(...base.map((row, index) => ({ ...row,
      chatId: `t${(batch - 1) * 5 + 1 + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}` })));
  }
  f.chat.messages = f.chat.message;
  f.control.artifact = artifact();
  for (const row of [...f.control.artifact.entities, ...f.control.artifact.facts]) {
    for (const span of row.evidenceSpans) span.ref = span.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + 5}`);
  }
}
const allRows = s => [...s.local.entries()].map(([key, raw]) => {
  let value; try { value = JSON.parse(raw); } catch { value = raw; }
  return { key, value };
}).concat(s.storedRows());
for (const mode of ['plugin_only', 'server_only']) test(`${mode}: selected historical batch outside receipt tail is captured without capturing unselected older turns`, async () => {
  const s = await serverFixture({ mode });
  try {
    const f = s.f; appendTo40(f);
    const inventory = await f.r.api.listCanonicalBatchRanges();
    assert.equal(inventory.observedTurns, 40);
    const selected = inventory.ranges.find(row => row.startTurn === 6);
    assert.equal(selected.status, 'missing');
    const before = JSON.stringify(allRows(s));
    await assert.rejects(f.r.api.startSelectedCanonicalBatches({ scopeKey: inventory.scopeKey,
      mode: 'missing', ranges: [{ ...selected, sourceDigest: 'wrong' }] }), /selected_batch_source_changed/);
    assert.equal(f.control.calls.length, 0, 'stale selection must not invoke analysis');
    assert.equal(JSON.stringify(allRows(s)), before, 'stale selection must not publish receipts or canonical data');
    const job = await f.r.api.startSelectedCanonicalBatches({ scopeKey: inventory.scopeKey, mode: 'missing', ranges: [selected] });
    assert.equal(job.completed, 1, `selected T6-10 must commit: ${JSON.stringify(job)}`);
    assert.equal(job.failed, 0);
    assert.equal(f.control.calls.length, 1, 'only the selected batch is analysed');
    const rows = allRows(s);
    const heads = new Set(rows.filter(row => row.value?.schema === 'libra.completed_turn_head.v1').map(row => row.value.turn));
    for (let turn = 6; turn <= 40; turn++) assert.ok(heads.has(turn), `selected plus original bounded tail has T${turn} receipt`);
    for (let turn = 1; turn <= 5; turn++) assert.equal(heads.has(turn), false, `unselected old T${turn} stays outside capture window`);
    const manifest = rows.find(row => row.value?.schema === 'libra.manifest.v1').value;
    assert.deepEqual(Object.keys(manifest.memories), ['6']);
    assert.equal(manifest.memories['6'].status, 'committed');
    const captures = rows.filter(row => row.value?.schema === 'libra.completed_turn_capture.v1' && row.value.turn >= 6 && row.value.turn <= 10);
    assert.equal(new Set(captures.map(row => row.value.turn)).size, 5);
    for (const row of captures) assert.deepEqual(clone(row.value.captureSources), ['completed_pair_reconcile'], 'historical preparation must not impersonate an output hook');
  } finally { await s.cleanup(); }
});
