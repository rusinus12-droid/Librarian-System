'use strict';
// FB-R1 regression — a LOCAL checkpoint-capacity stop must not be reported as a provider fault.
//
// Defect (reproduced on 1.0.98 before the fix, via review_artifacts/.../checkpoint_capacity_probe.cjs):
// the 257th checkpoint batch threw a bare `Error('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED')` with no
// `type`, so `classifyIsolatedEmbeddingFailure` fell through to `type='UNKNOWN'` ->
// `FLASHBACK_EMBEDDING_PROVIDER_INVALID_RESPONSE` with `requiresProvider: true`, and
// `embeddingFailureIsItemScoped` treated `UNKNOWN` as item-scoped, decomposing ONE request-level
// refusal into N per-document provider failures — while the provider was never called at all. The
// repair advice ("check provider, model, dimensions") sent the reader to the wrong subsystem.
//
// Contract: the capacity stop carries its own local code, reports zero provider calls, keeps
// `requiresProvider: false`, is never item-scoped, preserves the 256 limit and the 7-day window, and
// leaves the existing corpus untouched. A genuine provider 401/invalid-vector must still classify as
// a provider fault, so the new code cannot swallow them.
//
// Negative control: on the pre-fix plugin source the local-code and providerCallAttempted assertions
// fail (the code came back FLASHBACK_EMBEDDING_PROVIDER_INVALID_RESPONSE with requiresProvider true).
//
// Run: node Librarian-System/PROGRAM/tests/flashback_checkpoint_capacity_classification_test.cjs

const assert = require('node:assert/strict');
const path = require('node:path');
const PROGRAM = path.resolve(__dirname, '..');
const { createFlashback } = require(path.join(PROGRAM, 'tests', 'fixtures', 'embedding_contract_harness.cjs'));

const results = [];
const check = (name, fn) => { try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: String(e.message).slice(0, 300) }); } };

(async () => {
  const f = await createFlashback(PROGRAM);
  const observed = {};
  try {
    const t = f.api._test;
    // ── 1. The classifier keeps the local code verbatim ──────────────────────────────────────────
    const capacityError = new Error('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED');
    capacityError.code = 'EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED';
    capacityError.type = 'EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED';
    capacityError.localCapacityExhausted = true;
    capacityError.providerCallAttempted = false;
    observed.classified = t.classifyIsolatedEmbeddingFailure(capacityError);

    // ── 2. The bare pre-fix error (no type at all) must ALSO not become a provider fault ──────────
    observed.bare = t.classifyIsolatedEmbeddingFailure(new Error('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED'));

    // ── 2b. THE REAL PATH: from the checkpoint throw through `classifyEmbeddingError` and the
    // `EmbeddingAdapterError` constructor. The whitelist inside that constructor demotes any type it does
    // not know to 'UNKNOWN', so a code missing from EMBEDDING_ERROR_TYPES reaches the caller as
    // INVALID_RESPONSE — which is exactly how the 257th batch was misreported. Measuring only the
    // classifier (2) cannot see this: it has its own local branch and passes either way.
    observed.viaAdapter = t.classifyEmbeddingError(new Error('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED'), { provider: 'openai_compat' });
    const bare = new Error('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED');
    bare.code = 'EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED';
    bare.type = 'EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED';
    observed.viaAdapterTyped = t.classifyEmbeddingError(bare, { provider: 'openai_compat' });
    // The end-to-end classification the GUI/debug consumer reads for the capacity stop.
    observed.endToEnd = t.classifyIsolatedEmbeddingFailure(observed.viaAdapterTyped);

    // ── 3. Item-scope decision ───────────────────────────────────────────────────────────────────
    observed.itemScopedWithFlag = t.embeddingFailureIsItemScoped(capacityError);
    observed.itemScopedBare = t.embeddingFailureIsItemScoped(new Error('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED'));
    observed.itemScopedUnknown = t.embeddingFailureIsItemScoped(Object.assign(new Error('something odd'), { type: 'UNKNOWN' }));
    // The zero-vector validator error is a BARE Error (no type) and MUST stay item-scoped.
    observed.itemScopedZeroVector = t.embeddingFailureIsItemScoped(new Error('Embedding provider returned a zero vector.'));
    observed.itemScopedDimension = t.embeddingFailureIsItemScoped(Object.assign(new Error('Embedding dimension mismatch'), { type: 'DIMENSION_MISMATCH' }));
    // Genuine provider faults must STILL be classified as provider faults (the control).
    const auth = Object.assign(new Error('Embedding endpoint returned HTTP 401: unauthorized'), { type: 'AUTH_ERROR' });
    observed.auth = t.classifyIsolatedEmbeddingFailure(auth);
    observed.authItemScoped = t.embeddingFailureIsItemScoped(auth);
    const badVector = Object.assign(new Error('Embedding coordinates must be finite numbers without coercion.'), { type: 'INVALID_RESPONSE' });
    observed.badVector = t.classifyIsolatedEmbeddingFailure(badVector);
    observed.badVectorItemScoped = t.embeddingFailureIsItemScoped(badVector);
  } finally { await f.cleanup(); }

  check('capacity stop keeps its own local code (not a provider code)', () => {
    assert.equal(observed.classified.code, 'FLASHBACK_EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED', JSON.stringify(observed.classified));
    assert.equal(observed.classified.stage, 'embedding_checkpoint');
    assert.equal(observed.classified.requiresProvider, false, 'a local limit must not ask for a provider fix');
    assert.equal(observed.classified.providerCallAttempted, false);
    assert.equal(observed.classified.localCapacityExhausted, true);
  });
  check('a bare capacity error is still not classified as a provider fault', () => {
    assert.equal(observed.bare.code, 'FLASHBACK_EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED', JSON.stringify(observed.bare));
    assert.equal(observed.bare.requiresProvider, false);
  });
  // THE DECISIVE CHECK: the capacity code must survive `classifyEmbeddingError` + the
  // `EmbeddingAdapterError` whitelist. Removing the code from EMBEDDING_ERROR_TYPES turns the type into
  // 'UNKNOWN' here and then into a provider code end to end — this assertion is what detects it.
  check('the capacity code survives the adapter classification (whitelist included)', () => {
    assert.equal(observed.viaAdapterTyped.type, 'EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED',
      `the whitelist demoted the local code: ${JSON.stringify(observed.viaAdapterTyped.type)}`);
    assert.equal(observed.viaAdapterTyped.requiresProvider, false);
    assert.equal(observed.viaAdapterTyped.localCapacityExhausted, true);
    assert.equal(observed.endToEnd.code, 'FLASHBACK_EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED',
      `end-to-end classification reported ${observed.endToEnd.code}`);
    assert.equal(observed.endToEnd.stage, 'embedding_checkpoint');
    assert.equal(observed.endToEnd.requiresProvider, false);
  });
  check('a fault raised before any wire call is never item-scoped', () => {
    assert.equal(observed.itemScopedWithFlag, false, 'capacity stop must not be split per document');
    assert.equal(observed.itemScopedBare, false, 'an untyped capacity stop must not be split either');
    assert.equal(observed.itemScopedUnknown, false, 'UNKNOWN is the absence of a classification, not item evidence');
  });
  // The UNKNOWN guard must stay BELOW the message check, or these two untyped validator errors lose scope.
  check('an untyped validator error keeps its item scope', () => {
    assert.equal(observed.itemScopedZeroVector, true, 'a bare zero-vector error is item-scoped');
    assert.equal(observed.itemScopedDimension, true, 'a dimension mismatch is item-scoped');
  });
  check('a genuine provider 401 is still a provider fault', () => {
    assert.equal(observed.auth.code, 'FLASHBACK_EMBEDDING_PROVIDER_REJECTED', JSON.stringify(observed.auth));
    assert.equal(observed.auth.requiresProvider, true);
  });
  check('a genuine invalid vector is still classified and stays item-scoped', () => {
    assert.equal(observed.badVector.requiresProvider, true, JSON.stringify(observed.badVector));
    assert.equal(observed.badVectorItemScoped, true, 'a malformed single vector must still isolate per item');
  });

  const passed = results.filter(r => r.ok).length;
  console.log(`flashback_checkpoint_capacity_classification_test: ${passed}/${results.length} PASS`);
  console.log(JSON.stringify({ test: 'flashback_checkpoint_capacity_classification', passed, observed, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
