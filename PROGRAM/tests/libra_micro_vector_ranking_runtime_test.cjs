'use strict';
// Real publication/storage/query pipeline with controlled provider vectors.
// Optional LIBRA_COMPARE_PLUGIN measures an older plugin on the exact same snapshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const dimensions = 1024, axis = n => Array.from({ length: dimensions }, (_, i) => i === n ? 1 : 0);
const config = { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
  model: 'text-embedding-3-small', key: 'synthetic-not-a-real-key', dimensions, maxRetries: 0 };
(async () => {
  let calls = 0, comparison = false;
  const embed = async (_url, init) => {
    calls++;
    return new Response(JSON.stringify({ data: JSON.parse(init.body).input.map((text, index) => ({ index,
      embedding: axis(text === 'semantic target' || text.includes('최후의 증표') ? 0 : 1) })), usage: { total_tokens: 5 } }), { status: 200 });
  };
  const x = await fixture({ embeddingConfig: config, embeddingFetch: embed, microCount: 30,
    microText: turn => turn === 35 ? '민아가 최후의 증표를 준호에게 건넸다.' : '민아가 물건 ' + turn + '번을 준호에게 건넸다.',
    transformSource: source => comparison ? fs.readFileSync(process.env.LIBRA_COMPARE_PLUGIN, 'utf8') : source });
  try {
    await x.f.r.api.retryPendingUnifiedVectors();
    for (let i = 0; i < 3000 && x.f.r.api.inspectMicroRepresentationVectors().warming; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(x.f.r.api.inspectMicroRepresentationVectors().warming, false);
    const measure = async label => {
      const measurements = [];
      for (let i = 0; i < 4; i++) {
        const before = calls, start = performance.now();
        const result = await x.f.r.api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: 'semantic target' }, consumerPolicy: { maxUnits: 64 } });
        const hit = JSON.stringify(result.packet).includes('최후의 증표');
        assert.ok(hit, 'semantic-only winner must reach the actual RAG packet');
        assert.equal(result.modelDispatchEligible, true);
        if (!comparison) {
          assert.equal(result.diagnostics.nativeSemantic.microSelection.scanned, 30);
          assert.equal(result.diagnostics.nativeSemantic.microSelection.selected, 8);
          assert.ok(result.diagnostics.nativeSemantic.microRepresentations.some(row => row.turn === 35 && row.similarity > 0.99));
        }
        assert.ok(calls - before <= 1, 'selection and lane share the query embedding');
        measurements.push({ ms: Math.round(performance.now() - start), hit, modelCalls: calls - before });
      }
      console.log(JSON.stringify({ label, measurements, externalProviderQualityMeasured: false }));
    };
    await measure('recovered');
    if (process.env.LIBRA_COMPARE_PLUGIN) {
      comparison = true;
      await x.restart();
      await measure('comparison');
    }
    console.log('PASS native 30-source semantic ranking and RAG delivery');
  } finally { await x.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
