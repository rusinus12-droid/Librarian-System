'use strict';
// Correctness verification for the inverted-index shortcut, BEFORE it is applied to production.
//
// The proposed optimization answers "does this record have an exact identity match against any query
// token?" with one Map lookup per query token, using `record.fields.identity.counts` as the index,
// and skips the Q x I pairwise scan when the answer is yes.
//
// That reasoning depends on a chain of facts that this probe verifies explicitly, because each one
// is a way the shortcut could be WRONG:
//
//   1. `counts` keys are `loreJaccardNormalizeKey(tokenValue)`.
//   2. Query tokens arrive from `loreDistinctiveAnchorTokens`, which FILTERS (stopword list,
//      'concept:'/'time:' prefix, length >= 4 or Korean 2+) and CAPS at 90 via loreJaccardUnique.
//   3. For the shortcut to be sound, whenever a distinctive query token's normalized form is a key
//      in identity.counts, the pairwise scan must have returned 1.
//   4. AND whenever it is NOT a key, the pairwise scan must NOT have returned 1 (otherwise the
//      shortcut would miss a real exact match and lower the score).
//
// (3) and (4) together say: `counts.has(key)` is exactly equivalent to "the scan reaches 1".
//
// The probe tests that equivalence directly over a corpus designed to stress the filter and the cap:
// stopwords, short tokens, 'concept:'/'time:' prefixed tokens, Korean, plural/stem pairs, casing and
// punctuation variants, and records whose identity has many tokens (to push against the 90 cap).
//
// Any counterexample fails the probe, and the optimization must not be applied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_vm_harness.cjs'));

// Identity strings chosen to sit on both sides of every filter rule.
const IDENTITIES = [
  'archive', 'archives', 'archived', 'arch', 'arc',
  'ribbon', 'ribbons', 'ribboned',
  'lantern', 'lanterns', 'lantern light',
  'alice', 'alices', 'ALICE', 'Alice',
  'ledger', 'ledgers', 'ledger-book', 'ledger book', 'ledger_book',
  'corridor', 'corridors',
  'the', 'and', 'with', 'a', 'to', 'of',           // stopwords / short tokens
  'concept:archive', 'time:winter', 'concept:ledger',
  '기록', '기록들', '기록 보관소', '기록보관소',
  'winter market', 'winter', 'market',
  'blue ribbon', 'blue', 'ribbon beside the ledger',
  'archive door corridor lantern winter market harbor letter promise',
  'x', '', '   ', '!!!', '...',
  'token1', 'token2', 'entrykey5', 'shared3'
];

const QUERIES = [
  'Alice opened the archive door and found a blue ribbon beside the ledger while the lantern burned in the corridor near the winter market',
  'the archive',
  'archives',
  'ribbons and lanterns',
  '기록 보관소의 기록들',
  'concept:archive time:winter',
  'a of to the and',
  'entrykey5 shared3',
  ''
];

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  const instrumented = source.replace(anchor,
    `      idx: { responseLoreIndexRecord, loreDistinctiveAnchorTokens, loreJaccardTokenSimilarity, loreJaccardNormalizeKey },\n${anchor}`)
    .replace('    debugSgaPatchOperations(draft = \'\', edits = [])',
      '    idx(){ return LibraMemoryCore.idx; },\n    debugSgaPatchOperations(draft = \'\', edits = [])');

  const harness = await createLibraVmHarness({}, {}, { transformSource: () => instrumented });
  try {
    const I = harness.api.idx();
    const records = IDENTITIES.map((identity, index) => I.responseLoreIndexRecord({
      label: `L${index}`, key: `k${index}`, keys: [identity], content: `${identity} body`,
      sourceType: 'character', source: 'current', priority: 0, alwaysActive: false, mode: 'normal'
    }) || {
      // responseLoreIndexRecord may reject an entry whose identity is empty; build a minimal record
      // shape for those so the probe still measures the index/scan equivalence on them.
      identityText: identity,
      fields: { identity: { counts: new Map() } }
    }).filter(Boolean);

    // Facts (1) and (2): restate the chain the shortcut depends on.
    // NOTE: `instanceof Map` is false here even though the value IS a Map — the record was built
    // inside the VM realm, so its Map prototype differs from this realm's. Duck-type on the methods
    // instead, which is also what the production code must do to be realm-safe.
    const isMapLike = value => !!value && typeof value.get === 'function'
      && typeof value.has === 'function' && typeof value.set === 'function';
    const countsIsMap = records.every(record => isMapLike(record?.fields?.identity?.counts));
    assert.equal(countsIsMap, true, 'every record must expose identity.counts as a Map (fact 1)');

    let pairsChecked = 0;
    let indexTrueScanTrue = 0;
    let indexFalseScanTrue = 0;
    const counterexamples = [];

    for (const query of QUERIES) {
      const queryTokens = I.loreDistinctiveAnchorTokens(query);
      // Fact (2): the filter is what it claims to be.
      for (const token of queryTokens) {
        const key = I.loreJaccardNormalizeKey(token);
        if (key.length < 4 && !/^[가-힣]{2,}$/u.test(key)) {
          counterexamples.push({ kind: 'filter_let_short_token_through', query, token, key });
        }
      }
      for (const record of records) {
        const counts = record.fields.identity.counts;
        // The reference: what the CURRENT pairwise scan produces for this record.
        let scanBest = 0;
        const identityTokens = I.loreDistinctiveAnchorTokens(record.identityText);
        for (const queryToken of queryTokens) {
          for (const identityToken of identityTokens) {
            const similarity = I.loreJaccardTokenSimilarity(queryToken, identityToken);
            if (similarity > scanBest) scanBest = similarity;
          }
        }
        // The shortcut: one Map lookup per distinctive query token.
        let indexHit = false;
        for (const queryToken of queryTokens) {
          const key = I.loreJaccardNormalizeKey(queryToken);
          if (key && counts.has(key)) { indexHit = true; break; }
        }
        pairsChecked += 1;
        if (indexHit && scanBest === 1) indexTrueScanTrue += 1;
        // The two failure directions the shortcut must not have.
        if (indexHit && scanBest !== 1) {
          counterexamples.push({
            kind: 'index_says_hit_but_scan_is_not_1',
            query: query.slice(0, 40), identity: record.identityText.slice(0, 40), scanBest
          });
        }
        if (!indexHit && scanBest === 1) {
          counterexamples.push({
            kind: 'scan_is_1_but_index_says_no_hit',
            query: query.slice(0, 40), identity: record.identityText.slice(0, 40), scanBest
          });
        }
      }
    }

    // The 90-token cap: a record whose identity has more distinctive tokens than the cap can have
    // matches the scan would find but a full index would also find — verify the cap does not make
    // the index disagree with the scan.
    const longIdentity = Array.from({ length: 140 }, (_, index) => `distinct${index}word`).join(' ');
    const longQuery = 'distinct139word distinct138word distinct100word';
    {
      const record = I.responseLoreIndexRecord({
        label: 'long', key: 'long', keys: [longIdentity], content: 'body',
        sourceType: 'character', source: 'current', priority: 0, alwaysActive: false, mode: 'normal'
      });
      const queryTokens = I.loreDistinctiveAnchorTokens(longQuery);
      const identityTokens = I.loreDistinctiveAnchorTokens(record.identityText);
      let scanBest = 0;
      for (const queryToken of queryTokens) {
        for (const identityToken of identityTokens) {
          scanBest = Math.max(scanBest, I.loreJaccardTokenSimilarity(queryToken, identityToken));
        }
      }
      let indexHit = false;
      for (const queryToken of queryTokens) {
        if (record.fields.identity.counts.has(I.loreJaccardNormalizeKey(queryToken))) { indexHit = true; break; }
      }
      pairsChecked += 1;
      if (indexHit !== (scanBest === 1)) {
        counterexamples.push({ kind: 'cap_boundary_disagreement', scanBest, indexHit });
      }
    }

    assert.deepEqual(counterexamples, [],
      `the inverted-index shortcut must be exactly equivalent to the pairwise scan (${counterexamples.length} counterexamples)`);
    assert.ok(indexTrueScanTrue > 0,
      `the probe must observe cases where the index correctly short-circuits (got ${indexTrueScanTrue})`);
    assert.ok(pairsChecked >= 300, `the probe must cover a substantial pair set (got ${pairsChecked})`);
    assert.equal(indexFalseScanTrue, 0, 'no case may have the scan reach 1 while the index misses it');

    console.log(JSON.stringify({
      probe: 'lore_exact_index_equivalence',
      identities: IDENTITIES.length,
      queries: QUERIES.length,
      pairsChecked,
      indexShortCircuits: indexTrueScanTrue,
      counterexamples: 0,
      verdict: 'the index lookup is exactly equivalent to the pairwise scan'
    }, null, 1));
    process.stdout.write('_probe_lore_exact_index_equivalence: PASS\n');
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
