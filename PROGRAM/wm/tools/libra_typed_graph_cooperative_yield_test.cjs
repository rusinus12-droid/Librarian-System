'use strict';
// Removing either private-node loop's cooperative checkpoint must fail these tests.
const test = require('node:test'), assert = require('node:assert/strict');
const { runtime } = require('./libra_typed_recall_queue_test.cjs');
const { memoryEntry } = require('./libra_recall_test_runtime.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const key = r => [...r.store.keys()].find(k => k.endsWith(':typed-graph'));
const capture = r => r.snap({ currentTurn: 100, viewerId: 'main_request' });
const maintain = (r, options = {}) => r.api.MemoryEngine.maintainHmeTypedSourceGraph(capture(r), options);
async function setup(options = {}) {
  let count = 0, ticks = 0, checkpoints = 0, onCheckpoint;
  const r = await runtime(options.shared, { admittedHost: true, dist: options.dist, transformCode(code) {
    const node = 'const makeNode = (unit, counts, fingerprint) => {';
    const yieldEntry = 'const ctl = controller || createYieldController();';
    assert.equal(code.split(node).length, 2); assert.equal(code.split(yieldEntry).length, 2);
    const cacheSeam = 'const maintainHmeTypedSourceGraph = async (snapshot, options = {}) => {';
    assert.equal(code.split(cacheSeam).length, 2);
    code = code.replace(cacheSeam, 'globalThis.__GRAPH_CACHE__ = TypedHmeSourceGraph;\n' + cacheSeam);
    return code.replace(node, node + '\n globalThis.__NODE_OBSERVER__?.();')
      .replace(yieldEntry, yieldEntry + '\n if (ctl.label === "typed_hme_nodes") await globalThis.__NODE_CHECKPOINT__?.(ctl);');
  }});
  if (!options.shared) r.chat.localLore = Array.from({ length: 40 }, (_, i) => memoryEntry(i + 1, 'bounded graph source ' + i + ' shared constellation'));
  r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode = 'balanced';
  r.api.MemoryEngine.CONFIG.hybridMemoryEngineEnabled = true;
  r.api.MemoryEngine.CONFIG.hybridScopeIndexEnabled = true;
  // A deterministic six-ms node cost exercises the real governor's existing time
  // slice and native timer. It is not a benchmark or a change to its policy.
  r.context.performance = { now: () => ticks };
  r.context.__NODE_OBSERVER__ = () => { count++; ticks += 6; };
  r.context.__NODE_CHECKPOINT__ = async ctl => { checkpoints++; if (onCheckpoint) await onCheckpoint(ctl, checkpoints); };
  const timers = new Set();
  r.context.setTimeout = (fn, ms, ...args) => { let timer; timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms); timers.add(timer); return timer; };
  r.context.clearTimeout = timer => { timers.delete(timer); clearTimeout(timer); };
  const close = r.close;
  r.close = async () => { try { await close(); } finally { for (const timer of timers) clearTimeout(timer); } };
  return Object.assign(r, { nodeCount: () => count, checkpointCount: () => checkpoints, onCheckpoint: fn => { onCheckpoint = fn; }, resetCounts: () => { count = 0; checkpoints = 0; } });
}
for (const mode of ['built', 'restored']) test(mode + ' node preparation lets a native timer run before completion and preserves exact graph bytes', async () => {
  const r = await setup(); let baseline;
  try {
    if (mode === 'restored') { await maintain(r); r.api.MemoryEngine.clearDerivedCaches(); r.resetCounts(); }
    let observed = null;
    const timer = new Promise(resolve => setTimeout(() => { observed = r.nodeCount(); resolve(); }, 0));
    const result = await maintain(r); await timer;
    assert.equal(result.maintenance.mode, mode); assert.equal(result.nodes, 40);
    assert(observed > 0 && observed < 40, `timer saw ${observed}/40 prepared nodes`);
    if (process.env.TYPED_GRAPH_BASELINE_DIST) {
      baseline = await setup({ dist: process.env.TYPED_GRAPH_BASELINE_DIST }); await maintain(baseline);
      assert.equal(r.store.get(key(r)), baseline.store.get(key(baseline)), 'private yielding must preserve exact serialized graph');
    }
    assert.equal(r.state.calls.length, 0);
  } finally { await r.close(); if (baseline) await baseline.close(); }
});
for (const at of [1, 20, 40]) test('clear at private checkpoint ' + at + ' prevents RAM and storage publication', async () => {
  const r = await setup(); const before = clone([...r.store]);
  try {
    r.onCheckpoint((ctl, n) => { if (n === at) r.api.MemoryEngine.clearDerivedCaches(); });
    await assert.rejects(maintain(r), /graph_source_invalidated/);
    assert.equal(r.checkpointCount(), at); assert.equal(key(r), undefined);
    assert.deepEqual(clone([...r.store]), before); assert.equal(r.state.calls.length, 0);
  } finally { await r.close(); }
});
test('caller invalidation at a private checkpoint prevents publication', async () => {
  const r = await setup(); let current = true;
  try { r.onCheckpoint((ctl, n) => { if (n === 20) current = false; });
    await assert.rejects(maintain(r, { guard: () => current }), /graph_source_invalidated/); assert.equal(key(r), undefined);
  } finally { await r.close(); }
});
test('newer same-scope work invalidates private preparation and is the sole final graph writer', async () => {
  const r = await setup(); let newer, writes = 0; const set = r.storage.setItem;
  r.storage.setItem = async (k, v) => { if (k.endsWith(':typed-graph')) writes++; return set(k, v); };
  try {
    r.onCheckpoint((ctl, n) => { if (n === 20) { r.chat.localLore[0] = memoryEntry(1, 'newer source graph'); newer = maintain(r); } });
    await assert.rejects(maintain(r), /graph_source_invalidated/); assert(newer);
    assert.equal((await newer).maintenance.mode, 'built'); assert.equal(writes, 1);
    assert.equal((await maintain(r)).maintenance.mode, 'reused'); assert.equal(writes, 1);
  } finally { await r.close(); }
});
test('invalidated persisted-cache read stops before any private node work', async () => {
  const r = await setup(); const get = r.storage.getItem;
  try {
    r.storage.getItem = async k => { const result = await get(k); if (k.endsWith(':typed-graph')) r.api.MemoryEngine.clearDerivedCaches(); return result; };
    await assert.rejects(maintain(r), /graph_source_invalidated/); assert.equal(r.nodeCount(), 0); assert.equal(key(r), undefined);
  } finally { await r.close(); }
});

for (const at of [1, 20, 40]) test('restored checkpoint ' + at + ' refuses clear without replacing persisted bytes or source', async () => {
  const r = await setup();
  try {
    await maintain(r); r.api.MemoryEngine.clearDerivedCaches(); r.resetCounts();
    const before = clone([...r.store]), lore = clone(r.chat.localLore);
    r.onCheckpoint((ctl, n) => { assert.equal(r.context.__GRAPH_CACHE__.cachedScopes(), 0); if (n === at) r.api.MemoryEngine.clearDerivedCaches(); });
    await assert.rejects(maintain(r), /graph_source_invalidated/);
    assert.equal(r.checkpointCount(), at); assert.equal(r.context.__GRAPH_CACHE__.cachedScopes(), 0);
    assert.deepEqual(clone([...r.store]), before); assert.deepEqual(clone(r.chat.localLore), lore);
  } finally { await r.close(); }
});
for (const [mode, change] of [['built', cfg => { cfg.hmeAssociativeGraphMode = 'deep'; }], ['restored', cfg => { cfg.hybridMemoryEngineEnabled = false; }], ['updated', cfg => { cfg.hmeGraphMaxNodes = 2300; }]]) test(mode + ' preparation refuses a policy change at a private checkpoint', async () => {
  const r = await setup();
  try {
    if (mode !== 'built') await maintain(r);
    if (mode === 'restored') r.api.MemoryEngine.clearDerivedCaches();
    if (mode === 'updated') r.chat.localLore[0] = memoryEntry(1, 'changed row for warm reconciliation');
    r.resetCounts(); const before = clone([...r.store]), lore = clone(r.chat.localLore), cached = r.context.__GRAPH_CACHE__.cachedScopes();
    r.onCheckpoint((ctl, n) => { if (n === 20) change(r.api.MemoryEngine.CONFIG); });
    await assert.rejects(maintain(r), /graph_source_invalidated/);
    assert.deepEqual(clone([...r.store]), before); assert.deepEqual(clone(r.chat.localLore), lore);
    assert.equal(r.context.__GRAPH_CACHE__.cachedScopes(), cached);
  } finally { await r.close(); }
});
