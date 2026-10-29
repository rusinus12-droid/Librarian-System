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

// A live ledger (147 retired chunks, 1024-d vectors, Korean/English turn text)
// was stored indented at 3.8 MB on the wire, next to the 4 MiB server limit.
const realisticRetiredRecords = scopeKey => Array.from({ length: 160 }, (_, i) => ({
  schema: 'vector_rag_memory.record.v2', id: `vrm_${i}`, hash: `h${i}`, scopeKey, sourceType: 'response', role: 'turn_pair',
  title: `라이브챗 콜드스타트: 보라 철벽 허물기 성공 #${i}`, sourceId: `live_chat:abc:${i}`, sourceHash: `src${i}`,
  tags: ['live_chat', 'cold_start', 'raw_chat', 'user_assistant_turn'], turnIndex: 1 + (i % 40), pairIndex: 1 + (i % 40),
  chunkIndex: i % 12, chunkCount: 12, sourceMessageIds: [`live:${i}:user:q0wpnk`, `live:${i}:assistant:dmq97e`],
  entityAnchors: Array.from({ length: 60 }, (_, j) => `anchor${j}`), stateAnchors: Array.from({ length: 30 }, (_, j) => `state${j}`),
  metadata: { memorySanitized: true, memorySanitizerVersion: 4 },
  text: `User:\n보라는 카페로 향했다 "${i}". She didn’t even understand why.\n\n---\n\nAssistant:\n${'긴 응답 본문 '.repeat(60)}`,
  importanceScore: 0.42, vector: Array.from({ length: 1024 }, (_, j) => Number((Math.sin(i * 1024 + j) / 9).toFixed(6))), dim: 1024,
  lifecycleStatus: 'orphaned', retiredAt: new Date(1793070000000 + i * 1000).toISOString()
}));
const wireBytes = raw => new TextEncoder().encode(JSON.stringify(raw)).length;

test('a realistic ledger is stored compact and well under the server value limit', async () => {
  const h = await createFlashback(PROGRAM);
  try {
    const scope = await h.api.resolveCurrentScope(false);
    const retiredRecords = realisticRetiredRecords(scope.scopeKey);
    const worldline = { scopeKey: scope.scopeKey, revision: 2, nodes: [], retiredRecords };
    assert.ok(wireBytes(JSON.stringify(worldline, null, 2)) > 3.5 * 1024 * 1024, 'the indented legacy form sits near the limit');
    await h.api._test.saveTurnWorldline(scope.scopeKey, worldline);
    const raw = [...h.pluginStorage.values].find(([key]) => key.endsWith(':turn_worldline:v1'))[1];
    assert.equal(typeof raw, 'string');
    assert.ok(!raw.includes('\n  '), 'the ledger is not indented');
    assert.ok(wireBytes(raw) <= 2 * 1024 * 1024, `stored ${wireBytes(raw)} bytes`);
    const loaded = await h.api._test.loadTurnWorldline(scope.scopeKey);
    assert.equal(loaded.retiredRecords.length, retiredRecords.length, 'no retired turn text is lost');
    assert.ok(loaded.retiredRecords.every((record, i) => record.text === retiredRecords[i].text));
    const kept = loaded.retiredRecords.filter(record => record.vector.length === 1024).length;
    assert.ok(kept >= retiredRecords.length / 2, `compact storage keeps most vectors (${kept})`);
    assert.equal(loaded.retiredRecords.at(-1).vector.length, 1024, 'newest vectors are kept');
  } finally { await h.cleanup(); }
});

test('an existing indented ledger still loads and is rewritten compact on its next save', async () => {
  const h = await createFlashback(PROGRAM);
  try {
    const scope = await h.api.resolveCurrentScope(false);
    await h.api._test.saveTurnWorldline(scope.scopeKey, { scopeKey: scope.scopeKey, revision: 1, nodes: [], retiredRecords: [] });
    const key = [...h.pluginStorage.values.keys()].find(k => k.endsWith(':turn_worldline:v1'));
    const retiredRecords = realisticRetiredRecords(scope.scopeKey).slice(0, 40);
    const node = { turnNodeId: 'node-1', logicalTurnId: 'logical-1', variantId: 'variant-1', pairIndex: 1, originalOrdinal: 1, activeOrdinal: 1, status: 'active' };
    const legacy = JSON.stringify({ ...JSON.parse(h.pluginStorage.values.get(key)), headTurnNodeId: 'node-1', nodes: [node], retiredRecords }, null, 2);
    h.pluginStorage.values.set(key, legacy);
    const loaded = await h.api._test.loadTurnWorldline(scope.scopeKey);
    assert.equal(loaded.nodes[0].turnNodeId, 'node-1');
    assert.equal(loaded.headTurnNodeId, 'node-1');
    assert.equal(loaded.retiredRecords.length, 40);
    assert.ok(loaded.retiredRecords.every(record => record.vector.length === 1024), 'a legacy ledger under budget keeps every vector');
    await h.api._test.saveTurnWorldline(scope.scopeKey, loaded);
    const rewritten = h.pluginStorage.values.get(key);
    assert.ok(wireBytes(rewritten) < wireBytes(legacy) * 0.7, `${wireBytes(rewritten)} vs ${wireBytes(legacy)}`);
    assert.deepEqual(await h.api._test.loadTurnWorldline(scope.scopeKey), loaded);
  } finally { await h.cleanup(); }
});
