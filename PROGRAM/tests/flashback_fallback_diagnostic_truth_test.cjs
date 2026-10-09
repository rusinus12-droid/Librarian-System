'use strict';
// FB-R2 regression — `fallbackUsed` must reflect what actually happened, not what is permitted.
//
// Defect (reproduced on 1.0.98 before the fix, via review_artifacts/.../fallback_diagnostic_probe.cjs):
// `embedTexts` recorded `fallbackUsed: allowHashFallback` — the SETTING that permits a fallback — inside
// the catch block. A 401 and a malformed vector therefore reported `fallbackUsed: true` while the
// exception propagated and no vector was returned, and the same block set `lastEmbedUsedFallback`
// BEFORE producing the substitute vectors, so a fallback step that threw still reported success.
//
// Contract: `fallbackUsed` is true only when substitute vectors were actually produced and returned.
// The permission lives in its own field (`fallbackAllowed`). Auth/invalid-vector rejection stays
// fail-closed: the error propagates and no hash vector is substituted.
//
// Negative control: on the pre-fix plugin source this suite fails on the auth_rejected and
// invalid_vector cases (`diagnosticFallback` true) and on `fallbackStage`.
//
// Run: node Librarian-System/PROGRAM/tests/flashback_fallback_diagnostic_truth_test.cjs

const assert = require('node:assert/strict');
const path = require('node:path');
const PROGRAM = path.resolve(__dirname, '..');
const { createFlashback } = require(path.join(PROGRAM, 'tests', 'fixtures', 'embedding_contract_harness.cjs'));

const CASES = ['healthy', 'auth_rejected', 'invalid_vector', 'network_failure'];

const configure = (f) => f.api._test.normalizeSettings({
  embeddingEnabled: true, embeddingProvider: 'openai_compat', embeddingModel: 'diag-fixture',
  embeddingUrl: 'https://fixture.invalid/v1', embeddingDimensions: 3, embeddingMaxRetries: 0,
  fallbackHashEmbedding: true
});

const responderFor = (mode) => async () => {
  if (mode === 'network_failure') throw new Error('network connection refused');
  if (mode === 'auth_rejected') return new Response('{"error":{"message":"unauthorized"}}', { status: 401 });
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: mode === 'invalid_vector' ? ['1', 0, 0] : [1, 0, 0] }] }), { status: 200 });
};

(async () => {
  const results = [];
  const observed = {};
  for (const mode of CASES) {
    const f = await createFlashback(PROGRAM);
    try {
      f.host.nativeFetch = responderFor(mode);
      let value, error;
      try { value = await f.api._test.embedTexts(['diagnostic input ' + mode], configure(f), { purpose: 'query' }); }
      catch (e) { error = e; }
      const diag = f.audit.Runtime.lastEmbeddingDiagnostic || {};
      observed[mode] = {
        returned: !!value,
        error: error ? String(error.message).slice(0, 120) : null,
        actualFallback: value?.flashbackFallbackUsed ?? false,
        diagnosticFallback: diag.fallbackUsed === true,
        fallbackAllowed: diag.fallbackAllowed,
        fallbackStage: diag.fallbackStage,
        runtimeFlag: f.api._test.inspectLastEmbedFallback()
      };
    } finally { await f.cleanup(); }
  }

  const check = (name, fn) => { try { const r = fn(); if (r && typeof r.then === 'function') throw new Error('async case must use checkAsync'); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: String(e.message).slice(0, 240) }); } };
  const checkAsync = async (name, fn) => { try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: String(e.message).slice(0, 240) }); } };

  // 1. healthy — no fallback anywhere.
  check('healthy: no fallback reported', () => {
    const o = observed.healthy;
    assert.equal(o.returned, true, 'a healthy provider must return vectors');
    assert.equal(o.actualFallback, false);
    assert.equal(o.diagnosticFallback, false, 'a healthy call must not report a fallback');
    assert.equal(o.runtimeFlag, false);
  });

  // 2. auth rejected — fail-closed, and the diagnostic must NOT claim a fallback happened.
  check('auth_rejected: error propagates and fallbackUsed is false', () => {
    const o = observed.auth_rejected;
    assert.equal(o.returned, false, 'a 401 must not produce vectors');
    assert.ok(o.error, 'the error must propagate');
    assert.equal(o.actualFallback, false);
    assert.equal(o.diagnosticFallback, false,
      'a 401 did not run a fallback; recording fallbackUsed:true was the defect');
    assert.equal(o.fallbackAllowed, true, 'the permission belongs in its own field');
    assert.equal(o.fallbackStage, 'not_attempted');
    assert.equal(o.runtimeFlag, false);
  });

  // 3. invalid vector — same contract.
  check('invalid_vector: error propagates and fallbackUsed is false', () => {
    const o = observed.invalid_vector;
    assert.equal(o.returned, false);
    assert.ok(o.error);
    assert.equal(o.actualFallback, false);
    assert.equal(o.diagnosticFallback, false,
      'a malformed vector did not run a fallback; recording fallbackUsed:true was the defect');
    assert.equal(o.fallbackStage, 'not_attempted');
    assert.equal(o.runtimeFlag, false);
  });

  // 4. network failure — the fallback DOES run; the diagnostic must say so.
  check('network_failure: the real fallback is reported as used', () => {
    const o = observed.network_failure;
    assert.equal(o.returned, true, 'the hash fallback must return vectors');
    assert.equal(o.actualFallback, true);
    assert.equal(o.diagnosticFallback, true, 'an actually-executed fallback must be reported');
    assert.equal(o.fallbackStage, 'used');
    assert.equal(o.runtimeFlag, true);
  });

  // 5. The returned value and the diagnostic must agree in EVERY case — that is the contract.
  check('return value and diagnostic agree on every case', () => {
    for (const mode of CASES) {
      const o = observed[mode];
      assert.equal(o.diagnosticFallback, o.actualFallback,
        `${mode}: diagnostic (${o.diagnosticFallback}) must equal what actually happened (${o.actualFallback})`);
    }
  });

  // 6. A fallback step that THROWS must not report success — with a REAL injected failure.
  //
  // The first version of this case was not a test: it only READ `hashEmbedding` to check the helper
  // existed, never made the substitute fail, and its `else` branch passed whatever happened. Measured
  // consequence (reviewer): mutating the product's `catch (fallbackError)` to record
  // `fallbackUsed: true` still left this suite at 6/6 PASS.
  //
  // The substitute is `hashEmbeddingBatch`, which is a closure and not reachable through `_test`, so the
  // failure is injected at its body through the fixture's `transformSource` — the same seam the reviewer
  // used. That injection is asserted to have landed, and every assertion below is unconditional: there is
  // no branch that can pass on the happy path.
  await checkAsync('a fallback that throws records failure and never success', async () => {
    const MARKER = 'const hashEmbeddingBatch = async (values = [], dimensions = DEFAULTS.hashDimensions, scopeInput = null) => {';
    const INJECTED = 'probe-injected hash failure';
    let injected = 0;
    const f = await createFlashback(PROGRAM, {
      transformSource: (source) => {
        assert.ok(source.includes(MARKER), 'the injection marker must exist in the shipped source');
        injected += 1;
        return source.replace(MARKER, `${MARKER} throw new Error('${INJECTED}');`);
      }
    });
    try {
      const t = f.api._test;
      assert.equal(injected, 1, 'the injection must have been applied exactly once');
      let providerCalls = 0;
      f.host.nativeFetch = async () => { providerCalls += 1; throw new Error('network connection refused'); };

      let threw = null, value = null;
      try {
        value = await t.embedTexts(['fallback failure control'], configure(f), { purpose: 'query' });
      } catch (e) { threw = e; }

      const diag = f.audit.Runtime.lastEmbeddingDiagnostic || {};

      // (a) the provider was attempted, so the fallback branch is the one under test
      assert.equal(providerCalls > 0, true, 'the provider must have been attempted first');
      // (b) the injected failure propagated unchanged — not swallowed, not replaced
      assert.ok(threw, 'the fallback failure must propagate');
      assert.equal(String(threw.message).includes(INJECTED), true,
        `the propagated error must be the injected one, got: ${String(threw.message).slice(0, 120)}`);
      // (c) no vectors were returned
      assert.equal(value, null, 'a failed fallback must not return vectors');
      // (d) the diagnostic records failure — the exact lie the product must not tell
      assert.equal(diag.fallbackUsed === true, false, 'a failed fallback must not report fallbackUsed');
      assert.equal(diag.fallbackStage, 'failed', `fallbackStage must be 'failed', got ${JSON.stringify(diag.fallbackStage)}`);
      assert.equal(diag.fallbackAllowed, true, 'the permission stays true — that is a different fact');
      assert.equal(String(diag.fallbackReason || '').includes(INJECTED), true,
        'the reason must name the actual failure');
      // (e) the runtime flag agrees with the diagnostic
      assert.equal(t.inspectLastEmbedFallback(), false, 'Runtime.lastEmbedUsedFallback must stay false');
    } finally { await f.cleanup(); }
  });

  // 7. CONTROL — the same seam, un-injected: the substitute succeeds and IS reported as used. Without
  // this the case above could pass by never reaching the fallback at all.
  await checkAsync('control: an un-injected fallback still succeeds and is reported used', async () => {
    const f = await createFlashback(PROGRAM);
    try {
      const t = f.api._test;
      f.host.nativeFetch = async () => { throw new Error('network connection refused'); };
      const value = await t.embedTexts(['fallback success control'], configure(f), { purpose: 'query' });
      const diag = f.audit.Runtime.lastEmbeddingDiagnostic || {};
      assert.ok(value && value.length, 'the control fallback must return vectors');
      assert.equal(diag.fallbackStage, 'used', 'the control must report the fallback as used');
      assert.equal(diag.fallbackUsed, true);
      assert.equal(t.inspectLastEmbedFallback(), true);
    } finally { await f.cleanup(); }
  });

  const passed = results.filter(r => r.ok).length;
  console.log(`flashback_fallback_diagnostic_truth_test: ${passed}/${results.length} PASS`);
  console.log(JSON.stringify({ test: 'flashback_fallback_diagnostic_truth', passed, observations: observed, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
