'use strict';
// A source-edit reanalysis of several batches keeps going after a batch whose
// record admission quarantined a State field. The quarantine is permanent for that
// canonical record, so the next batch's replayed prefix can never become 'ready';
// it must still be usable instead of failing with UNIFIED_EDIT_PREFIX_PENDING.
const assert = require('node:assert/strict');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { selection } = require('./fixtures/libra_selected_source_contract.cjs');
const clone = x => JSON.parse(JSON.stringify(x));
const shifted = offset => {
  const out = artifact();
  for (const row of [...out.entities, ...out.facts]) for (const span of row.evidenceSpans)
    span.ref = span.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + offset}`);
  return out;
};

(async () => {
  const f = await fixture();
  const base = clone(f.chat.message);
  f.chat.message.push(...base.map((row, index) => ({ ...row, chatId: `t${6 + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}` })));
  f.chat.messages = f.chat.message;
  let editing = false;
  f.control.onCall = args => {
    const second = JSON.stringify(args).includes('[TURN 6]');
    const out = second ? shifted(5) : artifact();
    if (editing && !second) {
      // A thread filed under "world" has one reading and is normalized to narrative.
      out.facts.find(row => row.tempFactId === 'f12').domain = 'world';
      // A claim kind whose fixed domain disagrees outright stays quarantined.
      const template = out.facts.find(row => row.tempFactId === 'f13');
      out.facts.push({ ...clone(template), tempFactId: 'f99', domain: 'character', subjectTempRef: 'mina' });
    }
    return { type: 'success', result: JSON.stringify(out) };
  };
  const initial = await f.run();
  assert.equal(initial.completed, 2, JSON.stringify(initial));

  editing = true;
  const result = await f.r.api.startSelectedCanonicalBatches(await selection(f, [1, 6]));
  assert.deepEqual(clone(result.job.failures || []), [], 'no batch fails after a partial first batch');
  assert.equal(result.job.completed, 2, JSON.stringify(result.job));
  assert.equal(result.ok, true, JSON.stringify(result));

  const admission = clone(result.job.memoryWarnings.find(row => row.startTurn === 1)?.admission || null);
  assert.ok(admission, 'first batch is a partial admission');
  assert.deepEqual(admission.rejected.map(row => [row.id, row.reason]), [['f99', 'UNIFIED_FACT_KIND_INVALID']]);
  assert.ok(admission.stateBlocks.some(row => row.fact === 'f99'), 'the rejected field update still fences State');
  assert.ok(admission.normalizedFields.some(row => row.field === 'domain' && row.from === 'world' && row.to === 'narrative'),
    'world-filed thread is normalized to its narrative contract');
  const memory = f.getMemory(1);
  assert.ok(memory.canonicalArtifact.facts.some(row => row.tempFactId === 'f12' && row.domain === 'narrative'),
    'normalized thread is retained in the canonical record');
  const manifest = f.getManifest();
  for (const start of ['1', '6']) {
    assert.equal(manifest.memories[start].status, 'committed');
    assert.ok(Number(manifest.memories[start].revision) > 1, `T${start} batch was replaced`);
  }
  process.stdout.write(JSON.stringify({ test: 'libra_source_edit_partial_prefix_continuation', passed: true }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
