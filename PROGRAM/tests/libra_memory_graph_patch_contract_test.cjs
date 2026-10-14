'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
const createPages = require('../tools/libra_memory_graph_pages.cjs');
const createIndex = require('../tools/libra_memory_graph_index.cjs');
const createStore = require('../tools/libra_memory_graph_store.cjs');
const createCompiler = require('../tools/libra_memory_graph_compiler.cjs');
const createRollout = require('../tools/libra_memory_graph_rollout.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const graph = { schema: 'libra.memory_graph_projection.v1', scopeKey: 'fixture',
  readerFrame: { owner: 'libra:plugin_only', scopeKey: 'fixture', worldlineId: 'main', restoreEpoch: 0, view: { viewerId: 'owner_reader' } },
  coverage: { inventory: { inventoryComplete: false } },
  nodes: [{ id: 'n', layer: 'meaning', bindingId: 'b' }], edges: [], bases: [],
  units: [{ nodeId: 'n', family: 'canonical', semanticRole: 'canonical_assertion', text: 'test words' }] };
const tests = [];
async function run(name, fn) { await fn(); tests.push(name); }
const idle = pages => { const s = pages.inspect(); assert.equal(s.activeRequests, 0); assert.equal(s.pins, 0);
  assert.equal(s.bytes.staging, 0); assert.equal(s.bytes.request, 0); };
(async () => {
  await run('R7: compile and query refuse staging failures; disposal and corrupt decode cannot escape through a raw copy', () => {
    const normalPages = createPages({ fingerprint }), normal = createIndex({ pages: normalPages, fingerprint });
    const compiled = normal.compile(graph, { partition: 'p', generation: 'a'.repeat(64) });
    const tinyPages = createPages({ fingerprint, limits: { stagingBytes: 256 } });
    const tiny = createIndex({ pages: tinyPages, fingerprint });
    assert.throws(() => tiny.compile(graph, { partition: 'p', generation: 'a'.repeat(64) }), /PAGE_BUDGET_STAGING_BUDGET/);
    assert.throws(() => tiny.queryPage(compiled), /STAGING_BUDGET/); idle(tinyPages);
    const corrupt = createIndex({ pages: { ...normalPages, decode() { throw Error('INTEGRITY_FAILURE'); } }, fingerprint });
    assert.throws(() => corrupt.queryPage(compiled), /INTEGRITY_FAILURE/); idle(normalPages);
    normalPages.dispose(); assert.throws(() => normal.queryPage(compiled), /DISPOSED/); idle(normalPages);
    const oversized = clone(graph); oversized.units[0].text = 'x'.repeat(20000);
    const pages = createPages({ fingerprint }), index = createIndex({ pages, fingerprint });
    assert.equal(index.compile(oversized, { partition: 'p', generation: 'b'.repeat(64) }).directory.length, 1);
    assert.ok(pages.inspect().counters.pagesDecoded >= 2, 'larger rows use admitted pages rather than the original array'); idle(pages);
  });
  await run('R3/R4: incomplete inventories never sweep; publication during atomic delete rejects the candidate', async () => {
    const values = new Map([['source','v1']]), pages = createPages({ fingerprint }), store = createStore({ pages, fingerprint });
    let beforeDelete = () => {};
    const owner = { publication: 'mock', check() {},
      async read(key) { return values.get(key) ?? null; }, async putImmutable(key, raw) { values.set(key, raw); },
      async capture(keys) { return keys.map(key => ({ key, raw: values.get(key) ?? null })); },
      async assertCaptured(pin) { for (const row of pin) if ((values.get(row.key) ?? null) !== row.raw) throw Error('pin_changed'); },
      async commitRoot({ key, raw }) { values.set(key, raw); },
      async listKeys(prefix) { return [...values.keys()].filter(key => key.startsWith(prefix)); },
      async captureGCInventory(prefix) { return { keys: await this.listKeys(prefix), complete: true, fence: 'mock-namespace-lock' }; },
      async deleteConditional({ key, expectedRaw, roots, inventory, prefix }) {
        beforeDelete(); // Publisher interleaves after the store's final read.
        const now = [...values.keys()].filter(key => key.startsWith(prefix)).sort();
        const expected = inventory.keys.filter(key => values.has(key)).sort();
        if (JSON.stringify(now) !== JSON.stringify(expected) || values.get(key) !== expectedRaw
          || roots.some(root => values.get(root.key) !== root.raw)) return false;
        values.delete(key); return true; // No await between predicate and mutation.
      }
    };
    const sourceOptions = { limit: 20, nodeLimit: 2048 }, snapshot = async () => ({ graph, sourceKeys: ['source'] });
    const build = jobToken => store.build({ snapshot, owner, sourceOptions, pageBytes: 1024, jobToken });
    await build('A'); const rootKey = store.location(graph, sourceOptions).rootKey, a = values.get(rootKey);
    await build('B'); const b = values.get(rootKey), bRoot = JSON.parse(b); values.set(rootKey, a);
    const incompleteOwner = { ...owner, captureGCInventory: undefined, listKeys: async () => [bRoot.manifestKey] };
    const blocked = await store.collectGarbage({ owner: incompleteOwner, scopeKey: 'fixture' });
    assert.equal(blocked.status, 'blocked_incomplete_inventory'); assert.equal(blocked.deletedKeys.length, 0);
    beforeDelete = () => { values.set(rootKey, b); };
    const race = await store.collectGarbage({ owner, scopeKey: 'fixture' });
    assert.equal(race.status, 'aborted_concurrent_mutation'); assert.equal(race.deletedKeys.length, 0);
    assert.ok(values.has(bRoot.manifestKey));
    assert.equal((await store.read({ snapshot, owner, sourceOptions })).status, 'verified'); idle(pages);
    // Even a complete inventory is insufficient without namespace-level deletion fencing.
    const noFence = { ...owner, captureGCInventory: async prefix => ({ keys: await owner.listKeys(prefix), complete: true, fence: null }) };
    assert.equal((await store.collectGarbage({ owner: noFence, scopeKey: 'fixture' })).status, 'blocked_atomic_gc_unavailable');
  });
  await run('R6: rollout refuses a consumer packet failure before granting dispatch', async () => {
    const compiler = createCompiler({ fingerprint });
    const queryResult = { schema: 'libra.memory_graph_query.v1', generation: 'a'.repeat(64), indexDigest: 'b'.repeat(64), frameId: 'c'.repeat(64),
      complete: true, candidates: [{ nodeId: 'n', family: 'canonical', semanticRole: 'canonical_assertion', text: 'test words', score: 1 }] };
    const rollout = createRollout({ fingerprint,
      pages: { generation: () => 'a'.repeat(64) }, index: { compile: () => ({ indexDigest: 'b'.repeat(64) }) }, lane: {},
      query: { sealQueryFrame: () => ({ frameId: 'c'.repeat(64) }), openView: () => ({}), retrieve: () => queryResult },
      compiler: { ...compiler, render: selected => ({ ...compiler.render(selected), consumerVerification: { ok: false } }) }
    });
    const sealToken = rollout.sealRequestMode({ mode: 'unified', requestId: 'bad-packet', owner: graph.readerFrame.owner,
      scopeKey: graph.scopeKey, worldlineId: 'main', restoreEpoch: 0 });
    let physical = 0;
    const result = await rollout.executeUnifiedRequest({ sealToken, graph,
      ownerVerifier: { currentGraph: async () => graph, assertPhysicalCurrentness: async () => { physical++; return true; } } });
    assert.equal(result.deliveryOutcome, 'base_request_only'); assert.equal(result.modelDispatchEligible, false);
    assert.equal(result.packet, null); assert.equal(physical, 0);
  });
  console.log(JSON.stringify({ suite: 'libra_memory_graph_patch_contract', passed: tests.length, tests }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
