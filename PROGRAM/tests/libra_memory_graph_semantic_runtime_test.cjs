'use strict';
// Native writer -> saved vector -> real provider adapter/cache -> registered graph
// query and beforeRequest. HTTP embedding responses are controlled fixtures.
const assert = require('node:assert/strict');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const config = { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings', model: 'text-embedding-3-small',
  key: 'synthetic-not-a-real-key', dimensions: 256, maxRetries: 0 };
const query = 'keepsake custodian rendezvous'; // No corpus words or registered aliases.
const response = init => new Response(JSON.stringify({ data: JSON.parse(init.body).input.map((_, index) => ({ index,
  embedding: Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0) })), usage: { total_tokens: 5 } }), { status: 200 });
const tests = [];
async function test(name, fn) { await fn(); tests.push(name); console.log('PASS ' + name); }
const wait = async predicate => { for (let i = 0; i < 1000; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('semantic fixture wait timed out'); };
function provider() {
  const requests = []; let onQuery = null;
  const fetch = async (_url, init) => {
    const inputs = JSON.parse(init.body).input; requests.push(inputs);
    if (onQuery && inputs.length === 1 && !inputs[0].includes('[회상 키]')) return await onQuery(init, inputs[0]);
    return response(init);
  };
  return { requests, fetch, setQuery(fn) { onQuery = fn; } };
}
(async () => {
  for (const mode of ['plugin_only','server_only']) await test(`${mode}: stored projection seeds the common graph, warm query cache and actual Classic injection`, async () => {
    const p = provider(), host = await fixture({ mode, embeddingConfig: config, embeddingFetch: p.fetch });
    try {
      const api = host.f.r.api, calls = host.f.control.calls.length, before = p.requests.length;
      const disabled = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query }, semanticPolicy: { mode: 'disabled' }, consumerPolicy: { maxUnits: 64 } });
      assert.equal(disabled.bundle.items.some(item => item.family === 'canonical'), false, 'negative control has no lexical/entity path');
      assert.equal(p.requests.length, before);
      const first = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query }, consumerPolicy: { maxUnits: 64 } });
      assert.equal(first.diagnostics.nativeSemantic.status, 'available', JSON.stringify(first.diagnostics.nativeSemantic));
      assert.equal(first.diagnostics.nativeSemantic.admittedRepresentations, 1);
      assert.equal(first.diagnostics.nativeSemantic.queryRequestCount, 1);
      assert.equal(first.additionalEmbeddingCalls, 1); assert.equal(first.modelDispatchEligible, true);
      assert.equal(p.requests.length, before + 1); assert.deepEqual(p.requests.at(-1), [query]);
      const graph = await host.project(), sourceIds = new Set(graph.nodes.filter(node => node.layer === 'source').map(node => node.id));
      const canonical = first.bundle.items.filter(item => item.family === 'canonical'); assert.ok(canonical.length);
      for (const item of canonical) assert.ok(sourceIds.has(item.winningWitness.seedNodeId), 'the vector remains a source access signal');
      for (const family of ['canonical','micro','state','lore']) assert.ok(first.bundle.items.some(item => item.family === family), 'same graph reaches ' + family);
      assert.equal(first.diagnostics.semanticDiagnostics.compatibleCount, 1);
      assert.equal(first.legacyRankerExecuted, false); assert.equal(first.diagnostics.nativeSemantic.documentEmbeddingCalls, 0);
      const warm = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query }, consumerPolicy: { maxUnits: 64 } });
      assert.equal(warm.additionalEmbeddingCalls, 0); assert.equal(warm.diagnostics.nativeSemantic.queryCacheHits, 1);
      assert.equal(p.requests.length, before + 1); assert.equal(warm.packet.packetDigest, first.packet.packetDigest);
      const constrained = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: QUOTE }, semanticPolicy: { maxRepresentationBytes: 4096 } });
      assert.equal(constrained.deliveryOutcome, 'partial'); assert.equal(constrained.queryComplete, false);
      assert.equal(constrained.bundle.queryComplete, false);
      assert.equal(constrained.semanticCoverageComplete, false); assert.equal(constrained.stopReason, 'semantic_representation_byte_budget');
      assert.ok(constrained.bundle.items.length); assert.equal(p.requests.length, before + 1);
      const past = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query, asOfTurn: 3 } });
      assert.equal(past.diagnostics.nativeSemantic.status, 'no_compatible_representations');
      assert.ok(past.diagnostics.nativeSemantic.rejected.some(row => row.reason === 'representation_outside_temporal_view'));
      assert.equal(p.requests.length, before + 1, 'future-containing projection never serves the past view');
      await api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
      const messages = [{ role: 'user', content: query }], out = await host.f.control.hooks.beforeRequest(messages, 'model');
      assert.equal(out.length, 2);
      assert.ok(out.some(message => message.content.includes('[canonical:canonical_assertion]')));
      assert.equal(api.getRuntime().lastMemoryInjectionMeta.finalVerification.status, 'verified');
      assert.equal(api.getLastMemoryRecall().unifiedExecution.additionalEmbeddingCalls, 0, 'hook reuses the owned query cache');
      assert.equal(host.f.control.calls.length, calls, 'recall invokes no analysis or response helper');
      // No document vectors are generated during retrieval, including missing/changed spaces.
      await api.saveEmbeddingSettings({ ...config, model: 'text-embedding-3-large' });
      const mismatch = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: QUOTE } });
      assert.equal(mismatch.diagnostics.nativeSemantic.status, 'no_compatible_representations');
      assert.ok(mismatch.diagnostics.nativeSemantic.rejected.some(row => row.reason === 'embedding_space_mismatch'));
      assert.ok(mismatch.bundle.items.length); assert.equal(p.requests.length, before + 1);
      assert.equal(host.f.control.calls.length, calls);
      await api.saveEmbeddingSettings(config);
      await host.restart();
      const restarted = await host.f.r.api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query }, consumerPolicy: { maxUnits: 64 } });
      assert.equal(restarted.diagnostics.nativeSemantic.status, 'available');
      assert.equal(restarted.additionalEmbeddingCalls, 1, 'process-local query cache is rebuilt independently');
      assert.equal(restarted.packet.packetDigest, first.packet.packetDigest);
      assert.equal(p.requests.length, before + 2);
    } finally { await host.cleanup(); }
  });
  await test('native Cohere query/document task pair and automatic dimensions stay compatible', async () => {
    const requests = [], cohere = { ...config, provider: 'cohere', url: 'https://synthetic.invalid/v2/embed', model: 'embed-multilingual-v3.0', dimensions: 'auto' };
    const host = await fixture({ embeddingConfig: cohere, embeddingFetch: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      return new Response(JSON.stringify({ embeddings: { float: body.texts.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)) } }), { status: 200 });
    } });
    try {
      const result = await host.f.r.api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query } });
      assert.equal(result.diagnostics.nativeSemantic.status, 'available', JSON.stringify(result.diagnostics.nativeSemantic));
      assert.equal(result.diagnostics.nativeSemantic.dimension, 1024);
      assert.equal(result.diagnostics.nativeSemantic.queryTask, 'search_query');
      assert.equal(result.diagnostics.nativeSemantic.documentTask, 'search_document');
      assert.ok(requests.some(body => body.input_type === 'search_document'));
      assert.equal(requests.at(-1).input_type, 'search_query'); assert.deepEqual(requests.at(-1).texts, [query]);
      assert.ok(result.bundle.items.some(item => item.family === 'canonical')); assert.equal(result.modelDispatchEligible, true);
    } finally { await host.cleanup(); }
  });
  await test('native mirror owner uses the same engine with physical server verification', async () => {
    const p = provider(), host = await fixture({ mode: 'mirror', embeddingConfig: config, embeddingFetch: p.fetch });
    try {
      const before = p.requests.length;
      const result=await host.f.r.api.executeMemoryGraphUnifiedQuery({queryInput:{queryText:query}});
      assert.equal(result.diagnostics.nativeSemantic.status,'available');assert.equal(result.modelDispatchEligible,true);
      assert.equal(p.requests.length,before+1);
    } finally { await host.cleanup(); }
  });
  await test('retired shadow input uses the unified query, provider failure/timeout preserves its lexical graph', async () => {
    const p = provider(), host = await fixture({ includeMicro: false, embeddingConfig: config, embeddingFetch: p.fetch });
    let release;
    try {
      const api = host.f.r.api;
      // Settle the real T6 branch/frontier reconciliation before holding transport.
      // A concurrent source change must still reject augmentation independently.
      await host.f.control.hooks.beforeRequest([{ role: 'user', content: 'Initialize owner boundary.' }], 'model');
      const before = p.requests.length;
      const cold = await api.executeMemoryGraphUnifiedQuery({ mode: 'shadow', queryInput: { queryText: QUOTE } });
      assert.equal(cold.mode, 'unified');assert.equal(cold.additionalEmbeddingCalls,1);assert.equal(p.requests.length,before+1);
      assert.equal(cold.diagnostics.nativeSemantic.status,'available');
      p.setQuery(async () => { throw Error('controlled_provider_failure'); });
      const failed = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: QUOTE + ' failure' } });
      assert.equal(failed.diagnostics.nativeSemantic.status, 'query_embedding_unavailable');
      assert.ok(failed.bundle.items.some(item => item.family === 'canonical'));
      assert.equal(failed.modelDispatchEligible, true); assert.equal(failed.legacyRankerExecuted, false);
      const gate = new Promise(resolve => { release = resolve; });
      p.setQuery(async init => { await gate; return response(init); });
      const started = Date.now();
      const timed = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: QUOTE + ' timeout' }, semanticPolicy: { queryBudgetMs: 250 } });
      assert.ok(Date.now() - started < 10000);
      assert.equal(timed.diagnostics.nativeSemantic.status, 'query_embedding_unavailable');
      assert.ok(timed.bundle.items.length); assert.equal(timed.modelDispatchEligible, true, JSON.stringify(timed.dispatchVerification)); release();
    } finally { release?.(); await host.cleanup(); }
  });
  await test('coalesced query calls share transport, key changes isolate cache, settings changes cannot dispatch an old embedding', async () => {
    const p = provider(), host = await fixture({ includeMicro: false, embeddingConfig: config, embeddingFetch: p.fetch });
    try {
      const api = host.f.r.api; let release, entered = false;
      const gate = new Promise(resolve => { release = resolve; });
      p.setQuery(async init => { entered = true; await gate; return response(init); });
      const before = p.requests.length, coalescedBefore = (await api.getEmbeddingAdapterDiagnostics()).queryCache.coalesced;
      const a = api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query } });
      const b = api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query } });
      await wait(() => entered); await wait(async () => (await api.getEmbeddingAdapterDiagnostics()).queryCache.coalesced > coalescedBefore);
      release(); const [ra, rb] = await Promise.all([a,b]);
      assert.equal(p.requests.length, before + 1);
      assert.equal(ra.additionalEmbeddingCalls + rb.additionalEmbeddingCalls, 1);
      assert.ok(ra.diagnostics.nativeSemantic.coalesced || rb.diagnostics.nativeSemantic.coalesced);
      assert.equal(ra.packet.packetDigest, rb.packet.packetDigest);
      p.setQuery(async init => response(init));
      await api.saveEmbeddingSettings({ ...config, key: 'new-fixture-key' });
      const newKey = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query } });
      assert.equal(newKey.additionalEmbeddingCalls, 1); assert.equal(p.requests.length, before + 2);
      let unblock, hit = false; const held = new Promise(resolve => { unblock = resolve; });
      p.setQuery(async init => { hit = true; await held; return response(init); });
      const pending = api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query + ' changed' } });
      await wait(() => hit); await api.saveEmbeddingSettings({ ...config, key: 'new-fixture-key', queryPrefix: 'different query instruction: ' });
      unblock(); const changed = await pending;
      assert.equal(changed.deliveryOutcome, 'base_request_only'); assert.equal(changed.modelDispatchEligible, false);
      assert.equal(changed.packet, null);
    } finally { await host.cleanup(); }
  });
  await test('vector corruption is not hydrated from a warm local cache, and final physical vector mutation prevents injection', async () => {
    const p = provider(); let boundary = async () => {};
    const host = await fixture({ includeMicro: false, embeddingConfig: config, embeddingFetch: p.fetch,
      hostOverrides: { semanticDeliveryBoundary: () => boundary() },
      transformSource: source => source.replace('const authority = unifiedGraphDeliveryAuthority.get(execution);',
        'await risuai.semanticDeliveryBoundary(); const authority = unifiedGraphDeliveryAuthority.get(execution);') });
    try {
      const api = host.f.r.api; await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query } });
      const memory = host.f.getMemory(), key = memory.embedding.vectorKey, raw = host.f.r.values.get(key), calls = p.requests.length;
      const corrupted = JSON.parse(raw); corrupted.portableVectorPayload.data = 'corrupt';
      host.f.r.values.set(key, JSON.stringify(corrupted));
      const missing = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: QUOTE } });
      assert.equal(missing.diagnostics.nativeSemantic.status, 'no_compatible_representations');
      assert.equal(p.requests.length, calls, 'bad document vector never causes re-embedding');
      assert.ok(missing.bundle.items.length);
      host.f.r.values.set(key, raw); await api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
      boundary = async () => { const changed = JSON.parse(raw); changed.externalMutation = true; host.f.r.values.set(key, JSON.stringify(changed)); };
      const original = [{ role: 'user', content: query }], rejected = await host.f.control.hooks.beforeRequest(original, 'model');
      assert.equal(rejected.length, original.length); assert.equal(api.getRuntime().lastMemoryInjectionMeta.injected, false);
      assert.match(api.getRuntime().lastMemoryInjectionMeta.error, /PHYSICAL_READSET_STALE/);
      host.f.r.values.set(key, raw); boundary = async () => {};
      assert.equal((await host.f.control.hooks.beforeRequest(original, 'model')).length, 2);
    } finally { await host.cleanup(); }
  });
  await test('server vector ABA during query embedding cannot be accepted by a byte-identical reread', async () => {
    const p = provider(), host = await fixture({ mode: 'server_only', includeMicro: false, embeddingConfig: config, embeddingFetch: p.fetch });
    let release;
    try {
      const key = host.server.getMemory().embedding.vectorKey;
      const before = host.server.getRecords('libra.embedding_projection.v2').find(row => row.key === key);
      assert.ok(before);
      let entered = false; const gate = new Promise(resolve => { release = resolve; });
      p.setQuery(async init => { entered = true; await gate; return response(init); });
      const pending = host.f.r.api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query } });
      await wait(() => entered);
      await host.server.mutate(key, { ...before.value, externalMutation: 'ABA' });
      await host.server.mutate(key, before.value);
      const restored = host.server.getRecords('libra.embedding_projection.v2').find(row => row.key === key);
      assert.equal(restored.raw, before.raw, 'numeric values and stored bytes returned to A');
      assert.ok(restored.revision > before.revision);
      release(); const result = await pending;
      assert.equal(result.deliveryOutcome, 'base_request_only'); assert.equal(result.modelDispatchEligible, false);
      assert.equal(result.packet, null); assert.match(result.dispatchVerification.reason, /PHYSICAL_READSET_STALE/);
    } finally { release?.(); await host.cleanup(); }
  });
  console.log(JSON.stringify({ suite: 'libra_memory_graph_semantic_runtime', passed: tests.length, tests, actualHostQualified: false, externalProviderQualityMeasured: false }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
