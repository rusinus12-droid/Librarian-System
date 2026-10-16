'use strict';
// N01 second increment: the generation publication carries the source inventory, and the delta
// against the previous generation is either computed on the same window or explained as absent.
//
// The store owns publication, so this is where a generation can honestly record which part of each
// family it covers. The tests below use the same in-memory owner transport as the store suite.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const createPages = require('../tools/libra_memory_graph_pages.cjs');
const createStore = require('../tools/libra_memory_graph_store.cjs');
const createInventory = require('../tools/libra_memory_graph_inventory.cjs');

const fingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const options = { canonicalCursor: '', microCursor: '', limit: 20, nodeLimit: 2048 };

const makeFixture = ({ withInventory = true } = {}) => {
  const values = new Map([['source', 'original']]);
  const events = [];
  const pages = createPages({ fingerprint });
  const inventory = createInventory({ fingerprint });
  const store = createStore(withInventory ? { pages, fingerprint, inventory } : { pages, fingerprint });
  const graph = {
    schema: 'libra.memory_graph_projection.v1', scopeKey: 'fixture',
    readerFrame: { owner: 'libra:fixture', scopeKey: 'fixture', worldlineId: 'main', restoreEpoch: 0, view: { viewerId: 'owner_reader' } },
    coverage: { inventory: { inventoryComplete: false, canonicalNextCursor: 'mgc1:20', microNextCursor: 'mgm1:12' } },
    nodes: Array.from({ length: 8 }, (_, i) => ({ id: 'n' + i, bindingId: 'b' + i })),
    edges: [{ id: 'e0', bindingId: 'edge' }],
    bases: [{ id: 'basis', bindingId: 'reason' }],
    units: Array.from({ length: 8 }, (_, i) => ({ nodeId: 'n' + i, family: ['canonical', 'micro', 'state', 'lore'][i % 4], text: 'x'.repeat(100) + i }))
  };
  const owner = {
    publication: 'test_runtime_ordered_partial', check() {},
    async read(key) { return values.get(key) ?? null; },
    async putImmutable(key, raw) { if (values.has(key)) throw Error('write_conflict'); events.push(key); values.set(key, raw); },
    async capture(keys) { return keys.map(key => ({ key, raw: values.get(key) ?? null })); },
    async assertCaptured(pin) { for (const item of pin) if ((values.get(item.key) ?? null) !== item.raw) throw Error('source_pin_changed'); },
    async commitRoot({ key, raw, previous, expected, sourcePin }) {
      await owner.assertCaptured(sourcePin);
      for (const row of expected) if (values.get(row.key) !== row.raw) throw Error('page_changed');
      if ((values.get(key) ?? null) !== previous) throw Error('root_conflict');
      events.push(key); values.set(key, raw);
    }
  };
  const snapshot = async () => ({ graph: clone(graph), sourceKeys: ['source'] });
  return {
    values, events, pages, store, graph, owner, snapshot,
    build: extra => store.build({ snapshot, owner, sourceOptions: options, pageBytes: 512, jobToken: 'job-' + events.length, ...extra }),
    read: extra => store.read({ snapshot, owner, sourceOptions: options, ...extra })
  };
};

const tests = [];
const test = async (name, run) => { await run(); tests.push(name); };
const deltaFor = (built, family) => (built.sourceInventoryDeltas || []).find(delta => delta.family === family) || null;

(async () => {
  await test('N01: a published generation records what part of each family it covers', async () => {
    const x = makeFixture();
    const built = await x.build();
    assert.equal(built.status, 'published');
    assert.equal(built.sourceInventory.schema, 'libra.graph_generation_inventory.v1');
    const merged = built.sourceInventory.merged;
    assert.deepEqual(merged.families, ['canonical', 'lore', 'micro', 'state']);
    assert.deepEqual(merged.missingFamilies, []);
    assert.equal(merged.coverage, 'partial', 'a window is not a whole family');
    assert.equal(merged.byteBounded, false);
    assert.deepEqual(merged.ownerCursors.map(region => region.cursor), ['mgc1:20', 'mgm1:12']);
    assert.equal(built.sourceInventoryDeltaBasis, 'no_previous_generation');
    assert.deepEqual(built.sourceInventoryDeltas, []);
    const canonical = built.sourceInventory.pages.find(page => page.family === 'canonical');
    assert.deepEqual(canonical.unread, [{ family: 'canonical', cursor: 'mgc1:20', reason: 'owner_cursor' }]);
    // The same inventory is readable from the published generation.
    const read = await x.read();
    assert.equal(read.status, 'verified');
    assert.equal(read.durableGenerationVerified, true);
    assert.deepEqual(read.sourceInventory.merged.families, ['canonical', 'lore', 'micro', 'state']);
    assert.equal(read.sourceInventoryDeltaBasis, 'no_previous_generation');
  });

  await test('N01: the delta is computed on the same window and reports its own incompleteness', async () => {
    const x = makeFixture();
    await x.build();
    const built = await x.build();
    assert.equal(built.sourceInventoryDeltaBasis, 'same_window');
    const canonical = deltaFor(built, 'canonical');
    assert.ok(canonical, 'each family with a previous counterpart gets a delta');
    assert.deepEqual(canonical.added, []);
    assert.equal(canonical.deltaComplete, false);
    assert.ok(canonical.reasons.includes('coverage_not_declared'), JSON.stringify(canonical.reasons));
    // The mock units carry no revision, so the delta says so instead of assuming they match.
    assert.equal(canonical.unverified.length, 2);
    assert.ok(canonical.reasons.includes('revision_unverifiable'));
  });

  await test('N01: an entry that disappears is a removal only where the owner reports tombstones', async () => {
    const x = makeFixture();
    await x.build();
    x.graph.units = x.graph.units.filter(unit => unit.nodeId !== 'n0');
    const built = await x.build();
    assert.equal(built.sourceInventoryDeltaBasis, 'same_window');
    const canonical = deltaFor(built, 'canonical');
    assert.equal(canonical.windowChanged, false);
    assert.deepEqual(canonical.unobservableRemoval, ['n0']);
    assert.deepEqual(canonical.removed, [], 'canonical cannot prove a deletion');
    assert.ok(canonical.reasons.includes('removal_not_observable'));
    assert.equal(canonical.deltaComplete, false);
  });

  await test('N01 negative control: across windows nothing is reported as a deletion, even for lore', async () => {
    const x = makeFixture();
    const first = await x.build(), read = await x.read();
    // A lore entry disappears and the window moves: lore does report tombstones inside a window, but
    // across windows an absent entry is outside the window, so it must not be called removed.
    x.graph.units = x.graph.units.filter(unit => unit.nodeId !== 'n3');
    x.graph.units.push({ nodeId: 'n9', family: 'state', text: 'y'.repeat(100) });
    const built = await x.build({ sourceOptions: { ...options, canonicalCursor: 'mgc1:20' },
      baseRootKey: read.rootKey, baseGeneration: first.generation });
    assert.equal(built.sourceInventoryDeltaBasis, 'previous_window');
    for (const delta of built.sourceInventoryDeltas) {
      assert.deepEqual(delta.removed, [], delta.family + ' must not report a cross-window deletion');
      assert.equal(delta.windowChanged, true);
      assert.ok(delta.reasons.includes('window_changed'));
    }
    const lore = deltaFor(built, 'lore');
    assert.deepEqual(lore.unobservableRemoval, ['n3'], 'the absent lore entry is outside the window');
    assert.deepEqual(lore.removalObservable, true, 'lore can report tombstones — inside one window');
    assert.deepEqual(deltaFor(built, 'state').added, ['n9']);
  });

  await test('N01 regression: source revision and binding changes remain within the same window', async () => {
    const x = makeFixture();
    x.graph.units[0].revision = 'r1';
    const first = await x.build();
    x.graph.units[0].revision = 'r2'; x.graph.nodes[0].bindingId = 'changed-source-binding';
    const built = await x.build(), delta = deltaFor(built, 'canonical');
    assert.notEqual(built.sourceStamp, first.sourceStamp, 'the source itself changed');
    assert.equal(built.sourceInventoryDeltaBasis, 'same_window');
    assert.equal(delta.windowChanged, false);
    assert.deepEqual(delta.changed, [{ key: 'n0', from: 'r1', to: 'r2' }]);
    assert.equal(delta.reasons.includes('window_changed'), false);
  });

  await test('N01 regression: same-window lore removal is observable even when the source stamp changes', async () => {
    const x = makeFixture(); await x.build();
    x.graph.units = x.graph.units.filter(unit => unit.nodeId !== 'n3');
    x.graph.nodes = x.graph.nodes.filter(node => node.id !== 'n3');
    const built = await x.build(), delta = deltaFor(built, 'lore');
    assert.equal(built.sourceInventoryDeltaBasis, 'same_window');
    assert.deepEqual(delta.removed, ['n3']);
    assert.deepEqual(delta.unobservableRemoval, []);
    assert.equal(delta.deltaComplete, false, 'a bounded window still has incomplete family coverage');
  });

  await test('N01 regression: an explicit base within the same window is not a window change', async () => {
    const x = makeFixture(), first = await x.build(), read = await x.read();
    const built = await x.build({ baseRootKey: read.rootKey, baseGeneration: first.generation });
    assert.equal(built.sourceInventoryDeltaBasis, 'same_window');
    assert.ok(built.sourceInventoryDeltas.every(delta => delta.windowChanged === false));
  });

  await test('N01 regression: changing the restore/view frame keeps cross-window removals unobservable', async () => {
    for (const change of [graph => { graph.readerFrame.restoreEpoch++; }, graph => { graph.readerFrame.view.cutoffTurn = 5; }]) {
      const x = makeFixture(); await x.build();
      change(x.graph); x.graph.units = x.graph.units.filter(unit => unit.nodeId !== 'n3');
      const built = await x.build(), delta = deltaFor(built, 'lore');
      assert.equal(built.sourceInventoryDeltaBasis, 'previous_window');
      assert.equal(delta.windowChanged, true);
      assert.deepEqual(delta.removed, []);
      assert.deepEqual(delta.unobservableRemoval, ['n3']);
    }
  });

  await test('N01 negative control: without the inventory kernel nothing is claimed about coverage', async () => {
    const x = makeFixture({ withInventory: false });
    const built = await x.build();
    assert.equal(built.sourceInventory, null);
    assert.equal(built.sourceInventoryDeltaBasis, 'inventory_disabled');
    const read = await x.read();
    assert.equal(read.sourceInventory, null);
    assert.equal(read.durableGenerationVerified, true, 'the generation itself is still verified');
  });

  await test('N01: a unit outside the four families is not counted and not blamed', async () => {
    const x = makeFixture();
    x.graph.units.push({ nodeId: 'n99', family: 'unknown_family', text: 'z'.repeat(100) });
    const built = await x.build();
    assert.deepEqual(built.sourceInventory.merged.families, ['canonical', 'lore', 'micro', 'state']);
    const total = built.sourceInventory.pages.reduce((sum, page) => sum + page.entryCount, 0);
    assert.equal(total, 8, 'only the four known families are enumerated');
  });

  await test('N01: an explicit base generation is loaded and checked, not trusted', async () => {
    const x = makeFixture();
    const first = await x.build();
    const read = await x.read();
    assert.ok(read.rootKey && read.nextWindow, 'a published generation exposes its root and its unread handle');
    // Continuing lands in another slot, so the base is named explicitly — and it must really be the
    // generation it claims to be.
    await assert.rejects(() => x.build({ baseRootKey: read.rootKey, baseGeneration: 'f'.repeat(64) }),
      error => String(error.message).includes('BASE_GENERATION_MISMATCH'), 'a foreign base is refused');
    const continued = await x.build({ baseRootKey: read.rootKey, baseGeneration: first.generation,
      sourceOptions: { ...options, canonicalCursor: 'mgc1:20' } });
    assert.equal(continued.status, 'published');
    assert.equal(continued.sourceInventoryDeltaBasis, 'previous_window');
    for (const delta of continued.sourceInventoryDeltas) {
      if (delta.skipped) continue;
      assert.equal(delta.removed.length, 0, 'a continued window never reports a cross-window deletion');
      assert.equal(delta.windowChanged, true);
    }
  });

  console.log(JSON.stringify({ suite: 'libra_memory_graph_inventory_store', passed: tests.length, tests }));
})();
