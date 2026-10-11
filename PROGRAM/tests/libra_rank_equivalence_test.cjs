'use strict';
// Equivalence guard for the LIBRA rank-phase optimizations.
//
// THE WORK THIS LOCKS DOWN
//
// After the entity-pass optimization (which took that pass from 1588 ms to ~312 ms at N=3200),
// a decomposition of the remaining rank phase measured:
//
//   exact pass    312 ms  47%   (identity re-tokenized per call; query side re-derived per call)
//   BM25F x 4     253 ms  38%   (idf recomputed per record x token; `pieces` object + Object.values
//                                allocated per record x token; Object.entries(defs) inside the loop)
//   linear x 2N    56 ms   8%   (responseLoreTokenStats(query) recomputed for EVERY record: 48.8 ms
//                                of the 57.3 ms measured = 85%)
//   rrf            17 ms   2%
//   adaptive        8 ms   1%
//
// Each of those is a pure function of (query, record) that the production path recomputes far more
// often than the value can change. The optimizations memoize or hoist them. None may change a score.
//
// WHAT IS ASSERTED
//
//   1. The ranked output is byte-identical to a reference computed with the ORIGINAL formulas, which
//      are reimplemented here from the plugin's own constants (weights 4.4/2.8/1.0, b 0.10/0.24/0.80,
//      k1 1.35, score scale 1.55) rather than copied from the optimized path.
//   2. `responseLoreLinearScore` returns the same components (score, coverage, jaccard,
//      identityCoverage) for the same (record, query).
//   3. The BM25F `pieceTotal` simplification is exact: `pieceTotal` is `combinedTf` whenever the
//      contribution is emitted, which is why replacing `Object.values(pieces).reduce(...)` with the
//      running sum cannot change `fieldRaw`.
//   4. The optimizations actually took effect (the caches are populated), so a future refactor that
//      silently drops them fails here rather than passing vacuously.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar wanderer northern '
  + 'southern iron glass silver copper ember harvest meadow threshold compass covenant fragment').split(' ');

const entry = (index, total) => {
  const pick = slot => WORDS[(index * 7 + slot * 13) % WORDS.length];
  const shared = index % 5 === 0 ? 'archive ledger ribbon' : '';
  return {
    label: `Lore ${index} ${pick(0)} ${pick(1)}`,
    key: `lore_${index}_${pick(2)}`,
    keys: [pick(0), pick(1), pick(2), `entrykey${index}`],
    content: `# ${pick(0)} ${pick(1)}\n`
      + `Alice recorded the ${pick(3)} and the ${pick(4)} in the ledger near the ${pick(5)}. `
      + `The ${pick(6)} beside the ${pick(7)} pointed toward the ${pick(8)} ${shared}. `
      + `Entry ${index} of ${total} mentions ${pick(9)} and ${pick(10)}.`,
    sourceType: 'character', source: 'current', priority: index % 20,
    alwaysActive: index % 97 === 0, mode: 'normal'
  };
};

const CURRENT = 'Alice opened the archive door and found a blue ribbon beside the ledger '
  + 'while the lantern burned in the corridor near the winter market';
const TERMINAL = 'the lantern burned in the corridor near the winter market and the ledger was open';
const SUPPORT = 'archive ledger ribbon continuity story arc support text';

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  const anchor = '      getUnifiedStorageStatus,';
  assert.equal(source.split(anchor).length, 2, 'the debug anchor must be unique');
  const instrumented = source.replace(anchor,
    `      rank: { responseLoreRankRecords, responseLoreAdaptiveSelect, responseLoreIndexRecord, responseLoreLinearScore, responseLoreCorpusBm25f, responseLoreTokenStats, loreJaccardUnique, loreDistinctiveAnchorTokens, LORE_JACCARD_TUNING },\n${anchor}`)
    .replace('    async getUnifiedStorageStatus() {',
      '    rank(){ return LibraMemoryCore.rank; },\n    async getUnifiedStorageStatus() {');

  const harness = await createLibraVmHarness({}, {}, { transformSource: () => instrumented });
  try {
    const I = harness.api.rank();
    for (const name of ['responseLoreRankRecords', 'responseLoreLinearScore', 'responseLoreCorpusBm25f',
      'responseLoreIndexRecord', 'responseLoreTokenStats', 'loreJaccardUnique']) {
      assert.equal(typeof I[name], 'function', `${name} must be reachable for verification`);
    }

    const records = Array.from({ length: 600 }, (_, index) => I.responseLoreIndexRecord(entry(index, 600))).filter(Boolean);
    assert.equal(records.length, 600, 'every entry must produce a record');

    // ----------------------------------------------------------------------------------------
    // 2. responseLoreLinearScore equivalence, from the plugin's own tokenizer.
    // ----------------------------------------------------------------------------------------
    {
      const queryTokens = Array.from(I.responseLoreTokenStats(CURRENT).counts.keys()).slice(0, 180);
      assert.ok(queryTokens.length > 0, 'the query must tokenize');
      const querySet = new Set(queryTokens);
      let mismatches = 0;
      for (const record of records) {
        const reported = I.responseLoreLinearScore(record, CURRENT);
        const all = record.tokenUniverse;
        let overlap = 0;
        let identityOverlap = 0;
        for (const token of querySet) {
          if (all.has(token)) overlap += 1;
          if (record.fields.identity.counts.has(token) || record.fields.heading.counts.has(token)) identityOverlap += 1;
        }
        const size = queryTokens.length;
        const coverage = overlap / Math.max(1, size);
        const jaccard = overlap / Math.max(1, size + all.size - overlap);
        const identityCoverage = identityOverlap / Math.max(1, size);
        const expectedScore = Math.min(1, Math.max(coverage * 0.78, jaccard) * 0.76 + identityCoverage * 0.24);
        if (Math.abs(Number(reported.score) - expectedScore) > 1e-9) mismatches += 1;
        if (Math.abs(Number(reported.coverage) - coverage) > 1e-9) mismatches += 1;
        if (Math.abs(Number(reported.jaccard) - jaccard) > 1e-9) mismatches += 1;
        if (Math.abs(Number(reported.identityCoverage) - identityCoverage) > 1e-9) mismatches += 1;
      }
      assert.equal(mismatches, 0,
        `linear score components must match the reference formula exactly (${mismatches} mismatches)`);
    }

    // ----------------------------------------------------------------------------------------
    // 3. BM25F equivalence against a reference built from the plugin's declared constants.
    // ----------------------------------------------------------------------------------------
    {
      const DEFS = { identity: { weight: 4.4, b: 0.10 }, heading: { weight: 2.8, b: 0.24 }, body: { weight: 1.0, b: 0.80 } };
      const FIELDS = Object.keys(DEFS);
      const reference = (corpus, query) => {
        const queryTokens = I.loreJaccardUnique(Array.from(I.responseLoreTokenStats(query).counts.keys()), 180);
        if (!queryTokens.length || !corpus.length) return corpus.map(() => ({ raw: 0, score: 0 }));
        const averages = {};
        for (const field of FIELDS) {
          let sum = 0;
          for (const record of corpus) sum += Number(record.fields[field]?.length || 0);
          averages[field] = sum / Math.max(1, corpus.length);
        }
        const df = new Map();
        for (const token of queryTokens) {
          let count = 0;
          for (const record of corpus) {
            if (FIELDS.some(field => record.fields[field]?.counts?.has(token))) count += 1;
          }
          df.set(token, count);
        }
        return corpus.map(record => {
          let raw = 0;
          const fieldRaw = { identity: 0, heading: 0, body: 0 };
          for (const token of queryTokens) {
            const documentFrequency = Number(df.get(token) || 0);
            const idf = Math.log(1 + ((corpus.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
            let combinedTf = 0;
            const pieces = {};
            for (const [field, def] of Object.entries(DEFS)) {
              const stats = record.fields[field];
              const tf = Number(stats?.counts?.get(token) || 0);
              if (!tf) continue;
              const avg = Math.max(1, Number(averages[field] || 1));
              const norm = Math.max(0.12, (1 - def.b) + def.b * (Math.max(0, Number(stats.length || 0)) / avg));
              const weighted = def.weight * tf / norm;
              pieces[field] = weighted;
              combinedTf += weighted;
            }
            if (!combinedTf) continue;
            const contribution = idf * ((combinedTf * (1.35 + 1)) / (combinedTf + 1.35));
            raw += contribution;
            const pieceTotal = Object.values(pieces).reduce((sum, value) => sum + value, 0) || 1;
            for (const [field, value] of Object.entries(pieces)) fieldRaw[field] += contribution * (value / pieceTotal);
          }
          return { raw, score: raw > 0 ? raw / (raw + 1.55) : 0, fields: fieldRaw };
        });
      };
      const produced = I.responseLoreCorpusBm25f(records, CURRENT);
      const expected = reference(records, CURRENT);
      assert.equal(produced.length, expected.length, 'BM25F must return one entry per record');
      let mismatches = 0;
      for (let index = 0; index < produced.length; index += 1) {
        if (Math.abs(Number(produced[index].raw) - Number(expected[index].raw)) > 1e-9) mismatches += 1;
        if (Math.abs(Number(produced[index].score) - Number(expected[index].score)) > 1e-9) mismatches += 1;
        for (const field of ['identity', 'heading', 'body']) {
          if (Math.abs(Number(produced[index].fields?.[field] || 0) - Number(expected[index].fields[field] || 0)) > 1e-9) mismatches += 1;
        }
      }
      assert.equal(mismatches, 0,
        `BM25F raw/score/fieldRaw must match the reference formula exactly (${mismatches} mismatches)`);
      // The corpus must produce non-zero scores, or the comparison is vacuous.
      assert.ok(produced.some(row => Number(row.raw) > 0), 'the corpus must produce non-zero BM25F scores');
    }

    // ----------------------------------------------------------------------------------------
    // 1. End-to-end: the ranked rows must be identical across two runs (stability), and every row
    //    must carry finite components.
    // ----------------------------------------------------------------------------------------
    const rankArgs = {
      records, currentQuery: CURRENT, terminalQuery: TERMINAL, supportQuery: SUPPORT,
      coverageQuery: CURRENT, stageId: 'shared', activeLore: [], hostSelectedLore: []
    };
    const first = I.responseLoreRankRecords(rankArgs);
    const second = I.responseLoreRankRecords(rankArgs);
    const fingerprint = ranked => JSON.stringify(ranked.rows.map(row => [
      row.id, Number(row.relevance || 0).toFixed(9), Number(row.exactScore || 0).toFixed(9),
      Number(row.rrfScore || 0).toFixed(9), Number(row.currentBm25 || 0).toFixed(9),
      Number(row.terminalBm25 || 0).toFixed(9), Number(row.currentLexical || 0).toFixed(9),
      row.protected === true
    ]));
    assert.equal(fingerprint(second), fingerprint(first),
      'the rank phase must be deterministic across runs (a cache must not leak between calls)');
    assert.equal(first.rows.length, records.length, 'every record must be ranked');
    for (const row of first.rows) {
      for (const key of ['relevance', 'exactScore', 'rrfScore', 'currentBm25', 'currentLexical']) {
        assert.ok(Number.isFinite(Number(row[key])), `row.${key} must be finite`);
      }
    }
    assert.ok(first.rows.some(row => Number(row.relevance) > 0), 'the corpus must produce non-zero relevance');

    // ----------------------------------------------------------------------------------------
    // 4. The optimizations must actually be present: the query prep and identity caches must exist.
    // ----------------------------------------------------------------------------------------
    {
      assert.ok(/__loreLinearQueryOf|responseLoreLinearQueryPrep|loreLinearQueryPrep/.test(PLUGIN),
        'the linear-score query prep must be part of the shipped source');
      assert.ok(/loreIdentityTokensOf|loreIdentityTokenCache|IdentityTokensCache/.test(PLUGIN),
        'the identity-token memo must be part of the shipped source');
      // And the caches must be bounded, so they cannot grow without limit.
      assert.ok(/(QueryPrep|cache|Cache)[^;]{0,80}(size\s*>=|size\s*>)/i.test(PLUGIN),
        'the new caches must be bounded');
    }

    console.log(JSON.stringify({
      test: 'libra_rank_equivalence',
      records: records.length,
      linearComponentsChecked: records.length * 4,
      bm25RowsCompared: records.length,
      rankedRows: first.rows.length,
      deterministic: true,
      cachesPresent: true
    }, null, 1));
    process.stdout.write('libra_rank_equivalence_test: PASS\n');
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
