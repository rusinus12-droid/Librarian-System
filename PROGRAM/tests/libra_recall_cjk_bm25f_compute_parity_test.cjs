'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');
const createToolIndex = require('../tools/libra_memory_graph_index.cjs');

// LIBRA 9c03c35 retired the BM25F recall compute (plugin-local kernel and the
// `libra.recall-bm25f.v1` server operation). Recall is now served only by the
// unified memory graph index, whose lexical postings are keyed by the index
// tokenizer. The CJK parity intent is checked against that serving path: the
// plugin-embedded index and the shipped tool module must agree, CJK sentences
// must not collapse into one strong term, and a CJK query must reach the
// matching CJK memory through shared lexical terms.
const indexAdapter = { pages: { measure() { return 0; }, page() { return { items: [], nextOffset: 0 }; } }, fingerprint: () => 'a'.repeat(64) };
const pluginIndexTokenizer = source => {
  const start = source.indexOf('(function createMemoryGraphIndex(');
  const end = source.indexOf('\n});\n    const createLibraMemoryGraphCorpus =', start);
  assert.ok(start >= 0 && end > start, 'LIBRA embeds the unified memory graph index');
  return vm.runInNewContext(source.slice(start, end + 3))(indexAdapter).tokenize;
};

const normalize = value => JSON.parse(JSON.stringify(value));

(async () => {
  const harness = await createLibraVmHarness();
  try {
    assert.match(harness.source, /RECALL_CATALOG_BUILD_VERSION = 'validator_free_cjk_v3'/);
    assert.match(harness.source, /RECALL_CATALOG_BLOCK_BUILD_VERSION = 'memory_lane_cjk_v3'/);
    assert.match(harness.source, /RETRIEVAL_PROJECTION_VERSION = 'libra\.retrieval_projection\.v2'/, 'CJK Sparse upgrade must not rewrite the canonical retrieval projection');
    const japanese = harness.api.debugRecallTokenStream('駅で赤い傘を買った');
    const chinese = harness.api.debugRecallTokenStream('图书馆里发现红色笔记本');
    const mixed = harness.api.debugRecallTokenStream('academy 東京 2026');
    assert.ok(japanese.includes('駅で'));
    assert.ok(chinese.includes('图书'));
    assert.ok(mixed.includes('academy'));
    assert.ok(mixed.includes('2026'));
    assert.equal(japanese.includes('駅で赤い傘を買った'), false, 'whole CJK sentence must not become one strong token');
    assert.ok(harness.api.debugRecallTokenStream('漢'.repeat(4000)).length <= 1600);

    const rows = [
      { id: 'jp:red-notebook', memory: { retrieval: { sparseFields: { summary: '図書館で赤いノートを見つけた', recall_keys: '', characters_relations: '', narrative_open_threads: '', chronology: '', world_scene: '図書館', facts_uncertainty: '', full_text: '赤色のノートが書棚に置かれていた。' } } }, ownerMarker: { canonical: true } },
      { id: 'jp:blue-mug', memory: { retrieval: { sparseFields: { summary: '事務所の青いマグカップ', recall_keys: '', characters_relations: '', narrative_open_threads: '', chronology: '', world_scene: '事務所', facts_uncertainty: '', full_text: '青いカップが机にある。' } } }, ownerMarker: { canonical: true } },
      { id: 'zh:umbrella', memory: { retrieval: { sparseFields: { summary: '车站商店里的新雨伞', recall_keys: '', characters_relations: '', narrative_open_threads: '', chronology: '', world_scene: '火车站', facts_uncertainty: '', full_text: '因为下雨买了一把雨伞。' } } }, ownerMarker: { canonical: true } }
    ];
    const pluginTokenize = pluginIndexTokenizer(harness.source);
    const toolTokenize = createToolIndex(indexAdapter).tokenize;
    const terms = text => {
      const local = normalize(pluginTokenize(text));
      assert.deepEqual(normalize(toolTokenize(text)), local, 'plugin and tool index must tokenize identically');
      return local;
    };
    assert.equal(terms('駅で赤い傘を買った').includes('駅で赤い傘を買った'), false, 'whole CJK sentence must not become one lexical posting term');
    const query = terms('図書館の赤いノート');
    const scores = rows.map(row => {
      const docTerms = new Set(Object.values(row.memory.retrieval.sparseFields).flatMap(terms));
      return { id: row.id, evidence: query.filter(term => docTerms.has(term)).length };
    }).sort((a, b) => b.evidence - a.evidence || a.id.localeCompare(b.id));
    assert.ok(scores[0].evidence > 0, 'CJK query must share lexical terms with the matching memory');
    assert.equal(scores[0].id, 'jp:red-notebook');
    assert.ok(scores[1].evidence < scores[0].evidence);
  } finally {
    await harness.cleanup();
  }
  process.stdout.write('libra_recall_cjk_bm25f_compute_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_recall_cjk_bm25f_compute_parity_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
