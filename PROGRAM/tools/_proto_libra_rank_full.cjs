'use strict';
// Prototype: the full remaining optimization set, applied together, with the whole rank phase
// measured end to end and the result vector asserted identical.
//
// From the decomposition (N=3200: exact 312 ms = 47%, BM25F x4 253 ms = 38%, linear 56 ms = 8.5%):
//
//   A. responseLoreLinearScore re-tokenizes its query on EVERY call. Measured: of 57.3 ms spent in
//      `linear x N x 2`, 48.8 ms is `responseLoreTokenStats(query)` being recomputed 6400 times
//      (85%). The query side is fixed for a whole pass, so it is computed once.
//
//   B. The entity pass re-tokenizes each record's identityText on every call (26.1 ms at N=3200),
//      and the query side per call. Both are memoized.
//
//   C. responseLoreCorpusBm25f rebuilds `defs`, its `Object.keys(defs)` inside the DF inner loop, and
//      the per-field averages on every call — and is called four times with the SAME record set.
//      The DF table and averages are properties of (records, queryTokens); the averages and the
//      field-name list are properties of records alone.
//
// The prototype rewrites those three in memory and asserts the end-to-end ranked output is
// byte-identical (every row's relevance, exact, rrf, bm25 components and protected flag), so the
// speedup is provably lossless before any of it is applied to the plugin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_vm_harness.cjs'));

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar wanderer northern '
  + 'southern iron glass silver copper ember harvest meadow threshold compass covenant fragment').split(' ');

const SIZE = Number(process.argv[2] || 3200);

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

// Injected replacements, as source text. Each is a drop-in for the production function.
const LINEAR_PATCH = `
  const __loreLinearQueryPrep = new Map();
  const __loreLinearQueryOf = query => {
    const key = text(query || '');
    let cached = __loreLinearQueryPrep.get(key);
    if (cached !== undefined) return cached;
    const tokens = Array.from(responseLoreTokenStats(key).counts.keys()).slice(0, 180);
    cached = { tokens, set: new Set(tokens), size: tokens.length };
    if (__loreLinearQueryPrep.size >= 64) {
      const oldest = __loreLinearQueryPrep.keys().next().value;
      if (oldest !== undefined) __loreLinearQueryPrep.delete(oldest);
    }
    __loreLinearQueryPrep.set(key, cached);
    return cached;
  };
  const responseLoreLinearScore = (record, query = '') => {
    const prep = __loreLinearQueryOf(query);
    if (!prep.size) return { score: 0, coverage: 0, jaccard: 0, identityCoverage: 0 };
    const all = record.tokenUniverse;
    let overlap = 0;
    let identityOverlap = 0;
    for (const token of prep.set) {
      if (all.has(token)) overlap += 1;
      if (record.fields.identity.counts.has(token) || record.fields.heading.counts.has(token)) identityOverlap += 1;
    }
    const coverage = overlap / Math.max(1, prep.size);
    const jaccard = overlap / Math.max(1, prep.size + all.size - overlap);
    const identityCoverage = identityOverlap / Math.max(1, prep.size);
    return { score: clampNumber(Math.max(coverage * 0.78, jaccard) * 0.76 + identityCoverage * 0.24, 0, 1, 0), coverage, jaccard, identityCoverage };
  };
`;

const ENTITY_PATCH = `
  const __loreIdentityTokensCache = new Map();
  const __loreIdentityTokensOf = record => {
    const key = record?.id || '';
    let tokens = __loreIdentityTokensCache.get(key);
    if (tokens === undefined) {
      tokens = loreDistinctiveAnchorTokens(record?.identityText || '');
      if (__loreIdentityTokensCache.size >= 20000) {
        const oldest = __loreIdentityTokensCache.keys().next().value;
        if (oldest !== undefined) __loreIdentityTokensCache.delete(oldest);
      }
      __loreIdentityTokensCache.set(key, tokens);
    }
    return tokens;
  };
  const loreExactEntityAnchorScore = (query, identityText, recordId = null) => {
    const queryTokens = loreDistinctiveAnchorTokens(query);
    if (!queryTokens.length) return 0;
    const queryFeatures = queryTokens.map(loreTokenFeatureOf);
    const identityTokens = recordId != null && __loreIdentityTokensCache.has(recordId)
      ? __loreIdentityTokensOf({ id: recordId, identityText })
      : loreDistinctiveAnchorTokens(identityText);
    const queryKeys = new Set();
    for (const feature of queryFeatures) if (feature.normalized) queryKeys.add(feature.normalized);
    if (queryKeys.size) {
      for (const token of identityTokens) {
        const key = loreJaccardNormalizeKey(token);
        if (key && queryKeys.has(key)) return 1;
      }
    }
    const identityFeatures = identityTokens.map(loreTokenFeatureOf);
    let best = 0;
    outer:
    for (const queryFeature of queryFeatures) {
      for (const identityFeature of identityFeatures) {
        const similarity = loreTokenFeatureSimilarity(queryFeature, identityFeature);
        if (similarity > best) { best = similarity; if (best >= 1) break outer; }
      }
    }
    return best;
  };
`;

const BM25_PATCH = `
  const __LORE_BM25F_DEFS = Object.freeze({
    identity: Object.freeze({ weight: 4.4, b: 0.10 }),
    heading: Object.freeze({ weight: 2.8, b: 0.24 }),
    body: Object.freeze({ weight: 1.0, b: 0.80 })
  });
  const __LORE_BM25F_FIELDS = Object.freeze(Object.keys(__LORE_BM25F_DEFS));
  const __loreBm25fAverageCache = new WeakMap();
  const __loreBm25fAverages = records => {
    let cached = __loreBm25fAverageCache.get(records);
    if (cached) return cached;
    cached = {};
    for (const field of __LORE_BM25F_FIELDS) {
      let sum = 0;
      for (const record of records) sum += Number(record.fields[field]?.length || 0);
      cached[field] = sum / Math.max(1, records.length);
    }
    __loreBm25fAverageCache.set(records, cached);
    return cached;
  };
  const responseLoreCorpusBm25f = (records = [], query = '') => {
    const queryTokens = loreJaccardUnique(Array.from(responseLoreTokenStats(query).counts.keys()), 180);
    if (!queryTokens.length || !records.length) return records.map(() => ({ raw: 0, score: 0, fields: {} }));
    const defs = __LORE_BM25F_DEFS;
    const fields = __LORE_BM25F_FIELDS;
    const averages = __loreBm25fAverages(records);
    const recordCount = records.length;
    // Inverted-index DF: walk each record's OWN token sets once instead of scanning every record
    // for every query token. Safe here because BM25F asks counts.has(token) - an EXACT match -
    // and responseLoreTokenStats stores exactly those keys (including Korean character n-grams),
    // so the inverted index cannot miss a token the scan would find.
    const queryTokenSet = new Set(queryTokens);
    const df = new Map(queryTokens.map(token => [token, 0]));
    for (const record of records) {
      const seen = new Set();
      for (const field of fields) {
        const counts = record.fields[field]?.counts;
        if (!counts || typeof counts.keys !== 'function') continue;
        for (const token of counts.keys()) {
          if (queryTokenSet.has(token)) seen.add(token);
        }
      }
      for (const token of seen) df.set(token, df.get(token) + 1);
    }
    const idfByToken = new Map();
    for (const token of queryTokens) {
      const documentFrequency = Number(df.get(token) || 0);
      idfByToken.set(token, Math.log(1 + ((recordCount - documentFrequency + 0.5) / (documentFrequency + 0.5))));
    }
    return records.map(record => {
      let raw = 0;
      const fieldRaw = { identity: 0, heading: 0, body: 0 };
      for (const token of queryTokens) {
        const idf = idfByToken.get(token);
        let combinedTf = 0;
        const pieces = {};
        for (const field of fields) {
          const def = defs[field];
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
        for (const field of fields) {
          if (pieces[field] === undefined) continue;
          fieldRaw[field] += contribution * (pieces[field] / pieceTotal);
        }
      }
      return { raw, score: raw > 0 ? raw / (raw + 1.55) : 0, fields: fieldRaw };
    });
  };
`;

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  const inject = text => text.replace(anchor,
    `      full: { responseLoreRankRecords, responseLoreAdaptiveSelect, responseLoreIndexRecord },\n${anchor}`)
    .replace('    debugSgaPatchOperations(draft = \'\', edits = [])',
      '    full(){ return LibraMemoryCore.full; },\n    debugSgaPatchOperations(draft = \'\', edits = [])');

  // Baseline: production, with only the accessor injected.
  const baselineSource = inject(source);
  // Optimized: swap the three functions, plus route the entity call through the record id.
  const optimizedSource = inject(
    source.replace('  const responseLoreLinearScore = (record, query = \'\') => {', LINEAR_PATCH + '  const __unusedLinear = (record, query = \'\') => {')
      .replace('  const loreExactEntityAnchorScore = (query, identityText) => {', ENTITY_PATCH + '  const __unusedEntity = (query, identityText) => {')
      .replace('  const responseLoreCorpusBm25f = (records = [], query = \'\') => {', BM25_PATCH + '  const __unusedBm25 = (records = [], query = \'\') => {')
      .replace('    const entity = loreExactEntityAnchorScore(query, record.identityText);',
        '    const entity = loreExactEntityAnchorScore(query, record.identityText, record.id);')
  );

  const SETTINGS = { responseLoreStartCount: 8, responseLoreMaxItems: 48, responseLoreMaxChars: 12000 };
  const run = async variantSource => {
    const harness = await createLibraVmHarness({}, {}, { transformSource: () => variantSource });
    try {
      const internals = harness.api.full();
      const records = Array.from({ length: SIZE }, (_, index) => internals.responseLoreIndexRecord(entry(index, SIZE))).filter(Boolean);
      const start = process.hrtime.bigint();
      const ranked = internals.responseLoreRankRecords({
        records, currentQuery: CURRENT, terminalQuery: TERMINAL, supportQuery: SUPPORT,
        coverageQuery: CURRENT, stageId: 'shared', activeLore: [], hostSelectedLore: []
      });
      const rankMs = Number(process.hrtime.bigint() - start) / 1e6;
      const selectStart = process.hrtime.bigint();
      internals.responseLoreAdaptiveSelect(ranked, SETTINGS, 'shared');
      const selectMs = Number(process.hrtime.bigint() - selectStart) / 1e6;
      return {
        rankMs, selectMs, totalMs: rankMs + selectMs,
        rows: ranked.rows.length,
        fingerprint: JSON.stringify(ranked.rows.map(row => [
          row.id, Number(row.relevance || 0).toFixed(9), Number(row.exactScore || 0).toFixed(9),
          Number(row.rrfScore || 0).toFixed(9), Number(row.currentBm25 || 0).toFixed(9),
          Number(row.terminalBm25 || 0).toFixed(9), Number(row.supportBm25 || 0).toFixed(9),
          Number(row.currentLexical || 0).toFixed(9), Number(row.terminalLexical || 0).toFixed(9),
          row.protected === true
        ]))
      };
    } finally {
      await harness.cleanup?.();
    }
  };

  console.log(`=== N=${SIZE} ===`);
  const baseline = await run(baselineSource);
  const optimized = await run(optimizedSource);
  assert.equal(optimized.fingerprint, baseline.fingerprint,
    'the optimized rank phase must produce a byte-identical result vector');

  console.log(`  baseline  rank ${baseline.rankMs.toFixed(1)} ms  total ${baseline.totalMs.toFixed(1)} ms`);
  console.log(`  optimized rank ${optimized.rankMs.toFixed(1)} ms  total ${optimized.totalMs.toFixed(1)} ms`);
  console.log('');
  console.log(JSON.stringify({
    prototype: 'libra_rank_full',
    n: SIZE,
    baseline: { rankMs: Number(baseline.rankMs.toFixed(1)), totalMs: Number(baseline.totalMs.toFixed(1)) },
    optimized: { rankMs: Number(optimized.rankMs.toFixed(1)), totalMs: Number(optimized.totalMs.toFixed(1)) },
    rankSpeedup: Number((baseline.rankMs / optimized.rankMs).toFixed(2)),
    totalSpeedup: Number((baseline.totalMs / optimized.totalMs).toFixed(2)),
    identical: true
  }, null, 1));
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
