'use strict';

const assert = require('node:assert/strict');
const {
  createStore,
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });
const missingTurnMessages = suffix => [
  user(`${suffix}-u1`, 'I enter the archive.'),
  assistant(`${suffix}-a1`, hiddenPacketMessage(
    'Alice entered the archive.',
    createValidPacket({ turn: 1, summary: 'Alice entered the archive.' })
  )),
  user(`${suffix}-u2`, 'I open the cedar chest.'),
  assistant(`${suffix}-a2`, 'Alice opened the cedar chest and found a blue ribbon.')
];

const captureFailureId = async runtime => {
  runtime.setLlmResponder(async () => ({ type: 'success', result: 'not-json-failed-analysis-delete-fixture' }));
  let result;
  try {
    result = await runtime.hayaku.recovery.repairNow({ reason: 'failed_analysis_delete_test' });
  } catch (error) {
    result = error;
  }
  const failureId = result?.failureId || result?.failedAnalysisId || Array.from(result?.failedAnalysisIds || [])[0] || '';
  assert.ok(failureId, 'fixture must create one Failed Recovery record');
  const detail = await runtime.hayaku.recovery.failedAnalysis.read(failureId);
  assert.equal(detail.available, true);
  assert.equal(detail.durable, true);
  return { failureId, detail };
};

const snapshotEvidence = store => new Map(
  Array.from(store.values.entries()).filter(([key]) => (
    key.startsWith('hayaku.v2.recovery_vault.')
    || key.startsWith('hayaku.v2.recovery_evidence_manifest.')
    || key.startsWith('hayaku.v2.recovery_evidence_chunk.')
  ))
);

(async () => {
  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: missingTurnMessages('delete-success')
  });
  try {
    const { failureId, detail } = await captureFailureId(runtime);
    const evidenceBefore = snapshotEvidence(runtime.pluginStorage);
    assert.ok(evidenceBefore.size >= 2, 'Recovery Journal and exact evidence sidecar must exist before deletion');

    const concurrentSaveInput = {
      scopeKey: detail.manifest.scopeKey,
      kind: 'incremental_recovery',
      flow: 'failed_analysis_delete_concurrency_fixture',
      chunk: { turn: 99, text: '[Turn 99]\nUser: concurrent\nAssistant: preserved' },
      context: {},
      attempts: [{ mode: 'fixture', rawResponse: 'concurrent-invalid', rawChars: 18, rawHash: 'fixture-hash' }],
      failure: { code: 'FIXTURE', message: 'concurrent failure must remain indexed' }
    };
    const [deletion, concurrentSave] = await Promise.all([
      runtime.hayaku.recovery.failedAnalysis.delete(failureId),
      runtime.hayaku._test.saveFailedAnalysisArtifact(concurrentSaveInput)
    ]);
    assert.equal(deletion.ok, true);
    assert.equal(deletion.deleted, true);
    assert.equal(deletion.durable, true);
    assert.equal(deletion.reason, 'failed_analysis_deleted_verified');
    assert.equal(deletion.recoveryEvidencePreserved, true);
    assert.equal(concurrentSave.durable, true, 'concurrent failure write must complete after the serialized deletion');

    const listed = await runtime.hayaku.recovery.failedAnalysis.list();
    assert.equal(Array.from(listed.entries || []).some(entry => entry.failureId === failureId), false,
      'deleted failure must be absent from the durable index readback');
    assert.equal(Array.from(listed.entries || []).some(entry => entry.failureId === concurrentSave.failureId), true,
      'serialized deletion must not drop a concurrently-created failure index entry');
    const readback = await runtime.hayaku.recovery.failedAnalysis.read(failureId);
    assert.equal(readback.available, false, 'deleted manifest/chunks must not reconstruct after removal');
    assert.equal(runtime.pluginStorage.values.has(detail.manifestKey), false, 'manifest must be physically absent');
    for (const chunk of Array.from(detail.manifest.chunks || [])) {
      assert.equal(runtime.pluginStorage.values.has(chunk.key), false, `chunk must be physically absent: ${chunk.key}`);
    }
    assert.deepEqual(snapshotEvidence(runtime.pluginStorage), evidenceBefore,
      'deleting a Failed Recovery record must not mutate Recovery Journal or exact U+A evidence');
  } finally {
    await runtime.dispose();
  }

  const rollbackStore = createStore();
  const rollbackRuntime = await createHayakuRuntime({
    autoRepair: false,
    pluginStorage: rollbackStore,
    messages: missingTurnMessages('delete-rollback')
  });
  try {
    const { failureId, detail } = await captureFailureId(rollbackRuntime);
    const evidenceBefore = snapshotEvidence(rollbackStore);
    const originalRemove = rollbackStore.removeItem.bind(rollbackStore);
    let injected = false;
    rollbackStore.removeItem = async key => {
      const normalized = String(key);
      if (!injected && normalized === detail.manifestKey) {
        injected = true;
        await originalRemove(normalized);
        return false;
      }
      return await originalRemove(normalized);
    };

    const deletion = await rollbackRuntime.hayaku.recovery.failedAnalysis.delete(failureId);
    assert.equal(injected, true, 'fixture must interrupt deletion after at least one physical mutation');
    assert.equal(deletion.ok, false);
    assert.equal(deletion.deleted, false);
    assert.equal(deletion.reason, 'failed_analysis_delete_failed_rolled_back');
    assert.equal(deletion.rollback.ok, true);

    const restored = await rollbackRuntime.hayaku.recovery.failedAnalysis.read(failureId);
    assert.equal(restored.available, true, 'failed deletion must restore the exact artifact');
    assert.equal(restored.durable, true);
    assert.equal(restored.payloadHash, detail.payloadHash);
    const listed = await rollbackRuntime.hayaku.recovery.failedAnalysis.list();
    assert.equal(Array.from(listed.entries || []).some(entry => entry.failureId === failureId), true,
      'failed deletion must leave the index entry visible');
    assert.deepEqual(snapshotEvidence(rollbackStore), evidenceBefore,
      'rollback must not mutate Recovery Journal or exact U+A evidence');
  } finally {
    await rollbackRuntime.dispose();
  }

  console.log('PASS hayaku_failed_analysis_delete_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
