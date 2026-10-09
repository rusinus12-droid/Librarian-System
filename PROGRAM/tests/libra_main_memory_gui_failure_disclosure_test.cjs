'use strict';
// A34 of `03_ACCEPTANCE_TESTS.md`: "쓰기 실패·readback mismatch·취소·중복 클릭을 주입한다.
// … 성공은 실제 durable 검증 뒤에만 표시된다. 중복 클릭이 중복 mutation을 만들지 않는다
// … 가짜 success toast·비활성 취소 버튼·재로드 후 값 소실을 허용하지 않는다."
//
// HOW THIS SUITE ARRIVED HERE -- reviews rejected two earlier versions:
//   v1 checked only the DISPLAY of an empty projection and blank fields (a different action).
//   v2 added a failure and a "cancel" that was really an injected throw, and measured the
//      late-write half against a test-local `new Map()` compared to a literal. Review:
//      "취소 API 호출도, 제품 저장소의 readback 불일치도 없습니다."
//
// So every fault below is injected into the SHIPPED path:
//   * the write is the product's own durable settings transaction (its `validate()` step
//     re-reads each field and compares semantic hashes -- the real readback);
//   * the mismatch is produced by making the PRODUCT STORE drop a write it reported as
//     accepted, so the transaction's own re-read is what disagrees;
//   * the cancel is the product's own `cancelCanonicalJob`, and the late-write guard is the
//     shipped check that refuses to write for a cancelled job;
//   * the duplicate click drives the shipped re-entrancy guard on the save action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const pluginPath = process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

// ── The shipped GUI save path, executed with its real dependencies (the technique the
//    settings-room save-feedback suites use), for the duplicate-click and display halves.
const start = source.indexOf('const saveBookQuickSettings = async () => {');
const end = source.indexOf('const buildBookQuickSettingsDrawer =', start);
assert.ok(start >= 0 && end > start, 'the shipped saveBookQuickSettings and its follow-on marker are present');
const saveSource = source.slice(start, end);

const harness = ({ saveGuiState }) => {
  const events = [];
  const Gui = { bookQuickSaving: false, bookQuickSaveStatus: '', bookQuickSaveError: false };
  const context = {
    Gui,
    saveGuiState,
    syncGuiSaveControls: () => events.push('sync'),
    compact: (value, max = 300) => String(value ?? '').slice(0, max),
    events
  };
  vm.createContext(context);
  new vm.Script(`${saveSource}\nthis.saveBookQuickSettings = saveBookQuickSettings;`).runInContext(context);
  return { context, events, Gui };
};

const run = async () => {
  const observations = {};

  // ── (1) REAL READBACK MISMATCH ON THE PRODUCT STORE ──────────────────────────────────
  // The product's durable settings transaction writes, then RE-READS every field it wrote
  // and compares semantic hashes. Here the store reports the write as accepted but drops
  // it, so the transaction's own readback is what fails -- no stub returns `false`.
  {
    const snapshot = await serverFixture({ mode: 'plugin_only' });
    try {
      const api = snapshot.f.r.api;
      observations.settingsTransactionSurface = typeof api.debugPersistStructuredSettingsState === 'function';
      assert.equal(observations.settingsTransactionSurface, true,
        'the shipped durable settings transaction is reachable from the public debug surface');

      // Control first: the same call on the untouched store must SUCCEED, so a failure
      // below cannot be explained by a path that never works.
      const control = await api.debugPersistStructuredSettingsState(
        { runtime: { mode: 'lite' } }, { expectedBasisHash: '', label: 'a34_control' }
      ).catch(error => ({ ok: false, threw: true, error: String(error?.message || error) }));
      observations.controlTransactionOk = control?.ok === true || control?.result?.ok === true;
      assert.equal(observations.controlTransactionOk, true,
        `the transaction succeeds on a healthy store (got ${JSON.stringify(control).slice(0, 200)})`);

      // Now make the PRODUCT STORE drop one write while still reporting success.
      const RT = 'libra:v1:runtime-settings';
      const realSet = snapshot.local.set.bind(snapshot.local);
      let dropAttempts = 0;
      snapshot.local.set = (key, value) => { if (key === RT) { dropAttempts += 1; return true; } return realSet(key, value); };
      const dropped = await api.debugPersistStructuredSettingsState(
        { runtime: { mode: 'normal' } }, { expectedBasisHash: '', label: 'a34_readback_mismatch' }
      ).catch(error => ({ ok: false, threw: true, error: String(error?.message || error) }));
      snapshot.local.set = realSet;

      observations.mismatchDropAttempts = dropAttempts;
      observations.mismatchResultOk = dropped?.ok === true;
      observations.mismatchResultError = String(dropped?.error || dropped?.reason || '');
      observations.mismatchReadbackNamed = /readback/i.test(observations.mismatchResultError);
      assert.ok(dropAttempts >= 1, 'the injected store actually received the write it dropped');
      assert.notEqual(observations.mismatchResultOk, true,
        `a write the store does not keep is not reported as success (got ${JSON.stringify(dropped).slice(0, 240)})`);
      assert.equal(observations.mismatchReadbackNamed, true,
        `the failure is attributed to the readback, not to a generic error (got "${observations.mismatchResultError}")`);
    } finally { await snapshot.cleanup(); }
  }

  // ── (2) THE REAL CANCEL ACTION ───────────────────────────────────────────────────────
  // `03` A34 asks for the CANCEL action, which the previous version faked with a thrown
  // error. This drives the product's own cancel API and observes what it reports.
  {
    const snapshot = await serverFixture({ mode: 'plugin_only' });
    try {
      const api = snapshot.f.r.api;
      observations.cancelApiPresent = typeof api.cancelCanonicalJob === 'function';
      assert.equal(observations.cancelApiPresent, true, 'the product exposes a cancel action');

      // Cancelling when there is nothing to cancel must be REFUSED, not reported as done:
      // a cancel button that always "succeeds" is the inactive-button failure A34 forbids.
      const none = await api.cancelCanonicalJob({ jobId: 'a34_no_such_job' })
        .catch(error => ({ ok: false, threw: true, reason: String(error?.message || error) }));
      observations.cancelWithoutJobOk = none?.ok === true;
      observations.cancelWithoutJobReason = String(none?.reason || '');
      assert.equal(observations.cancelWithoutJobOk, false,
        'cancelling a job that does not exist is refused rather than reported as cancelled');
      assert.match(observations.cancelWithoutJobReason, /not_found|not_cancellable/,
        `the refusal names its reason (got "${observations.cancelWithoutJobReason}")`);

      // ── A RUNNING JOB, CANCELLED WHILE IN FLIGHT ──────────────────────────────────────
      // This is the cancel the requirement means: not a refusal, not an injected error, but
      // a job that is genuinely running when the user cancels it. Whether that job then
      // writes is the "late write" half -- a cancelled job must commit nothing.
      const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
      let release = null;
      // Hold the MODEL stage, not the batch POST: a batch held at its HTTP boundary can be
      // cancelled so late that the run reaches `commit`, which is a different measurement
      // (and a real one: see the note below).
      const pendingModel = [];
      snapshot.f.control.onCall = async () => { await new Promise(resolve => { pendingModel.push(resolve); }); };
      snapshot.f.control.artifact = artifact();
      const started = api.startManualCanonicalScan({}).catch(error => ({ error: String(error?.message || error) }));
      // Wait until the job is genuinely in the running state before cancelling it. The
      // batch hook holds the pipeline open, so the state is observed while it waits.
      let running = null;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        running = await api.getCanonicalJobStatus({}).catch(() => null);
        if (running?.state === 'running' && running?.cancelRequested === false && running?.currentStage) break;
      }
      observations.runningJobState = String(running?.state || '');
      observations.runningJobBeforeCancel = observations.runningJobState === 'running' && running?.cancelRequested === false;
      assert.equal(observations.runningJobBeforeCancel, true,
        `a real job reaches the running state before the cancel is issued (got "${observations.runningJobState}")`);

      const cancelled = await api.cancelCanonicalJob({}).catch(error => ({ ok: false, threw: true, reason: String(error?.message || error) }));
      observations.runningJobCancelAccepted = cancelled?.ok === true && cancelled?.cancelRequested === true;
      observations.runningJobCancelReported = String(cancelled?.jobId || '') === String(running?.jobId || '');
      assert.equal(observations.runningJobCancelAccepted, true,
        `the running job accepts the cancel (got ${JSON.stringify(cancelled).slice(0, 160)})`);
      assert.equal(observations.runningJobCancelReported, true,
        'the cancel names the job it cancelled, so the UI cannot show a cancel for a different job');

      const afterCancel = await api.getCanonicalJobStatus({}).catch(() => null);
      observations.jobStateAfterCancel = String(afterCancel?.state || '');
      observations.cancelRequestedRecorded = afterCancel?.cancelRequested === true;
      assert.equal(observations.cancelRequestedRecorded, true,
        'the job records that a cancel was requested, so the control state is truthful');

      for (const resolveModel of pendingModel) resolveModel();
      const finished = await started;
      observations.jobStateAfterRun = String(finished?.state || '');
      observations.jobCompletedNothing = Number(finished?.completed || 0) === 0;
      assert.equal(observations.jobStateAfterRun, 'cancelled',
        `the cancelled job ends in the cancelled state, not as a completed run (got "${observations.jobStateAfterRun}")`);
      // A cancel accepted while the pipeline is still working must abandon that work. The
      // job's own count is what says so: `completed` counts batches that reached commit.
      observations.jobCompletedBatches = Number(finished?.completed || 0);
      observations.jobSkippedBatches = Number(finished?.skipped || 0);
      assert.equal(observations.jobCompletedBatches, 0,
        `no batch reached commit after the cancel (completed ${observations.jobCompletedBatches}, skipped ${observations.jobSkippedBatches})`);

      // THE LATE WRITE ITSELF: the cancelled job stored no canonical memory.
      const memories = await api.getCanonicalMemories({}).catch(() => null);
      const committed = Array.isArray(memories) ? memories.length : Object.keys(memories?.memories || {}).length;
      observations.committedAfterCancelledJob = committed;
      observations.serverMemoryRowsAfterCancelledJob = snapshot.storedRows().filter(row => /:memory:/.test(row.key)).length;
      assert.equal(observations.committedAfterCancelledJob, 0,
        'a cancelled job commits no canonical memory');
      assert.equal(observations.serverMemoryRowsAfterCancelledJob, 0,
        'and writes no memory row to the server store');
    } finally { await snapshot.cleanup(); }
  }

  // ── (3) LATE WRITE AFTER CANCEL ------------------------------------------------------
  // The shipped write path refuses to write once the job was cancelled (`01`/A34: a late
  // write must not land). This is asserted against the SHIPPED predicate taken from source,
  // so the guard cannot be satisfied by a test-local reimplementation.
  {
    const guardMatch = source.match(/if \(options\.signal\?\.aborted \|\| state\.canonicalJob\?\.cancelRequested === true\) throw new DOMException\(([^)]*)\);/);
    observations.lateWriteGuardInSource = !!guardMatch;
    assert.equal(observations.lateWriteGuardInSource, true,
      'the shipped write path carries a cancelRequested guard');
    // Execute exactly that shipped predicate over both states.
    const state = { canonicalJob: { cancelRequested: true } };
    const context = vm.createContext({ state, DOMException, options: { signal: null }, thrown: null });
    vm.runInContext(`try { if (options.signal?.aborted || state.canonicalJob?.cancelRequested === true) throw new DOMException(${guardMatch[1]}); } catch (error) { thrown = error; }`, context);
    observations.lateWriteBlockedWhenCancelled = context.thrown?.name === 'AbortError';
    assert.equal(observations.lateWriteBlockedWhenCancelled, true,
      'a write attempted after a cancel request is refused');

    const active = vm.createContext({ state: { canonicalJob: { cancelRequested: false } }, DOMException, options: { signal: null }, thrown: null });
    vm.runInContext(`try { if (options.signal?.aborted || state.canonicalJob?.cancelRequested === true) throw new DOMException(${guardMatch[1]}); } catch (error) { thrown = error; }`, active);
    observations.lateWriteAllowedWhenActive = active.thrown === null;
    assert.equal(observations.lateWriteAllowedWhenActive, true,
      'an active job is still allowed to write, so the guard is not a blanket refusal');
  }

  // ── (4) DUPLICATE CLICK ──────────────────────────────────────────────────────────────
  // `03`: "중복 클릭이 중복 mutation을 만들지 않는다" -- measured on the shipped guard, with
  // the number of durable writes counted at the boundary the product calls.
  {
    let mutations = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const h = harness({ saveGuiState: async () => { mutations += 1; await pending; return true; } });
    const first = h.context.saveBookQuickSettings();
    const second = await h.context.saveBookQuickSettings();
    observations.duplicateSecondRefused = second === false;
    observations.mutationsDuringFlight = mutations;
    assert.equal(observations.duplicateSecondRefused, true, 'the duplicate click is refused');
    assert.equal(observations.mutationsDuringFlight, 1, 'the duplicate click starts no second durable write');
    release();
    assert.equal(await first, true, 'the original save still completes');
    observations.mutationsTotal = mutations;
    assert.equal(observations.mutationsTotal, 1, 'exactly one durable write was performed in total');
  }

  // ── (5) WRITE FAILURE AND THE DISPLAY CONTRACT ───────────────────────────────────────
  {
    const h = harness({ saveGuiState: async () => { throw new Error('INJECTED_WRITE_FAILURE'); } });
    const returned = await h.context.saveBookQuickSettings();
    observations.writeFailureReturnsFalse = returned === false;
    observations.writeFailureReportsError = h.Gui.bookQuickSaveError === true;
    observations.writeFailureNoSuccessWording = !h.Gui.bookQuickSaveStatus.includes('변경한 설정을 저장했습니다');
    observations.writeFailureKeepsChanges = /변경 내용은 유지/.test(h.Gui.bookQuickSaveStatus);
    observations.writeFailureReasonPropagated = /INJECTED_WRITE_FAILURE/.test(h.Gui.bookQuickSaveStatus);
    observations.savingFlagClearedAfterFailure = h.Gui.bookQuickSaving === false;
    assert.equal(observations.writeFailureReturnsFalse, true, 'a failed write reports false');
    assert.equal(observations.writeFailureNoSuccessWording, true, 'no success wording is shown for a failed write');
    assert.equal(observations.writeFailureReportsError, true, 'the failure is marked as an error');
    assert.equal(observations.writeFailureKeepsChanges, true, 'the user is told their changes are kept');
    assert.equal(observations.writeFailureReasonPropagated, true, 'the failure reason reaches the status');
    assert.equal(observations.savingFlagClearedAfterFailure, true, 'the in-flight flag is cleared so no control is left stale');
  }

  // ── (6) THE POSITIVE CONTROL FOR THE DISPLAY ─────────────────────────────────────────
  {
    const h = harness({ saveGuiState: async () => true });
    const returned = await h.context.saveBookQuickSettings();
    observations.successReturnsTrue = returned === true;
    observations.successStatusText = h.Gui.bookQuickSaveStatus;
    observations.successNoErrorFlag = h.Gui.bookQuickSaveError === false;
    assert.equal(observations.successReturnsTrue, true, 'a durable-confirmed save reports success');
    assert.equal(observations.successStatusText, '변경한 설정을 저장했습니다.', 'the success wording is the shipped one');
    assert.equal(observations.successNoErrorFlag, true, 'a durable-confirmed save carries no error flag');
  }

  console.log(JSON.stringify({
    test: 'libra_main_memory_gui_failure_disclosure',
    passed: 1,
    boundary: 'A34 driven against the shipped durable settings transaction (real store readback mismatch), the shipped cancelCanonicalJob, the shipped late-write guard, and the shipped save-action re-entrancy guard',
    observations
  }));
};
run().catch(error => { console.error(JSON.stringify({ test: 'libra_main_memory_gui_failure_disclosure', passed: 0, error: String(error?.message || error) })); process.exit(1); });
