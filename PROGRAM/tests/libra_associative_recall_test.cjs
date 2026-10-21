'use strict';
// Retirement contract for the Stage 3/4 associative recall (evidence-graph expansion).
//
// Commit 9c03c35 replaced LIBRA's legacy retrieval with the unified memory engine
// (docs/LIBRA_UNIFIED_SEARCH_REPLACEMENT_CONTRACT_20261014.md): catalog/evidence-link preparation after
// canonical adoption is ended and recall no longer builds or reads the evidence-link index. The old
// observation/participation behavior (added/omitted candidates, admit limit, bridges) is gone. What stays
// true, and what this suite holds to through the PUBLIC surface on a REAL committed batch:
//   - getAssociativeRecallDiagnostics is a retired read model (available:false, participation off);
//   - recall never reads or builds the evidence-link index, even with the explicit opt-in flags;
//   - the unified engine alone serves the recall and makes no provider / LLM / embedding calls for it;
//   - the opt-in flags do not change which memories are delivered.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_lore_link_index_fixture.cjs');

const results = [];
const plain = value => JSON.parse(JSON.stringify(value ?? null));
const INDEX_KEY = ':evidence-link-index:v1';

async function withFixture(name, args, fn) {
  const f = await fixture({ args: args || {} });
  try { await fn(f); results.push(name); } finally { await f.r.cleanup(); }
}

(async () => {
  let baselineIds;
  await withFixture('default recall is served by the unified engine and does not touch the evidence graph', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    const reads = () => f.r.storageReads.filter(key => key.includes(INDEX_KEY)).length;
    const before = reads();
    const recalled = plain(await f.r.api.previewUnifiedMemoryRecall('서재 열쇠'));
    assert.equal(reads(), before, 'recall must not even check the evidence-link index storage key');
    assert.equal(recalled.diagnostics.memoryEngine.mode, 'unified');
    assert.ok(recalled.memories.length > 0, 'the unified engine must still deliver memories');
    assert.equal(f.getRecords('libra.evidence_link_index.v1').length, 0, 'recall must not build the index');
    baselineIds = recalled.memories.map(m => m.memoryId);
  });

  await withFixture('associative diagnostics are a retired read model', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
    const read = plain(await f.r.api.getAssociativeRecallDiagnostics());
    assert.equal(read.schema, 'libra.associative_recall.v1');
    assert.equal(read.retired, true);
    assert.equal(read.available, false);
    assert.equal(read.participationEnabled, false, 'no associative candidate is admitted');
    assert.equal(read.engine, 'unified');
    for (const retiredField of ['mode', 'admitLimit', 'added', 'omitted', 'bridges', 'candidates']) {
      assert.equal(read.observation?.[retiredField], undefined, `retired observation field ${retiredField} must be absent`);
    }
  });

  await withFixture('explicit evidence/lore link opt-in no longer makes recall read or build a graph index', {
    evidence_link_index_enabled: 'true', lore_link_index_enabled: 'true'
  }, async f => {
    assert.equal((await f.run()).completed, 1);
    const calls = f.control.calls.length;
    const before = f.r.storageReads.filter(key => key.includes(INDEX_KEY)).length;
    const recalled = plain(await f.r.api.previewUnifiedMemoryRecall('서재 열쇠'));
    const after = f.r.storageReads.filter(key => key.includes(INDEX_KEY)).length;
    assert.equal(after, before, 'the opt-in must not revive the retired graph expansion on the recall path');
    assert.equal(f.control.calls.length, calls, 'recall makes no provider / LLM / embedding call');
    assert.deepEqual(recalled.memories.map(m => m.memoryId), baselineIds,
      'the opt-in flags must not change which memories are delivered');
    assert.equal(plain(await f.r.api.getAssociativeRecallDiagnostics()).participationEnabled, false);
  });

  console.log(`libra_associative_recall_test: PASS (${results.length})`);
})().catch(error => { console.error(error); process.exit(1); });
