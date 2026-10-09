'use strict';
// Task 26 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// LIBRA-WORLD-MANAGER-STATE / LIBRA-STATE-CORRECTION-JOURNAL / LIBRA-DUAL-WORLDLINE
// are `unverified` for `mirror` and `server_only`. The plan lists two "repro" files,
// but both are **string-match contract tests** (`libra_latest_state_tracking_contract_test.cjs`
// reads the plugin text with regexes; `libra_world_manager_correction_transaction_rc2_test.cjs`
// slices source sections). Since a `verified_supported` status requires an executed
// entry point plus durable readback, this test drives the real public State API
// against real HTTP/SQLite storage in all three modes.
//
// Measured behaviour (this is a FINDING, reported as such, not a defect invented here):
//
//   Current State Head, correction append/suspend/reactivate, and rebuild
//   behave identically in all three modes.
//   `setWorldManagerWorldline` and `rollbackWorldManagerState` return
//   UNIFIED_BACKEND_NOT_SUPPORTED in `mirror` and `server_only` and succeed in
//   `plugin_only`, because the unified storage writer does not implement those
//   two operations on the server (the same boundary
//   `libra_unified_server_writer_v1_test.cjs` asserts for rollback/handoff).
//
// So this test asserts the verified behaviour exactly and pins the boundary
// explicitly instead of claiming parity that does not exist.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const SERVER_BACKED = ['mirror', 'server_only'];

// The State Head lives in the authority the mode actually uses.
const headOf = snapshot => {
  const server = snapshot.getHead();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => /:continuity-state$/.test(candidate));
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
// The correction journal lives under `:state-corrections:v2` (plural), and the
// authoritative read path is the public `getWorldManagerCorrections()`, which
// resolves whichever authority the mode uses. Read it that way rather than
// guessing a key shape or a storage location.
const correctionJournalOf = async fixture => fixture.r.api.getWorldManagerCorrections();
// ---------------------------------------------------------------------------
// RESOLVED DEFECT (fixed 2026-09-17): the journal `revision` counter was not
// mode-independent, because `plugin_only` wrote the correction journal twice per
// status change.
//
// `setStateCorrectionStatus` takes the `serverAtomic` path in mirror/server_only
// (the replay persists the journal) but in plugin_only it first wrote the journal
// via `saveStateCorrectionJournal` and then the follow-up replay wrote it again.
// Observed physical writes for one suspend BEFORE the fix:
//
//   plugin_only : revisions 2 and 3   (two writes)
//   mirror      : revision  2         (one write)
//   server_only : revision  2         (one write)
//
// Fix: `rebuildCurrentStateForWorldlineUnlocked` now forwards `storeOverride` into
// `rebuildUnifiedStateForWorldline`, and both `addWorldManagerCorrection` and
// `setStateCorrectionStatus` pass the already-saved journal on the non-atomic path
// too -- the same way the atomic path already did. One status change now writes the
// journal exactly once in every mode and `revision` advances identically (+1).
//
// The write count is still asserted, per authority, so the defect cannot return.
// ---------------------------------------------------------------------------
const EXPECTED_JOURNAL_WRITES_PER_STATUS_CHANGE = 1;
const localStateKeys = snapshot => [...snapshot.local.keys()]
  .filter(key => /:continuity-state$|:state-corrections:v2$/.test(key)).sort();
const worldCondition = (snapshot, worldId) => {
  const head = headOf(snapshot);
  return head?.world?.find(row => row.id === worldId)?.state?.condition ?? null;
};

// The head is only meaningful when it is the CURRENT one, so every readback below
// uses the production authority rule rather than reading a stale sidecar.
// `getCurrentStateHead()` returns a public *projection*: it carries the same
// authoritative fields but omits internal bookkeeping (correction provenance,
// alias evidence, cleared-field evidence, basis internals). So the check is
// agreement on the authoritative *content*, not object identity — comparing whole
// objects would fail on the projection itself rather than on any state difference.
const stateContent = value => JSON.parse(JSON.stringify(
  Array.isArray(value) ? value.map(row => ({ id: row?.id, name: row?.name, state: row?.state })) : value ?? null
));
const currentHead = async (fixture, snapshot) => {
  const projected = await fixture.r.api.getCurrentStateHead();
  assert.ok(projected, 'the public Current State Head projection is available');
  const durable = headOf(snapshot);
  assert.ok(durable, 'the durable State Head exists');
  for (const field of ['schema', 'status', 'throughTurn', 'worldlineId', 'scopeKey']) {
    assert.deepEqual(projected[field], durable[field],
      `the public projection agrees with the durable head on "${field}"`);
  }
  assert.deepEqual(stateContent(projected.world), stateContent(durable.world),
    'the public projection agrees on world state content');
  assert.deepEqual(stateContent(projected.characters), stateContent(durable.characters),
    'the public projection agrees on character state content');
  return projected;
};

async function runMode(mode) {
  const snapshot = await serverFixture({ mode });
  const fixture = snapshot.f;
  const observations = { mode };
  try {
    const first = await fixture.run();
    assert.equal(first.completed, 1, `${mode}: the canonical batch commits`);
    const callsAfterRun = fixture.control.calls.length;

    // --- Current State Head + pending/last-known ----------------------------
    let head = await currentHead(fixture, snapshot);
    assert.equal(head.schema, 'libra.continuity_state.v2', `${mode}: head schema`);
    assert.equal(head.status, 'ready', `${mode}: head is ready`);
    assert.equal(head.throughTurn, 5, `${mode}: head covers the committed batch`);
    assert.equal(head.worldlineId, 'main', `${mode}: head is on the main worldline`);
    assert.ok(head.world.length > 0 && head.characters.length > 0, `${mode}: head carries world and characters`);
    assert.equal(head.unifiedApplied?.pending?.length ?? 0, 0, `${mode}: nothing is left pending on a clean commit`);
    observations.head = { status: head.status, throughTurn: head.throughTurn, world: head.world.length, characters: head.characters.length };

    // --- correction append -> suspend -> reactivate --------------------------
    const worldRow = head.world[0];
    // Count journal writes ON THE MODE'S REAL AUTHORITY so the divergence is
    // MEASURED rather than assumed (see the FINDING block at the top of this file):
    //   plugin_only  -> local setItem is the authority
    //   mirror / server_only -> the server conditional batch is the authority
    //     (mirror also re-writes its local mirror copy many times; counting that
    //      would measure the copy, not the commit)
    const journalKey = /:state-corrections:v2$/;
    const journalWrites = { local: 0, server: 0 };
    const authorityWrites = () => (mode === 'plugin_only' ? journalWrites.local : journalWrites.server);
    const originalSet = snapshot.local.set.bind(snapshot.local);
    snapshot.local.set = (key, value) => {
      if (journalKey.test(String(key))) journalWrites.local += 1;
      return originalSet(key, value);
    };
    const countServerJournalMutations = sinceIndex => snapshot.batches.slice(sinceIndex)
      .flatMap(batch => (batch.mutations || []).filter(mutation => journalKey.test(String(mutation.key)))).length;
    const journalBefore = await correctionJournalOf(fixture);
    assert.equal(journalBefore?.revision ?? 0, 0, `${mode}: the correction journal starts empty`);
    const added = await fixture.r.api.addWorldManagerCorrection({
      anchorTurn: 5, target: { domain: 'world' }, patch: { world: [{ id: worldRow.id, set: { condition: '휴관 중' } }] }
    });
    assert.equal(added.schema, 'libra.state_correction.v1', `${mode}: correction schema`);
    assert.ok(added.correctionId, `${mode}: correction id is returned`);
    assert.equal(added.worldlineId, 'main', `${mode}: correction is anchored to the main worldline`);
    assert.equal(worldCondition(snapshot, worldRow.id), '휴관 중', `${mode}: the correction is applied to the head`);
    assert.equal(fixture.control.calls.length, callsAfterRun, `${mode}: a correction costs no model call`);

    // A correction is a journal record, not a rewrite of canonical memory. The
    // LOGICAL contract is one record and the requested status -- the revision
    // counter is reported separately below because it is not mode-independent.
    const journalAfterAdd = await correctionJournalOf(fixture);
    assert.equal(journalAfterAdd?.records?.length, 1, `${mode}: the journal holds exactly one record`);
    assert.equal(journalAfterAdd?.records?.[0]?.status, 'active', `${mode}: the appended correction is active`);
    assert.equal(journalAfterAdd?.records?.[0]?.correctionId, added.correctionId, `${mode}: the record is the appended correction`);

    journalWrites.local = 0;
    const suspendBatchMark = snapshot.batches.length;
    await fixture.r.api.setWorldManagerCorrectionStatus(added.correctionId, 'suspended');
    journalWrites.server = countServerJournalMutations(suspendBatchMark);
    const suspendWrites = authorityWrites();
    assert.equal(worldCondition(snapshot, worldRow.id), null, `${mode}: a suspended correction no longer applies`);
    assert.equal(fixture.control.calls.length, callsAfterRun, `${mode}: suspension costs no model call`);
    const afterSuspend = await correctionJournalOf(fixture);
    assert.equal(afterSuspend?.records?.length, 1, `${mode}: suspension does not duplicate the record`);
    assert.equal(afterSuspend?.records?.[0]?.status, 'suspended', `${mode}: the record reads back as suspended`);

    journalWrites.local = 0;
    const activateBatchMark = snapshot.batches.length;
    await fixture.r.api.setWorldManagerCorrectionStatus(added.correctionId, 'active');
    journalWrites.server = countServerJournalMutations(activateBatchMark);
    const activateWrites = authorityWrites();
    assert.equal(worldCondition(snapshot, worldRow.id), '휴관 중', `${mode}: reactivation re-applies the correction`);
    assert.equal(fixture.control.calls.length, callsAfterRun, `${mode}: reactivation costs no model call`);
    const journalAfterReactivate = await correctionJournalOf(fixture);
    assert.equal(journalAfterReactivate?.records?.length, 1, `${mode}: pause/reactivate never duplicates the record`);
    assert.equal(journalAfterReactivate?.records?.[0]?.status, 'active', `${mode}: the record reads back as active again`);
    snapshot.local.set = originalSet;
    observations.correction = {
      applied: true, suspendedToNull: true, reactivatedTo: '휴관 중',
      journalRecords: journalAfterReactivate?.records?.length ?? null,
      journalWritesOnAuthority: { suspend: suspendWrites, activate: activateWrites },
      journalRevisionFinal: journalAfterReactivate?.revision ?? null,
      modelCalls: fixture.control.calls.length
    };

    // --- replay / rebuild ---------------------------------------------------
    const rebuilt = await fixture.r.api.rebuildWorldManagerState({});
    assert.equal(rebuilt.ok, true, `${mode}: replay/rebuild succeeds`);
    assert.equal(rebuilt.head?.schema, 'libra.continuity_state.v2', `${mode}: rebuild yields a current head`);
    assert.equal(rebuilt.head?.throughTurn, 5, `${mode}: rebuild keeps the covered range`);
    assert.equal(worldCondition(snapshot, worldRow.id), '휴관 중', `${mode}: replay re-applies the active correction`);
    assert.equal(fixture.control.calls.length, callsAfterRun, `${mode}: rebuild replays from storage, not from the model`);
    observations.rebuild = { throughTurn: rebuilt.head?.throughTurn, modelCalls: fixture.control.calls.length };

    // --- worldline switch / rollback: implemented in all three modes --------
    // T01 of the World Maker integration plan (2026-09-25) made these two
    // operations reach the same success in every storage mode; before that they
    // were bounded to `plugin_only` and failed closed here with
    // UNIFIED_BACKEND_NOT_SUPPORTED. The named logical fork stays bounded -- see
    // the assertions below -- so this is not a blanket removal of the boundary.
    const rollback = await fixture.r.api.rollbackWorldManagerState({ throughTurn: 0 });
    assert.equal(rollback.ok, true, `${mode}: rollback succeeds`);
    assert.ok(rollback.head, `${mode}: rollback yields a head`);
    const worldlineSet = await fixture.r.api.setWorldManagerWorldline({});
    assert.equal(worldlineSet.ok, true, `${mode}: worldline switch succeeds`);
    assert.equal(fixture.control.calls.length, callsAfterRun, `${mode}: the two view operations make no model call`);
    // A cutoff is a VIEW. The committed correction is still authoritative, so
    // re-opening main re-applies it rather than losing it.
    assert.equal(worldCondition(snapshot, worldRow.id), '휴관 중',
      `${mode}: the active correction survives the view round-trip`);
    observations.worldline = { rollback: 'ok', setWorldline: 'ok', modelCalls: fixture.control.calls.length };

    // The remaining boundary must still fail closed: a NAMED logical fork needs
    // native-branch lineage, which the server writer does not implement.
    await assert.rejects(
      () => fixture.r.api.setWorldManagerWorldline({ worldlineId: 'named_fork_probe', parentId: 'main', forkTurn: 5 }),
      error => error.code === 'UNIFIED_USE_NATIVE_BRANCH_FOR_FORK' || /UNIFIED_USE_NATIVE_BRANCH_FOR_FORK/.test(String(error.message)),
      `${mode}: a named logical fork still fails closed with UNIFIED_USE_NATIVE_BRANCH_FOR_FORK`
    );
    assert.equal(fixture.control.calls.length, callsAfterRun, `${mode}: the rejected fork made no model call`);

    // --- storage contract for State -----------------------------------------
    if (mode === 'plugin_only') {
      assert.equal(snapshot.batches.length, 0, 'plugin_only sends no state batch to the backend');
      const headKey = snapshot.local.keys ? [...snapshot.local.keys()].find(key => /:continuity-state$/.test(key)) : null;
      assert.ok(headKey, 'plugin_only keeps the State Head locally');
    }
    if (mode === 'mirror') {
      const headRow = snapshot.getRecords('libra.continuity_state.v2')[0];
      assert.ok(headRow, 'mirror holds the State Head on the server');
      assert.ok(snapshot.local.has(headRow.key), 'mirror keeps a local copy of the State Head');
      assert.deepEqual(JSON.parse(snapshot.local.get(headRow.key)), headRow.value,
        'mirror local State Head equals the server value');
    }
    if (mode === 'server_only') {
      assert.deepEqual(localStateKeys(snapshot), [], 'server_only keeps no State Head or correction journal locally');
      const headRow = snapshot.getRecords('libra.continuity_state.v2')[0];
      assert.ok(headRow, 'server_only holds the State Head on the server');
    }

    // --- reload: State is durable, not in-memory ----------------------------
    const callsBeforeReload = fixture.control.calls.length;
    const restarted = await snapshot.restart();
    const reloadedFixture = snapshot.f;
    const reloadedHead = headOf(snapshot);
    assert.equal(reloadedHead?.status, 'ready', `${mode}: the head survives a reload`);
    assert.equal(reloadedHead?.throughTurn, 5, `${mode}: the reloaded head covers the same range`);
    assert.equal(worldCondition(snapshot, worldRow.id), '휴관 중', `${mode}: the active correction survives a reload`);
    // Read the journal through the RESTARTED runtime: the previous fixture was
    // disposed by `restart()`, so its API is no longer a valid read path.
    const reloadedJournal = await correctionJournalOf(reloadedFixture);
    assert.equal(reloadedJournal?.records?.length, 1, `${mode}: the journal survives a reload without duplication`);
    assert.equal(restarted.control.calls.length, 0, `${mode}: reload is non-generative`);
    assert.equal(callsBeforeReload, callsAfterRun, `${mode}: no extra model call happened anywhere in this scenario`);
    observations.reload = { headStatus: reloadedHead?.status, journalRecords: reloadedJournal?.records?.length ?? null, modelCallsAfterReload: restarted.control.calls.length };
    return observations;
  } finally {
    await snapshot.cleanup();
  }
}

// Branch-specific correction isolation (plan Step 2) is NOT covered by this test
// and is not claimed as verified. Its entry point is `setStateWorldline` →
// `inheritStateCorrectionsForWorldlineFork`, and this run measured that
// `setWorldManagerWorldline` is bounded to `plugin_only`
// (UNIFIED_BACKEND_NOT_SUPPORTED in mirror/server_only, see `observations.worldline`).
// So branch isolation can currently only be exercised in one of the three modes,
// which is not storage-mode parity. It needs either the server-side worldline
// implementation or its own plugin_only-scoped test; it is recorded as open in the
// plan and the backlog rather than silently skipped.
(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);

  // The revision counter is deliberately NOT part of the parity projection: it is
  // the one thing that legitimately differs (see the FINDING block). Everything
  // logical must match exactly.
  const project = mode => {
    const { head, correction, rebuild, reload } = results[mode];
    const { journalWritesOnAuthority, ...logicalCorrection } = correction;
    return { head, correction: logicalCorrection, rebuild, reload };
  };
  assert.deepEqual(project('mirror'), project('plugin_only'), 'mirror produces the same State verdict as plugin_only');
  assert.deepEqual(project('server_only'), project('plugin_only'), 'server_only produces the same State verdict as plugin_only');
  // The two view operations now reach the SAME success in every mode (T01), so
  // the parity projection above already covers them. The bounded operation that
  // remains is the named logical fork, asserted inside each mode.
  assert.deepEqual(
    SERVER_BACKED.map(mode => results[mode].worldline),
    [{ rollback: 'ok', setWorldline: 'ok', modelCalls: results.plugin_only.worldline.modelCalls },
     { rollback: 'ok', setWorldline: 'ok', modelCalls: results.plugin_only.worldline.modelCalls }],
    'both server-backed modes now reach the same State view success as plugin_only'
  );

    // --- duplicate local journal write: FIXED, kept as a regression guard ----
    // One status change must write the correction journal exactly once in EVERY
    // mode. This was broken in plugin_only (revisions 2 then 3 because
    // `setStateCorrectionStatus` saved the journal and the follow-up replay saved
    // it again); the fix passes the already-saved journal through `storeOverride`
    // so the replay no longer re-writes it. The assertion stays so the defect
    // cannot silently return.
    for (const mode of MODES) {
      const writes = results[mode].correction.journalWritesOnAuthority;
      assert.equal(writes.suspend, EXPECTED_JOURNAL_WRITES_PER_STATUS_CHANGE,
        `${mode}: one suspend writes the correction journal exactly once, saw ${writes.suspend}`);
      assert.equal(writes.activate, EXPECTED_JOURNAL_WRITES_PER_STATUS_CHANGE,
        `${mode}: one reactivate writes the correction journal exactly once, saw ${writes.activate}`);
    }
    assert.deepEqual(
      MODES.map(mode => results[mode].correction.journalRevisionFinal),
      [3, 3, 3],
      'the journal revision now advances identically (+1 per status change) in all three modes'
    );

  console.log(JSON.stringify({
    test: 'libra_world_manager_state_3mode_parity',
    passed: 1,
    boundary: 'real deployed LIBRA public State API + real HTTP/SQLite storage in three modes; synthetic RisuAI/LLM boundary only',
    finding: 'rollbackWorldManagerState and setWorldManagerWorldline are bounded to plugin_only: in mirror/server_only they fail closed with UNIFIED_BACKEND_NOT_SUPPORTED instead of silently downgrading state to local-only',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
