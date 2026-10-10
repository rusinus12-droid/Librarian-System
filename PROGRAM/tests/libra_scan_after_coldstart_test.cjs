'use strict';
// The GUI's two scan buttons must work in the order they are laid out.
//
// THE DEFECT, measured: the canonical tab renders "수동 콜드스타트" and "현재 5턴 분석" side by side.
// Pressing the second one as soon as the first resolves failed 100% of the time (3/3, reproduced twice)
// with:
//
//     manifest commit conflict: another writer committed this manifest after this document was loaded
//
// A cold start commits the manifest again in its own settled work, so a scan that loads the manifest
// in that window publishes from a stale revision and the CAS refuses it. The refusal is correct — the
// manifest is a whole-document overwrite, so publishing would silently revert the other writer's
// fields. The defect is that the user-facing path never recovered: the job simply sat in `failed`
// with stage `preparing`, and the only remedy was to press the button again (verified: the second
// press succeeds).
//
// WHAT IS FIXED: a bounded single retry when the failure is LIBRA_COMMIT_CONFLICT. Retrying is safe
// because scan() loads the manifest INSIDE the per-scope lock, so the retry recomputes from the
// committed document rather than replaying a stale one. A conflict that survives the retry still
// surfaces as a failure, so a genuine loop is not hidden.
//
// This suite locks: the natural button order completes, the standalone path is unchanged, and a cold
// start still commits memory.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixture } = require(path.resolve(__dirname, 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const jobState = job => { const j = parse(job) || {}; return { state: j.state || null, phase: j.phase || null, error: String(j.error || '') }; };

const runColdThenScan = async () => {
  const f = await fixture();
  try {
    const cold = await f.run();
    const api = f.r.api;
    // Exactly what the second button does: startManualCanonicalScan({}) with no arguments.
    await api.startManualCanonicalScan({});
    // Let the job settle: the conflict window is ~500ms after the cold start resolves.
    await new Promise(resolve => setTimeout(resolve, 1200));
    return {
      coldCompleted: cold?.completed ?? null,
      memoryCommitted: Boolean(f.getMemory()),
      job: jobState(await api.getCanonicalJobStatus())
    };
  } finally {
    await f.r.cleanup();
  }
};

(async () => {
  const report = { rounds: [] };

  // 1. THE REGRESSION: the natural GUI sequence, three times, because the window is timing-dependent.
  for (let round = 1; round <= 3; round += 1) {
    const outcome = await runColdThenScan();
    report.rounds.push(outcome);
    assert.equal(outcome.job.state, 'completed',
      `round ${round}: a scan started right after a cold start must complete, not fail (${JSON.stringify(outcome.job)})`);
    assert.equal(outcome.coldCompleted, 1, `round ${round}: the cold start itself must still complete`);
    assert.equal(outcome.memoryCommitted, true, `round ${round}: the cold start must still commit memory`);
  }

  // 2. The standalone path is unchanged — a scan with no prior cold start.
  {
    const f = await fixture();
    try {
      const api = f.r.api;
      await api.startManualCanonicalScan({ startTurns: [1] });
      await new Promise(resolve => setTimeout(resolve, 900));
      report.standalone = jobState(await api.getCanonicalJobStatus());
      assert.equal(report.standalone.state, 'completed',
        `a standalone scan must still complete (${JSON.stringify(report.standalone)})`);
    } finally {
      await f.r.cleanup();
    }
  }

  // 3. The retry must not mask a real failure: a bad range still fails loudly.
  {
    const f = await fixture();
    try {
      const api = f.r.api;
      let rejected = false;
      try { await api.startManualCanonicalScan({ startTurns: [999] }); }
      catch (error) { rejected = /selected_batch_range_invalid/.test(String(error?.message || error)); }
      report.badRangeRejected = rejected;
      assert.ok(rejected, 'an invalid batch range must still be rejected');
    } finally {
      await f.r.cleanup();
    }
  }

  // 4. A cold start on its own remains a working entry point.
  {
    const f = await fixture();
    try {
      const cold = await f.run();
      await new Promise(resolve => setTimeout(resolve, 800));
      report.coldStartAlone = { completed: cold?.completed ?? null, job: jobState(await f.r.api.getCanonicalJobStatus()) };
      assert.equal(report.coldStartAlone.completed, 1, 'a cold start on its own must still complete');
    } finally {
      await f.r.cleanup();
    }
  }

  console.log(JSON.stringify({ suite: 'libra_scan_after_coldstart', ...report }, null, 1));
  console.log('libra_scan_after_coldstart_test: PASS');
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_scan_after_coldstart_test: FAIL');
  process.exitCode = 1;
});
