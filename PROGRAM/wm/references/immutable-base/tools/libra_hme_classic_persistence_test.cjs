'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { runtime, flush } = require('./libra_typed_recall_queue_test.cjs');
const clone = value => JSON.parse(JSON.stringify(value));

async function setup(withEntity = false) {
  const r = await runtime(null, { admittedHost: true, dist: process.env.WM_CLASSIC_TEST_DIST, transformCode(code) {
    const build = '        const buildHmeGraphIndexFromScopeIndex = (scopeIndex = null, options = {}) => {';
    assert(code.includes(build), 'classic builder measurement seam');
    code = code.replace(build, build + 'globalThis.__CLASSIC_BUILDS__ = (globalThis.__CLASSIC_BUILDS__ || 0) + (Array.isArray(options.typedNodes) ? 0 : 1);');
    const expose = '            getRecallDerivedStorageAdapter,';
    assert(code.includes(expose), 'classic test access seam');
    return code.replace(expose, expose + '\n            __classicEnsure:ensureHybridScopeIndex,__classicGraph:ensureHmeGraphIndex,__classicCache:getCachedHmeGraphIndex,');
  }});
  r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode = 'balanced';
  const lore = clone(r.chat.localLore.filter(e => e.comment === 'lmai_memory'));
  if (withEntity) lore.push(clone(r.chat.localLore.find(e => e.comment === 'lmai_entity')));
  const scope = r.snapshot.scopeKey;
  const writes = [];
  const originalSet = r.storage.setItem;
  r.storage.setItem = async (key, value) => {
    if (key.startsWith('libra:v1:hme-derived:') && key.endsWith(':graph')) writes.push({ key, value: String(value) });
    return originalSet(key, value);
  };
  const ensure = (options = {}) => r.api.MemoryEngine.__classicEnsure(lore, { scopeKey: scope, currentTurn: 10, ...options });
  const graph = (options = {}) => r.api.MemoryEngine.__classicGraph(lore, { scopeKey: scope, ...options });
  const first = ensure();
  await flush();
  assert.equal(first.ok, true);
  assert.equal(r.context.__CLASSIC_BUILDS__, 1);
  assert.equal(writes.length, 1);
  assert.equal(r.state.calls.length, 0);
  return { r, lore, scope, writes, ensure, graph, first };
}

test('unchanged memory-only graph reuses explicit empty digests without rebuilding or writing', async () => {
  const { r, scope, writes, ensure } = await setup();
  const before = r.api.MemoryEngine.__classicCache(scope);
  assert.equal(before.source.entityDigest, '');
  assert.equal(before.source.loreDigest, '');
  assert.equal(before.source.relationDigest, '');
  const next = ensure(); await flush();
  assert.equal(next.graphChanged, false);
  assert.equal(next.graphMode, 'reused');
  assert.equal(r.context.__CLASSIC_BUILDS__, 1);
  assert.equal(writes.length, 1);
  assert.equal(r.api.MemoryEngine.__classicCache(scope), before);
});

test('actual supplied lorebook permits unchanged entity graph reuse without an options copy', async () => {
  const { r, scope, writes, graph } = await setup(true);
  const before = r.api.MemoryEngine.__classicCache(scope);
  assert.notEqual(before.source.entityDigest, '');
  const next = graph(); await flush();
  assert.equal(next.changed, false);
  assert.equal(next.mode, 'reused');
  assert.equal(r.context.__CLASSIC_BUILDS__, 1);
  assert.equal(writes.length, 1);
});

test('entity body correction and explicit deletion invalidate the graph then reuse the current version', async () => {
  const { r, lore, scope, writes, graph } = await setup(true);
  const prior = r.api.MemoryEngine.__classicCache(scope).source.entityDigest;
  const entity = lore.find(e => e.comment === 'lmai_entity');
  const body = JSON.parse(entity.content);
  body.description = 'Updated persistent entity fact, exactly one source correction.';
  entity.content = JSON.stringify(r.signed(body, 'entity', body.name));
  assert.equal(graph().changed, true); await flush();
  assert.notEqual(r.api.MemoryEngine.__classicCache(scope).source.entityDigest, prior);
  assert.equal(graph().changed, false); await flush();
  lore.splice(lore.findIndex(e => e.key === entity.key), 1);
  assert.equal(graph().changed, true); await flush();
  assert.equal(r.api.MemoryEngine.__classicCache(scope).source.entityDigest, '');
  assert.equal(graph().changed, false); await flush();
  assert.equal(r.context.__CLASSIC_BUILDS__, 3);
  assert.equal(writes.length, 3);
  assert.equal(r.state.calls.length, 0);
});

test('legacy missing or malformed verification fields cause a one-time rebuild', async () => {
  for (const mutation of [source => delete source.entityDigest, source => { source.loreDigest = null; }, source => {
    delete source.entityDigest; delete source.loreDigest; delete source.relationDigest;
  }]) {
    const { r, scope, writes, graph } = await setup();
    mutation(r.api.MemoryEngine.__classicCache(scope).source);
    assert.equal(graph().changed, true); await flush();
    assert.equal(graph().changed, false); await flush();
    assert.equal(r.context.__CLASSIC_BUILDS__, 2);
    assert.equal(writes.length, 2);
  }
});

test('lore and relation changes and removals are verified against the current supplied source', async () => {
  for (const [comment, field, initial, updated] of [
    ['lmai_character_lore_cues', 'loreDigest', { schema: 'libra.character_lore_cues.v1', version: 1, cues: [{ id: 'cue_0', text: 'Initial harbor rule', entityRefs: ['Alice'], tags: [] }] }, { schema: 'libra.character_lore_cues.v1', version: 1, cues: [{ id: 'cue_0', text: 'Corrected harbor rule', entityRefs: ['Alice'], tags: [] }] }],
    ['lmai_relation', 'relationDigest', { entityA: 'Alice', entityB: 'Bob', metrics: { closeness: 2, trust: 3 } }, { entityA: 'Alice', entityB: 'Bob', metrics: { closeness: 2, trust: 8 } }]
  ]) {
    const { r, lore, scope, graph, writes } = await setup();
    const entry = { comment, key: comment + '::source', content: JSON.stringify(initial) };
    lore.push(entry);
    assert.equal(graph().changed, true); await flush();
    const oldDigest = r.api.MemoryEngine.__classicCache(scope).source[field];
    assert.notEqual(oldDigest, '');
    assert.equal(graph().changed, false); await flush();
    lore.find(e => e.key === entry.key).content = JSON.stringify(updated);
    assert.equal(graph().changed, true); await flush();
    assert.notEqual(r.api.MemoryEngine.__classicCache(scope).source[field], oldDigest);
    assert.equal(graph().changed, false); await flush();
    lore.splice(lore.findIndex(e => e.key === entry.key), 1);
    assert.equal(graph().changed, true); await flush();
    assert.equal(r.api.MemoryEngine.__classicCache(scope).source[field], '');
    assert.equal(graph().changed, false); await flush();
    assert.equal(r.context.__CLASSIC_BUILDS__, 4);
    assert.equal(writes.length, 4);
    assert.equal(r.state.calls.length, 0);
  }
});

test('force and obsolete graph schema still rebuild; another scope cannot reuse this graph', async () => {
  const { r, scope, writes, graph, ensure } = await setup();
  assert.equal(graph({ force: true }).changed, true); await flush();
  r.api.MemoryEngine.__classicCache(scope).version = 0;
  assert.equal(graph().changed, true); await flush();
  assert.equal(graph().changed, false); await flush();
  const otherScope = scope + '::other-chat';
  const other = ensure({ scopeKey: otherScope }); await flush();
  assert.equal(other.ok, true);
  const otherGraph = r.api.MemoryEngine.__classicCache(otherScope);
  assert(otherGraph);
  assert.equal(otherGraph.scopeKey, otherScope);
  assert.notEqual(otherGraph, r.api.MemoryEngine.__classicCache(scope));
  assert.equal(r.context.__CLASSIC_BUILDS__, 4);
  assert.equal(writes.length, 4);
});
