'use strict';

const assert = require('node:assert/strict');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

(async () => {
  let providerCalls = 0;
  const vectorFor = value => {
    const text = String(value || '');
    if (/우산|umbrella|傘|雨伞/.test(text)) return [1, 0, 0, 0];
    if (/머그|커피잔|mug|coffee cup|マグ|コーヒーカップ|马克杯|咖啡杯/.test(text)) return [0, 1, 0, 0];
    if (/공책|노트|notebook|ノート|笔记本/.test(text)) return [0, 0, 1, 0];
    return [0, 0, 0, 1];
  };
  const harness = await createLibraVmHarness({}, {
    async nativeFetch(url, init = {}) {
      assert.match(String(url), /embeddings/);
      providerCalls += 1;
      const body = JSON.parse(String(init.body || '{}'));
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({ data: inputs.map((value, index) => ({ index, embedding: vectorFor(value) })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  try {
    assert.equal(providerCalls, 0, 'startup must not run the multilingual provider probe');
    const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const queryVectors = Array.from({ length: 4 }, () => basis.map(vector => [...vector])).flat();
    const documentVectors = Array.from({ length: 4 }, () => basis.map(vector => [...vector])).flat();
    const supported = harness.api.debugEvaluateMultilingualEmbeddingProbe(queryVectors, documentVectors, 0.42);
    assert.equal(supported.schema, 'libra.embedding_multilingual_probe.v1');
    assert.equal(supported.status, 'supported');
    assert.equal(supported.directionPassCount, 6);
    assert.equal(supported.gateReadiness, 'ready');
    assert.equal(supported.gatePassedConcepts, 18);
    assert.deepEqual(JSON.parse(JSON.stringify(supported.directions.map(item => item.key))), ['ko->en', 'en->ko', 'ko->ja', 'ja->ko', 'ko->zh', 'zh->ko']);

    const collapsedDocuments = documentVectors.map(() => [1, 0, 0]);
    const failed = harness.api.debugEvaluateMultilingualEmbeddingProbe(queryVectors, collapsedDocuments, 0.42);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.directions.some(item => item.status === 'fail'));
    assert.equal(failed.semanticRankingSupported, false);

    const connection = await harness.api.testLibraEmbeddingProvider({
      provider: 'openai',
      url: 'https://embedding-fixture.invalid',
      apiKey: 'fixture-key',
      model: 'fixture-multilingual-embedding',
      dimensions: 4,
      batchSize: 16,
      timeoutMs: 10000
    });
    assert.equal(connection.ok, true);
    assert.equal(connection.multilingualProbe.status, 'supported');
    assert.equal(connection.multilingualProbe.directionPassCount, 6);
    assert.ok(providerCalls >= 4, 'explicit connection test must issue query, document, and multilingual probe requests');
    assert.equal(harness.api.getLastMultilingualEmbeddingProbe().status, 'supported');
  } finally {
    await harness.cleanup();
  }
  process.stdout.write('libra_multilingual_recall_runtime_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_multilingual_recall_runtime_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
