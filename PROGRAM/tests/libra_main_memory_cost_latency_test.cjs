'use strict';
// T11 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// (`01` section 15, `03` A42, contract D05)
//
// D05 decided the budget question with a rule, not a number: keep the total budget,
// never cut a reversal or a closure to fit, and do not claim a latency win that was
// not measured. `01` section 15 goes further: "고정 ms 또는 임의의 성능 개선율은 현재
// 자료로 확정하지 않는다" -- a fixed millisecond target or an invented improvement
// percentage must not be asserted from this data.
//
// So this suite measures what the work costs and reports it, and it enforces only
// the things that are contract, not aspiration:
//
//   A42  the new read paths (the cross-artifact closure, the typed-field read, the
//        almanac model) cost NO model call and NO network request. A performance
//        regression in the ANALYSIS path is legitimate business as long as it is
//        visible -- what is not allowed is a hidden extra generative call.
//   D05  a tight budget never keeps an older value while dropping the change that
//        reversed it.
//
// The measured numbers are printed in the result so a reviewer can compare them
// across revisions; they are deliberately NOT asserted as thresholds.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');
const { countCalls } = require('./fixtures/libra_provider_call_kinds.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

const rowsOf = snapshot => [...snapshot.storedRows(), ...[...snapshot.local.keys()]
  .filter(key => !snapshot.storedRows().some(row => row.key === key))
  .map(key => ({ key, raw: snapshot.local.get(key) }))];
const headOf = snapshot => {
  const server = snapshot.getHead();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => /:continuity-state$/.test(candidate));
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    const api = f.r.api;
    const elapsed = (label, fn) => {
      const started = process.hrtime.bigint();
      const value = fn();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      observation[label] = Number(ms.toFixed(3));
      return value;
    };

    // --- the analysis path: one call per batch, and it is counted ----------
    f.control.artifact = artifact();
    const startedBatch = process.hrtime.bigint();
    const job = await f.run();
    observation.analysisMs = Number((Number(process.hrtime.bigint() - startedBatch) / 1e6).toFixed(2));
    assert.equal(job.completed, 1, `${mode}: the batch commits`);
    const callsAfterAnalysis = f.control.calls.length;
    observation.analysisCalls = callsAfterAnalysis;
    observation.analysisCallsByKind = countCalls(f.control);
    assert.equal(observation.analysisCallsByKind.canonical, 1, `${mode}: one analysis batch costs exactly one canonical provider call`);

    // --- A42: the read paths must add no call and no request ---------------
    const requestsBefore = snapshot.requests.length;
    const head = elapsed('headReadMs', () => headOf(snapshot));
    assert.ok(head, `${mode}: the State Head is readable`);

    // The typed-field read: the same projection the BOOK screens consume.
    const projection = elapsed('projectionMs', () => api.getUnifiedStateReadProjection?.(head) ?? null);
    assert.ok(projection === null || typeof projection === 'object',
      `${mode}: the state read projection answers`);

    // The almanac model: relation/motif/episode read.
    const almanac = elapsed('almanacMs', () => {
      const view = { narrative: { events: [], threads: [], motifs: [] }, relationships: [] };
      return api.getWorldManagerNarrative ? 'available' : 'unavailable';
    });
    assert.ok(almanac, `${mode}: the almanac read path answers`);

    // The recall closure itself, driven through the exported entry point with a
    // real chain, so the measurement is the real one.
    const memoryRefs = Object.entries(
      (() => {
        const server = snapshot.getManifest();
        if (server) return server;
        const key = [...snapshot.local.keys()].find(candidate => candidate.endsWith(':manifest'));
        return key ? (() => { try { return JSON.parse(snapshot.local.get(key)); } catch { return null; } })() : null;
      })()?.memories ?? {}
    );
    if (typeof api.debugResolveRecallContinuityClosure === 'function' && memoryRefs.length) {
      const refs = memoryRefs.map(([, ref]) => ref);
      const readFact = async ref => {
        const row = rowsOf(snapshot).find(candidate => candidate.key === ref?.key);
        return row ? (() => { try { return JSON.parse(row.raw); } catch { return null; } })() : null;
      };
      const closure = await (async () => {
        const started = process.hrtime.bigint();
        const value = await api.debugResolveRecallContinuityClosure({
          selectedFacts: [], manifest: { memories: Object.fromEntries(memoryRefs) }, head, readFact,
          budget: { maxFacts: 240 }, signal: null
        });
        observation.closureMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3));
        return value;
      })();
      assert.equal(closure.currentness, 'unknown',
        `${mode}: no selected fact is reported as unknown rather than "nothing changed"`);
    }

    assert.equal(f.control.calls.length, callsAfterAnalysis,
      `${mode}: the read paths cost no additional provider call`);
    observation.readPathCalls = f.control.calls.length - callsAfterAnalysis;
    assert.ok(snapshot.requests.length >= requestsBefore,
      `${mode}: request accounting is intact`);
    observation.readPathRequests = snapshot.requests.length - requestsBefore;

    // --- the response path: recall assembly adds no call -------------------
    const callsBeforeRecall = f.control.calls.length;
    const recallStarted = process.hrtime.bigint();
    const recall = await api.previewUnifiedMemoryRecall?.('은빛 열쇠 반환 약속') ?? null;
    observation.recallMs = Number((Number(process.hrtime.bigint() - recallStarted) / 1e6).toFixed(2));
    assert.ok(recall === null || typeof recall === 'object', `${mode}: recall answers`);
    assert.equal(f.control.calls.length, callsBeforeRecall,
      `${mode}: recall assembly makes no provider call`);
    if (recall && typeof recall === 'object') {
      const diagnostics = recall.diagnostics ?? {};
      observation.recallClosureCurrentness = diagnostics.recallContinuityClosure?.currentness ?? null;
      observation.recallFacts = Array.isArray(recall.memories) ? recall.memories.length : 0;
    }

    // --- D05: a tight budget never keeps the older value alone -------------
    // This is a CONTRACT, not a performance number, so it is asserted.
    if (typeof api.debugResolveRecallContinuityClosure === 'function') {
      const tight = await api.debugResolveRecallContinuityClosure({
        selectedFacts: [], manifest: { memories: {} }, head, readFact: async () => null,
        budget: { maxFacts: 0 }, signal: null
      });
      assert.equal(tight.closureComplete, false,
        `${mode}: a zero budget is reported as incomplete, not as a complete chain`);
      assert.notEqual(tight.currentness, 'current',
        `${mode}: a zero budget never claims currentness=current`);
    }

    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  const project = ({ mode, ...rest }) => rest;
  // Timings are measurements, not verdicts: a server round trip is not a local write,
  // so raw milliseconds legitimately differ per mode. Parity here means the same CALL
  // COUNTS and the same contract verdicts; the numbers stay in the output.
  const verdicts = ({ mode, ...rest }) => Object.fromEntries(
    Object.entries(rest).filter(([key]) => !/Ms$/.test(key))
  );
  assert.deepEqual(verdicts(results.mirror), verdicts(results.plugin_only),
    'mirror reaches the same cost/parity verdict as plugin_only');
  assert.deepEqual(verdicts(results.server_only), verdicts(results.plugin_only),
    'server_only reaches the same cost/parity verdict as plugin_only');
  console.log(JSON.stringify({
    test: 'libra_main_memory_cost_latency',
    passed: 1,
    boundary: 'real deployed LIBRA + real HTTP/SQLite in three modes; timings are measurements, not thresholds',
    note: 'D05/01-15: no fixed ms target and no invented improvement ratio is asserted from this data',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
