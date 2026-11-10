'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

test('retired graph APIs, server capabilities and lifecycle endpoint are absent', async t => {
  const x = await serverFixture({ mode: 'server_only' }); t.after(() => x.cleanup());
  for (const name of ['buildMemoryGraphCorpus','buildMemoryGraphGeneration','getMemoryGraphProjectionPage',
    'inspectMemoryGraphStructure','getMemoryGraphDurablePage','collectMemoryGraphGarbage','inspectMemoryNetwork',
    'getAssociativeRecallDiagnostics','executeMemoryGraphUnifiedQuery','inspectVolatileMemoryGraphCorpus',
    'getEvidenceLinkIndex','getLoreLinkIndex','setLoreLinkMapping']) {
    assert.equal(x.f.r.api[name], undefined, name);
    assert.equal(x.f.r.core[name], undefined, 'core ' + name);
  }
  const boot = await x.send('GET', '/bootstrap');
  const capabilities = Array.isArray(boot.capabilities) ? boot.capabilities : Object.keys(boot.capabilities || {});
  assert.equal(capabilities.some(name => name.startsWith('libra-graph-')), false);
  assert.equal((await x.send('POST', '/v1/libra/graph-lifecycle', { action: 'inventory', scopeKey: 'test' })).status, 404);
  assert.equal(typeof x.f.r.api.executeStateMemoryQuery, 'function');
  const plugin = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  for (const marker of ['buildAssociativeRecallPanel','buildDurableGraphPanel','acquireGraphStorageLease',
    'LIBRA MEMORY GRAPH','LIBRA_MEMORY_GRAPH','durableGraphBuildFailure','ASSOCIATIVE_RECALL_','RECALL_CATALOG_BLOCK',
    'durable_common_index','request_local_corpus','legacyRankerExecuted','unifiedMemoryEngine:','RECALL_HYDRATE_','BM25F_WEIGHTS',
    'EVIDENCE_LINK_INDEX_','LORE_LINK_INDEX_','evidenceLinkIndexCache','loreLinkIndexCache',
    'evidence_link_index_enabled','lore_link_index_enabled']) assert.equal(plugin.includes(marker), false, marker);
});

for (const mode of ['plugin_only', 'mirror', 'server_only']) test('retired index rows stay untouched during recall and restart: ' + mode, async t => {
  const x = await serverFixture({ mode, args: { evidence_link_index_enabled: 'true', lore_link_index_enabled: 'true' } });
  t.after(() => x.cleanup());
  assert.equal((await x.f.run()).completed, 1);
  const manifest = mode === 'plugin_only' ? JSON.parse([...x.local].find(([key]) => key.endsWith(':manifest'))[1]) : x.getManifest();
  const prefix = `libra:v1:scope:${manifest.scopeKey}:`;
  const legacy = new Map(['evidence-link-index:v1','lore-link-index:v1','lore-link-mapping:v1'].map(suffix =>
    [prefix + suffix, { schema: 'retired-test-data', marker: suffix, data: ['preserve'] }]));
  for (const [key, value] of legacy) {
    if (mode !== 'server_only') x.local.set(key, JSON.stringify(value));
    if (mode !== 'plugin_only') await x.mutate(key, value);
  }
  const f = await x.restart();
  const result = await f.r.api.executeStateMemoryQuery({ queryInput: { queryText: '은빛 열쇠' }, consumerPolicy: { maxCharacters: 8000, maxUnits: 24 } });
  assert.ok(result.bundle.items.some(row => row.family === 'canonical' || row.family === 'state'));
  assert.equal(result.bundle.items.some(row => row.family === 'lore'), false);
  for (const [key, value] of legacy) {
    if (mode !== 'server_only') assert.equal(x.local.get(key), JSON.stringify(value));
    if (mode !== 'plugin_only') assert.deepEqual(x.storedRows().find(row => row.key === key)?.value, value);
  }
});
