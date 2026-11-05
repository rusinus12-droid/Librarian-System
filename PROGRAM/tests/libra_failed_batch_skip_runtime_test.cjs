'use strict';
// A failed batch is skipped: later turns are analysed and State keeps moving. Retrying just that batch fills
// the hole and replays State in order.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

(async () => {
  let failFirst = true, f;
  f = await fixture();
  try {
    const base = input.sourceRows, shift = ref => ref.replace(/^t(\d)/, (_, n) => 't' + (Number(n) + 5));
    const message = [...base.map(r => ({ role: r.role, chatId: r.ref, data: r.text })), ...base.map(r => ({ role: r.role, chatId: shift(r.ref), data: r.text + ' (이후)' }))];
    f.chat.message = message; f.chat.messages = message;
    const later = () => { const a = JSON.parse(JSON.stringify(f.control.artifact)); a.facts = a.facts.filter(x => ['f5', 'f9'].includes(x.tempFactId)).map(x => ({ ...x, evidenceSpans: x.evidenceSpans.map(span => ({ ref: shift(span.ref), quote: span.quote })) })); a.stateBindings = a.stateBindings.filter(b => ['f5', 'f9'].includes(b.factTempId)); return a; };
    f.control.onCall = async args => { const text = JSON.stringify(args); if (text.includes('[LIBRA MICRO SOURCE')) return { type: 'error', result: 'skip' }; const first = text.includes('t1-a'); if (first && failFirst) return { type: 'error', result: 'synthetic_failure' }; return { type: 'success', result: JSON.stringify(first ? f.control.artifact : later()) }; };
    const cold = await f.r.api.runManualColdStart();
    assert.equal(cold.failed, 1, 'the first batch fails');
    assert.equal(cold.completed, 1, 'the next batch still runs');
    let head = f.getHead();
    assert.equal(head.throughTurn, 10, 'State moved past the failed batch');
    assert.ok(head.characters.find(row => row.name === '민아').state.knowledge?.length, 'with the later facts');
    assert.deepEqual(head.skippedRanges.map(row => [row.start, row.end]), [[1, 5]], 'and says what it skipped');
    const view = await f.r.api.debugLoadContinuityStateForResponse();
    assert.ok(view.head?.characters?.length, 'the response can read it');

    failFirst = false;
    const retry = await f.r.api.runManualColdStart();
    assert.equal(retry.skipped, 1, 'the batch already saved is left alone');
    for (let i = 0; i < 100 && !f.getManifest().memories['1']; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.getManifest().memories['1']?.status, 'committed', 'only the failed batch is retried');
    for (let i = 0; i < 100 && f.getHead().skippedRanges?.length; i++) await new Promise(resolve => setTimeout(resolve, 100));
    head = f.getHead();
    assert.equal(head.throughTurn, 10);
    assert.equal(head.skippedRanges, undefined, 'the hole is filled');
    assert.ok(head.world.some(row => row.name === '은빛 열쇠'), 'with what the retried batch held');
    console.log('PASS a failed batch is skipped and retried on its own');
  } finally { await f.r.cleanup?.(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
