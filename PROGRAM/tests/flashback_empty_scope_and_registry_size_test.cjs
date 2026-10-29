'use strict';
// A chat with no stored Flashback memory has no manifest; emptyManifest() stamps updatedAt=now on
// every read, so the before/after identity check of the response list and the world line view
// always "changed" and both views stayed on an error. Separately, callers pass whole manifests as
// scope metadata, so every registry entry carried its per-shard summaries and the registry grew
// past the 4 MB server value limit. Full plugin in the native runtime fixture.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

(async () => {
  // Manifest reads take a few milliseconds, as a server round-trip does, so the generated
  // timestamps of an absent manifest differ between the list's two reads.
  const values = new Map();
  const pluginStorage = { values,
    async getItem(key) { if (/manifest/.test(String(key))) await new Promise(resolve => setTimeout(resolve, 5)); return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); } };
  const f = await createFixture({ pluginStorage });
  const results = [];
  try {
    const t = f.api._test, scope = await f.api.resolveCurrentScope();
    const empty = await t.loadScopeManifest(scope.scopeKey);
    assert.equal(empty.manifestRawPresent, false, 'fixture chat starts without stored memory');

    const listed = await f.api.listManualEditorRecords({ scope, force: true });
    assert.equal(listed.total, 0);
    assert.equal(listed.records.length, 0);
    results.push('response originals list opens for a chat without stored memory');

    const view = await t.loadFlashbackWorldlineView({});
    assert.ok(view && typeof view === 'object', 'world line view resolves');
    results.push('world line view opens for a chat without stored memory');

    const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });
    const make = i => ({ id: 'raw-' + i, scopeKey: scope.scopeKey, sourceType: 'response', sourceId: 'turn:' + i,
      text: `User:\n질문 ${i}\n\n---\n\nAssistant:\n응답 ${i}`, title: 'Turn ' + i, pairIndex: i, turnIndex: i,
      vector: [1, 0, 0, 0, 0, 0, 0, 0], createdAt: Date.now(), updatedAt: Date.now() });
    await t.saveAllRecords(Array.from({ length: 120 }, (_, i) => make(i + 1)), cfg, scope);
    const manifest = await t.loadScopeManifest(scope.scopeKey);
    assert.ok(manifest.shardSummaries.length >= 2, 'stored scope has several shard summaries');

    const registryKey = [...f.pluginStorage.values.keys()].find(key => /scope_registry:v2$/.test(key));
    assert.ok(registryKey, 'registry written');
    const registry = JSON.parse(f.pluginStorage.values.get(registryKey));
    const entry = registry.scopes.find(row => row.scopeKey === scope.scopeKey);
    assert.ok(entry, 'current scope is registered');
    assert.equal('shardSummaries' in entry, false, 'per-shard summaries stay in the manifest, not the registry');
    assert.equal(Number(entry.count || entry.stats?.recordTotal || 0) > 0, true, 'registry still carries the scope summary counts');
    results.push('registry entries omit manifest-only shard summaries');

    const rows = await f.api.listScopeStorageStats({ force: true });
    assert.ok(rows.some(row => row.scopeKey === scope.scopeKey), 'storage list includes the current scope');
    results.push('storage list includes the current scope');

    console.log(JSON.stringify({ test: 'flashback_empty_scope_and_registry_size', passed: results.length, results,
      boundary: 'full plugin in native runtime fixture; live RisuAI and server mirror untested' }));
  } finally {
    await f.close?.();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
