'use strict';
// DEFECTS 1 & 5 REGRESSION
//
// #1 auto-retry reused an exhausted provider budget
//    MEASURED (before fix): the automatic scan passes neither discardPreviousWork nor
//    freshTerminalAttempt, so it reloaded the failed attempt's work — whose single physical call was
//    already spent. The retry threw `canonical_provider_budget_already_exhausted` before any model
//    call: calls 1 -> 1, same runId/providerOperationId, attemptCount 1 -> 2, nothing stored.
//    INVARIANT: a backoff-passed failure must reach the provider again and store.
//
// #5 a cancelled retry was reported as completed
//    MEASURED (before fix): the retry completion branch only inspected failures/warnings, so a job
//    cancelled during the retry was written as state 'completed' / phase 'complete' with the message
//    "정본 작업을 완료했습니다." while nothing had been stored.
//    INVARIANT: cancelRequested at retry completion must produce state 'cancelled'.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const pause = ms => new Promise(r => setTimeout(r, ms));

const expose = source => {
  const coreAnchor = '      getUnifiedStorageStatus,';
  const publicAnchor = "    async getUnifiedStorageStatus() {";
  assert.equal(source.split(coreAnchor).length, 2, 'core anchor must be unique');
  return source
    .replace(coreAnchor, '      reviewScan: options => scan(options),\n' + coreAnchor)
    .replace(publicAnchor, '    reviewScan(options) { return LibraMemoryCore.reviewScan(options); },\n' + publicAnchor);
};

async function defect1() {
  const out = { check: 'auto-retry reaches the provider after the budget is spent' };
  const f = await fixture({ transformSource: expose });
  try {
    // 1. Fail once, leaving work whose providerBudget has spent its single physical call.
    f.control.modelFails = true;
    await f.run();
    await pause(700);
    const mk = [...f.r.values.keys()].find(k => k.endsWith(':manifest'));
    const wk = [...f.r.values.keys()].find(k => /:work:/.test(k));
    const mf = JSON.parse(f.r.values.get(mk));
    const budgetBefore = JSON.parse(f.r.values.get(wk) || '{}').providerBudget || {};
    out.budgetBefore = {
      totalCalls: budgetBefore.totalCalls, maxPhysicalCalls: budgetBefore.maxPhysicalCalls,
      exhaustedReason: budgetBefore.exhaustedReason || '', runId: JSON.parse(f.r.values.get(wk) || '{}').runId
    };
    out.failedRunId = mf.failedBatches['1'].runId;

    // 2. Elapse the backoff and restore the provider, then run the AUTOMATIC path.
    mf.failedBatches['1'].failedAt = '2020-01-01T00:00:00.000Z';
    f.r.values.set(mk, JSON.stringify(mf));
    f.control.modelFails = false;

    out.callsBefore = f.control.calls.length;
    let res;
    try { res = await f.r.api.reviewScan({ mode: 'risu_output', sourceStabilityDelay: 120 }); }
    catch (e) { res = { error: String(e.message).slice(0, 200) }; }
    out.callsAfter = f.control.calls.length;
    out.result = {
      ok: res?.ok, failed: res?.failed,
      failedBatches: (res?.failedBatches || []).map(r => ({ start: r.startTurn, message: String(r.message).slice(0, 140) }))
    };
    out.stored = !!f.getMemory();
    const rec = JSON.parse(f.r.values.get(mk) || 'null')?.failedBatches?.['1'];
    out.failureCleared = !rec;
    out.recoveryDiagnostic = f.r.api.getRuntimeDiagnostics
      ? '(runtime diagnostics not queried)'
      : undefined;
    return out;
  } finally { await f.r.cleanup(); }
}

async function defect5() {
  const out = { check: 'a cancelled retry is not reported as completed' };
  const scanAnchor = '    const scan = async (options = {}) => {';
  const g = await fixture({ transformSource: source => {
    assert.equal(source.split(scanAnchor).length, 2, 'scan anchor must be unique');
    return source.replace(scanAnchor,
      '    let reviewConflictInjected = false;\n' + scanAnchor +
      '\n      if (options.jobId && !reviewConflictInjected) { reviewConflictInjected = true; const e = new Error("review forced CAS conflict"); e.code = "LIBRA_COMMIT_CONFLICT"; throw e; }');
  }});
  try {
    g.control.onCall = async () => {
      out.cancellation = await g.r.api.cancelCanonicalJob();
      return { type: 'success', result: JSON.stringify(g.control.artifact) };
    };
    await g.r.api.startManualCanonicalScan({ startTurns: [1] });
    const job = await g.r.api.getCanonicalJobStatus();
    out.job = {
      state: job.state, phase: job.phase, cancelRequested: job.cancelRequested,
      completed: job.completed, failed: job.failed, message: job.message
    };
    out.stored = !!g.getMemory();
    return out;
  } finally { await g.r.cleanup(); }
}

(async () => {
  const rows = { defect1: await defect1(), defect5: await defect5() };
  console.log(JSON.stringify(rows, null, 1));

  // ── #1 ──
  const d1 = rows.defect1;
  assert.ok(d1.callsAfter > d1.callsBefore,
    `the automatic retry must reach the provider (calls ${d1.callsBefore} -> ${d1.callsAfter}); `
    + 'it previously threw canonical_provider_budget_already_exhausted without calling');
  assert.equal(d1.result.failed, 0,
    `the retry must not fail after the provider recovers (failed ${d1.result.failed}: `
    + `${(d1.result.failedBatches || []).map(x => x.message).join('; ')})`);
  assert.equal(d1.stored, true, 'the recovered retry must store the memory');
  assert.equal(d1.failureCleared, true, 'the resolved failure record must be cleared');

  // ── #5 ──
  const d5 = rows.defect5;
  assert.equal(d5.job.cancelRequested, true, 'the probe must actually request cancellation');
  assert.equal(d5.job.state, 'cancelled',
    `a cancelled retry must not be recorded as '${d5.job.state}' (message: ${d5.job.message})`);
  assert.equal(d5.job.phase, 'cancelled',
    `a cancelled retry must not carry phase '${d5.job.phase}'`);
  assert.ok(!/완료했습니다/.test(String(d5.job.message || '')),
    `a cancelled retry must not report completion (message: ${d5.job.message})`);

  process.stdout.write('libra_retry_budget_and_cancel_test: PASS\n');
})().catch(e => { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 1; });
