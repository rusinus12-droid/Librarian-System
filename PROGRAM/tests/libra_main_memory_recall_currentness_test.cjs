'use strict';
// T07 (World Maker integration plan) -- cross-batch recall continuity.
//
// WHAT THIS PINS. `unifiedFactExcerpt` already closes a fact over the LATER
// facts of the SAME five-turn artifact (per-slot `terminal` map + `dependsOn`)
// and already prefers complete terminal evidence under a tight budget. What it
// cannot see is a successor that lives in a DIFFERENT artifact: a promise made at
// T5 is closed by an event at T105, and today the two are packed independently.
//
// A18 requires the two questions to answer differently:
//   "T5 때 무엇을 약속했나?"   -> the promise as it stood then
//   "지금도 해야 하나?"        -> the successor (fulfilment) reflected
// A19 requires that under a small budget the LATER, closing evidence wins rather
// than the earlier value alone. A21 requires that what could not be verified is
// labelled last-known/unknown rather than reported as "no later change".
//
// UPDATED for the unified memory engine: the cross-batch successor is returned from its own
// committed batch and completeness is stated by the engine diagnostics (no closure layer).
//
// The surface driven here is the SHIPPED one: `previewUnifiedMemoryRecall(query)`
// -> `LibraMemoryCore.recall(context, query)`. No test-only recall API is added.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

// Batch 1 (T1-5): the promise is OPEN -- 지호 still holds the key.
const promiseBatch = () => {
  const a = artifact();
  a.facts.find(f => f.tempFactId === 'f11').values.holderRef = 'jiho';
  a.facts.find(f => f.tempFactId === 'f11').text = '지호가 은빛 열쇠를 아직 반환하지 않았다.';
  const thread = a.facts.find(f => f.tempFactId === 'f12');
  thread.values.thread.status = 'open';
  thread.text = '오늘 열쇠를 반환하겠다는 약속은 아직 이행되지 않았다.';
  return a;
};
// Batch 2 (T6-10): the promise is FULFILLED -- the promise's successor.
// The evidence refs are moved to the second batch's turns, because the validator
// binds every span to the batch it is committing with.
const fulfilmentBatch = () => {
  const a = artifact();
  for (const fact of [...a.entities, ...a.facts]) {
    for (const span of fact.evidenceSpans || []) span.ref = span.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + 5}`);
  }
  a.facts.find(f => f.tempFactId === 'f11').values.holderRef = 'mina';
  a.facts.find(f => f.tempFactId === 'f11').text = '지호가 열쇠를 민아에게 반환했다.';
  const thread = a.facts.find(f => f.tempFactId === 'f12');
  thread.values.thread.status = 'resolved';
  thread.text = '오늘 열쇠를 반환하겠다는 약속이 이행되었다.';
  return a;
};

const MODES = ['plugin_only', 'mirror', 'server_only'];
const recallOf = async (f, query) => JSON.stringify(await f.r.api.previewUnifiedMemoryRecall(query));

// The mode's real authority: `snapshot.getManifest()` reads the server, which holds
// nothing in plugin_only, so a passing pipeline would look like zero batches.
const manifestOf = snapshot => {
  const server = snapshot.getManifest();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => candidate.endsWith(':manifest'));
  if (!key) return null;
  try { return JSON.parse(snapshot.local.get(key)); } catch { return null; }
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    f.control.artifact = promiseBatch();
    assert.equal((await f.run()).completed, 1, `${mode}: the promise batch commits`);
    fiveMore(f);
    // `fiveMore` resets control.artifact to the fixture artifact, so the second
    // batch's artifact is assigned after it -- otherwise the fulfilment never runs.
    f.control.artifact = fulfilmentBatch();
    assert.equal((await f.run()).completed, 1, `${mode}: the fulfilment batch commits`);
    assert.equal(Object.keys(manifestOf(snapshot)?.memories ?? {}).length, 2,
      `${mode}: two batches are committed, so the pair spans artifacts`);

    // The user-visible recall surface.
    const recall = await f.r.api.previewUnifiedMemoryRecall('은빛 열쇠 반환 약속');
    assert.ok(recall, `${mode}: recall returns a result`);
    const text = JSON.stringify(recall);

    // (A18) The closing batch must be reachable from the same recall as the promise:
    // a "지금도 해야 하나?" answer has to be able to see the fulfilment.
    observation.successorVisible = /이행되었다|반환했다/.test(text);
    assert.equal(observation.successorVisible, true,
      `${mode}: the cross-batch successor (fulfilment) is visible in recall`);

    // (A18) Both the promise as it stood (earlier batch) and its successor (later batch) are
    // returned from their own committed memories, so a caller can answer both questions.
    const memoryIds = new Set(recall.memories.map(row => row.memory?.memoryId));
    const openRows = recall.memories.filter(row => /아직 이행되지 않았다/.test(row.excerpt || ''));
    const closedRows = recall.memories.filter(row => /약속이 이행되었다/.test(row.excerpt || ''));
    observation.promiseAndSuccessorFromSeparateBatches = openRows.length > 0 && closedRows.length > 0
      && openRows.every(row => !closedRows.some(other => other.memory.memoryId === row.memory.memoryId));
    assert.equal(observation.promiseAndSuccessorFromSeparateBatches, true,
      `${mode}: the open promise and its fulfilment come from different committed batches`);
    assert.ok(memoryIds.size >= 2, `${mode}: recall spans both committed batches`);

    // (A21) The legacy closure/last-known labelling (recallContinuityClosure) was retired with the
    // old retrieval pipeline (9c03c35). The unified engine instead states completeness explicitly,
    // so unverified coverage cannot be mistaken for "no later change".
    const engine = recall.diagnostics?.unifiedMemoryEngine;
    assert.equal(recall.diagnostics?.recallContinuityClosure, undefined, `${mode}: retired closure diagnostics are absent`);
    observation.statesCoverage = engine?.queryComplete === true && engine?.sourceCoverageComplete === true
      && engine?.deliveryOutcome === 'complete' && engine?.legacyRankerExecuted === false;
    assert.equal(observation.statesCoverage, true,
      `${mode}: recall states that its query and source coverage are complete (and no legacy ranker ran)`);

    // (A22) A reported/hypothetical fact must not be promoted to a verified closure.
    observation.uncertaintyNotPromoted = !/reported[^"]*"[^"]*이행되었다/.test(text);
    assert.equal(observation.uncertaintyNotPromoted, true,
      `${mode}: uncertainty is not promoted to a verified closure`);

    observation.modelCalls = f.control.calls.length;
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  const project = ({ mode, ...rest }) => rest;
  assert.deepEqual(project(results.mirror), project(results.plugin_only),
    'mirror reaches the same cross-batch continuity verdict as plugin_only');
  assert.deepEqual(project(results.server_only), project(results.plugin_only),
    'server_only reaches the same cross-batch continuity verdict as plugin_only');
  console.log(JSON.stringify({
    test: 'libra_main_memory_recall_currentness',
    passed: 1,
    boundary: 'real deployed LIBRA public recall API + real HTTP/SQLite in three modes; synthetic provider artifacts only',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
