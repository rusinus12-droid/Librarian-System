'use strict';
// Model-only contract: obsolete fallback permission cannot turn a provider
// failure into substitute evidence. Healthy vectors and truthful diagnostics
// remain covered, including recovery after a failed request.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
(async () => {
  const f = await createFlashback(PROGRAM);
  try {
    const cfg = f.api._test.normalizeSettings({ embeddingEnabled: true,
      embeddingProvider: 'openai_compat', embeddingModel: 'diag-fixture',
      embeddingUrl: 'https://fixture.invalid/v1', embeddingDimensions: 3,
      embeddingMaxRetries: 0, fallbackHashEmbedding: true });
    assert.equal(cfg.fallbackHashEmbedding, false, 'legacy permission is disabled');
    for (const mode of ['healthy', 'auth_rejected', 'invalid_vector', 'network_failure', 'recovered']) {
      let calls = 0;
      f.host.nativeFetch = async () => {
        calls++;
        if (mode === 'network_failure') throw Error('network connection refused');
        if (mode === 'auth_rejected') return new Response('{"error":{"message":"unauthorized"}}', { status: 401 });
        return new Response(JSON.stringify({ data: [{ index: 0,
          embedding: mode === 'invalid_vector' ? ['1', 0, 0] : [1, 0, 0] }] }), { status: 200 });
      };
      let value, error;
      try { value = await f.api._test.embedTexts(['diagnostic input ' + mode], cfg, { purpose: 'query' }); }
      catch (e) { error = e; }
      assert.equal(calls, 1, mode + ': exercise the provider');
      assert.equal(f.api._test.inspectLastEmbedFallback(), false);
      assert.equal(value?.flashbackFallbackUsed ?? false, false);
      if (mode === 'healthy' || mode === 'recovered') {
        assert.equal(error, undefined);
        assert.deepEqual(Array.from(value[0]), [1, 0, 0], 'actual provider vector is returned');
      } else {
        assert.ok(error, mode + ': rejection propagates');
        assert.equal(value, undefined, 'failed request returns no substitute');
        const diag = f.audit.Runtime.lastEmbeddingDiagnostic;
        assert.equal(diag.fallbackAllowed, false);
        assert.equal(diag.fallbackUsed, false);
        assert.equal(diag.fallbackStage, 'disabled');
        assert.ok(diag.errorType, 'actual failure has a diagnostic');
      }
    }
    console.log('flashback_fallback_diagnostic_truth_test: PASS (controlled provider; real provider NOT_RUN)');
  } finally { await f.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
