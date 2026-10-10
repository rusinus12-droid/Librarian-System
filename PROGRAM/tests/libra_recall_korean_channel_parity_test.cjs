'use strict';

const assert = require('node:assert/strict');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');
const { executeOperation } = require('../server/compute/registry.cjs');

const fields = text => ({
  summary: text,
  recall_keys: '',
  characters_relations: '',
  narrative_open_threads: '',
  chronology: '',
  world_scene: '',
  facts_uncertainty: '',
  full_text: ''
});
const inputFor = (queryText, documents) => ({
  schema: 'libra.recall-bm25f.input.v1', queryText,
  documents: documents.map(([id, text], position) => ({ position, id, fields: fields(text) }))
});
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
  const harness = await createLibraVmHarness();
  try {
    const score = input => {
      const local = plain(harness.api.debugRunRecallBm25fComputeLocal(input));
      const server = plain(executeOperation('libra.recall-bm25f.v1', input));
      assert.deepEqual(server, local, 'plugin and server compute must agree');
      return Object.fromEntries(local.scores.map(row => [row.id, row]));
    };

    const korean = score(inputFor('도현', [
      ['partial', '도현욱이 도서관에 왔다.'],
      ['complete', '도현은 도서관에 왔다.'],
      ['unrelated', '민아는 정원에 있었다.']
    ]));
    assert.ok(korean.partial.raw > 0, 'Hangul bigram remains a candidate signal');
    assert.equal(korean.partial.evidence, 0, 'a longer name is not strong lexical evidence');
    assert.ok(korean.complete.evidence > 0, 'particle-stripped complete name supplies evidence');

    const latin = score(inputFor('Alice', [
      ['partial', 'Aliceville is a city.'], ['complete', 'Alice visited the city.']
    ]));
    assert.equal(latin.partial.evidence, 0);
    assert.ok(latin.complete.evidence > 0);

    const cjk = score(inputFor('図書館', [
      ['match', '図書館で赤い傘を見つけた。'], ['other', '駅で青い傘を見つけた。']
    ]));
    assert.ok(cjk.match.evidence > 0, 'CJK grams retain the existing sparse evidence path');
  } finally {
    await harness.cleanup();
  }
  console.log('PASS libra_recall_korean_channel_parity_test');
})().catch(error => { console.error(error); process.exitCode = 1; });
