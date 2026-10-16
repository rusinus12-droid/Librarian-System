'use strict';
const assert = require('node:assert/strict'), path = require('node:path'), { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error('fixture boundary not reached'); await new Promise(r => setTimeout(r, 5)); }
};
const response = (count = 1, dimensions = 3) => new Response(JSON.stringify({ data: Array.from({ length: count }, (_, index) => ({ index, embedding: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) })) }), { status: 200 });
async function fixture(t) {
  const f = await createFlashback(path.resolve(__dirname, '..'));
  t.after(() => f.cleanup());
  const api = f.api._test, runtime = f.audit.Runtime;
  const cfg = api.normalizeSettings({ embeddingEnabled: true, embeddingProvider: 'openai_compat', embeddingModel: 'lifetime-fixture',
    embeddingUrl: 'https://fixture.invalid/v1', embeddingDimensions: 3, embeddingMaxRetries: 0, embeddingNormalize: false });
  const wires = [];
  f.host.nativeFetch = async (_url, init) => { const result = deferred(); wires.push({ init, result }); return await result.promise; };
  return { ...f, publicApi: f.api, api, runtime, cfg, wires, call: (queries, options = {}) => api.getCachedQueryEmbeddings(queries, cfg, options) };
}

test('query budget aborts the wire and ignores a provider that returns after cancellation', async t => {
  const f = await fixture(t);
  const pending = f.call(['late'], { queryBudgetMs: 60 });
  await assert.rejects(pending, error => error.code === 'FLASHBACK_DEADLINE');
  assert.equal(f.wires.length, 1); assert.equal(f.wires[0].init.signal.aborted, true);
  assert.equal(f.runtime.queryEmbeddingInFlight.size, 0); assert.equal(f.runtime.queryEmbeddingCache.size, 0);
  f.wires[0].result.resolve(response());
  await until(() => f.runtime.embeddingActiveRequests.size === 0);
  assert.equal(f.runtime.queryEmbeddingCache.size, 0, 'late physical completion cannot publish an abandoned vector');
});

test('first caller timeout leaves a coalesced live caller and its single wire intact', async t => {
  const f = await fixture(t);
  const first = f.call(['shared'], { queryBudgetMs: 100 });
  const rejected = assert.rejects(first, error => error.code === 'FLASHBACK_DEADLINE');
  await until(() => f.wires.length === 1);
  const second = f.call(['shared'], { queryBudgetMs: 1500 });
  await until(() => f.runtime.queryEmbeddingCacheStats.coalesced === 1);
  await rejected;
  assert.equal(f.wires[0].init.signal.aborted, false);
  assert.equal(f.runtime.queryEmbeddingInFlight.size, 1);
  f.wires[0].result.resolve(response());
  const result = await second;
  assert.equal(result[0].vector.length, 3); assert.equal(f.wires.length, 1);
  assert.equal(f.runtime.queryEmbeddingCache.size, 1); assert.equal(f.runtime.queryEmbeddingInFlight.size, 0);
  assert.equal((await f.call(['shared']))[0].cacheHit, true); assert.equal(f.wires.length, 1);
});

test('timeout after response headers also aborts and rejects a late body', async t => {
  const f = await fixture(t), body = deferred(); let reading = false;
  const pending = f.call(['late-body'], { queryBudgetMs: 80 });
  const rejected = assert.rejects(pending, error => error.code === 'FLASHBACK_DEADLINE');
  await until(() => f.wires.length === 1);
  f.wires[0].result.resolve({ ok: true, status: 200, async json() { reading = true; return await body.promise; } });
  await until(() => reading); await rejected;
  assert.equal(f.wires[0].init.signal.aborted, true);
  body.resolve({ data: [{ index: 0, embedding: [1, 0, 0] }] });
  await until(() => f.runtime.embeddingActiveRequests.size === 0);
  assert.equal(f.runtime.queryEmbeddingCache.size, 0); assert.equal(f.runtime.queryEmbeddingInFlight.size, 0);
});

test('a coalesced plus fresh batch survives original caller cancellation and validates the whole result', async t => {
  const f = await fixture(t), controller = new AbortController();
  const first = f.call(['union-a'], { signal: controller.signal });
  const rejected = assert.rejects(first, /cancel/i); await until(() => f.wires.length === 1);
  const second = f.call(['union-a', 'union-b']); await until(() => f.wires.length === 2);
  controller.abort(); await rejected;
  assert.equal(f.wires[0].init.signal.aborted, false);
  f.wires[1].result.resolve(response()); f.wires[0].result.resolve(response());
  assert.equal((await second).length, 2); assert.equal(f.runtime.queryEmbeddingCache.size, 2);
});

test('coalesced follower cancellation does not cancel the original caller', async t => {
  const f = await fixture(t), controller = new AbortController();
  const first = f.call(['shared-follower']); await until(() => f.wires.length === 1);
  const second = f.call(['shared-follower'], { signal: controller.signal });
  const rejected = assert.rejects(second, error => error.type === 'ABORTED' || error.code === 'ABORTED');
  await until(() => f.runtime.queryEmbeddingCacheStats.coalesced === 1);
  controller.abort(); await rejected;
  assert.equal(f.wires[0].init.signal.aborted, false);
  f.wires[0].result.resolve(response()); await first;
  assert.equal(f.runtime.queryEmbeddingCache.size, 1); assert.equal(f.wires.length, 1);
});

test('last lease cancellation aborts a shared batch and publishes no partial cache', async t => {
  const f = await fixture(t), a = new AbortController(), b = new AbortController();
  const first = f.call(['batch-a', 'batch-b'], { signal: a.signal });
  const rejectA = assert.rejects(first, /cancel/i); await until(() => f.wires.length === 1);
  const second = f.call(['batch-b'], { signal: b.signal }); const rejectB = assert.rejects(second, /cancel/i);
  await until(() => f.runtime.queryEmbeddingCacheStats.coalesced === 1);
  a.abort(); await rejectA; assert.equal(f.wires[0].init.signal.aborted, false);
  b.abort(); await rejectB; assert.equal(f.wires[0].init.signal.aborted, true);
  assert.equal(f.runtime.queryEmbeddingInFlight.size, 0);
  f.wires[0].result.resolve(response(2)); await until(() => f.runtime.embeddingActiveRequests.size === 0);
  assert.equal(f.runtime.queryEmbeddingCache.size, 0);
});

test('deadline covers credential lookup and an already cancelled query submits no wire', async t => {
  const f = await fixture(t), key = deferred(), original = f.host.getArgument;
  f.runtime.sessionEmbeddingKey = '';
  f.host.getArgument = async name => name === 'embedding_key' ? await key.promise : await original.call(f.host, name);
  await assert.rejects(f.call(['slow-key'], { queryBudgetMs: 30 }), error => error.code === 'FLASHBACK_DEADLINE');
  assert.equal(f.wires.length, 0); key.resolve('fixture-only-key');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.call(['cancelled'], { signal: controller.signal }), /cancel/i);
  await new Promise(r => setTimeout(r, 10)); assert.equal(f.wires.length, 0); assert.equal(f.runtime.queryEmbeddingCache.size, 0);
});

test('cache invalidation aborts pending work and a late result cannot restore the old generation', async t => {
  const f = await fixture(t);
  const pending = f.call(['invalidate']); const rejected = assert.rejects(pending);
  await until(() => f.wires.length === 1);
  f.api.invalidateQueryEmbeddingCache(); assert.equal(f.wires[0].init.signal.aborted, true);
  f.wires[0].result.resolve(response()); await rejected;
  assert.equal(f.runtime.queryEmbeddingCache.size, 0); assert.equal(f.runtime.queryEmbeddingInFlight.size, 0);
});

test('cached and fresh vectors are validated together before any new vector is published', async t => {
  const f = await fixture(t), cfg = { ...f.cfg, embeddingDimensions: 0 };
  const first = f.api.getCachedQueryEmbeddings(['cached-3d'], cfg); await until(() => f.wires.length === 1);
  f.wires[0].result.resolve(response()); await first;
  const mixed = f.api.getCachedQueryEmbeddings(['cached-3d', 'fresh-2d'], cfg); const rejected = assert.rejects(mixed);
  await until(() => f.wires.length === 2); f.wires[1].result.resolve(response(1, 2)); await rejected;
  assert.equal(f.runtime.queryEmbeddingCache.size, 1, 'failed union must not publish fresh-2d');
});

test('a caller that loses authority at completion cannot publish query vectors', async t => {
  const f = await fixture(t); let current = true;
  const pending = f.call(['authority'], { validateAuthority: async () => { if (!current) throw Object.assign(new Error('scope changed'), { code: 'STALE_SOURCE' }); } });
  const rejected = assert.rejects(pending);
  await until(() => f.wires.length === 1); current = false; f.wires[0].result.resolve(response()); await rejected;
  assert.equal(f.runtime.queryEmbeddingCache.size, 0);
});

test('a native request signal cancels the wire even when the caller signal is still live', async t => {
  const f = await fixture(t), caller = new AbortController(), request = new AbortController();
  const pending = f.call(['native-hook'], { signal: caller.signal, requestSignal: request.signal });
  const rejected = assert.rejects(pending, /cancel/i); await until(() => f.wires.length === 1);
  request.abort(); await rejected;
  assert.equal(caller.signal.aborted, false); assert.equal(f.wires[0].init.signal.aborted, true);
  f.wires[0].result.resolve(response()); await until(() => f.runtime.embeddingActiveRequests.size === 0);
  assert.equal(f.runtime.queryEmbeddingCache.size, 0);
});

test('cancelled recall does not emit fallback evidence or cool down the next live recall', async t => {
  const f = await fixture(t), controller = new AbortController();
  await f.publicApi.saveSettings(f.cfg);
  const scope = await f.publicApi.resolveCurrentScope(false);
  const prepare = f.publicApi._selectionTest.prepareFlashbackRecall;
  const pending = prepare('cancel recall', f.cfg, scope, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel/i); await until(() => f.wires.length === 1);
  controller.abort(); await rejected;
  f.wires[0].result.resolve(response()); await until(() => f.runtime.embeddingActiveRequests.size === 0);
  const next = prepare('live recall', f.cfg, scope);
  await until(() => f.wires.length === 2); f.wires[1].result.resolve(response());
  const result = await next;
  assert.notEqual(result.modelReadiness?.status, 'lexical_fallback');
  assert.equal(f.runtime.queryEmbeddingCache.size, 1);
});
