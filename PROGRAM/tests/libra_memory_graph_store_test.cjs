'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const createPages = require('../tools/libra_memory_graph_pages.cjs'), createStore = require('../tools/libra_memory_graph_store.cjs');
const fingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const options = { canonicalCursor: '', microCursor: '', limit: 20, nodeLimit: 2048 };
function fixture() {
  const values = new Map([['source', 'original']]), events = [];
  const pages = createPages({ fingerprint }), store = createStore({ pages, fingerprint });
  const graph = { schema: 'libra.memory_graph_projection.v1', scopeKey: 'fixture',
    readerFrame: { owner: 'libra:fixture', scopeKey: 'fixture', worldlineId: 'main', restoreEpoch: 0, view: { viewerId: 'owner_reader' } },
    coverage: { inventory: { inventoryComplete: false } },
    nodes: Array.from({ length: 8 }, (_, i) => ({ id: 'n' + i, bindingId: 'b' + i })),
    edges: [{ id: 'e0', bindingId: 'edge' }], bases: [{ id: 'basis', bindingId: 'reason' }],
    units: Array.from({ length: 8 }, (_, i) => ({ nodeId: 'n' + i, family: ['canonical','micro','state','lore'][i % 4], text: 'x'.repeat(100) + i })) };
  const owner = {
    publication: 'test_runtime_ordered_partial', check() {}, async read(key) { return values.get(key) ?? null; },
    async putImmutable(key, raw) { if (values.has(key)) throw Error('write_conflict'); events.push(key); values.set(key, raw); },
    async capture(keys) { return keys.map(key => ({ key, raw: values.get(key) ?? null })); },
    async assertCaptured(pin) { for (const item of pin) if ((values.get(item.key) ?? null) !== item.raw) throw Error('source_pin_changed'); },
    async commitRoot({ key, raw, previous, expected, sourcePin }) {
      await owner.assertCaptured(sourcePin); for (const row of expected) if (values.get(row.key) !== row.raw) throw Error('page_changed');
      if ((values.get(key) ?? null) !== previous) throw Error('root_conflict'); events.push(key); values.set(key, raw);
    }
  };
  const snapshot = async () => ({ graph: clone(graph), sourceKeys: ['source'] });
  return { values, events, pages, store, graph, owner, snapshot,
    build: extra => store.build({ snapshot, owner, sourceOptions: options, pageBytes: 512, jobToken: 'job-' + events.length, ...extra }),
    read: extra => store.read({ snapshot, owner, sourceOptions: options, ...extra }),
    rootKey: () => store.location(graph, options).rootKey };
}
const idle = x => { const state = x.pages.inspect(); assert.equal(state.activeRequests, 0); assert.equal(state.pins, 0);
  assert.equal(state.bytes.request, 0); assert.equal(state.bytes.staging, 0); assert.equal(x.store.inspect().activeBuild, false); };
const tests = [];
const test = async (name, run) => { await run(); tests.push(name); };
const resign = (x, manifest, root) => {
  const raw = JSON.stringify(manifest), generation = fingerprint(raw), prefix = x.store.location(x.graph, options).prefix;
  x.values.set(prefix + 'generation:' + generation, raw);
  x.values.set(x.rootKey(), JSON.stringify({ ...root, generation, manifestKey: prefix + 'generation:' + generation }));
};
(async () => {
  await test('missing generation stays read-only, and a maintenance build publishes its root last', async () => {
    const x = fixture(); assert.equal((await x.read()).status, 'missing_generation'); assert.equal(x.events.length, 0);
    const built = await x.build(); assert.equal(built.status, 'published'); assert.ok(built.pageCount >= 4);
    assert.equal(x.events.at(-1), x.rootKey()); assert.equal(built.inventoryComplete, false); assert.equal(built.ownerAtomicity, false);
    const read = await x.read(); assert.equal(read.status, 'verified'); assert.equal(read.durableGenerationVerified, true); idle(x);
  });
  await test('a fresh store independently verifies all persisted pools after restart without writing', async () => {
    const x = fixture(); await x.build(); const before = x.events.length;
    const fresh = createStore({ pages: createPages({ fingerprint }), fingerprint });
    for (const pool of ['nodes','edges','bases','units']) {
      const read = await fresh.read({ snapshot: x.snapshot, owner: x.owner, sourceOptions: options, pool });
      assert.equal(read.status, 'verified'); assert.ok(read.items.length); assert.equal(read.modelDispatchEligible, false);
    }
    assert.equal(x.events.length, before); assert.ok(fresh.inspect().counters.validations > 0); idle(x);
  });
  await test('current binding or projection changes reject old data even without a native manifest counter', async () => {
    const x = fixture(); await x.build(); x.graph.nodes[0].bindingId = 'changed';
    assert.equal((await x.read()).status, 'stale_generation'); x.graph.nodes[0].bindingId = 'b0';
    x.graph.units[0].text = 'different unit value with unchanged mock ID labels';
    await assert.rejects(() => x.read(), /DIRECTORY_MISMATCH|PROJECTION_MISMATCH/); idle(x);
  });
  await test('a corrupt unselected page rejects the whole verified window even after a warm cache hit', async () => {
    const x = fixture(); await x.build(); await x.read({ pool: 'nodes' });
    const key = [...x.values.keys()].find(key => key.includes(':page:units:'));
    const body = JSON.parse(x.values.get(key)); body.text = '[]'; x.values.set(key, JSON.stringify(body));
    await assert.rejects(() => x.read({ pool: 'nodes' }), /PAGE_CORRUPT/); idle(x);
  });
  await test('recomputed manifest and payload checksums cannot substitute for re-derived source pages', async () => {
    const x = fixture(); await x.build(); const root = JSON.parse(x.values.get(x.rootKey())), manifest = JSON.parse(x.values.get(root.manifestKey));
    const ref = manifest.pages.find(ref => ref.pool === 'units'), record = JSON.parse(x.values.get(ref.key));
    const items = JSON.parse(record.text); items[0].text = 'forged'; record.text = JSON.stringify(items);
    record.digest = fingerprint(record.text); record.codeUnits = record.text.length; record.utf8Bytes = Buffer.byteLength(record.text);
    Object.assign(ref, { digest: record.digest, codeUnits: record.codeUnits, utf8Bytes: record.utf8Bytes,
      key: x.store.location(x.graph, options).prefix + 'page:units:' + record.digest });
    x.values.set(ref.key, JSON.stringify(record)); resign(x, manifest, root);
    await assert.rejects(() => x.read(), /DIRECTORY_MISMATCH/); idle(x);
  });
  await test('partial page writes preserve the previously published root and reuse safe immutable pages later', async () => {
    const x = fixture(); await x.build(); const root = x.values.get(x.rootKey());
    x.graph.units[0].text = 'new'; x.graph.nodes[0].bindingId = 'new';
    const put = x.owner.putImmutable; x.owner.putImmutable = async () => { throw Error('synthetic_write_failure'); };
    await assert.rejects(() => x.build(), /synthetic_write_failure/); assert.equal(x.values.get(x.rootKey()), root); idle(x);
    x.owner.putImmutable = put; await x.build(); assert.notEqual(x.values.get(x.rootKey()), root); idle(x);
  });
  await test('source changes while pages are being prepared abort before root publication', async () => {
    const x = fixture(); await x.build(); const root = x.values.get(x.rootKey()), put = x.owner.putImmutable;
    x.graph.nodes[0].bindingId = 'first-change';
    x.owner.putImmutable = async (...args) => { await put(...args); x.graph.coverage.pending = true; };
    await assert.rejects(() => x.build(), /SOURCE_CHANGED/); assert.equal(x.values.get(x.rootKey()), root); idle(x);
  });
  await test('cancellation retains the old write barrier until its host write settles', async () => {
    const x = fixture(); await x.build(); const root = x.values.get(x.rootKey()); x.graph.nodes[0].bindingId = 'changed';
    let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    const put = x.owner.putImmutable; x.owner.putImmutable = async (...args) => { started(); await gate; await put(...args); };
    const pending = x.build(); await entered; x.store.invalidate();
    await assert.rejects(() => x.build(), /BUILD_BUSY/); assert.equal(x.store.inspect().activeBuild, true);
    release(); await assert.rejects(() => pending, /CANCELLED/); assert.equal(x.values.get(x.rootKey()), root); idle(x);
  });
  await test('root conflicts and source-pin changes never silently overwrite another publisher', async () => {
    const x = fixture(), commit = x.owner.commitRoot;
    x.owner.commitRoot = async input => { x.values.set(x.rootKey(), 'other-root'); await commit(input); };
    await assert.rejects(() => x.build(), /source_pin_changed|root_conflict/); assert.equal(x.values.get(x.rootKey()), 'other-root'); idle(x);
  });
  await test('a re-signed directory cannot redirect a page read into another partition', async () => {
    const x = fixture(); await x.build(); const root = JSON.parse(x.values.get(x.rootKey())), manifest = JSON.parse(x.values.get(root.manifestKey));
    manifest.pages[0].key = 'foreign-secret-key'; resign(x, manifest, root);
    const read = x.owner.read; x.owner.read = async key => { assert.notEqual(key, 'foreign-secret-key'); return await read(key); };
    await assert.rejects(() => x.read(), /DIRECTORY_MISMATCH/); idle(x);
  });
  await test('oversized stored records are refused before the store JSON parser and never repaired by a query', async () => {
    const x = fixture(); await x.build(); const key = [...x.values.keys()].find(key => key.includes(':page:'));
    x.values.set(key, 'x'.repeat(300000)); const before = x.events.length;
    await assert.rejects(() => x.read(), /RECORD_SIZE_INVALID/); assert.equal(x.events.length, before); idle(x);
  });
  await test('source changes during final verification discard already-decoded output', async () => {
    const x = fixture(); await x.build(); let visits = 0; const read = x.owner.read;
    x.owner.read = async key => { if (key === x.rootKey() && ++visits === 2) x.graph.nodes[0].bindingId = 'late-change'; return await read(key); };
    const result = await x.read(); assert.equal(result.status, 'stale_generation'); assert.deepEqual(result.items, []); idle(x);
  });
  console.log(JSON.stringify({ suite: 'libra_memory_graph_store', passed: tests.length, tests,
    scope: 'synthetic_storage_and_current_projection_contract', actualHostQualified: false }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
