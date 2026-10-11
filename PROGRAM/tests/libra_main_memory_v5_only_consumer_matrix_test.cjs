'use strict';
const assert = require('node:assert/strict');
const { lineageFixture } = require('./fixtures/libra_unified_lineage_fixture.cjs');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { createRootBoundary } = require('./fixtures/source_edit_root_boundary.cjs');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const V5 = 'libra.canonical_artifact.v5';
const info = value => JSON.stringify(value);
const open = async () => {
  const f = await lineageFixture();
  f.control.artifact.schema = V5;
  assert.equal((await f.run()).completed, 1, 'a v5-only chain commits');
  assert.equal(f.manifest()?.memories?.['1']?.artifactSchema, V5,
    'the chain has no v4 ref');
  return f;
};

(async () => {
  const results = {};
  {
    const f = await open();
    try {
      assert.equal(f.head()?.throughTurn, 5, 'v5-only replay reaches State');
      const history = await f.r.api.listWorldManagerHistory({});
      assert.ok(history && typeof history === 'object', 'v5-only history is readable');
      const recall = await f.r.api.previewUnifiedMemoryRecall('은빛 열쇠 반환 약속');
      assert.ok(recall && Array.isArray(recall.memories), 'v5-only recall is readable');
      const migration = await f.r.api.previewUnifiedMemoryTransition();
      assert.equal(migration.legacyRefs?.length, 0, 'v5-only refs never enter the legacy migration path');
      // The canonical operation returns before optional Micro queue settlement.
      await waitFor(() => f.r.api.getCaptureBackendState().microQueuedJobs === 0, 15000);
      const portable = await f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope();
      assert.ok(portable && JSON.stringify(portable).includes(V5), 'portable export carries v5');
      const destination = await lineageFixture();
      try {
        destination.empty('v5-portable-target');
        const preview = await destination.r.api.previewPortableMemoryImport(portable);
        assert.ok(preview && typeof preview === 'object', 'v5-only portable bundle validates');
        const imported = await destination.r.api.importPortableMemoryAsArchive(portable);
        assert.equal(imported.ok, true, `v5-only portable import: ${info(imported)}`);
        assert.equal(destination.head()?.characters?.length, 3, 'v5 portable import replays State');
      } finally { await destination.r.cleanup(); }
      const rolled = await f.r.api.rollbackWorldManagerState({ throughTurn: 0 });
      assert.equal(rolled.ok, true, `v5-only rollback: ${info(rolled)}`);
      const resumed = await f.r.api.setWorldManagerWorldline({worldlineId:'main',cutoffTurn:null});
      assert.equal(resumed.ok, true, `v5-only resume: ${info(resumed)}`);
      assert.equal(f.head()?.throughTurn, 5, 'resume restores v5 State');
      results.replayRollbackHistoryRecallPortable = true;
    } finally { await f.r.cleanup(); }
  }
  {
    const f = await open();
    try {
      f.branch(5, 'v5-native-child');
      const copy = await f.r.api.debugNativeChatCopy({ force: true });
      assert.equal(copy.result?.ok, true, `v5-only native copy: ${info(copy)}`);
      assert.equal(f.head()?.throughTurn, 5, 'v5-only native child replays copied prefix');
      results.nativeCopy = true;
    } finally { await f.r.cleanup(); }
  }
  {
    const f = await open();
    try {
      const prepared = await f.r.api.prepareSessionHandoff({ transferId: 'v5-only-A-B' });
      assert.notEqual(prepared.ok, false, `v5-only handoff prepare: ${info(prepared)}`);
      f.empty('v5-only-target');
      const adopted = await f.r.api.adoptSessionHandoff({ transferId: 'v5-only-A-B', targetChatId: 'v5-only-target' });
      assert.equal(adopted.verified, true, `v5-only handoff adopt: ${info(adopted)}`);
      assert.equal(f.head()?.characters?.length, 3, 'v5-only handoff reconstructs State');
      results.handoff = true;
    } finally { await f.r.cleanup(); }
  }
  {
    const f = await open();
    try {
      f.appendFive();
      f.control.artifact.schema = V5;
      assert.equal((await f.run()).completed, 1, 'second v5-only segment commits');
      assert.deepEqual(Object.values(f.manifest().memories).map(ref => ref.artifactSchema), [V5,V5]);
      assert.equal((await f.r.api.rollbackWorldManagerState({throughTurn:5})).ok, true);
      await assert.rejects(() => f.r.api.prepareSessionHandoff({transferId:'v5-rollback-rejected'}),
        /UNIFIED_HANDOFF_ROLLBACK_REQUIRES_NATIVE_PREFIX/,
        'v5-only handoff refuses to export a rolled-back view as current');
      // The canonical operation returns before optional Micro queue settlement.
      await waitFor(() => f.r.api.getCaptureBackendState().microQueuedJobs === 0, 15000);
      const portable = await f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope();
      const destination = await lineageFixture();
      try {
        destination.empty('v5-rollback-portable-target');
        await assert.rejects(() => destination.r.api.importPortableMemoryAsArchive(portable),
          /UNIFIED_PORTABLE_ROLLBACK_REQUIRES_NATIVE_PREFIX/,
          'v5-only portable import enforces the typed rollback guard');
      } finally { await destination.r.cleanup(); }
      results.rollbackTransferRejected = true;
    } finally { await f.r.cleanup(); }
  }
  {
    const root = createRootBoundary();
    const f = await fixture({host:{getRootDocument:async()=>root.root}});
    try {
      f.control.artifact.schema = V5;
      assert.equal((await f.run()).completed, 1);
      const oldRef = f.getManifest().memories['1'];
      const oldBytes = f.r.values.get(oldRef.key);
      const oldCalls = f.control.calls.length;
      const edited = '서재에서 준호가 열쇠를 지호에게 건넸지만 지호는 민아에게 돌려주지 않았다. 오늘 반환 약속은 아직 이행되지 않았다. 공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.';
      f.chat.message[9].data = edited;
      const replacement = artifact();
      replacement.schema = V5;
      for (const row of [...replacement.entities,...replacement.facts])
        for (const span of row.evidenceSpans) if (span.ref === 't5-a') span.quote = edited;
      replacement.facts.find(row => row.tempFactId === 'f11').values.holderRef = 'jiho';
      replacement.facts.find(row => row.tempFactId === 'f12').values.thread.status = 'open';
      f.control.artifact = replacement;
      await f.r.sourceEditBoundary();
      assert.equal(f.getMemory()?.revision, oldRef.revision, 'passive source edits preserve the approved v5 revision');
      assert.equal(f.r.values.get(oldRef.key), oldBytes, 'passive edits leave approved bytes unchanged');
      assert.equal(f.control.calls.length, oldCalls, 'passive request hooks cannot start reanalysis');
      await waitFor(() => f.r.api.getCaptureBackendState().microQueuedJobs === 0, 15000);
      const inventory = await f.r.api.listCanonicalBatchRanges();
      const selection = { scopeKey: inventory.scopeKey, mode: 'source_edit', ranges: inventory.ranges.filter(row => row.startTurn === 1) };
      assert.equal(selection.ranges.length, 1, 'the explicit operation selects exactly the existing five-turn range');
      assert.equal(f.control.calls.length, oldCalls, 'listing selectable ranges is model-free');
      assert.equal((await f.r.api.startSelectedCanonicalBatches(selection)).ok, true, 'explicit selected reanalysis succeeds');
      assert.equal(f.control.calls.length, oldCalls + 1, 'exactly one explicitly requested canonical call');
      assert.equal(f.getMemory()?.revision, 2, 'explicit v5-only source edit writes a new revision');
      assert.equal(f.getMemory()?.artifactSchema, V5, 'replacement stays v5');
      assert.equal(f.r.values.get(oldRef.key), oldBytes, 'old v5 bytes remain sealed');
      results.sourceEdit = true;
    } finally { await f.r.cleanup(); }
  }
  for (const mode of ['mirror','server_only']) {
    const snapshot = await serverFixture({mode});
    try {
      snapshot.f.control.artifact.schema = V5;
      assert.equal((await snapshot.f.run()).completed, 1, `${mode}: v5 commits`);
      await snapshot.f.r.api.retryPendingUnifiedVectors();
      const deleted = await snapshot.f.r.api.deleteLibraScope();
      assert.equal(deleted.verified, true, `${mode}: v5 scope deletion is verified`);
      assert.equal(deleted.durable, true, `${mode}: v5 scope deletion is durable`);
      results[`scopeDelete_${mode}`] = true;
    } finally { await snapshot.cleanup(); }
  }
  console.log(JSON.stringify({ test:'libra_main_memory_v5_only_consumer_matrix', passed:1, results }));
})().catch(error => { console.error(error); process.exitCode = 1; });
