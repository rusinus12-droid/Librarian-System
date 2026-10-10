'use strict';
// Subsystem verification: source-edit review, cold start, re-analysis, and Flashback state recovery.
//
// The standard this holds itself to is the one this session established: a subsystem is "working" only
// if driving it produces an observable effect (state written, job status moved, memory produced), not
// because an API exists or a string is present in the source. Every section reports the real outcome,
// including "not run" and "no effect" when that is the truth.
const fs = require('node:fs');
const path = require('node:path');
const PROGRAM = path.resolve(__dirname, '..');
const OUT = process.env.SUBSYSTEM_OUT || '/tmp/subsystem_probe.json';

const libraFixture = require(path.join(PROGRAM, 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));
const hayakuHarness = require(path.join(PROGRAM, 'tests', 'fixtures', 'hayaku_runtime_harness.cjs'));
const flashbackFixture = require(path.join(PROGRAM, 'tests', 'fixtures', 'flashback_native_runtime_fixture.cjs'));

const out = { capturedAt: new Date().toISOString() };
const attempt = async (fn, label) => {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, error: `${error?.name}: ${String(error?.message || error).slice(0, 260)}`, label }; }
};
const count = value => Array.isArray(value) ? value.length
  : value && typeof value === 'object' ? Object.keys(value).length : (value == null ? 0 : 1);

// =================================================================================================
// LIBRA — source-edit review, cold start, re-analysis
// =================================================================================================
const probeLibra = async () => {
  const f = await libraFixture.fixture();
  const result = {};
  try {
    const api = f.r.api;

    // --- Cold start: does it actually produce committed memory? ---------------------------------
    const cold = await attempt(() => f.run(), 'coldStart');
    result.coldStart = cold.ok ? {
      completed: cold.value?.completed ?? null,
      status: cold.value?.manifestStatus || null,
      memoryCommitted: Boolean(f.getMemory()),
      stateHead: f.getHead()?.schema || null
    } : { error: cold.error };
    const firstMemoryId = f.getMemory()?.memoryId || null;
    result.coldStart.memoryId = firstMemoryId;

    // --- Re-analysis: regenerateCanonicalMemory must change the stored record --------------------
    result.reAnalysis = {};
    if (firstMemoryId) {
      const before = JSON.stringify(f.getMemory()?.canonicalArtifact || {}).length;
      const regen = await attempt(() => api.regenerateCanonicalMemory(1), 'regenerate');
      const after = f.getMemory();
      result.reAnalysis = regen.ok ? {
        called: true,
        returnedKeys: Object.keys(regen.value || {}).slice(0, 12),
        memoryStillPresent: Boolean(after),
        memoryIdChanged: String(after?.memoryId || '') !== String(firstMemoryId),
        artifactCharsBefore: before,
        artifactCharsAfter: JSON.stringify(after?.canonicalArtifact || {}).length,
        revision: after?.revision ?? null
      } : { error: regen.error };
    }

    // --- Source-edit review: what does it see, and does it report a usable verdict? --------------
    const edits = await attempt(() => api.reviewLibraSourceEdits(), 'reviewSourceEdits');
    result.sourceEditReview = edits.ok ? {
      returnedType: Array.isArray(edits.value) ? 'array' : typeof edits.value,
      entries: count(edits.value),
      keys: edits.value && !Array.isArray(edits.value) ? Object.keys(edits.value).slice(0, 14) : [],
      sample: JSON.stringify(edits.value).slice(0, 500)
    } : { error: edits.error };

    // --- Batch ranges / job status: is the scan job surface live? --------------------------------
    const ranges = await attempt(() => api.listCanonicalBatchRanges(), 'listCanonicalBatchRanges');
    const jobs = await attempt(() => api.listCanonicalJobs(), 'listCanonicalJobs');
    const status = await attempt(() => api.getCanonicalJobStatus(), 'getCanonicalJobStatus');
    result.scanSurface = {
      ranges: ranges.ok ? count(ranges.value) : ranges.error,
      jobs: jobs.ok ? count(jobs.value) : jobs.error,
      status: status.ok ? JSON.stringify(status.value).slice(0, 300) : status.error
    };

    // --- Manual scan: does startManualCanonicalScan move the job status? -------------------------
    const manual = await attempt(() => api.startManualCanonicalScan({ fromTurn: 1, toTurn: 5 }), 'startManualCanonicalScan');
    const statusAfter = await attempt(() => api.getCanonicalJobStatus(), 'getCanonicalJobStatus');
    result.manualScan = {
      started: manual.ok,
      error: manual.ok ? '' : manual.error,
      statusAfter: statusAfter.ok ? JSON.stringify(statusAfter.value).slice(0, 300) : statusAfter.error,
      memoryCountBefore: 1,
      memoryCountAfter: (await attempt(() => api.getCanonicalMemories({ startTurn: 1, endTurn: 5 }), 'getCanonicalMemories')).value
        ? count((await api.getCanonicalMemories({ startTurn: 1, endTurn: 5 }))) : null
    };

    // --- retryFailedMemoryAnalysis: does it exist and report a real state? -----------------------
    const retry = await attempt(() => api.retryFailedMemoryAnalysis(), 'retryFailedMemoryAnalysis');
    result.retryFailedAnalysis = retry.ok
      ? { returned: JSON.stringify(retry.value).slice(0, 300) }
      : { error: retry.error };
  } finally {
    await f.r.cleanup();
  }
  return result;
};

// =================================================================================================
// HAYAKU — source-edit review, cold start / recovery
// =================================================================================================
const probeHayaku = async () => {
  const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
  const runtime = await hayakuHarness.createHayakuRuntime({
    messages: [
      user('u1', 'I turn the brass valve on the blue pipe.'),
      user('u2', 'I close it again and check the pressure reading.')
    ]
  });
  const result = {};
  try {
    const api = runtime.hayaku;

    // --- Source-edit surface: rules, ignored tags, review ---------------------------------------
    const rules = await attempt(() => api.getSourceEditRules?.(), 'getSourceEditRules');
    const setRules = await attempt(() => api.setSourceEditRules?.([{ id: 'probe', pattern: 'valve', replacement: '' }]), 'setSourceEditRules');
    const ignored = await attempt(() => api.getSourceEditIgnoredTags?.(), 'getSourceEditIgnoredTags');
    const review = await attempt(() => api.reviewSourceEdits?.(), 'reviewSourceEdits');
    const syncStatus = await attempt(() => api.getSourceEditSyncStatus?.(), 'getSourceEditSyncStatus');
    const trackingMode = await attempt(() => api.setSourceEditTrackingMode?.('track'), 'setSourceEditTrackingMode');
    result.sourceEdit = {
      rulesReturnType: rules.ok ? (Array.isArray(rules.value) ? `array(${rules.value.length})` : typeof rules.value) : rules.error,
      setRulesOk: setRules.ok ? setRules.value !== false : setRules.error,
      ignoredTags: ignored.ok ? count(ignored.value) : ignored.error,
      reviewType: review.ok ? (Array.isArray(review.value) ? `array(${review.value.length})` : typeof review.value) : review.error,
      reviewSample: review.ok ? JSON.stringify(review.value).slice(0, 400) : '',
      syncStatus: syncStatus.ok ? JSON.stringify(syncStatus.value).slice(0, 300) : syncStatus.error,
      trackingModeOk: trackingMode.ok ? trackingMode.value !== false : trackingMode.error
    };

    // --- Cold start / recovery surface ----------------------------------------------------------
    const recovery = api.recovery || {};
    result.recoverySurface = {
      keys: Object.keys(recovery).slice(0, 24)
    };
    for (const name of ['coldStart', 'recover', 'runRecovery', 'coldStartRecovery', 'audit']) {
      if (typeof recovery[name] !== 'function') continue;
      const run = await attempt(() => recovery[name](), `recovery.${name}`);
      result.recoverySurface[name] = run.ok
        ? { returned: JSON.stringify(run.value).slice(0, 400) }
        : { error: run.error };
    }
    result.ledgerKeys = api.ledger ? Object.keys(api.ledger).slice(0, 20) : [];
    result.packetKeys = api.packet ? Object.keys(api.packet).slice(0, 20) : [];

    // --- Does the real hook path run and store anything? ----------------------------------------
    const before = await attempt(() => runtime.callBeforeRequest(runtime.chat.messages, 'model'), 'beforeRequest');
    const after = await attempt(() => runtime.callAfterRequest('The needle settles at 4.2 bar.', 'model'), 'afterRequest');
    result.hooks = {
      beforeOk: before.ok, beforeType: before.ok ? (Array.isArray(before.value) ? `array(${before.value.length})` : typeof before.value) : before.error,
      afterOk: after.ok, afterError: after.ok ? '' : after.error,
      storedKeys: Array.from(runtime.pluginStorage.values.keys()).map(k => k.slice(0, 60))
    };
  } finally {
    await runtime.dispose();
  }
  return result;
};

// =================================================================================================
// Flashback — cold start, re-analysis (rebuild), and STATE RECOVERY specifically
// =================================================================================================
const probeFlashback = async () => {
  const f = await flashbackFixture.createFixture({});
  const result = {};
  const cleanup = f.dispose || f.cleanup || (() => {});
  try {
    const api = f.api;

    // --- State recovery: handoff adoption and restore validation --------------------------------
    result.stateRecovery = {};
    for (const [label, fn] of [
      ['adoptSessionHandoff', () => api.adoptSessionHandoff()],
      ['validatePluginStorageRestore', () => api.validatePluginStorageRestore()],
      ['restoreLegacyCompactedSource', () => api.restoreLegacyCompactedSource()],
      ['debugState', () => api.debugState()],
      ['getCaptureBackendState', () => api.getCaptureBackendState()]
    ]) {
      const run = await attempt(fn, label);
      result.stateRecovery[label] = run.ok
        ? { returned: JSON.stringify(run.value).slice(0, 400) }
        : { error: run.error };
    }

    // --- Cold start: ingestLiveChatColdStart ----------------------------------------------------
    const cold = await attempt(() => api.ingestLiveChatColdStart(), 'ingestLiveChatColdStart');
    result.coldStart = cold.ok
      ? { returned: JSON.stringify(cold.value).slice(0, 400), storedKeys: Array.from(f.pluginStorage.values.keys()).length }
      : { error: cold.error };

    // --- Re-analysis: rebuildCurrentChatMemory / rebuildEpisodeIndex ----------------------------
    result.reAnalysis = {};
    for (const [label, fn] of [
      ['rebuildCurrentChatMemory', () => api.rebuildCurrentChatMemory()],
      ['rebuildEpisodeIndex', () => api.rebuildEpisodeIndex()]
    ]) {
      const run = await attempt(fn, label);
      result.reAnalysis[label] = run.ok
        ? { returned: JSON.stringify(run.value).slice(0, 400) }
        : { error: run.error };
    }

    // --- Manual editor surface ------------------------------------------------------------------
    const list = await attempt(() => api.listManualEditorRecords(), 'listManualEditorRecords');
    result.manualEditor = list.ok ? { entries: count(list.value), sample: JSON.stringify(list.value).slice(0, 300) } : { error: list.error };

    result.finalStorageKeys = Array.from(f.pluginStorage.values.keys()).map(k => k.slice(0, 70));
  } finally {
    await cleanup();
  }
  return result;
};

(async () => {
  out.libra = await attempt(probeLibra, 'libra');
  out.hayaku = await attempt(probeHayaku, 'hayaku');
  out.flashback = await attempt(probeFlashback, 'flashback');
  const payload = JSON.parse(JSON.stringify(out, (k, v) => (typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}…` : v)));
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log(JSON.stringify({
    ok: true, out: OUT,
    libra: payload.libra?.ok === false ? { error: payload.libra.error } : payload.libra?.value,
    hayaku: payload.hayaku?.ok === false ? { error: payload.hayaku.error } : payload.hayaku?.value,
    flashback: payload.flashback?.ok === false ? { error: payload.flashback.error } : payload.flashback?.value
  }, null, 1));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
