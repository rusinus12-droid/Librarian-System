'use strict';
// Micro claim vectors: stored after publication as content-addressed micro-vector records,
// read (never embedded) by retrieval, and served identically after a restart.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const config = { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings', model: 'text-embedding-3-small',
  key: 'synthetic-not-a-real-key', dimensions: 256, maxRetries: 0 };
const query = 'keepsake custodian rendezvous';
const wait = async predicate => { for (let i = 0; i < 2000; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('micro vector wait timed out'); };

(async () => {
  const passed = [];
  for (const mode of ['plugin_only', 'server_only']) {
    const requests = [];
    const fetch = async (_url, init) => {
      const inputs = JSON.parse(init.body).input; requests.push(inputs);
      return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0) })),
        usage: { total_tokens: 5 } }), { status: 200 });
    };
    const host = await fixture({ mode, embeddingConfig: config, embeddingFetch: fetch });
    try {
      let api = host.f.r.api;
      await wait(() => !api.inspectMicroRepresentationVectors().warming && api.inspectMicroRepresentationVectors().cached > 0);
      if (mode === 'plugin_only') assert.ok([...host.f.r.values.keys()].some(key => /:scope:[^]*:micro-vector:[0-9a-f-]+:[0-9a-f-]+$/.test(key)), 'vector stored under the scope');
      const before = requests.length;
      const first = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query }, consumerPolicy: { maxUnits: 64 } });
      const micro = first.diagnostics.nativeSemantic.microRepresentations;
      assert.ok(micro.length >= 1, 'stored Micro vector joins the semantic lane');
      assert.equal(first.diagnostics.nativeSemantic.admittedRepresentations, 1 + micro.length);
      assert.equal(JSON.stringify(requests.slice(before)), JSON.stringify([[query]]), 'retrieval embeds only the query');
      await host.restart(); api = host.f.r.api;
      const restartedAt = requests.length;
      const restarted = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: query }, consumerPolicy: { maxUnits: 64 } });
      assert.equal(JSON.stringify(restarted.diagnostics.nativeSemantic.microRepresentations), JSON.stringify(micro), 'a restart reads the stored vectors');
      assert.equal(restarted.packet.packetDigest, first.packet.packetDigest);
      assert.ok(requests.slice(restartedAt).every(inputs => inputs.length === 1 && inputs[0] === query), 'no document embedding after restart');
      passed.push(mode);
      console.log('PASS ' + mode + ': stored Micro vectors are read by retrieval and survive a restart');
    } finally { await host.cleanup(); }
  }
  console.log(JSON.stringify({ suite: 'libra_micro_representation_vectors_runtime', passed }));
})().catch(error => { console.error(error); process.exit(1); });
