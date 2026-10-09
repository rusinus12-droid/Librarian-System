'use strict';
// FB-R1 user-facing capacity guidance.
//
// Defect (reproduced on 1.0.98 before the fix): a LOCAL checkpoint capacity stop surfaced to the user as
// the raw diagnostic — the maintenance catch path goes `guiError -> formatErrorMessage -> error.message`,
// so the dialog read `EmbeddingAdapterError: EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED`. That names a local
// device limit in provider vocabulary: the repair advice a reader derives from it ("check the embedding
// provider / model / dimensions") points at the wrong subsystem, and nothing said whether existing
// memories survived.
//
// Contract asserted here:
//   1. formatErrorMessage turns a local checkpoint stop into a user sentence that says the provider is
//      NOT the cause and that existing memories are preserved.
//   2. The maintenance RESULT text carries the same notice, so the outcome dialog states it too.
//   3. A provider fault (401 / rejected / invalid response) is NOT rewritten into that local notice —
//      the two classes must stay distinguishable in the UI.
//   4. The isolated-reason table covers the local codes (no raw code name leaks).
//
// Run: node Librarian-System/PROGRAM/tests/flashback_local_capacity_guidance_test.cjs

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
    const fmt = t.formatErrorMessage;
    const reasonText = t.maintenanceIsolatedReasonText;
    const resultText = t.maintenanceResultText;
    const partialLines = t.maintenancePartialSuccessLines;
    assert.equal(typeof fmt, 'function', 'formatErrorMessage must be reachable on _test');
    assert.equal(typeof reasonText, 'function', 'maintenanceIsolatedReasonText must be reachable on _test');
    assert.equal(typeof resultText, 'function', 'maintenanceResultText must be reachable on _test');
    assert.equal(typeof partialLines, 'function', 'maintenancePartialSuccessLines must be reachable on _test');

    // (1) the raw capacity error (message IS the code) and the classified adapter error (type carries it)
    const raw = new Error('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED');
    const classified = Object.assign(new Error('Embedding endpoint returned HTTP 500: x'), {
      name: 'EmbeddingAdapterError', type: 'EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED', code: 'EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED',
      localCapacityExhausted: true, providerCallAttempted: false
    });
    observed.raw = fmt(raw);
    observed.classified = fmt(classified);

    // (3) provider faults must NOT become the local notice
    const auth = Object.assign(new Error('Embedding endpoint returned HTTP 401: unauthorized'), { name: 'EmbeddingAdapterError', type: 'AUTH_ERROR' });
    observed.auth = fmt(auth);
    const invalid = Object.assign(new Error('Embedding endpoint returned HTTP 500: upstream'), { name: 'EmbeddingAdapterError', type: 'INVALID_RESPONSE' });
    observed.invalid = fmt(invalid);

    // (2) the maintenance result text. The advice line must match the FAILURE CLASS:
    //     a local checkpoint stop must not send the user to the embedding-provider settings.
    const localOnly = { maintenanceMode: 'sync', operation: { isolatedFailures: [{ code: 'FLASHBACK_EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED', turn: 3, previousVectorPreserved: true }] } };
    const providerOnly = { maintenanceMode: 'sync', operation: { isolatedFailures: [{ code: 'FLASHBACK_EMBEDDING_PROVIDER_TIMEOUT', turn: 4 }] } };
    // NOTE: maintenanceIsolatedFailures de-duplicates on `scopeKey:hash:recordIndex`, so two rows that
    // differ only by `turn` collapse into one. Give each row a distinct identity, as real records have.
    const mixed = { maintenanceMode: 'sync', operation: { isolatedFailures: [{ code: 'FLASHBACK_EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED', turn: 3, hash: 'h-local' }, { code: 'FLASHBACK_EMBEDDING_PROVIDER_TIMEOUT', turn: 4, hash: 'h-provider' }] } };
    observed.resultWithCapacity = resultText(localOnly);
    observed.resultHealthy = resultText({ maintenanceMode: 'sync', healthy: true, operation: {} });
    observed.resultProviderFault = resultText(providerOnly);
    observed.resultMixed = resultText(mixed);

    // (4) isolated-reason table
    observed.reasonCapacity = reasonText('FLASHBACK_EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED');
    observed.reasonLocalDefect = reasonText('FLASHBACK_EMBEDDING_CHECKPOINT_LOCAL_DEFECT');
    observed.reasonUnknown = reasonText('SOME_UNKNOWN_CODE');
    observed.localCodes = null;
    observed.notice = t.maintenanceIsolatedReasonText('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED');
    observed.resultText = resultText;
    observed.reasonFor = t.maintenanceIsolatedReasonText;
  } finally { await f.cleanup(); }

  const LOCAL_MARK = /임베딩 제공자 문제가 아/;          // "the embedding provider is not the problem"
  const PRESERVED_MARK = /보존되|보존되었|그대로 보존/;   // existing data preserved
  const LOCAL_PROVIDER_ADVICE = /임베딩 설정 확인/;       // the provider-settings advice marker
  const RETRY_ADVICE = /\[다시 시도\]/;                  // the retry CALL TO ACTION line specifically
  // The ADVICE LINE specifically, not the per-row reason: the row sentence also contains the word
  // "한도", so a loose /기록 한도/ matched the row and let a missing advice line pass. Anchor on the
  // line label instead.
  const LOCAL_LIMIT_LINE = /\[기록 한도\]/;
  const CORRUPT_LINE = /\[기록 손상\]/;         // a damaged store is NOT a size limit (reviewer P2)
  const TARGETED_ADVICE = /임베딩 제공자 오류로 보류된 턴/;   // the advice names its target on a mixed list

  check('formatErrorMessage: a raw capacity stop becomes a user sentence', () => {
    assert.equal(typeof observed.raw, 'string');
    assert.ok(!observed.raw.includes('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED'),
      `the raw code must not reach the user: ${observed.raw.slice(0, 120)}`);
    assert.ok(LOCAL_MARK.test(observed.raw), `must say the provider is not at fault: ${observed.raw}`);
    assert.ok(PRESERVED_MARK.test(observed.raw), `must say existing memories are preserved: ${observed.raw}`);
  });
  check('formatErrorMessage: the classified adapter error maps too', () => {
    assert.ok(!observed.classified.includes('EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED'), observed.classified.slice(0, 120));
    assert.ok(!/EmbeddingAdapterError/.test(observed.classified), 'the class name must not leak either');
    assert.ok(LOCAL_MARK.test(observed.classified) && PRESERVED_MARK.test(observed.classified), observed.classified);
  });
  check('a provider 401 is NOT rewritten as a local capacity notice', () => {
    assert.ok(!LOCAL_MARK.test(observed.auth), `a 401 must keep its own text: ${observed.auth}`);
    assert.ok(/401|unauthori/i.test(observed.auth), observed.auth);
  });
  check('a provider invalid response is NOT rewritten as a local capacity notice', () => {
    assert.ok(!LOCAL_MARK.test(observed.invalid), observed.invalid);
  });
  check('a local-only stop does NOT offer a retry, because a retry cannot clear it', () => {
    // The reviewer's checkpoint-user.cjs measured this: retrying immediately with no state change
    // reproduces the same capacity stop, `providerCallAttempted:false`, zero additional wire calls. The
    // audit contract therefore forbids offering a retry as the remedy. The previous assertion here
    // (`/다시 시도|저장소/`) ACCEPTED the wrong advice — it passed on the defect it was meant to catch.
    assert.ok(!RETRY_ADVICE.test(observed.resultWithCapacity),
      `must NOT offer a retry for a local limit: ${observed.resultWithCapacity.slice(-260)}`);
    assert.ok(!LOCAL_PROVIDER_ADVICE.test(observed.resultWithCapacity),
      `must NOT advise inspecting the embedding provider for a local limit: ${observed.resultWithCapacity.slice(-260)}`);
    // And it must say what actually happened.
    assert.ok(LOCAL_LIMIT_LINE.test(observed.resultWithCapacity),
      `must state the real limit and that a retry will not produce a vector: ${observed.resultWithCapacity.slice(-260)}`);
  });
  check('the local stop keeps the per-row reason and the preserved notice', () => {
    assert.ok(PRESERVED_MARK.test(observed.resultWithCapacity), observed.resultWithCapacity.slice(0, 300));
    assert.ok(!observed.resultWithCapacity.includes('FLASHBACK_EMBEDDING_'), 'no raw code names in the outcome text');
  });
  check('a healthy maintenance result carries no isolated-failure notice', () => {
    assert.ok(!LOCAL_MARK.test(observed.resultHealthy), observed.resultHealthy.slice(0, 200));
  });
  check('a PROVIDER fault keeps the provider advice (classes stay distinguishable)', () => {
    assert.ok(LOCAL_PROVIDER_ADVICE.test(observed.resultProviderFault),
      `a provider fault must keep its own advice: ${observed.resultProviderFault.slice(-200)}`);
    assert.ok(!LOCAL_MARK.test(observed.resultProviderFault), observed.resultProviderFault.slice(-200));
  });
  check('a MIXED list separates the causes AND names what each advice targets', () => {
    // The earlier guard (`every(...)`) was false as soon as ONE row was not local, so a mixed list still
    // told the user to check provider settings for the LOCAL rows. Both classes must now be addressed,
    // and each advice must name its TARGET — on a mixed list "held-back turns" alone does not say which.
    assert.ok(LOCAL_LIMIT_LINE.test(observed.resultMixed),
      `the local cause must be stated: ${observed.resultMixed.slice(-320)}`);
    assert.ok(LOCAL_PROVIDER_ADVICE.test(observed.resultMixed),
      `the provider cause must keep its advice: ${observed.resultMixed.slice(-320)}`);
    assert.ok(RETRY_ADVICE.test(observed.resultMixed),
      `a retry is valid for the provider rows: ${observed.resultMixed.slice(-320)}`);
    assert.ok(TARGETED_ADVICE.test(observed.resultMixed),
      `the retry must name the provider rows it applies to: ${observed.resultMixed.slice(-320)}`);
  });

  check('a corrupt store is NOT described as a size limit', () => {
    const corruptOnly = { maintenanceMode: 'sync', operation: { isolatedFailures: [
      { code: 'EMBEDDING_CHECKPOINT_CORRUPT', turn: 5, hash: 'h-corrupt' }] } };
    const text = observed.resultText(corruptOnly);
    assert.ok(CORRUPT_LINE.test(text), `a damaged store needs its own line: ${text.slice(-300)}`);
    assert.ok(!LOCAL_LIMIT_LINE.test(text), `damage must not be reported as a capacity limit: ${text.slice(-300)}`);
    assert.ok(!RETRY_ADVICE.test(text), `a retry cannot clear damage either: ${text.slice(-300)}`);
  });

  check('a capacity stop is NOT described as damage', () => {
    assert.ok(!CORRUPT_LINE.test(observed.resultWithCapacity),
      `a full store is not a damaged one: ${observed.resultWithCapacity.slice(-300)}`);
  });
  check('the local-code path separates local limits from provider faults', () => {
    // The split is observed through the reason table: a local code resolves to the LOCAL sentinel, a
    // provider code to its own sentence. That is the boundary the UI actually consumes.
    const reason = observed.reasonFor;
    assert.equal(typeof reason, 'function', 'maintenanceIsolatedReasonText must be reachable on _test');
    for (const c of ['FLASHBACK_EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED', 'EMBEDDING_CHECKPOINT_CAPACITY_EXHAUSTED']) {
      assert.equal(reason(c), observed.notice, `${c} must resolve to the LOCAL capacity sentence`);
    }
    // CORRUPT keeps its own local sentence (also names the provider as innocent).
    assert.ok(LOCAL_MARK.test(reason('EMBEDDING_CHECKPOINT_CORRUPT')), reason('EMBEDDING_CHECKPOINT_CORRUPT'));
    for (const [c, mark] of [['FLASHBACK_EMBEDDING_PROVIDER_TIMEOUT', /제공자 응답이 시간/], ['FLASHBACK_EMBEDDING_ZERO_VECTOR', /0 벡터/]]) {
      assert.ok(mark.test(reason(c)), `${c} must keep its own sentence: ${reason(c)}`);
      assert.notEqual(reason(c), observed.notice, `${c} must NOT resolve to the LOCAL sentence`);
    }
  });
  check('the reason text covers the local codes with the shared sentence', () => {
    assert.ok(LOCAL_MARK.test(observed.reasonCapacity), observed.reasonCapacity);
    assert.ok(PRESERVED_MARK.test(observed.reasonCapacity), observed.reasonCapacity);
    assert.ok(!observed.reasonCapacity.includes('EMBEDDING_CHECKPOINT_'), 'no code names in the user text');
    assert.ok(observed.reasonUnknown.length > 0, 'an unknown code still yields a generic sentence');
  });

  const passed = results.filter(r => r.ok).length;
  console.log(`flashback_local_capacity_guidance_test: ${passed}/${results.length} PASS`);
  console.log(JSON.stringify({ test: 'flashback_local_capacity_guidance', passed, observed, results }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
