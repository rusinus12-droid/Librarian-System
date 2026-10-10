'use strict';
// Flashback recall-scoring scaling probe.
//
// Same question as the LIBRA lore probe, asked of Flashback's candidate scoring:
// `scoreBm25fCandidates` builds a per-query document-frequency table with
//
//     for (const token of queryTokens)        // up to 160
//       for (const item of documents)         // N
//         if (fields.some(field => ...))      // field count, iterated per (token, document)
//
// which is O(Q x N x fields) BEFORE any scoring happens. LIBRA's equivalent pass measured 83% of
// its rank phase at N=3200, so this probe measures whether Flashback's pass has the same shape and
// where its time goes as the record count grows.
//
// It drives the REAL plugin through the fixture and times:
//   buildMs  - projection construction per record (sparseScoringProjectionForRecord)
//   scoreMs  - scoreBm25fCandidates end to end
// plus the per-record cost, so the scaling shape is visible.
//
// The fixture is the native runtime fixture used by the other Flashback suites, so the plugin is
// executed rather than sliced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('../tests/fixtures/flashback_native_runtime_fixture.cjs');

const SIZES = (process.argv[2] ? process.argv[2].split(',').map(Number) : [100, 200, 400, 800, 1600, 3200])
  .filter(size => Number.isFinite(size) && size > 0);

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar').split(' ');

// A record shaped like the ones the recall path scores: title, tags, and a body the tokenizer sees.
const record = (index, total) => {
  const pick = slot => WORDS[(index * 7 + slot * 13) % WORDS.length];
  return {
    id: `rec_${index}`,
    key: `rec_${index}`,
    title: `${pick(0)} ${pick(1)}`,
    tags: [pick(2), pick(3), `tag${index}`],
    summary: `Entry ${index} of ${total}`,
    body: `Alice recorded the ${pick(4)} and the ${pick(5)} in the ledger near the ${pick(6)}. `
      + `The ${pick(7)} beside the ${pick(8)} pointed toward the ${pick(9)}. Entry ${index}.`,
    turnStart: index,
    turnEnd: index + 1,
    scopeKey: 'flashback-scaling-scope'
  };
};

const QUERY = 'Alice opened the archive door and found a blue ribbon beside the ledger '
  + 'while the lantern burned in the corridor near the winter market';

(async () => {
  const fixture = await createFixture({
    arguments: {
      memory_suite_server_mode: 'plugin_only',
      enable_gui: 'false'
    }
  });
  try {
    const internals = fixture.api?._test;
    assert.ok(internals, 'the plugin test surface must be exposed');
    for (const name of ['scoreBm25fCandidates', 'sparseProjectionForRecord']) {
      assert.equal(typeof internals[name], 'function', `${name} must be reachable`);
    }

    const results = [];
    let previousTotal = null;
    for (const size of SIZES) {
      const records = Array.from({ length: size }, (_, index) => record(index, size));
      const settings = {};

      // Phase 1: projection construction (per record).
      const projectStart = process.hrtime.bigint();
      const projections = records.map(entry => internals.sparseProjectionForRecord(entry, settings));
      const projectMs = Number(process.hrtime.bigint() - projectStart) / 1e6;
      assert.equal(projections.length, records.length, `every record must project at size ${size}`);

      // Phase 2: the BM25F candidate scoring pass (contains the Q x N x fields document-frequency loop).
      const scoreStart = process.hrtime.bigint();
      const scored = internals.scoreBm25fCandidates(records, QUERY, settings);
      const scoreMs = Number(process.hrtime.bigint() - scoreStart) / 1e6;
      assert.ok(Array.isArray(scored), `scoreBm25fCandidates must return an array at size ${size}`);

      const totalMs = projectMs + scoreMs;
      results.push({
        size,
        hits: scored.length,
        projectMs: Number(projectMs.toFixed(1)),
        scoreMs: Number(scoreMs.toFixed(1)),
        totalMs: Number(totalMs.toFixed(1)),
        usPerRecord: Number((totalMs / size * 1000).toFixed(1)),
        timeRatioVsPrevious: previousTotal ? Number((totalMs / previousTotal).toFixed(2)) : null
      });
      previousTotal = totalMs;
    }

    console.log(JSON.stringify({ probe: 'flashback_recall_scaling', results }, null, 1));
  } finally {
    await fixture.dispose?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
