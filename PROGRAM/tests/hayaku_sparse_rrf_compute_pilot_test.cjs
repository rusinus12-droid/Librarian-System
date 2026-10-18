'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');
const { DEFINITIONS, executeOperation } = require('./fixtures/retired_compute_reference_kernels.cjs');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');
const operation = 'hayaku.sparse-rrf-fusion.v1';
const fingerprint = '7f32e8b10fdd34e8356af70e40ad90d3c48e6fda132080046a807db0ea3ec58f';
const normalize = value => JSON.parse(JSON.stringify(value));

assert.match(source, releasePattern("^\\/\\/@version {hayaku}\\s*$", "m"));
// The Compute SDK is retired from HAYAKU: sparse RRF and composite recall run locally.
assert.doesNotMatch(source, /LIBRARIAN SYSTEM COMPUTE SDK v|createMemorySuiteComputeBridge|MemorySuiteHayakuComputeBridge|createMemorySuiteSearchClient/, 'HAYAKU no longer embeds the Compute SDK');
assert.doesNotMatch(source, /^\/\/@arg memory_suite_hayaku_compute_mode\b/m);
assert.match(source, /const HAYAKU_SPARSE_RRF_COMPUTE_OPERATION = 'hayaku\.sparse-rrf-fusion\.v1'/, 'historical operation id stays disclosed');
assert.match(source, new RegExp(fingerprint));
assert.match(source, /return materializeHayakuSparseRrfRows\(rows, runHayakuSparseRrfLocal\(input\)\);/, 'applyRrfFusion runs the local sparse RRF kernel');
assert.match(source, /const rows=localRecallCandidates\(store,query,settings,null\)/, 'composite recall ranks locally');
assert.equal(DEFINITIONS[operation].fingerprint, fingerprint, 'plugin and server algorithm fingerprints match');

const sparseSignals = ['bm25fSignal', 'identitySignal', 'canonicalExactSignal', 'associationSignal', 'charNgramSignal', 'lexicalCoverageSignal', 'sparsePhraseSignal'];
const fallbackSignals = ['bm25Signal', 'entitySignal', 'canonicalSignal', 'frameSignal', 'locatorSignal', 'phraseSignal'];
const legacyApplyRrfFusion = (rows, k = 60, blend = 0.12, epsilon = 0.001) => {
  if (!rows.length) return rows;
  const signals = sparseSignals.some(signal => rows.some(row => Number(row.scoreBreakdown?.[signal] || 0) > epsilon))
    ? sparseSignals
    : fallbackSignals;
  const ranked = {};
  for (const signal of signals) {
    const sorted = [...rows]
      .filter(row => Number(row.scoreBreakdown?.[signal] || 0) > epsilon)
      .sort((left, right) => Number(right.scoreBreakdown?.[signal] || 0) - Number(left.scoreBreakdown?.[signal] || 0));
    ranked[signal] = new Map(sorted.map((row, index) => [row, index + 1]));
  }
  let maxRrf = 0;
  const computed = rows.map(row => {
    let rrf = 0;
    for (const signal of signals) {
      const rank = ranked[signal].get(row);
      if (rank !== undefined) rrf += 1 / (k + rank);
    }
    maxRrf = Math.max(maxRrf, rrf);
    return { row, rrf };
  });
  return computed.map(({ row, rrf }) => {
    const normalized = maxRrf > 0 ? rrf / maxRrf : 0;
    const base = Number(row.score || 0);
    const blended = Math.max(0, Math.min(1.35, base * (1 - blend) + normalized * blend * 1.35));
    return {
      ...row,
      score: blended,
      scoreBreakdown: {
        ...row.scoreBreakdown,
        rrfScore: Number(normalized.toFixed(4)),
        rrfSignals: signals,
        scoreBeforeRrf: Number(base.toFixed(4))
      }
    };
  });
};

(async () => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    arguments: { memory_suite_server_mode: 'plugin_only' }
  });
  try {
    assert.equal(runtime.hayaku.version, releaseVersion('hayaku'));
    const rows = [
      {
        axis: 'entity', category: 'character', publicRef: 'entity.character.alice', publicText: 'Alice remembers the forbidden archive.',
        score: 0.42, importance: 0.8, ownerMarker: { canonical: true },
        scoreBreakdown: { bm25fSignal: 0.84, identitySignal: 0.75, canonicalExactSignal: 0.31, associationSignal: 0.2, charNgramSignal: 0.5, lexicalCoverageSignal: 0.65, sparsePhraseSignal: 0.4 }
      },
      {
        axis: 'world', category: 'world_rule', publicRef: 'world.rule.magic', publicText: 'Magic is forbidden at the royal academy.',
        score: 0.5, importance: 0.9, ownerMarker: { canonical: true },
        scoreBreakdown: { bm25fSignal: 0.92, identitySignal: 0.12, canonicalExactSignal: 0.86, associationSignal: 0.3, charNgramSignal: 0.28, lexicalCoverageSignal: 0.71, sparsePhraseSignal: 0.69 }
      },
      {
        axis: 'narrative', category: 'active_event', publicRef: 'narrative.event.breakfast', publicText: 'A quiet breakfast in the garden.',
        score: 0.22, importance: 0.3, ownerMarker: { canonical: true },
        scoreBreakdown: { bm25fSignal: 0.03, identitySignal: 0, canonicalExactSignal: 0, associationSignal: 0.05, charNgramSignal: 0.08, lexicalCoverageSignal: 0.04, sparsePhraseSignal: 0 }
      }
    ];
    const original = normalize(rows);
    const expected = legacyApplyRrfFusion(rows);
    const input = normalize(runtime.hayaku._test.buildHayakuSparseRrfInput(rows));
    const local = normalize(runtime.hayaku._test.runHayakuSparseRrfLocal(input));
    const server = normalize(executeOperation(operation, input));
    assert.deepEqual(server, local, 'HAYAKU local and server RRF kernels have exact parity');
    assert.equal(runtime.hayaku._test.validateHayakuSparseRrfResult(server, { input }), true);
    const actual = normalize(runtime.hayaku._test.applyRrfFusion(rows));
    assert.deepEqual(actual, expected, 'the pure seam preserves the pre-Compute RRF formula and stable ties');
    assert.deepEqual(rows, original, 'RRF Compute input never mutates HAYAKU owner rows');
    assert.deepEqual(actual.map(row => row.ownerMarker), original.map(row => row.ownerMarker), 'owner row metadata remains local and unchanged');
    assert.equal(runtime.hayaku.compute.status().status, 'retired');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(runtime.fetchCalls.filter(call => call.url.includes('/v1/compute/')).length, 0, 'HAYAKU local mode never probes Compute');
    process.stdout.write('hayaku_sparse_rrf_compute_pilot_test: PASS\n');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  process.stderr.write(`hayaku_sparse_rrf_compute_pilot_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
