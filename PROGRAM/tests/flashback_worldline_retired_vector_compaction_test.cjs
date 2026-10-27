'use strict';
// Re-syncing many turns retires their records (with inline 1024-d vectors) into
// the turn worldline. One value grew to 8.7 MB and the server refused it
// (memory_suite_interactive_value_too_large_use_shards). The saved worldline
// must stay under the limit while keeping every retired record's text.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');

test('retired vectors are dropped oldest-first so the worldline fits one storage value', async () => {
  const h = await createFlashback(PROGRAM);
  try {
    const scope = await h.api.resolveCurrentScope(false);
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i) / 3);
    const retiredRecords = Array.from({ length: 300 }, (_, i) => ({
      id: `retired-${i}`, hash: `retired-${i}`, scopeKey: scope.scopeKey, sourceType: 'response', role: 'turn_pair',
      turnIndex: 1 + (i % 20), pairIndex: 1 + (i % 20), chunkIndex: i, chunkCount: 300,
      text: `User:\nturn ${i}\n\n---\n\nAssistant:\nretired body ${i}`, vector, dim: 1024,
      lifecycleStatus: 'inactive_variant', retiredAt: new Date(1793070000000 + i * 1000).toISOString()
    }));
    const worldline = { version: 1, scopeKey: scope.scopeKey, revision: 1, nodes: [], retiredRecords };
    assert.ok(new TextEncoder().encode(JSON.stringify(worldline)).length > 4 * 1024 * 1024, 'fixture exceeds the server value limit');
    await h.api._test.saveTurnWorldline(scope.scopeKey, worldline);
    const raw = [...h.pluginStorage.values].find(([key]) => key.endsWith(':turn_worldline:v1'))?.[1];
    assert.ok(raw, 'the worldline was saved');
    assert.ok(new TextEncoder().encode(typeof raw === 'string' ? raw : JSON.stringify(raw)).length <= 3 * 1024 * 1024);
    const loaded = await h.api._test.loadTurnWorldline(scope.scopeKey);
    assert.equal(loaded.retiredRecords.length, 300, 'no retired turn text is lost');
    const byId = new Map(loaded.retiredRecords.map(record => [record.id, record]));
    assert.equal(byId.get('retired-0').retiredVectorDropped, true, 'oldest vectors go first');
    assert.equal(byId.get('retired-0').vector.length, 0);
    assert.equal(byId.get('retired-299').vector.length, 1024, 'newest vectors are kept while they fit');
    assert.equal(byId.get('retired-0').text, retiredRecords[0].text);
    // A dropped record is raw-first work, so restoring it re-embeds rather than
    // failing the commit readback as a missing vector payload.
    assert.equal(byId.get('retired-0').embeddingWork?.schema, 'flashback.embedding_work.v1');
    assert.ok(['pending', 'unconfigured'].includes(byId.get('retired-0').embeddingWork.status));
    assert.equal(byId.get('retired-0').vectorRef, null);
    assert.equal(byId.get('retired-0').dim, 0);
  } finally { await h.cleanup(); }
});

test('a vector already dropped without embedding work is repaired when the worldline loads', async () => {
  const h = await createFlashback(PROGRAM);
  try {
    const scope = await h.api.resolveCurrentScope(false);
    const legacyDropped = { id: 'legacy-dropped', hash: 'legacy-dropped', scopeKey: scope.scopeKey, sourceType: 'response', sourceHash: 'legacy-hash',
      role: 'turn_pair', turnIndex: 4, pairIndex: 4, chunkIndex: 0, chunkCount: 1, text: 'User:\nhello\n\n---\n\nAssistant:\nworld',
      vector: [], dim: 0, retiredVectorDropped: true, lifecycleStatus: 'detached_branch', retiredAt: new Date(1793070000000).toISOString() };
    await h.api._test.saveTurnWorldline(scope.scopeKey, { scopeKey: scope.scopeKey, revision: 1, nodes: [], retiredRecords: [] });
    const worldlineKey = [...h.pluginStorage.values.keys()].find(k => k.endsWith(':turn_worldline:v1'));
    const stored = JSON.parse(h.pluginStorage.values.get(worldlineKey));
    h.pluginStorage.values.set(worldlineKey, JSON.stringify({ ...stored, retiredRecords: [legacyDropped] }));
    const loaded = await h.api._test.loadTurnWorldline(scope.scopeKey);
    const record = loaded.retiredRecords.find(row => row.id === 'legacy-dropped');
    assert.ok(record, 'the record survives');
    assert.equal(record.embeddingWork?.schema, 'flashback.embedding_work.v1');
    assert.equal(record.text, legacyDropped.text);
  } finally { await h.cleanup(); }
});
