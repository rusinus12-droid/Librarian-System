'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const create = require('../tools/libra_memory_graph_pages.cjs');
const fingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
const tests = []; const test = (name, run) => { run(); tests.push(name); };
const graph = (n = 10) => ({ schema: 'libra.memory_graph_projection.v1', coverage: { inventoryComplete: false },
  nodes: Array.from({ length: n }, (_, i) => ({ id: 'node:' + i, bindingId: 'binding:' + i })), edges: [], bases: [],
  units: Array.from({ length: n }, (_, i) => ({ nodeId: 'node:' + i, family: ['canonical','micro','state','lore'][i % 4], text: '한국어🌏 ' + i + 'x'.repeat(100) })) });
const put = (store, handle, items, pool = 'units') => {
  const size = store.measure(items), text = JSON.stringify(items);
  const stage = store.reserve(handle, store.stageCost(size)), binding = { pool, codec: 'json_array.v1', rows: items.length, digest: fingerprint(text) };
  try { return { token: store.install(handle, binding, text, stage), binding }; }
  finally { store.releaseStage(stage); }
};
const idle = store => { const x = store.inspect(); assert.equal(x.activeRequests, 0); assert.equal(x.pins, 0);
  assert.equal(x.bytes.request, 0); assert.equal(x.bytes.staging, 0); assert.ok(x.bytes.resident <= x.limits.residentBytes); };

test('pre-encoding measurement agrees with real JSON UTF8 and UTF16 across escapes and Unicode', () => {
  const store = create({ fingerprint });
  for (const value of [null, true, -1.3e-8, ['한국어', '🌏', '\u0000\b\t\n\f\r"\\', '\ud800', '\udfff', '\u2028'],
    { 'escaped\nkey': [0, false, { value: 'abc' }] }]) {
    const size = store.measure(value), text = JSON.stringify(value);
    assert.equal(size.utf8Bytes, Buffer.byteLength(text)); assert.equal(size.codeUnits, text.length);
  }
  assert.throws(() => store.measure('x'.repeat(10000), 256), /ROW_EXCEEDS_PAGE/);
});
test('measurement never runs caller getters, toJSON, sparse arrays or cycles', () => {
  const store = create({ fingerprint }); let invoked = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked++; return 'unsafe'; } });
  const cycle = {}; cycle.self = cycle;
  for (const value of [getter, { toJSON() { invoked++; return 1; } }, [,,], cycle, { value: undefined }]) assert.throws(() => store.measure(value), /JSON_INVALID/);
  assert.equal(invoked, 0);
});
test('nested empty containers and recorded narrative dictionaries fit their preflight validation reservation', () => {
  const store = create({ fingerprint }), source = graph(1);
  source.units[0].value = Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['field' + i, i % 2 ? {} : []]));
  const page = store.page(source, { partition: 'scope', generation: 'g', pageBytes: 16384 });
  assert.equal(page.items.length, 1, JSON.stringify(page.budgetDetail)); assert.deepEqual(page.items[0], source.units[0]); idle(store);
});
test('page boundaries traverse every supplied row without a recent-N or family cutoff', () => {
  const store = create({ fingerprint }), source = graph(24), rows = [];
  let offset = 0;
  while (offset < source.units.length) {
    const page = store.page(source, { partition: 'scope', generation: 'g', offset, pageBytes: 600 });
    assert.ok(page.items.length); assert.ok(page.serializedUtf8Bytes <= 600); assert.ok(page.nextOffset > offset);
    rows.push(...page.items); offset = page.nextOffset; idle(store);
  }
  assert.deepEqual(rows, source.units);
  const tooSmall = store.page(source, { partition: 'scope', generation: 'g', pageBytes: 256 });
  if (!tooSmall.items.length) { assert.equal(tooSmall.nextOffset, 0); assert.equal(tooSmall.stopReason, 'row_exceeds_page'); }
});
test('same immutable payload is reusable across issued generations without reviving old request handles', () => {
  const store = create({ fingerprint }), source = graph();
  const a = store.page(source, { partition: 'scope', generation: 'g1', pageBytes: 600 });
  const b = store.page(source, { partition: 'scope', generation: 'g2', pageBytes: 600 });
  assert.equal(a.cacheHit, false); assert.equal(b.cacheHit, true); assert.deepEqual(a.items, b.items); assert.equal(b.generation, 'g2'); idle(store);
});
test('LRU eviction changes residency while reloaded page contents stay identical', () => {
  const store = create({ fingerprint, limits: { residentBytes: 2200, partitionBytes: 2200 } });
  const source = graph();
  const a = store.page(source, { partition: 'scope', generation: 'g', pageBytes: 300 });
  assert.ok(a.items.length);
  const b = store.page(source, { partition: 'scope', generation: 'g', offset: a.nextOffset, pageBytes: 300 });
  assert.ok(b.items.length); assert.ok(b.cache.counters.evictions > 0);
  const reload = store.page(source, { partition: 'scope', generation: 'g', pageBytes: 300 });
  assert.equal(reload.cacheHit, false); assert.deepEqual(reload.items, a.items); idle(store);
});
test('pin backpressure rejects admission atomically until the owning request releases its page', () => {
  const store = create({ fingerprint, limits: { residentBytes: 2200, partitionBytes: 2200 } });
  const a = store.open({ partition: 'scope', generation: 'g1' }), b = store.open({ partition: 'scope', generation: 'g2' });
  const first = put(store, a, [{ text: 'a'.repeat(120) }]);
  const before = store.inspect(); assert.throws(() => put(store, b, [{ text: 'b'.repeat(120) }]), /PIN_BACKPRESSURE/);
  assert.equal(store.inspect().bytes.resident, before.bytes.resident); assert.equal(store.inspect().counters.evictions, 0);
  assert.deepEqual(store.decode(first.token), [{ text: 'a'.repeat(120) }]);
  store.release(first.token); const second = put(store, b, [{ text: 'b'.repeat(120) }]);
  assert.equal(store.decode(second.token)[0].text, 'b'.repeat(120)); store.close(a); store.close(b); idle(store);
});
test('request and staging budgets stop before managed page decode or encoding and unwind all reservations', () => {
  for (const limits of [{ perRequestBytes: 1400 }, { stagingBytes: 8192 }, { residentBytes: 256, partitionBytes: 256 }]) {
    const store = create({ fingerprint, limits }), page = store.page(graph(), { partition: 'scope', generation: 'g', pageBytes: 600 });
    assert.equal(page.nextOffset, 0); assert.equal(page.items.length, 0);
    assert.ok(['request_budget','staging_budget','resident_budget'].includes(page.stopReason));
    if (page.stopReason === 'staging_budget') assert.equal(page.cache.counters.pagesEncoded, 0);
    assert.equal(page.cache.counters.pagesDecoded, 0); idle(store);
  }
});
test('partition quotas preserve the other partition and identical payloads do not cross privacy partitions', () => {
  const store = create({ fingerprint, limits: { residentBytes: 4500, partitionBytes: 1700 } });
  const a = store.open({ partition: 'A', generation: 'g' }), b = store.open({ partition: 'B', generation: 'g' });
  const first = put(store, a, [{ text: 'same'.repeat(25) }]); store.release(first.token);
  const other = put(store, b, [{ text: 'same'.repeat(25) }]); store.release(other.token);
  assert.equal(store.inspect().pages, 2);
  const changed = put(store, a, [{ text: 'new'.repeat(35) }]); store.release(changed.token);
  const hit = store.acquire(b, other.binding); assert.ok(hit); assert.equal(store.decode(hit)[0].text, 'same'.repeat(25));
  store.close(a); store.close(b); idle(store);
});
test('role pools keep separate bindings under one shared resident budget', () => {
  const store = create({ fingerprint }), handle = store.open({ partition: 'scope', generation: 'g' });
  for (const pool of ['nodes','edges','bases','units']) { const value = put(store, handle, [{ id: 'x' }], pool); store.release(value.token); }
  const state = store.inspect(); assert.equal(state.pages, 4);
  assert.equal(Object.values(state.pools).reduce((sum, pool) => sum + pool.bytes, 0), state.bytes.resident);
  store.close(handle); idle(store);
});
test('exact payload and descriptor comparison rejects forced digest collisions', () => {
  const collision = 'a'.repeat(64), store = create({ fingerprint: () => collision });
  const handle = store.open({ partition: 'scope', generation: 'g' });
  const save = text => {
    const items = [{ text }], size = store.measure(items), stage = store.reserve(handle, store.stageCost(size));
    try { return store.install(handle, { pool: 'units', codec: 'json_array.v1', digest: collision, rows: 1 }, JSON.stringify(items), stage); }
    finally { store.releaseStage(stage); }
  };
  const first = save('first'); assert.throws(() => save('other'), /IDENTITY_COLLISION/);
  assert.equal(store.decode(first)[0].text, 'first'); store.close(handle); idle(store);
});
test('invalidated, cloned and foreign handles cannot regain page authority after identical content returns', () => {
  const store = create({ fingerprint }), foreign = create({ fingerprint });
  const handle = store.open({ partition: 'scope', generation: 'g' }), value = put(store, handle, [{ id: 'x' }]);
  assert.throws(() => store.decode({}), /LEASE_REVOKED/); assert.throws(() => foreign.decode(value.token), /LEASE_REVOKED/);
  store.invalidate(); assert.throws(() => store.decode(value.token), /LEASE_REVOKED/);
  assert.throws(() => store.acquire(handle, value.binding), /REQUEST_REVOKED/); idle(store);
  const newHandle = store.open({ partition: 'scope', generation: 'g' }); put(store, newHandle, [{ id: 'x' }]);
  assert.throws(() => store.decode(value.token), /LEASE_REVOKED/); store.close(newHandle); store.dispose();
  assert.throws(() => store.open({ partition: 'scope', generation: 'g' }), /DISPOSED/);
});
test('generation follows current bindings, coverage, view and nonrewinding restore epoch', () => {
  const store = create({ fingerprint }), source = graph(), frame = { partition: 'scope', restoreEpoch: 1 };
  const first = store.generation(source, frame);
  source.nodes[0].bindingId = 'changed'; assert.notEqual(store.generation(source, frame), first);
  source.nodes[0].bindingId = 'binding:0'; assert.equal(store.generation(source, frame), first);
  assert.notEqual(store.generation(source, { ...frame, restoreEpoch: 2 }), first);
  source.coverage.pending = true; assert.notEqual(store.generation(source, frame), first); idle(store);
  const state = store.inspect(); assert.equal(state.accountedByteBounded, true); assert.equal(state.actualHeapBounded, false);
  assert.equal(state.sourceReaderWorkspaceAccounted, false); assert.equal(state.durableStoreImplemented, false);
});
console.log(JSON.stringify({ suite: 'libra_memory_graph_pages', passed: tests.length, tests,
  scope: 'accounted_derived_page_cache_and_managed_decode', actualHeapBounded: false, durableStoreImplemented: false }));
