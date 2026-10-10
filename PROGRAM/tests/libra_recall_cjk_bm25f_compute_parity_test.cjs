'use strict';

const assert = require('node:assert/strict');
const { executeOperation } = require('../server/compute/registry.cjs');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

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
    const input = normalize(harness.api.debugBuildRecallBm25fInput(rows, '図書館の赤いノート'));
    const local = normalize(harness.api.debugRunRecallBm25fComputeLocal(input));
    const server = normalize(executeOperation('libra.recall-bm25f.v1', input));
    assert.deepEqual(server, local);
    assert.equal(server.scores[0].id, 'jp:red-notebook');
  } finally {
    await harness.cleanup();
  }
  process.stdout.write('libra_recall_cjk_bm25f_compute_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_recall_cjk_bm25f_compute_parity_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
