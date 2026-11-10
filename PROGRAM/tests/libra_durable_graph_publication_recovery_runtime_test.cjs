'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

test('server maintenance during lease acquisition retries the same request then publishes a usable graph', async t => {
  const x = await fixture({ mode: 'server_only', pauseAutomaticAnalysis: true });
  t.after(() => x.cleanup());
  const api = x.f.r.api, host = x.f.r.context.risuai, fetch = host.nativeFetch;
  const acquires = [];
  host.nativeFetch = async (url, init) => {
    if (url.endsWith('/v1/libra/graph-lifecycle')) {
      const body = JSON.parse(init.body);
      if (body.action === 'acquire' && body.kind === 'build') {
        acquires.push(body.requestId);
        if (acquires.length <= 2) return new Response(JSON.stringify({ ok: false, error: 'server_maintenance_in_progress' }), { status: 503 });
      }
    }
    return fetch(url, init);
  };
  const built = await api.buildMemoryGraphCorpus();
  assert.equal(built.status, 'published');
  assert.equal(acquires.length, 3);
  assert.equal(new Set(acquires).size, 1, 'a refused command is retried with its original identity');
  const query = await api.executeMemoryGraphUnifiedQuery({ corpusMode: 'required', queryInput: { queryText: '은빛 열쇠' }, semanticPolicy: { mode: 'disabled' } });
  assert.equal(query.corpusRead.mode, 'durable_common_index');
  assert.equal(query.modelDispatchEligible, true);
  assert.ok(query.bundle.items.length);
  api.releaseMemoryGraphUnifiedQuery?.(query);
  const root = x.server.storedRows().find(row => row.key.includes(':memory-graph:v1:corpus:root:'));
  host.nativeFetch = async (url, init) => url.endsWith('/v1/libra/graph-lifecycle') && JSON.parse(init.body).action === 'acquire'
    ? new Response(JSON.stringify({ ok: false, error: 'server_maintenance_in_progress' }), { status: 503 })
    : fetch(url, init);
  await assert.rejects(() => api.buildMemoryGraphCorpus(), /maintenance|503/);
  assert.equal(x.server.storedRows().find(row => row.key === root.key).raw, root.raw, 'exhausted maintenance wait leaves the published root intact');
  assert.equal(api.inspectDurableGraphStatus().buildFailure.serverError, 'server_maintenance_in_progress');
  host.nativeFetch = fetch;
});

for (const microCount of [6, 12]) test(`${microCount + 5} turns: index budget recovery publishes and accelerates server queries after restart`, async t => {
  const x = await fixture({ mode: 'server_only', pauseAutomaticAnalysis: true, microCount,
    microText: turn => '민아는 은빛 열쇠 기록 ' + turn + '을 남겼다. ' + Array.from({ length: 60 }, (_, n) => 'topic' + turn + 'x' + n).join(' ') });
  t.after(() => x.cleanup());
  let api = x.f.r.api;
  const build = await api.buildMemoryGraphCorpus({ limit: 1, maxIndexBytes: 393216, maxShardsPerStep: 64 });
  assert.equal(build.status, 'published');
  assert.ok(build.shardCount > 1, 'small-chat index overflow enters the sharded publication path');
  const needle = 'topic' + (microCount + 5) + 'x0';
  const options = { corpusMode: 'required', queryInput: { queryText: needle }, semanticPolicy: { mode: 'disabled' } };
  let requests = 0;
  x.server.hooks.beforeServerRequest = async () => { requests++; };
  const cold = await api.executeMemoryGraphUnifiedQuery(options), coldRequests = requests;
  requests = 0;
  const warm = await api.executeMemoryGraphUnifiedQuery(options), warmRequests = requests;
  for (const query of [cold, warm]) {
    assert.equal(query.corpusRead.mode, 'durable_common_index');
    assert.equal(query.corpusRead.storage.storageAccess, 'routed_durable_shards');
    assert.equal(query.modelDispatchEligible, true);
    assert.ok(query.bundle.items.some(item => item.text.includes(needle)));
    api.releaseMemoryGraphUnifiedQuery?.(query);
  }
  assert.deepEqual(Array.from(warm.bundle.items, i => i.text), Array.from(cold.bundle.items, i => i.text));
  assert.ok(warmRequests < coldRequests, `${warmRequests} warm requests < ${coldRequests} cold requests`);
  requests = 0;
  if (microCount === 6) {
    const projected = await api.executeMemoryGraphUnifiedQuery({ ...options, corpusMode: 'window' });
    const projectedRequests = requests;
    assert.ok(projected.bundle.items.some(item => item.text.includes(needle)));
    api.releaseMemoryGraphUnifiedQuery?.(projected);
    assert.ok(warmRequests < projectedRequests, `${warmRequests} durable requests < ${projectedRequests} native projection requests`);
    console.log(JSON.stringify({ test: 'durable_vs_native_projection_requests', coldRequests, warmRequests, projectedRequests }));
  } else {
    // Its independent 64-key pin ceiling prevents the original native path
    // from delivering this full 17-turn window. The durable route must work.
    await assert.rejects(() => api.executeMemoryGraphUnifiedQuery({ ...options, corpusMode: 'window' }), /QUERY_SOURCE_PIN_LIMIT/);
  }
  const increment = await api.buildMemoryGraphCorpus({ maxIndexBytes: 393216, maxShardsPerStep: 64 });
  assert.equal(increment.status, 'published');
  assert.equal(increment.effectiveLimit, 1, 'incremental builds retain the successfully published window width');
  assert.ok(increment.reusedWindowCount > 0);
  await x.restart(); api = x.f.r.api;
  const restarted = await api.executeMemoryGraphUnifiedQuery(options);
  assert.equal(restarted.corpusRead.mode, 'durable_common_index');
  assert.equal(restarted.corpusRead.storage.storageAccess, 'routed_durable_shards');
  assert.ok(restarted.bundle.items.some(item => item.text.includes(needle)));
  api.releaseMemoryGraphUnifiedQuery?.(restarted);
  console.log(JSON.stringify({ test: 'budget_recovery_durable_acceleration', turns: microCount + 5, shards: build.shardCount, coldRequests, warmRequests }));
});
