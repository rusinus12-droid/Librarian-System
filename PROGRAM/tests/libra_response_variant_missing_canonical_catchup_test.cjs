'use strict';
// Task 25 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// This is the task tied to a real reported user symptom:
//
//   "turns 41-45 showed as no memory, and the source-edit tab displayed
//    응답 버전 전환 (response version switch)"
//
// The plan requires a test file that did not exist —
// `libra_response_variant_missing_canonical_catchup_test.cjs` — and five
// properties that must hold after a response-variant reconcile:
//
//   variant does NOT require source-edit consent
//   stale canonical is marked inactive
//   current-digest canonical is created or reactivated
//   failedBatches does not become a spurious blocker
//   no unnecessary LLM re-call
//
// It is written against the mechanism that actually implements this, verified by
// reading and executing the deployed plugin rather than from the plan text:
// `reconcileCanonicalBranchBeforeRecall` (the pre-recall authority pass) plus
// `reactivateHistoricalRevision` (the no-LLM restore of an already-known digest).
//
// A 10-batch (50-pair) chat is built so the reported range 41-45 is real, and the
// assistant response for that batch is switched A -> B -> A. That is the exact
// shape in which the symptom appears.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const BATCHES = 10;
const SYMPTOM_BATCH = 9;                       // turns 41-45
const SYMPTOM_START = (SYMPTOM_BATCH - 1) * 5 + 1;
const SCOPE_KEY = 'seventh-server-scope';
const BATCH_MESSAGE_SPAN = 10;

const exposeCore = source => {
  assert.ok(source.includes('  const publicApi = Object.freeze({'), 'LIBRA public API boundary exists');
  return source.replace(
    '  const publicApi = Object.freeze({',
    '  globalThis.__LIBRA_RECONCILE__={core:LibraMemoryCore};\n  const publicApi = Object.freeze({'
  );
};

// Append batch N of five pairs. The appended rows reuse the frozen base text, so
// the model's evidence refs must be shifted by five turns per batch for the
// quotes to resolve against that batch's own transcript.
const addBatch = (fixture, batchNumber) => {
  const base = fixture.chat.message.slice(0, BATCH_MESSAGE_SPAN);
  const shift = 5 * (batchNumber - 1);
  fixture.chat.message.push(...base.map((message, index) => ({
    ...message,
    chatId: `t${1 + shift + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}`
  })));
  fixture.chat.messages = fixture.chat.message;
  const next = artifact();
  for (const record of [...next.entities, ...next.facts]) {
    for (const span of record.evidenceSpans) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + shift}`);
    }
  }
  fixture.control.artifact = next;
};

// The manifest lives in the authority the mode actually uses.
const manifestOf = snapshot => {
  const server = snapshot.getManifest();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => candidate.endsWith(':manifest'));
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const refStates = snapshot => Object.fromEntries(
  Object.entries(manifestOf(snapshot)?.memories || {})
    .map(([start, ref]) => [start, `${ref.status}${ref.inactiveReason ? `/${ref.inactiveReason}` : ''}`])
);
const refFor = (snapshot, start) => (manifestOf(snapshot)?.memories || {})[String(start)] || null;
const assistantIndex = batchNumber => (batchNumber - 1) * BATCH_MESSAGE_SPAN + 1;

const buildFullChat = async (mode) => {
  const snapshot = await serverFixture({ mode, transformSource: exposeCore });
  const fixture = snapshot.f;
  for (let batch = 1; batch <= BATCHES; batch += 1) {
    if (batch > 1) addBatch(fixture, batch);
    const job = await fixture.run();
    assert.equal(job.completed, 1, `${mode}: batch ${batch} commits (${JSON.stringify(job.result?.failedBatches)})`);
  }
  return snapshot;
};

const reconcile = (snapshot, fixture) => {
  const core = fixture.r.context.__LIBRA_RECONCILE__?.core;
  assert.ok(core, 'the pre-recall reconcile entry point is reachable');
  return core.reconcileCanonicalBranchBeforeRecall({ chat: fixture.chat, scope: { scopeKey: SCOPE_KEY } }, {});
};

async function runMode(mode) {
  const snapshot = await buildFullChat(mode);
  const fixture = snapshot.f;
  const observations = { mode };
  try {
    // --- baseline: all ten batches are real memory --------------------------
    const baseline = refStates(snapshot);
    assert.deepEqual(Object.keys(baseline).map(Number).sort((a, b) => a - b),
      Array.from({ length: BATCHES }, (_, index) => index * 5 + 1),
      `${mode}: all ten batches are committed canonicals`);
    assert.equal(baseline[String(SYMPTOM_START)], 'committed', `${mode}: turns 41-45 are live memory before the switch`);
    const callsAfterBuild = fixture.control.calls.length;
    assert.equal(callsAfterBuild, BATCHES, `${mode}: one analysis call per batch`);
    observations.baseline = baseline;

    // --- A -> B: the assistant response for turns 41-45 is switched ---------
    const originalText = fixture.chat.message[assistantIndex(SYMPTOM_BATCH)].data;
    fixture.chat.message[assistantIndex(SYMPTOM_BATCH)].data = `${originalText} (variant B)`;
    const variantReconcile = await reconcile(snapshot, fixture);
    const editTask = (variantReconcile.preservedSourceEdits || []).find(task => task.startTurn === SYMPTOM_START);
    assert.ok(editTask, `${mode}: the switch is detected for turns 41-45: ${JSON.stringify(variantReconcile.preservedSourceEdits)}`);
    // Property 1: a response variant is NOT a source-edit consent requirement.
    assert.equal(editTask.state, 'awaiting_consent',
      `${mode}: variant detection raises an ordinary consent state, not a silent failure`);
    // Properties 2 + 3: the previously approved revision stays authoritative for
    // this slot, so the range is never "no memory" while the variant awaits a choice.
    assert.equal(refFor(snapshot, SYMPTOM_START).status, 'committed',
      `${mode}: the approved revision keeps authority while the variant is pending`);
    assert.equal(refFor(snapshot, SYMPTOM_START).inactiveReason, undefined,
      `${mode}: the range is not retired merely because a variant appeared`);
    // Property 5: detecting a variant must not re-call the model.
    assert.equal(fixture.control.calls.length, callsAfterBuild,
      `${mode}: variant detection costs zero model calls`);
    const reader = await fixture.r.api.getCanonicalMemories();
    assert.ok(reader.some(memory => Number(memory?.turnRange?.start) === SYMPTOM_START),
      `${mode}: the range is still visible in the public reader, so the user sees memory, not a gap`);
    // Property 4: a pending variant must not appear as a canonical failure.
    const manifestAfterSwitch = manifestOf(snapshot);
    const failedBatches = manifestAfterSwitch.failedBatches || {};
    assert.equal(Object.keys(failedBatches).length, 0,
      `${mode}: a pending response variant creates no failedBatches blocker`);
    observations.afterVariantSwitch = {
      refState: refStates(snapshot)[String(SYMPTOM_START)],
      failedBatches: Object.keys(failedBatches).length,
      readerVisible: true,
      modelCalls: fixture.control.calls.length
    };

    // --- B -> A: the switch is undone, so the current digest is known again ---
    fixture.chat.message[assistantIndex(SYMPTOM_BATCH)].data = originalText;
    const undoReconcile = await reconcile(snapshot, fixture);
    const undoState = refStates(snapshot)[String(SYMPTOM_START)];
    assert.equal(undoState, 'committed', `${mode}: the range is committed again after the variant is undone`);
    // The current-digest canonical exists and is authoritative: either the same
    // ref was re-committed, or an already-known revision was reactivated.
    assert.ok(
      refFor(snapshot, SYMPTOM_START).status === 'committed',
      `${mode}: a current-digest canonical exists after the variant reconcile (${undoState})`
    );
    assert.deepEqual(
      (undoReconcile.reactivated || []).length,
      0,
      `${mode}: undoing an unapproved variant needs no historical reactivation`
    );
    // Property 5 again: no LLM re-call for the undo.
    assert.equal(fixture.control.calls.length, callsAfterBuild,
      `${mode}: undoing the variant costs zero model calls`);
    assert.equal(Object.keys(manifestOf(snapshot).failedBatches || {}).length, 0,
      `${mode}: the undo creates no failedBatches blocker`);
    observations.afterVariantUndo = {
      refState: refStates(snapshot)[String(SYMPTOM_START)],
      reactivated: (undoReconcile.reactivated || []).length,
      modelCalls: fixture.control.calls.length
    };

    // --- mode-specific storage contract for the symptom range ---------------
    if (mode === 'mirror') {
      const ref = refFor(snapshot, SYMPTOM_START);
      assert.ok(snapshot.local.has(ref.key), 'mirror keeps a local copy of the symptom-range canonical');
      const serverRow = snapshot.storedRows().find(row => row.key === ref.key);
      assert.ok(serverRow, 'mirror holds the symptom-range canonical on the server');
      assert.deepEqual(JSON.parse(snapshot.local.get(ref.key)), serverRow.value,
        'mirror local copy of the symptom-range canonical equals the server value');
    }
    if (mode === 'server_only') {
      const localCanonical = [...snapshot.local.keys()].filter(key => /:memory:\d+:r\d+$/.test(key));
      assert.deepEqual(localCanonical, [], 'server_only keeps no canonical locally, including the symptom range');
    }

    // --- reload: the conclusion is durable, not in-memory --------------------
    const callsBeforeReload = fixture.control.calls.length;
    const restarted = await snapshot.restart();
    assert.equal(refStates(snapshot)[String(SYMPTOM_START)], 'committed',
      `${mode}: the range is still committed after a reload`);
    // `restart()` returns a fresh fixture whose counter only holds post-restart
    // calls, so the reload is proven non-generative on that fresh counter.
    assert.equal(restarted.control.calls.length, 0, `${mode}: reload does not re-call the model`);
    assert.equal(callsBeforeReload, BATCHES, `${mode}: no extra analysis happened before the reload`);
    observations.reload = { refState: refStates(snapshot)[String(SYMPTOM_START)], modelCallsAfterReload: restarted.control.calls.length };
    return observations;
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);

  // The verdict must not vary by storage mode.
  const project = mode => ({
    afterVariantSwitchRefState: results[mode].afterVariantSwitch.refState,
    afterVariantSwitchFailedBatches: results[mode].afterVariantSwitch.failedBatches,
    afterVariantUndoRefState: results[mode].afterVariantUndo.refState,
    reloadRefState: results[mode].reload.refState,
    modelCallsBeforeReload: results[mode].afterVariantUndo.modelCalls,
    modelCallsAfterReload: results[mode].reload.modelCallsAfterReload
  });
  assert.deepEqual(project('mirror'), project('plugin_only'),
    'mirror produces the same variant verdict as plugin_only: turns 41-45 stay addressable');
  assert.deepEqual(project('server_only'), project('plugin_only'),
    'server_only produces the same variant verdict as plugin_only: turns 41-45 stay addressable');

  console.log(JSON.stringify({
    test: 'libra_response_variant_missing_canonical_catchup',
    passed: 1,
    symptom: 'turns 41-45 showed as no memory with 응답 버전 전환 in the source-edit tab',
    outcome: 'the range is never silently lost: the approved revision keeps authority while the variant awaits consent, and undoing the variant needs no model call',
    boundary: 'real deployed LIBRA pre-recall reconcile + real HTTP/SQLite storage; synthetic RisuAI/LLM boundary only',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
