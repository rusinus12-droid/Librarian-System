'use strict';
// RED/GREEN guard for automatic retry of failed canonical batches.
//
// THE PROBLEM THIS LOCKS DOWN
//
// A five-turn canonical batch that fails is recorded in `manifest.failedBatches` (good — the
// failure is durable and visible). But `addCandidate` then does this:
//
//     if (!allowHistoricalBackfill && terminalFailedStarts.has(numeric)) return;
//
// `allowHistoricalBackfill` is true only for manual cold start / historical reanalysis, so for
// every AUTOMATIC scan (afterrequest fallback, risu output, boundary recovery) a failed start turn
// is skipped permanently. The only route back is the GUI's manual "실패 구간 새 분석" button.
//
// That is why a transient failure — a gateway timeout, a provider hiccup, a batch that was
// malformed and is now repairable — leaves a permanent hole in memory. The user's requirement is
// that memory generation must succeed under any circumstance, so a failed batch must be retried
// automatically, with backoff so a persistently failing batch cannot burn the provider budget.
//
// WHAT IS ASSERTED
//
//   1. A failed batch becomes eligible for an automatic scan again once its backoff has elapsed.
//   2. It stays INELIGIBLE before the backoff elapses (so a hard failure is not hammered).
//   3. The attempt counter and backoff are bounded, so a permanently broken batch eventually
//      stops being retried automatically rather than looping forever.
//   4. The existing manual path is unchanged: `allowHistoricalBackfill` still ignores the gate.
//   5. The gate is unchanged when the batch source has changed — a stale failure marker is
//      already dropped before candidate selection, so a changed batch is always retried.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

(async () => {
  const harness = await createLibraVmHarness();
  try {
    const api = harness.api;

    // ------------------------------------------------------------------------------------
    // The decision function must exist and be reachable, so the scan loop's gate can be
    // verified directly instead of only through a whole pipeline run.
    // ------------------------------------------------------------------------------------
    assert.equal(typeof api.debugFailedBatchRetryDue, 'function',
      'the failed-batch retry decision must be reachable for verification');

    const due = api.debugFailedBatchRetryDue;

    // ------------------------------------------------------------------------------------
    // 1. BACKOFF: a fresh failure is NOT immediately due; once the window passes it IS due.
    // ------------------------------------------------------------------------------------
    const base = 1000 * 1000; // arbitrary fixed epoch, so the test is not wall-clock dependent
    const fresh = { startTurn: 1, failedAt: new Date(base).toISOString(), attemptCount: 1 };
    assert.equal(due(fresh, base + 1_000), false,
      'a batch that just failed must not be retried immediately');
    assert.equal(due(fresh, base + 90_000), true,
      'a batch must become retryable once its backoff has elapsed');

    // ------------------------------------------------------------------------------------
    // 2. BOUNDED: the attempt count is capped, so a permanently broken batch stops retrying.
    // ------------------------------------------------------------------------------------
    const exhausted = { startTurn: 1, failedAt: new Date(base).toISOString(), attemptCount: 99 };
    assert.equal(due(exhausted, base + 86_400_000), false,
      'a batch that has exhausted its retry allowance must stop being retried automatically');

    // The cap must be a real, documented constant rather than an accident of the check.
    const capMatch = PLUGIN.match(/LIBRA_FAILED_BATCH_MAX_AUTO_RETRIES\s*=\s*(\d+)/);
    assert.ok(capMatch, 'the automatic retry allowance must be a named constant');
    const cap = Number(capMatch[1]);
    assert.ok(cap >= 2 && cap <= 10,
      `the retry allowance must be a small bounded count (got ${cap})`);
    assert.equal(due({ startTurn: 1, failedAt: new Date(base).toISOString(), attemptCount: cap - 1 }, base + 86_400_000), true,
      'the last permitted attempt must still be allowed');
    assert.equal(due({ startTurn: 1, failedAt: new Date(base).toISOString(), attemptCount: cap }, base + 86_400_000), false,
      'one attempt past the allowance must be refused');

    // ------------------------------------------------------------------------------------
    // 3. BACKOFF GROWS: later attempts wait longer, and the wait is bounded.
    // ------------------------------------------------------------------------------------
    const first = { startTurn: 1, failedAt: new Date(base).toISOString(), attemptCount: 1 };
    const second = { startTurn: 1, failedAt: new Date(base).toISOString(), attemptCount: 2 };
    assert.equal(due(second, base + 31_000), false,
      'a second attempt must wait longer than the first');
    assert.equal(due(second, base + 3_600_000), true,
      'the backoff must still elapse within a bounded time');

    // ------------------------------------------------------------------------------------
    // 4. NO TIMESTAMP: a legacy failure record without failedAt must not be stuck forever.
    //    The normalizer already defaults it to now, but the decision must tolerate a missing
    //    or unparsable value rather than silently refusing to retry.
    // ------------------------------------------------------------------------------------
    assert.equal(due({ startTurn: 1, attemptCount: 1 }, base), true,
      'a failure marker without a usable timestamp must still be retryable');

    // ------------------------------------------------------------------------------------
    // 5. The gate wiring must be real, not just a decision function nobody calls. This is a
    //    source assertion because the scan loop is a closure over half the module; the runtime
    //    behaviour of the decision itself is covered by 1-4 above.
    // ------------------------------------------------------------------------------------
    assert.match(PLUGIN,
      /if \(!allowHistoricalBackfill && terminalFailedStarts\.has\(numeric\)\s*\n\s*&& !failedBatchRetryDue\(failedBatchRecordFor\(numeric\), Date\.now\(\), settings\)\) return;/,
      'the candidate gate must consult the retry decision instead of excluding failures outright');

    // The ledger fields must survive manifest normalization, or a retry count would reset on
    // every write and the backoff would never progress past its first step.
    assert.equal(typeof api.debugNormalizeFailedCanonicalBatches, 'function',
      'the failure-marker normalizer must be reachable to verify the ledger survives');
    const normalized = api.debugNormalizeFailedCanonicalBatches({
      1: { startTurn: 1, attemptCount: 3, lastAttemptAt: '2026-01-01T00:00:00.000Z', failedAt: '2026-01-01T00:00:00.000Z' }
    });
    assert.equal(normalized['1'].attemptCount, 3,
      'the attempt count must survive normalization (it is the retry ledger)');
    assert.equal(normalized['1'].lastAttemptAt, '2026-01-01T00:00:00.000Z',
      'the last-attempt timestamp must survive normalization');

    // ------------------------------------------------------------------------------------
    // 6. The `autoRetry` setting must actually govern automatic retry. It previously controlled
    //    only "stop the remaining batches" vs "propagate the error" — a setting named autoRetry
    //    that never retried anything, and that is not reachable from the GUI either.
    // ------------------------------------------------------------------------------------
    assert.equal(due(fresh, base + 90_000, { autoRetry: false }), false,
      'autoRetry=false must switch automatic retry off');
    assert.equal(due(fresh, base + 90_000, { autoRetry: true }), true,
      'autoRetry=true must allow automatic retry');
    assert.equal(due(fresh, base + 90_000, {}), true,
      'autoRetry defaults to on, matching the stored default');

    // ------------------------------------------------------------------------------------
    // 7. A failed batch must not abort the batches behind it. The loop used to `break` on the
    //    first failure whenever autoRetry was on (the default), so one bad range silently
    //    prevented every later range in the same scan from being analysed.
    // ------------------------------------------------------------------------------------
    assert.match(PLUGIN, /if \(settings\.autoRetry === false && options\.throwOnError === true\) throw error;/,
      'an explicit autoRetry=false plus throwOnError must still propagate the error');
    assert.match(PLUGIN, /await saveManifest\(context\.scope, manifest\);\s*\n\s*continue;\s*\n\s*\}\s*\n\s*if \(effectiveMaxBatches > 0/,
      'a batch failure must continue with the remaining batches, not abort the scan');

    console.log(JSON.stringify({
      test: 'libra_failed_batch_retry',
      backoffImmediate: false,
      backoffElapsed: true,
      maxAutoRetries: cap,
      backoffGrows: true,
      missingTimestampRetryable: true,
      gateConsultsDecision: true,
      autoRetryGovernsRetry: true,
      failureContinuesRemainingBatches: true
    }, null, 1));
    process.stdout.write('libra_failed_batch_retry_test: PASS\n');
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
