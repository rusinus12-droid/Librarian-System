'use strict';
// Real owner projection -> stored Micro vector -> Memory Lane -> Classic delivery.
// Provider responses are controlled; no external model is called.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const config = { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
  model: 'text-embedding-3-small', key: 'synthetic-not-a-real-key', dimensions: 256, maxRetries: 0 };
const query = 'keepsake custodian rendezvous';
const embed = async (_url, init) => new Response(JSON.stringify({
  data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0) })),
  usage: { total_tokens: 5 }
}), { status: 200 });
const waitForWarm = async api => {
  for (let i = 0; i < 3000; i++) {
    if (!api.inspectMicroRepresentationVectors().warming) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Micro warm did not settle');
};
const options = { queryInput: { queryText: query }, consumerPolicy: { maxUnits: 64 } };
const tests = [];
const test = async (name, fn) => { await fn(); tests.push(name); console.log('PASS ' + name); };

(async () => {
  for (const mode of ['plugin_only', 'server_only', 'mirror']) await test(mode + ': stored Micro vectors stay current through delivery', async () => {
    let boundary = async () => {};
    const x = await fixture({ mode, embeddingConfig: config, embeddingFetch: embed,
      hostOverrides: { microDeliveryBoundary: () => boundary() },
      transformSource: source => source.replace('const authority = unifiedGraphDeliveryAuthority.get(execution);',
        'await risuai.microDeliveryBoundary(); const authority = unifiedGraphDeliveryAuthority.get(execution);') });
    try {
      const api = x.f.r.api;
      await waitForWarm(api);
      const values = x.server?.local || x.f.r.values;
      const stored = x.server ? x.server.getRecords('libra.micro_vector.v1')[0]
        : [...values].map(([key, raw]) => { try { return { key, value: JSON.parse(raw) }; } catch (_) { return {}; } }).find(row => row.value?.schema === 'libra.micro_vector.v1');
      assert.ok(stored, api.inspectMicroRepresentationVectors().lastError);
      const write = async (value, remove = false) => {
        if (x.server) await x.server.mutate(stored.key, value, remove ? 'remove' : 'set');
        if (!x.server || mode === 'mirror') {
          if (remove) values.delete(stored.key);
          else values.set(stored.key, JSON.stringify(value));
        }
      };
      assert.equal((await api.executeMemoryGraphUnifiedQuery(options)).diagnostics.nativeSemantic.microRepresentations.length, 1);
      await write(null, true);
      const deleted = await api.executeMemoryGraphUnifiedQuery(options);
      assert.equal(deleted.diagnostics.nativeSemantic.microRepresentations.length, 0, 'a warm common cache cannot replace a deleted owner vector');
      await write(stored.value);
      await api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
      const messages = [{ role: 'user', content: query }];
      assert.ok((await x.f.control.hooks.beforeRequest(messages, 'model')).length > messages.length);
      const context = api.getLastResponseContext();
      assert.equal((await api.validateResponseContext(context)).ok, true);
      const changed = { ...stored.value, vector: [0, 1, ...stored.value.vector.slice(2)] };
      await write(changed);
      assert.equal((await api.validateResponseContext(context)).ok, false, 'retained response contexts keep the real Micro vector dependency');
      await write(stored.value);
      boundary = async () => {
        await write(changed);
        if (mode !== 'plugin_only') await write(stored.value); // ABA changes revision even when bytes return to A.
      };
      const rejected = await x.f.control.hooks.beforeRequest(messages, 'model');
      assert.equal(rejected.length, messages.length);
      assert.equal(api.getRuntime().lastMemoryInjectionMeta.injected, false);
      assert.match(api.getRuntime().lastMemoryInjectionMeta.error, /PHYSICAL_READSET_STALE/);
      boundary = async () => {};
      await write(stored.value);
      assert.ok((await x.f.control.hooks.beforeRequest(messages, 'model')).length > messages.length);
    } finally { await x.cleanup(); }
  });

  await test('Micro owner payload and representation floors share query admission', async () => {
    const x = await fixture({ embeddingConfig: config, embeddingFetch: embed });
    try {
      const api = x.f.r.api;
      await waitForWarm(api);
      const key = [...x.f.r.values.keys()].find(key => key.includes(':micro-vector:'));
      assert.ok(key);
      const before = x.f.r.storageReads.length;
      const stopped = await api.executeMemoryGraphUnifiedQuery({ ...options, laneBudget: { maxStorageBytes: 512 } });
      assert.equal(stopped.queryComplete, false);
      assert.equal(stopped.diagnostics.nativeSemantic.microRepresentations.length, 0);
      assert.ok(!x.f.r.storageReads.slice(before).includes(key));
      const callsBefore = (await api.getEmbeddingAdapterDiagnostics()).queryCache;
      const readsBefore = x.f.r.storageReads.length;
      await api.executeMemoryGraphUnifiedQuery({ ...options, semanticPolicy: { maxRepresentationBytes: 4096 } });
      assert.ok(!x.f.r.storageReads.slice(readsBefore).includes(key), 'a too-small representation budget never loads the vector');
      assert.equal(typeof callsBefore.misses, 'number');
      assert.equal((await api.getEmbeddingAdapterDiagnostics()).queryCache.misses, callsBefore.misses);
      const raw = x.f.r.values.get(key);
      x.f.r.values.set(key, JSON.stringify({ ...JSON.parse(raw), padding: 'x'.repeat(2 * 1024 * 1024) }));
      await assert.rejects(() => api.executeMemoryGraphUnifiedQuery({ ...options, resourceBudget: { maxValueBytes: 256 * 1024 } }), /LIBRA_GRAPH_RESOURCE_VALUE_BYTE_BUDGET/);
      x.f.r.values.set(key, raw);
      assert.equal((await api.executeMemoryGraphUnifiedQuery(options)).modelDispatchEligible, true);
    } finally { await x.cleanup(); }
  });

  await test('revocation during final verification returns only the rejected base request', async () => {
    let revoke = false;
    const x = await fixture({ embeddingConfig: config, embeddingFetch: embed,
      hostOverrides: { revokeSelection: fn => { if (revoke) { revoke = false; fn(); } } },
      transformSource: source => source.replace('const live = await ownerVerifier.currentGraph();',
        'risuai.revokeSelection(() => state.memoryGraphCompiler.invalidateAll()); const live = await ownerVerifier.currentGraph();') });
    try {
      const api = x.f.r.api;
      await waitForWarm(api);
      revoke = true;
      const rejected = await api.executeMemoryGraphUnifiedQuery(options);
      assert.equal(rejected.modelDispatchEligible, false);
      assert.equal(rejected.packet, null);
      assert.equal(rejected.deliveryOutcome, 'base_request_only');
      assert.equal(rejected.diagnostics.resourceAccess.closeReason, 'readset_revoked');
      assert.equal((await api.executeMemoryGraphUnifiedQuery(options)).modelDispatchEligible, true);
    } finally { await x.cleanup(); }
  });

  await test('a valid Micro after the first empty 50-turn window is embedded and retrieved', async () => {
    const x = await fixture({ microTurn: 60, embeddingConfig: config, embeddingFetch: embed });
    try {
      const api = x.f.r.api;
      await api.retryPendingUnifiedVectors();
      await waitForWarm(api);
      assert.equal(x.active.status, 'verified');
      assert.equal(api.inspectMicroRepresentationVectors().lastError, '');
      assert.ok([...x.f.r.values.keys()].some(key => key.includes(':micro-vector:')));
      const recall = await api.executeMemoryGraphUnifiedQuery(options);
      assert.ok(recall.diagnostics.nativeSemantic.microRepresentations.some(row => row.turn === 60));
    } finally { await x.cleanup(); }
  });
  console.log(JSON.stringify({ suite: 'libra_micro_vector_authority_runtime', passed: tests.length, tests }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
