'use strict';
// Task 24 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// LIBRA-ARIADNE-ITO-PIPELINE (D2) is `unverified` for `mirror` and `server_only`.
// The claim to prove: **the storage mode must never change whether a pipeline
// stage "succeeded"**.
//
// IMPORTANT — the plan's Task 24 text is stale and this test does not pretend
// otherwise. It names `executeUnifiedStage` with the stage chain
// `Ariadne → Character ito → World ito → Plot ito`. Those stage ids are now
// RETIRED (`RETIRED_MEMORY_STAGE_IDS`), `STAGE_ORDER` is `['librarian']`, and
// `executeUnifiedStage` is not reachable from the public API. Verified here, in
// every mode: all four ids reject with `LEGACY_ANALYZER_RETIRED`.
//
// So this test asserts the modern equivalent, which is what the feature now is:
//
//   success chain   : the enabled stage ('librarian') commits a complete canonical
//                     and a ready State Head in the same verdict in all 3 modes
//   fail-soft       : hard provider failure  -> NO memory committed (Ariadne
//                     equivalent discards the whole memory; the batch fails)
//                     invalid evidence      -> memory committed, pipelineStatus
//                     `partial` (the surviving facts are kept, not discarded)
//   retirement      : every retired stage id is rejected identically in all 3 modes
//
// Storage contract per mode: plugin_only sends zero owner-data batches,
// server_only keeps zero owner canonical keys locally, mirror keeps local copies
// byte-identical to the server.
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const MODES = ['plugin_only', 'mirror', 'server_only'];
const RETIRED = ['ariadne', 'character_ito', 'world_ito', 'plot_ito'];
const CANONICAL_KEY = /:memory:\d+:r\d+$/;
const MANIFEST_KEY = /:manifest$/;
const HEAD_KEY = /:continuity-state$/;

// Owner data lives in different authorities per mode, so read through whichever
// one the mode actually uses rather than from one hard-coded store.
const localJson = (snapshot, matcher) => {
  const key = [...snapshot.local.keys()].find(matcher);
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const manifestOf = snapshot => snapshot.getManifest() || localJson(snapshot, k => MANIFEST_KEY.test(k));
const memoryOf = (snapshot, start = 1) => {
  const server = snapshot.getMemory(start);
  if (server) return server;
  const ref = manifestOf(snapshot)?.memories?.[String(start)];
  if (!ref?.key) return null;
  const raw = snapshot.local.get(ref.key);
  return raw ? JSON.parse(raw) : null;
};
const headOf = snapshot => snapshot.getHead() || localJson(snapshot, k => HEAD_KEY.test(k));
const localOwnerKeys = snapshot => [...snapshot.local.keys()].filter(key => CANONICAL_KEY.test(key) || MANIFEST_KEY.test(key)).sort();
const serverOwnerKeys = snapshot => snapshot.storedRows().filter(row => CANONICAL_KEY.test(row.key) || MANIFEST_KEY.test(row.key)).map(row => row.key).sort();

// Some LIBRA maintenance writes are intentionally detached from the caller that
// scheduled them. In mirror mode, wait for those same-key commit/readback tails
// to settle before checking the storage contract. Keep the timeout bounded and
// preserve full JSON equality so a genuinely stale mirror still fails clearly.
async function waitForMirrorConvergence(snapshot, timeoutMs = 5000, stableMs = 40) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  let last = null;
  while (Date.now() < deadline) {
    const serverKeys = serverOwnerKeys(snapshot);
    const localKeys = localOwnerKeys(snapshot);
    const serverRows = snapshot.storedRows().filter(row => CANONICAL_KEY.test(row.key) || MANIFEST_KEY.test(row.key));
    const byKey = new Map(serverRows.map(row => [row.key, row]));
    const mismatches = serverRows.flatMap(row => {
      const raw = snapshot.local.get(row.key);
      try {
        return raw !== undefined && isDeepStrictEqual(JSON.parse(raw), row.value)
          ? [] : [{ key:row.key, server:row.value, local:raw === undefined ? null : (() => { try { return JSON.parse(raw); } catch { return raw; } })() }];
      } catch {
        return [{ key:row.key, server:row.value, local:raw === undefined ? null : raw }];
      }
    });
    const localOnly = localKeys.filter(key => !byKey.has(key));
    last = { serverKeys, localKeys, mismatches, localOnly };
    if (!mismatches.length && !localOnly.length && serverKeys.length === localKeys.length) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return last;
    } else stableSince = 0;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const diagnostics = snapshot.f.r.api.getRuntime?.()?.memorySuite || null;
  assert.fail(`mirror did not converge within ${timeoutMs}ms: ${JSON.stringify({ ...last, diagnostics })}`);
}

// The verdict is the only thing allowed to matter here: what the run decided,
// not how the mode stored it.
const verdict = snapshot => {
  const memory = memoryOf(snapshot);
  const head = headOf(snapshot);
  return {
    memoryCommitted: memory?.status === 'committed',
    completedStages: memory ? [...(memory.pipeline?.completedStages || [])].sort() : null,
    pipelineStatus: memory?.pipeline?.status ?? null,
    failedItoStages: memory ? [...(memory.pipeline?.failedItoStages || [])].sort() : null,
    factCount: memory?.canonicalArtifact?.facts?.length ?? null,
    factDomains: memory?.canonicalArtifact?.facts
      ? [...new Set(memory.canonicalArtifact.facts.map(fact => fact.domain))].sort() : null,
    headStatus: head?.status ?? null,
    headThroughTurn: head?.throughTurn ?? null
  };
};

const exposeCore = source => {
  assert.ok(source.includes('  const publicApi = Object.freeze({'), 'LIBRA public API boundary exists');
  return source.replace(
    '  const publicApi = Object.freeze({',
    '  globalThis.__LIBRARIAN_STAGE_TEST__={core:LibraMemoryCore};\n  const publicApi = Object.freeze({'
  );
};

async function successRun(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    const job = await snapshot.f.run();
    assert.equal(job.completed, 1, `${mode}: the enabled stage commits (${JSON.stringify(job.result)})`);
    assert.equal(countCalls(snapshot.f.control).canonical,1);
    const seen = verdict(snapshot);
    assert.equal(seen.memoryCommitted, true, `${mode}: the canonical is committed`);
    assert.deepEqual(seen.completedStages, ['librarian'], `${mode}: the enabled stage completed`);
    assert.equal(seen.pipelineStatus, 'complete', `${mode}: the pipeline reports complete`);
    assert.deepEqual(seen.failedItoStages, [], `${mode}: no stage failed`);
    assert.equal(seen.factCount, 13, `${mode}: every supplied fact became canonical`);
    assert.deepEqual(seen.factDomains, ['character', 'narrative', 'relationship', 'world'], `${mode}: all four domains are present`);
    assert.equal(seen.headStatus, 'ready', `${mode}: the State Head is ready`);
    assert.equal(seen.headThroughTurn, 5, `${mode}: the State Head covers the batch`);
    return seen;
  } finally {
    await snapshot.cleanup();
  }
}

async function hardFailureRun(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    snapshot.f.control.modelFails = true;
    const job = await snapshot.f.run();
    const seen = verdict(snapshot);
    // The failure must be a real failure, not a silent success in any mode.
    assert.equal(job.completed, 0, `${mode}: a hard provider failure commits nothing`);
    assert.equal(seen.memoryCommitted, false, `${mode}: no canonical is committed on hard failure`);
    assert.equal(memoryOf(snapshot), null, `${mode}: no canonical exists after hard failure`);
    assert.equal(headOf(snapshot), null, `${mode}: no State Head exists after hard failure`);
    assert.equal(job.result?.failed > 0 || job.state === 'completed_with_warnings', true,
      `${mode}: the failure is reported, not swallowed (${JSON.stringify({ state: job.state, failed: job.result?.failed })})`);
    return { completed: job.completed, state: job.state, seen };
  } finally {
    await snapshot.cleanup();
  }
}

async function partialRun(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    // One fact carries evidence that is not in the source, so it must be dropped
    // while the remaining facts survive: the fail-soft rule.
    snapshot.f.control.artifact.facts[0].evidenceSpans[0].quote = '원문에 없는 주장이므로 거절해야 한다';
    const job = await snapshot.f.run();
    assert.equal(job.completed, 1, `${mode}: a partial batch still commits the surviving memory`);
    const seen = verdict(snapshot);
    assert.equal(seen.memoryCommitted, true, `${mode}: the surviving memory is committed`);
    assert.equal(seen.pipelineStatus, 'partial', `${mode}: the pipeline reports partial, not complete`);
    assert.equal(seen.factCount, 12, `${mode}: only the unsupported fact was dropped`);
    assert.equal(seen.headStatus, 'partial', `${mode}: the State Head reports partial`);
    assert.equal(seen.headThroughTurn, 5, `${mode}: the partial head still covers the batch`);
    return seen;
  } finally {
    await snapshot.cleanup();
  }
}

async function retirementRun(mode) {
  const snapshot = await serverFixture({ mode, transformSource: exposeCore });
  try {
    const core = snapshot.f.r.context.__LIBRARIAN_STAGE_TEST__?.core;
    assert.ok(core, `${mode}: the closure core is reachable for the retirement check`);
    assert.deepEqual([...core.STAGE_ORDER], ['librarian'], `${mode}: only the enabled stage is in the pipeline order`);
    const policy = snapshot.f.r.api.getLibrarianPolicy();
    for (const stage of RETIRED) {
      assert.ok(policy.retiredStages.includes(stage), `${mode}: ${stage} is declared retired`);
      await assert.rejects(
        () => core.executeUnifiedStage(stage, [], null),
        error => error.code === 'LEGACY_ANALYZER_RETIRED',
        `${mode}: ${stage} must reject with LEGACY_ANALYZER_RETIRED`
      );
    }
    await assert.rejects(
      () => core.executeStage('ariadne', []),
      error => error.code === 'LEGACY_ANALYZER_RETIRED',
      `${mode}: the legacy executeStage entry point rejects the retired chain`
    );
    // A retired route must never reach the provider.
    assert.equal(snapshot.f.control.calls.length, 0, `${mode}: a retired route makes no analysis call`);
    return { stageOrder: [...core.STAGE_ORDER], retiredStages: policy.retiredStages.length };
  } finally {
    await snapshot.cleanup();
  }
}

async function storageContract(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    await snapshot.f.run();
    if (mode === 'plugin_only') {
      assert.equal(snapshot.batches.length, 0, 'plugin_only sends no owner-data batch to the backend');
      assert.equal(snapshot.storedRows().length, 0, 'plugin_only stores no owner data on the server');
      assert.ok(localOwnerKeys(snapshot).length >= 1, 'plugin_only keeps the canonical and manifest locally');
    }
    if (mode === 'mirror') {
      await waitForMirrorConvergence(snapshot);
      const serverKeys = serverOwnerKeys(snapshot);
      assert.ok(serverKeys.length >= 2, `mirror commits the manifest and canonical to the server: ${serverKeys.length}`);
      for (const key of serverKeys) {
        assert.ok(snapshot.local.has(key), `mirror keeps a local copy of ${key}`);
        const serverRow = snapshot.storedRows().find(row => row.key === key);
        assert.deepEqual(JSON.parse(snapshot.local.get(key)), serverRow.value, `mirror local copy of ${key} equals the server value`);
      }
      const serverSet = new Set(serverKeys);
      for (const key of localOwnerKeys(snapshot)) {
        assert.ok(serverSet.has(key), `mirror has no local-only owner key: ${key}`);
      }
    }
    if (mode === 'server_only') {
      assert.deepEqual(localOwnerKeys(snapshot), [], 'server_only keeps no canonical or manifest locally');
      assert.ok(serverOwnerKeys(snapshot).length >= 2, 'server_only holds the manifest and canonical on the server');
    }
    return { serverOwnerKeys: serverOwnerKeys(snapshot).length, localOwnerKeys: localOwnerKeys(snapshot).length };
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const results = {};
  for (const mode of MODES) {
    const storage = await storageContract(mode);
    const success = await successRun(mode);
    const hardFailure = await hardFailureRun(mode);
    const partial = await partialRun(mode);
    const retirement = await retirementRun(mode);
    results[mode] = { storage, success, hardFailure, partial, retirement };
  }

  // The whole point: the verdict must not vary by storage mode.
  const pick = (mode, field) => {
    const { memoryCommitted, completedStages, pipelineStatus, failedItoStages, factCount, factDomains, headStatus, headThroughTurn } = results[mode].success;
    return { memoryCommitted, completedStages, pipelineStatus, failedItoStages, factCount, factDomains, headStatus, headThroughTurn };
  };
  assert.deepEqual(pick('mirror'), pick('plugin_only'), 'mirror produces the same success verdict as plugin_only');
  assert.deepEqual(pick('server_only'), pick('plugin_only'), 'server_only produces the same success verdict as plugin_only');
  assert.deepEqual(
    MODES.map(mode => ({ completed: results[mode].hardFailure.completed, state: results[mode].hardFailure.state })),
    [{ completed: 0, state: 'completed_with_warnings' }, { completed: 0, state: 'completed_with_warnings' }, { completed: 0, state: 'completed_with_warnings' }],
    'all three modes fail the batch identically on a hard provider failure'
  );
  const partialVerdict = mode => {
    const { memoryCommitted, pipelineStatus, factCount, headStatus } = results[mode].partial;
    return { memoryCommitted, pipelineStatus, factCount, headStatus };
  };
  assert.deepEqual(partialVerdict('mirror'), partialVerdict('plugin_only'), 'mirror produces the same partial verdict as plugin_only');
  assert.deepEqual(partialVerdict('server_only'), partialVerdict('plugin_only'), 'server_only produces the same partial verdict as plugin_only');
  assert.deepEqual(
    MODES.map(mode => results[mode].retirement.stageOrder),
    [['librarian'], ['librarian'], ['librarian']],
    'the pipeline order is storage-mode independent'
  );

  console.log(JSON.stringify({
    test: 'libra_ariadne_ito_pipeline_3mode_parity',
    passed: 1,
    boundary: 'real deployed LIBRA memory pipeline + real HTTP/SQLite storage in three modes; synthetic RisuAI/LLM boundary only',
    planNote: 'the plan named retired stage ids (ariadne/character_ito/world_ito/plot_ito); the modern single-stage pipeline is what is asserted, and the retirement of the old chain is asserted per mode',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
