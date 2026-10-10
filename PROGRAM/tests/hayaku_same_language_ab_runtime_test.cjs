'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');
const cases = require('./fixtures/hayaku_same_language_ab.cjs');
const sentence = value => String(value).normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
// Evaluation-only control, deliberately not a product ranking policy. Exact
// sentence equality carries no proof about paraphrases or general semantics.
const candidate = (ranked, query) => [...ranked].sort((a, b) =>
  Number(sentence(b.publicText) === sentence(query)) - Number(sentence(a.publicText) === sentence(query)));

test('same-language role/negation controls compare product lexical rank with an exact-sentence research control', async () => {
  const h = await createHayakuRuntime({ autoRepair: false });
  try {
    const results = cases.map(fixture => {
      const rows = [
        { id: 'a-distractor', packetHash: 'fixture', axis: 'world', publicText: fixture.distractor },
        { id: 'z-supported', packetHash: 'fixture', axis: 'world', publicText: fixture.supported }
      ];
      const before = JSON.stringify(rows), ranked = h.hayaku._test.localRecallRank(rows, [fixture.query]);
      const control = candidate(ranked, fixture.query);
      assert.ok(ranked.some(row => row.id === 'z-supported'), `${fixture.id} retains supported multilingual recall`);
      assert.equal(control[0].id, 'z-supported', `${fixture.id} exact sentence control`);
      assert.equal(JSON.stringify(rows), before, 'evaluation cannot alter source evidence');
      return { ...fixture, baselineIds: ranked.map(row => row.id), candidateIds: control.map(row => row.id),
        baselineTop1Correct: ranked[0].id === 'z-supported', candidateTop1Correct: control[0].id === 'z-supported',
        baselineContradictoryHit: ranked.some(row => row.id === 'a-distractor') };
    });
    assert.equal(results.find(row => row.id === 'en-role').baselineTop1Correct, false, 'the observed bag-of-terms role reversal remains an explicit bounded limitation');
    assert.equal(h.llmCalls.length, 0);
    console.log(JSON.stringify({ dataset: 'six hand-authored same-language controls', activatedInProduct: false,
      baselineTop1: results.filter(row => row.baselineTop1Correct).length,
      candidateTop1: results.filter(row => row.candidateTop1Correct).length,
      baselineContradictoryHits: results.filter(row => row.baselineContradictoryHit).length,
      limits: 'Exact equality control; no paraphrase, cross-language, or universal semantic accuracy claim.', modelCalls: 0, results }));
  } finally { await h.dispose(); }
});
