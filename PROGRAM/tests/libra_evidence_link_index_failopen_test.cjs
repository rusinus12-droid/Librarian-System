'use strict';
// Stage 1 must fail open. The index is derived and regenerable, so a storage failure, an
// unreadable memory or a bounded index must degrade the index only: the baseline recall path
// keeps producing exactly the same answer, and the partial state is disclosed rather than
// presented as complete.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_evidence_link_index_fixture.cjs');

const INDEX_KEY = /evidence-link-index/;
const results = [];
const enabled = (options = {}) => fixture({ ...options, args: { evidence_link_index_enabled: 'true', ...options.args } });
const plain = value => JSON.parse(JSON.stringify(value));
const VOLATILE = new Set(['updatedAt', 'snapshotDigest', 'builtAt', 'buildMs', 'runId', 'createdAt', 'at', 'embedding']);
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.has(key)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
};
const recallOf = async f => stable(plain(await f.r.api.previewUnifiedMemoryRecall('도서관 공연 허가')));
// The recall comparison ignores exactly ONE field: the feature's own diagnostic, which is expected to
// differ because the index is on in one run and off in the other. It is not something a model receives,
// and the earlier whole-object comparison passed only because the key was ABSENT in both states — so this
// names the exception and asserts its CONTENT separately, which is strictly stronger than comparing two
// absences. Every other field, including the delivered `memories`, is still compared exactly.
const withoutFeatureDiagnostic = value => {
  const copy = JSON.parse(JSON.stringify(value ?? null));
  if (copy && typeof copy === 'object' && copy.diagnostics && typeof copy.diagnostics === 'object') delete copy.diagnostics.associativeRecall;
  return stable(copy);
};
const recallCompared = async f => withoutFeatureDiagnostic(await f.r.api.previewUnifiedMemoryRecall('도서관 공연 허가'));
async function complete(f) { const result = await f.run(); assert.equal(result.completed, 1, JSON.stringify(result).slice(0, 600)); }
async function test(name, options, fn) { const f = await enabled(options); try { await fn(f); results.push(name); } finally { await f.r.cleanup(); } }

(async () => {
  // The baseline every degraded case must keep intact.
  const base = await fixture({});
  let baseline;
  try { await complete(base); baseline = await recallCompared(base); }
  finally { await base.r.cleanup(); }

  await test('a failing index write degrades the index, not recall', {}, async f => {
    await complete(f);
    const original = f.r.values.set.bind(f.r.values);
    f.r.values.set = (key, value) => {
      if (INDEX_KEY.test(String(key))) throw new Error('synthetic storage failure');
      return original(key, value);
    };

    const index = await f.r.api.getEvidenceLinkIndex({ force: true });
    assert.equal(index.schema, 'libra.evidence_link_index.v1', 'the built view is still returned');
    assert.equal(index.status.persisted, false);
    assert.equal(index.status.partial, true, 'a failed persist must not be reported as complete');
    assert.equal(index.status.complete, false);
    assert.ok(plain(index.status.reasons).includes('persist_failed'));
    assert.equal(index.facts.length, 13, 'the view itself stays fully usable');
    assert.equal(index.entities.length, 10);

    f.r.values.set = original;
    assert.deepEqual(await recallCompared(f), baseline, 'recall must be unaffected by an index write failure');

    // The exempted diagnostic is asserted BY CONTENT so the exception cannot hide a change: with the index
    // enabled and reachable, the observation reports that it ran, and it still costs no provider call.
    const diagnostic = plain(await f.r.api.previewUnifiedMemoryRecall('도서관 공연 허가'))?.diagnostics?.associativeRecall;
    assert.ok(diagnostic, 'the enabled feature reports its own diagnostic');
    assert.equal(diagnostic.active, false, 'this corpus reaches nothing, and the report says so');
    assert.equal(diagnostic.providerCalls, 0, 'the observation adds no provider call');
    assert.notEqual(diagnostic.mode, 'disabled', 'the index is enabled here, so the diagnostic must not report disabled');
  });

  await test('one unreadable memory degrades that memory alone, not the whole index', {}, async f => {
    await complete(f);
    // A manifest that declares a committed memory whose record is gone. The readable memory
    // must still be indexed in full; only the missing one is dropped and disclosed.
    const key = [...f.r.values.keys()].find(entry => entry.endsWith(':manifest'));
    const manifest = JSON.parse(f.r.values.get(key));
    manifest.memories['6'] = {
      memoryId: 'mem_000006', key: `libra:v1:scope:${manifest.scopeKey}:memory:6:r1`, revision: 1,
      status: 'committed', worldlineId: 'main', turnRange: { start: 6, end: 10 }, summary: '', vectorCount: 0
    };
    f.r.values.set(key, JSON.stringify(manifest));

    const index = await f.r.api.getEvidenceLinkIndex({ force: true });
    assert.equal(index.status.partial, true);
    assert.ok(plain(index.status.reasons).includes('memory_unavailable'));
    assert.equal(index.status.totalMemoryCount, 2, 'both declared memories are counted in the basis');
    assert.equal(index.status.indexedMemoryCount, 1);
    assert.equal(index.memories.length, 1, 'the readable memory is still indexed');
    assert.equal(index.facts.length, 13, 'and contributes all of its facts');
    assert.equal(index.entities.length, 10);
  });

  await test('an unreadable basis leaves recall exactly as the corruption alone leaves it', {}, async f => {
    await complete(f);
    // The canonical record is the one source both paths read, so corrupting it breaks recall
    // by itself. What must hold is that the index adds nothing on top: the same corruption
    // must produce the same recall with the index on and the index off.
    const corrupt = target => target.r.values.set(Object.values(target.getManifest().memories)[0].key, '{ this is not valid json');
    const off = await fixture({});
    let recallWithIndexOff;
    try { await complete(off); corrupt(off); recallWithIndexOff = await recallCompared(off); }
    finally { await off.r.cleanup(); }

    corrupt(f);
    const index = await f.r.api.getEvidenceLinkIndex({ force: true });
    assert.equal(index.status.partial, true, 'the loss of the basis must be disclosed');
    assert.ok(plain(index.status.reasons).includes('memory_unavailable'));
    assert.equal(index.facts.length, 0, 'the unreadable memory contributes no facts');
    assert.equal(index.memories.length, 0);
    assert.equal(index.status.totalMemoryCount, 1, 'the unreadable memory is still counted in the basis');
    assert.deepEqual(await recallCompared(f), recallWithIndexOff, 'the index must not change what the corruption already did to recall');
  });

  await test('a bounded index reports partial instead of silently truncating', {
    transformSource: source => source.replace('const EVIDENCE_LINK_INDEX_MEMORY_LIMIT = 512;', 'const EVIDENCE_LINK_INDEX_MEMORY_LIMIT = 0;')
  }, async f => {
    await complete(f);
    const index = await f.r.api.getEvidenceLinkIndex({});
    assert.equal(index.status.partial, true);
    assert.ok(plain(index.status.reasons).includes('memory_limit'));
    assert.equal(index.memories.length, 0);
    assert.equal(index.status.totalMemoryCount, 1);
    assert.equal(index.status.indexedMemoryCount, 0);
    assert.deepEqual(await recallCompared(f), baseline, 'a bounded index must not change recall');
  });

  await test('the index is confined to its own per-scope key', {}, async f => {
    await complete(f);
    await f.r.api.getEvidenceLinkIndex({});
    const scopeKey = f.getHead().scopeKey;
    assert.deepEqual([...f.r.values.keys()].filter(key => INDEX_KEY.test(key)),
      [`libra:v1:scope:${scopeKey}:evidence-link-index:v1`]);
    const writes = [...f.r.storageWrites].filter(write => INDEX_KEY.test(write.key));
    assert.equal(writes.length, 1, 'exactly one index write');
    for (const guarded of ['entity-registry:v2', 'continuity-state', ':manifest']) {
      assert.equal(INDEX_KEY.test(writes[0].key) && writes[0].key.includes(guarded), false, `${guarded} must not be rewritten by the index`);
    }
  });

  console.log(JSON.stringify({ suite: 'libra_evidence_link_index_failopen', passed: results.length, tests: results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
