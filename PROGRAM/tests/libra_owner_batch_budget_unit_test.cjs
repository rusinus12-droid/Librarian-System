'use strict';
// Owner heads are read by server get-many in batches of up to 32 keys with one read
// lease per batch. A batch whose body could exceed the per-read cap is re-read as
// halves before it is accepted, because a resource failure poisons the request.
// The helper is cut out of the shipped plugin and run with the real resource
// manager: large values, mixed sizes, a single over-cap value and a failing split
// request, each returning every lease and reservation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pages = require('../tools/libra_memory_graph_pages.cjs')({ fingerprint: s => crypto.createHash('sha256').update(s).digest('hex') });
const resourceFactory = require('../tools/libra_memory_graph_resources.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const start = source.indexOf('      const bodyUtf8Bytes = text => {');
const end = source.indexOf('      const frame = {', start);
assert.ok(start > 0 && end > start, 'ownerGetMany is present in LIBRA.js');
const build = (resources, bridge) => new Function('resources', 'MemorySuiteStorageBridge',
  source.slice(start, end) + '\nreturn ownerGetMany;')(resources, bridge);

const pool = () => resourceFactory({ measure: pages.measure, encodedSize: pages.encodedSize, stageCost: pages.stageCost });
const store = sizes => new Map(sizes.map((size, index) => ['k' + index, 'x'.repeat(size)]));
const bridgeFor = (values, failWhen = () => false) => {
  const calls = [];
  return { calls, serverGetMany: async (_space, keys) => {
    calls.push(keys.length);
    if (failWhen(keys)) throw new Error('fixture_get_many_failed');
    return { values: Object.fromEntries(keys.map(key => [key, { exists: true, tombstone: false, revision: 1, value: values.get(key) }])) };
  } };
};
const idle = p => { const state = p.inspect(); assert.equal(state.reads, 0, 'reads'); assert.equal(state.ioBytes, 0, 'ioBytes'); };

test('small values: one round trip for 32 keys', async () => {
  const p = pool(), resources = p.open({ maxValueBytes: 64 * 1024 });
  const values = store(Array(32).fill(100)), bridge = bridgeFor(values);
  const rows = await build(resources, bridge)([...values.keys()]);
  assert.deepEqual(bridge.calls, [32]);
  assert.equal(Object.keys(rows.values).length, 32);
  idle(p); resources.close();
});

test('large and mixed values split into halves and return every value exactly', async () => {
  const p = pool(), resources = p.open({ maxValueBytes: 64 * 1024 });
  const sizes = Array.from({ length: 32 }, (_, i) => i % 5 === 0 ? 20000 : 300);
  const values = store(sizes), bridge = bridgeFor(values);
  const rows = await build(resources, bridge)([...values.keys()]);
  assert.ok(bridge.calls.length > 1, 'an over-half-cap batch is re-read in parts: ' + bridge.calls);
  for (const [key, value] of values) assert.equal(rows.values[key].value, value, key);
  assert.ok(resources.inspect().sourceBytes >= sizes.reduce((a, b) => a + b, 0), 'every split part is byte-accounted');
  idle(p); resources.close();
});

test('a single over-cap value still fails as a value budget error', async () => {
  const p = pool(), resources = p.open({ maxValueBytes: 4096 });
  const values = store([10000]), bridge = bridgeFor(values);
  await assert.rejects(build(resources, bridge)(['k0']), /LIBRA_GRAPH_RESOURCE_VALUE_BYTE_BUDGET/);
  idle(p); resources.close();
});

test('a failing split request fails closed and returns its reservations', async () => {
  const p = pool(), resources = p.open({ maxValueBytes: 64 * 1024 });
  const values = store(Array.from({ length: 32 }, () => 2000));
  const bridge = bridgeFor(values, keys => keys.length < 32 && keys.includes('k31'));
  await assert.rejects(build(resources, bridge)([...values.keys()]), /fixture_get_many_failed/);
  idle(p); resources.close();
});
