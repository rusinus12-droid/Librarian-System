'use strict';
// Guard for the Flashback sparse-projection cache ceiling.
//
// THE DEFECT THIS LOCKS DOWN
//
// `sparseProjectionForRecord` memoizes each record's projection in an LRU capped at
// FLASHBACK_SPARSE_CACHE_MAX. A single recall request scores the SAME record set several times over
// (`scoreBm25fCandidates` is called for the sparse pass, the context pass, the topic pass, and the
// semantic fallback path), so that cache is what makes the later passes cheap.
//
// The ceiling was 384. Measured with the real fixture, warm/cold ratio as the ceiling was crossed:
//
//   n=200   cold  46.6 ms   warm  10.1 ms   (0.22 — cache working)
//   n=400   cold  87.0 ms   warm 146.6 ms   (1.68 — evicting what the next pass needs)
//   n=800   cold 296.9 ms   warm 289.7 ms   (0.98 — warm no cheaper than cold)
//   n=1600  cold 572.4 ms   warm 639.5 ms   (1.12 — warm no cheaper than cold)
//
// So a lorebook larger than the ceiling paid FULL projection cost on every pass — the "large recall
// set gets slow" symptom, produced by a cache-size artefact rather than by the algorithm.
//
// THE INVARIANTS ASSERTED HERE
//
//   1. The cache must actually work: projecting the same record repeatedly is much cheaper than a
//      cold projection, so a later pass reuses the earlier pass's work.
//   2. The ceiling must cover a realistically large lorebook: above the OLD ceiling a warm pass must
//      be materially cheaper than cold. This is the regression guard — lowering the ceiling back
//      toward 384 fails here.
//   3. A projection must be a pure function of its record, which is what makes the larger cache safe
//      to hold (a stale or record-dependent value would be a correctness bug, not a memory policy).
//   4. The ceiling must stay BOUNDED: the retained size is measured, and the ceiling must not be
//      raised without limit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar').split(' ');

const record = index => ({
  id: `cache_guard_${index}`,
  key: `key_${index} ${WORDS[index % 10]}`,
  title: `${WORDS[index % 10]} ${WORDS[(index + 1) % 20]}`,
  tags: [WORDS[(index + 2) % 20], `tag${index}`],
  summary: `Summary ${index}`,
  body: `Alice recorded the ${WORDS[(index + 3) % 20]} near the ${WORDS[(index + 4) % 20]} `
    + `in the ledger. Entry ${index} of the archive.`,
  turnStart: index, turnEnd: index + 1, scopeKey: 'flashback-cache-guard'
});

const QUERY = 'Alice opened the archive door and found a blue ribbon beside the ledger '
  + 'while the lantern burned in the corridor near the winter market';

(async () => {
  // ------------------------------------------------------------------------------------------
  // Static: the ceiling must exist, be a number, and stay within a bound this test enforces.
  // ------------------------------------------------------------------------------------------
  const ceilingMatch = PLUGIN.match(/const FLASHBACK_SPARSE_CACHE_MAX\s*=\s*(\d[\d_]*)\s*;/);
  assert.ok(ceilingMatch, 'FLASHBACK_SPARSE_CACHE_MAX must be declared');
  const ceiling = Number(ceilingMatch[1].replace(/_/g, ''));
  assert.ok(Number.isFinite(ceiling) && ceiling > 0, `the ceiling must be a positive number (got ${ceiling})`);
  // The guard for invariant 4: raised deliberately (384 -> 4096), not unbounded.
  assert.ok(ceiling >= 2048,
    `the ceiling must cover a realistically large lorebook, not just a small one (got ${ceiling})`);
  assert.ok(ceiling <= 65536,
    `the ceiling must stay bounded so the cache cannot grow without limit (got ${ceiling})`);

  const fixture = await createFixture({
    arguments: { memory_suite_server_mode: 'plugin_only', enable_gui: 'false' }
  });
  try {
    const internals = fixture.api?._test;
    assert.ok(internals, 'the plugin test surface must be exposed');
    for (const name of ['sparseProjectionForRecord', 'scoreBm25fCandidates']) {
      assert.equal(typeof internals[name], 'function', `${name} must be reachable`);
    }

    // ----------------------------------------------------------------------------------------
    // 1. The cache works at all: a repeated projection is far cheaper than a cold one.
    // ----------------------------------------------------------------------------------------
    const warmup = Array.from({ length: 64 }, (_, index) => record(index));
    for (const entry of warmup) internals.sparseProjectionForRecord(entry, {});

    const cachedStart = process.hrtime.bigint();
    for (let repeat = 0; repeat < 400; repeat += 1) internals.sparseProjectionForRecord(warmup[0], {});
    const cachedMs = Number(process.hrtime.bigint() - cachedStart) / 1e6;

    const coldStart = process.hrtime.bigint();
    internals.sparseProjectionForRecord(record(999_999), {});
    const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;

    const cachedPerCall = cachedMs / 400;
    assert.ok(cachedPerCall < coldMs,
      `a cached projection must be cheaper than a cold one (cached ${cachedPerCall.toFixed(4)}ms vs cold ${coldMs.toFixed(4)}ms)`);

    // ----------------------------------------------------------------------------------------
    // 2. INVARIANT: above the OLD 384 ceiling, a warm pass must be materially cheaper than cold.
    //    This is the regression guard — a ceiling back near 384 fails here.
    // ----------------------------------------------------------------------------------------
    const rows = [];
    for (const size of [600, 1200, 2400]) {
      const records = Array.from({ length: size }, (_, index) => record(index));
      const coldPass = process.hrtime.bigint();
      internals.scoreBm25fCandidates(records, QUERY, {});
      const coldMsPass = Number(process.hrtime.bigint() - coldPass) / 1e6;
      const warmPass = process.hrtime.bigint();
      internals.scoreBm25fCandidates(records, QUERY, {});
      const warmMsPass = Number(process.hrtime.bigint() - warmPass) / 1e6;
      rows.push({
        size,
        coldMs: Number(coldMsPass.toFixed(1)),
        warmMs: Number(warmMsPass.toFixed(1)),
        ratio: Number((warmMsPass / coldMsPass).toFixed(2))
      });
    }
    const failing = rows.filter(row => !(row.ratio < 0.7));
    assert.deepEqual(failing, [],
      `above the old 384 ceiling a warm scoring pass must be materially cheaper than cold; `
      + `a cache ceiling that does not cover the record set makes warm == cold (${JSON.stringify(rows)})`);

    // ----------------------------------------------------------------------------------------
    // 3. Purity: a projection depends only on its record, so a larger cache is safe.
    // ----------------------------------------------------------------------------------------
    {
      const entry = record(4242);
      const first = internals.sparseProjectionForRecord(entry, {});
      const second = internals.sparseProjectionForRecord(JSON.parse(JSON.stringify(entry)), {});
      const shapeOf = projection => Object.fromEntries(
        Object.entries(projection.fieldTf || {}).map(([field, tf]) => [
          field, tf && typeof tf.keys === 'function' ? [...tf.keys()].sort() : []
        ])
      );
      assert.deepEqual(shapeOf(second), shapeOf(first),
        'a projection must depend only on its record');
    }

    // ----------------------------------------------------------------------------------------
    // 4. Bounded memory: measure the retained size and report it against the ceiling.
    // ----------------------------------------------------------------------------------------
    const sample = internals.sparseProjectionForRecord(record(777), {});
    const bytesOf = value => {
      let bytes = 0;
      const walk = item => {
        if (item == null) return;
        if (typeof item === 'string') { bytes += Buffer.byteLength(item); return; }
        if (typeof item === 'number' || typeof item === 'boolean') { bytes += 8; return; }
        if (item instanceof Map) { for (const [key, entryValue] of item) { walk(String(key)); walk(entryValue); } return; }
        if (Array.isArray(item)) { for (const entryValue of item) walk(entryValue); return; }
        if (typeof item === 'object') {
          if (typeof item.keys === 'function' && typeof item.get === 'function') {
            for (const key of item.keys()) walk(String(key));
            return;
          }
          for (const [key, entryValue] of Object.entries(item)) { walk(key); walk(entryValue); }
        }
      };
      walk(value);
      return bytes;
    };
    const perProjection = bytesOf(sample);
    assert.ok(perProjection > 0, 'a projection must occupy memory');
    const retainedMb = perProjection * ceiling / (1024 * 1024);
    assert.ok(retainedMb < 64,
      `the ceiling must not retain an unreasonable amount (${retainedMb.toFixed(1)} MB at ${perProjection} B each)`);

    console.log(JSON.stringify({
      test: 'flashback_sparse_projection_cache',
      ceiling,
      cachedPerCallMs: Number(cachedPerCall.toFixed(5)),
      coldMs: Number(coldMs.toFixed(5)),
      warmVsCold: rows,
      perProjectionBytes: perProjection,
      retainedMbAtCeiling: Number(retainedMb.toFixed(2)),
      pure: true
    }, null, 1));
    process.stdout.write('flashback_sparse_projection_cache_test: PASS\n');
  } finally {
    await fixture.dispose?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
