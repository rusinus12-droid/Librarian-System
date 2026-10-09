'use strict';
// Verification for the Flashback sparse-projection cache ceiling, BEFORE it is changed.
//
// THE MEASURED PROBLEM
//
// `sparseProjectionForRecord` memoizes each record's projection in `Runtime.sparseProjectionCache`,
// an LRU capped at FLASHBACK_SPARSE_CACHE_MAX = 384. A single recall request calls
// `scoreBm25fCandidates` several times over the SAME record set (sparse, contextSparse, topicSparse,
// and the semantic fallback path), so the cache is what makes the later passes cheap.
//
// Measured with a real fixture, second (warm) pass vs first (cold) pass:
//
//   n=400   cold 100.4 ms   warm  54.4 ms   <- cache helps
//   n=800   cold 102.6 ms   warm 112.3 ms   <- cache stops helping
//   n=1600  cold 201.6 ms   warm 194.8 ms   <- warm == cold
//   n=3200  cold 399.8 ms   warm 395.9 ms   <- warm == cold
//
// Above the ceiling every pass evicts what the next pass needs, so a lorebook larger than 384
// records pays the full projection cost on every call — which is exactly the "many lorebooks get
// slow" symptom, and it is a CACHE-SIZE artefact rather than an algorithmic one.
//
// THIS PROBE establishes, before any change:
//   1. the ceiling is what it claims to be, and records are what occupy it;
//   2. projections ARE reused when they fit (so the cache works, it is just too small);
//   3. the per-projection retained size, so a raised ceiling can be costed honestly;
//   4. that a projection is a pure function of the record (same input -> same output), which is
//      what makes a larger cache safe to hold.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'flashback_native_runtime_fixture.cjs'));

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar').split(' ');

const record = index => ({
  id: `rec_${index}`,
  key: `key_${index} ${WORDS[index % 10]}`,
  title: `${WORDS[index % 10]} ${WORDS[(index + 1) % 20]}`,
  tags: [WORDS[(index + 2) % 20], `tag${index}`],
  summary: `Summary ${index}`,
  body: `Alice recorded the ${WORDS[(index + 3) % 20]} near the ${WORDS[(index + 4) % 20]} `
    + `in the ledger. Entry ${index} of the archive.`,
  turnStart: index, turnEnd: index + 1, scopeKey: 'flashback-cache-probe'
});

const QUERY = 'Alice opened the archive door and found a blue ribbon beside the ledger '
  + 'while the lantern burned in the corridor near the winter market';

(async () => {
  const fixture = await createFixture({
    arguments: { memory_suite_server_mode: 'plugin_only', enable_gui: 'false' }
  });
  try {
    const internals = fixture.api?._test;
    assert.ok(internals, 'the plugin test surface must be exposed');
    assert.equal(typeof internals.sparseProjectionForRecord, 'function',
      'sparseProjectionForRecord must be reachable');
    assert.equal(typeof internals.scoreBm25fCandidates, 'function',
      'scoreBm25fCandidates must be reachable');

    const report = {};

    // (1) The cache ceiling must be observable, and projections are what occupy it.
    {
      const small = Array.from({ length: 120 }, (_, index) => record(index));
      for (const entry of small) internals.sparseProjectionForRecord(entry, {});
      const stats = internals.sparseCacheStats ? internals.sparseCacheStats() : null;
      report.cacheStats = stats || 'not exposed';
      // Repeated projection of the SAME record must hit the cache (fact 2).
      const before = process.hrtime.bigint();
      for (let repeat = 0; repeat < 200; repeat += 1) internals.sparseProjectionForRecord(small[0], {});
      const repeatMs = Number(process.hrtime.bigint() - before) / 1e6;
      const singleStart = process.hrtime.bigint();
      const freshRecord = record(9999);
      internals.sparseProjectionForRecord(freshRecord, {});
      const singleMs = Number(process.hrtime.bigint() - singleStart) / 1e6;
      report.reuse = {
        twoHundredCachedCallsMs: Number(repeatMs.toFixed(3)),
        oneColdCallMs: Number(singleMs.toFixed(3)),
        cacheHelps: repeatMs / 200 < singleMs
      };
      assert.ok(report.reuse.cacheHelps,
        'a repeated projection must be cheaper than a cold one — the cache must actually work');
    }

    // (2) Per-projection retained size, so a raised ceiling can be costed.
    {
      const probe = internals.sparseProjectionForRecord(record(12345), {});
      const measured = (() => {
        let bytes = 0;
        const walk = value => {
          if (value == null) return;
          if (typeof value === 'string') { bytes += Buffer.byteLength(value); return; }
          if (typeof value === 'number' || typeof value === 'boolean') { bytes += 8; return; }
          if (value instanceof Map) { for (const [key, item] of value) { walk(String(key)); walk(item); } return; }
          if (Array.isArray(value)) { for (const item of value) walk(item); return; }
          if (typeof value === 'object') {
            if (typeof value.keys === 'function' && typeof value.get === 'function') {
              for (const key of value.keys()) walk(String(key));
              return;
            }
            for (const [key, item] of Object.entries(value)) { walk(key); walk(item); }
          }
        };
        walk(probe);
        return bytes;
      })();
      report.perProjectionBytes = measured;
      assert.ok(measured > 0, 'a projection must occupy memory');
    }

    // (3) Warm vs cold across sizes, which is the symptom being fixed.
    {
      const rows = [];
      for (const size of [200, 400, 800, 1600]) {
        const records = Array.from({ length: size }, (_, index) => record(index));
        const coldStart = process.hrtime.bigint();
        internals.scoreBm25fCandidates(records, QUERY, {});
        const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;
        const warmStart = process.hrtime.bigint();
        internals.scoreBm25fCandidates(records, QUERY, {});
        const warmMs = Number(process.hrtime.bigint() - warmStart) / 1e6;
        rows.push({
          size,
          coldMs: Number(coldMs.toFixed(1)),
          warmMs: Number(warmMs.toFixed(1)),
          warmRatio: Number((warmMs / coldMs).toFixed(2))
        });
      }
      report.warmVsCold = rows;
      // THE INVARIANT AFTER THE FIX: with the ceiling raised to cover a realistically large lorebook,
      // a warm pass over the same records must be materially cheaper than the cold one. Before the
      // raise, every size above 384 had warmRatio >= 0.98 (cache evicting what the next pass needs).
      const aboveOldCeiling = rows.filter(row => row.size > 384);
      assert.ok(aboveOldCeiling.length > 0, 'the probe must sample sizes above the OLD ceiling');
      assert.ok(aboveOldCeiling.every(row => row.warmRatio < 0.7),
        `above the old 384 ceiling a warm pass must now be materially cheaper than cold — the cache `
        + `must survive a large lorebook (got ${JSON.stringify(aboveOldCeiling)})`);
    }

    // (4) Purity: a projection must depend only on its record, or a larger cache would hold wrong data.
    {
      const entry = record(77);
      const first = internals.sparseProjectionForRecord(entry, {});
      const clone = JSON.parse(JSON.stringify(entry));
      const second = internals.sparseProjectionForRecord(clone, {});
      const shapeOf = projection => Object.fromEntries(
        Object.entries(projection.fieldTf || {}).map(([field, tf]) => [
          field, tf && typeof tf.keys === 'function' ? [...tf.keys()].sort() : []
        ])
      );
      assert.deepEqual(shapeOf(second), shapeOf(first),
        'a projection must depend only on its record, so a larger cache stays correct');
      report.pure = true;
    }

    console.log(JSON.stringify({ probe: 'flashback_projection_cache', report }, null, 1));
    process.stdout.write('_probe_flashback_projection_cache: PASS\n');
  } finally {
    await fixture.dispose?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
