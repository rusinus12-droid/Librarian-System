'use strict';
// Correctly drive LIBRA's scan subsystems: cold start, manual scan, failed retry, re-analysis.
//
// The first probe passed {fromTurn, toTurn}, which the runtime ignores — it wants `startTurns` with
// values from completeBatchStarts(pairs) — so the manual scan reported state 'failed' and that said
// nothing about the plugin. This version reads the real batch ranges first and drives the scan with
// what the API actually expects, then reports the job state the plugin itself reports.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_unified_runtime_fixture.cjs'));

const OUT = process.env.LIBRA_SCAN_OUT || '/tmp/libra_scan_probe.json';

const parse = value => {
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
};
const jobSummary = job => {
  const j = parse(job) || {};
  return {
    kind: j.kind || null, state: j.state || null, phase: j.phase || null,
    targetStarts: j.targetStarts || [], completed: j.completed ?? null,
    failed: j.failed ?? null, skipped: j.skipped ?? null,
    currentStage: j.currentStage || '', error: j.error || j.reason || ''
  };
};

(async () => {
  const out = { capturedAt: new Date().toISOString() };
  const f = await fixture();
  try {
    const api = f.r.api;

    // 1. What ranges does the runtime consider scannable?
    // The payload is an OBJECT (libra.batch_selection.v1) whose `ranges` array holds the entries — not
    // a bare array. Treating it as an array yielded availableStarts [], which silently skipped the
    // manual scan and made the subsystem look untested. This shape was measured.
    const ranges = parse(await api.listCanonicalBatchRanges());
    const rangeRows = Array.isArray(ranges) ? ranges : (Array.isArray(ranges?.ranges) ? ranges.ranges : []);
    out.batchRanges = {
      type: Array.isArray(ranges) ? 'array' : typeof ranges,
      schema: ranges?.schema || null,
      observedTurns: ranges?.observedTurns ?? null,
      completeBatches: ranges?.completeBatches ?? null,
      pendingTurns: ranges?.pendingTurns ?? null,
      entries: rangeRows.length,
      sample: JSON.stringify(ranges).slice(0, 600)
    };
    const starts = rangeRows.map(r => Number(r?.startTurn ?? r?.start ?? r)).filter(Boolean);
    out.availableStarts = starts;

    // 2. Cold start with no prior memory — the normal entry point.
    const cold = await api.runManualColdStart();
    out.coldStart = {
      completed: cold?.completed ?? null,
      status: cold?.manifestStatus ?? null,
      memoryCommitted: Boolean(f.getMemory()),
      stateHead: f.getHead()?.schema || null
    };

    // 3. Manual scan, driven with the ranges the runtime itself reports.
    if (starts.length) {
      let scanError = '';
      try {
        await api.startManualCanonicalScan({ startTurns: starts });
      } catch (error) { scanError = `${error?.name}: ${String(error?.message || error).slice(0, 240)}`; }
      const status = jobSummary(await api.getCanonicalJobStatus());
      out.manualScan = { scanError, status };
      // Let the job settle, then read again — a job that is 'preparing' has not failed.
      await new Promise(resolve => setTimeout(resolve, 1500));
      out.manualScan.settled = jobSummary(await api.getCanonicalJobStatus());
      out.manualScan.memoryCountAfter = (await api.getCanonicalMemories({})) ? Object.keys(parse(await api.getCanonicalMemories({})) || {}).length : 0;
    } else {
      out.manualScan = { skipped: 'no complete batch ranges available' };
    }

    // 4. Failed retry with no failures — should be a clean no-op, not an error.
    let retryError = '';
    try { await api.retryFailedMemoryAnalysis(); } catch (error) { retryError = `${error?.name}: ${String(error?.message || error).slice(0, 240)}`; }
    out.failedRetry = { error: retryError, status: jobSummary(await api.getCanonicalJobStatus()) };

    // 5. Re-analysis: regenerate a memory and see whether the record actually changes.
    const before = f.getMemory();
    const beforeId = before?.memoryId || null;
    let regenError = '';
    let regenJob = null;
    try { regenJob = await api.regenerateCanonicalMemory({ resumeJobId: '' }); }
    catch (error) {
      // The API also accepts a plain start turn; try that before recording a failure.
      try { regenJob = await api.regenerateCanonicalMemory(1); }
      catch (error2) { regenError = `${error2?.name}: ${String(error2?.message || error2).slice(0, 240)}`; }
    }
    out.reAnalysis = {
      regenError,
      job: jobSummary(regenJob),
      memoryIdBefore: beforeId,
      memoryStillPresent: Boolean(f.getMemory()),
      memoryIdAfter: f.getMemory()?.memoryId || null,
      revisionAfter: f.getMemory()?.revision ?? null
    };
    // Regeneration is a compare/choose flow: report the variants it produced.
    const variants = await (async () => { try { return parse(await api.listCanonicalVariants({ startTurn: 1 })); } catch (e) { return { error: String(e?.message || e).slice(0, 160) }; } })();
    out.reAnalysis.variants = Array.isArray(variants) ? `array(${variants.length})` : JSON.stringify(variants).slice(0, 400);

    // 6. Job management surface: can a job be cancelled and does status reflect it?
    const cancel = await (async () => { try { return await api.cancelCanonicalJob({}); } catch (e) { return `${e?.name}: ${String(e?.message || e).slice(0, 160)}`; } })();
    out.jobControl = { cancelResult: JSON.stringify(cancel).slice(0, 300), statusAfter: jobSummary(await api.getCanonicalJobStatus()) };

    // 7. Source-edit surface on LIBRA — find the real name.
    const candidates = Object.keys(api).filter(k => /sourceEdit|SourceEdit/i.test(k));
    out.sourceEditApi = { candidates };
    for (const name of candidates) {
      if (typeof api[name] !== 'function' || /set|ignore|mode|rules/i.test(name)) continue;
      try { out.sourceEditApi[name] = JSON.stringify(await api[name]()).slice(0, 400); }
      catch (error) { out.sourceEditApi[name] = `${error?.name}: ${String(error?.message || error).slice(0, 160)}`; }
    }

    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ ok: true, out: OUT, ...out }, null, 1));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
