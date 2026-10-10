'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let outputListener;
    const host = {addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; }};
    const fixture = await serverFixture({mode, host});
    try {
      const {f} = fixture;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      assert.equal(typeof f.r.api.debugReadActiveCompletedTurnReceipt, 'function',
        `${mode}: active receipt reader must be wired through the production core`);
      const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
      outputListener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);

      const active = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
      assert.equal(active.status, 'verified', `${mode}: active head and receipt pass physical readback`);
      assert.equal(active.receipt.assistant.text, f.chat.message[1].data);
      assert.equal(active.receipt.revisionId, active.head.revisionId);
      const captureRows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
      const captured = captureRows.find(row => row.value?.schema === 'libra.completed_turn_capture.v1'
        && row.value?.revisionId === active.receipt.revisionId)?.value;
      assert.equal(captured?.captureSource, 'risu_chat_output', `${mode}: official hook provenance is durable`);
      assert.equal(captured?.receiptKey, active.receiptKey);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.revisionId === active.receipt.revisionId
        && f.r.api.getCaptureBackendState().lastMicroPublication?.status === 'verified', 10000);
      assert.equal(f.control.calls.length, 1, `${mode}: first verified revision starts Micro analysis`);

      f.chat.message[1].data += ' 영수증 이후 수정.';
      const stale = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
      assert.equal(stale.status, 'stale_source', `${mode}: an edited source invalidates the old active head`);
      assert.equal(stale.receipt, null, `${mode}: old source cannot be consumed as current`);

      outputListener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.revision === 2
        && f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
      const revised = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
      assert.equal(revised.status, 'verified');
      assert.equal(revised.receipt.assistant.text, f.chat.message[1].data);
      assert.notEqual(revised.receiptKey, active.receiptKey);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.revisionId === revised.receipt.revisionId, 10000);
      const callsAfterRevisions = f.control.calls.length;
      assert.equal(callsAfterRevisions, 2, `${mode}: each verified source revision starts one Micro analysis`);

      if (mode === 'mirror') {
        fixture.local.delete(revised.receiptKey);
        const partial = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
        assert.equal(partial.status, 'pending_reconciliation', 'a missing mirror copy is not verified');
        assert.equal(partial.receipt, null);
        outputListener(event);
        await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true
          && f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
        assert.equal((await f.r.api.debugReadActiveCompletedTurnReceipt(1)).status, 'verified');
        assert.equal(localRows(fixture.local).filter(row => row.value?.schema === 'libra.completed_turn_receipt.v1').length, 2);
      }
      assert.equal(f.control.calls.length, callsAfterRevisions, `${mode}: reading and repair do not reanalyse`);
      console.log(`PASS active completed-turn receipt lifecycle in ${mode}`);
    } finally { await fixture.cleanup(); }
  }

  // Run this independent fixture before the retained split-capture repair case.
  // A failure in that unresolved positive must not hide fallback's current contract.
  const fallback = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async () => false,
    addRisuScriptHandler: async () => false
  }});
  try {
    fallback.f.chat.message = fallback.f.chat.message.slice(0, 2);
    fallback.f.chat.messages = fallback.f.chat.message;
    await fallback.f.r.sourceEditBoundary();
    await waitFor(() => localRows(fallback.local).some(row => row.value?.schema === 'libra.completed_turn_capture.v1'), 10000);
    const active = await fallback.f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(active.status, 'verified', 'fallback must produce an active receipt before no-call checks');
    assert.equal(active.receipt.assistant.text, fallback.f.chat.message[1].data);
    const captured = localRows(fallback.local).find(row => row.value?.schema === 'libra.completed_turn_capture.v1'
      && row.value.receiptKey === active.receiptKey)?.value;
    assert.equal(captured.captureSource, 'completed_pair_reconcile', 'fallback identifies the validated completed-pair path');
    assert.equal(captured.captureSources.length, 1);
    assert.equal(captured.revisionId, active.receipt.revisionId);
    const raw = await fallback.f.r.api.debugReadActiveRawPacket(1);
    assert.equal(raw.status, 'verified', 'fallback has verified original raw, not merely a no-call result');
    const physicalReceipt = JSON.parse(fallback.local.get(active.receiptKey));
    assert.deepEqual(JSON.parse(JSON.stringify(raw.packet)), physicalReceipt.rawSourcePacket);
    await waitFor(() => fallback.f.r.api.getCaptureBackendState().lastMicroPublication?.revisionId === active.receipt.revisionId
      && fallback.f.r.api.getCaptureBackendState().microQueuedJobs === 0, 10000);
    const status = await fallback.f.r.api.getReceiptRecoveryStatus();
    const receiptStage = status.receiptStages.find(row => row.receiptRef === active.receiptKey);
    assert.equal(receiptStage?.status, 'verified');
    const stage = status.microJobs.find(row => row.receiptRef === active.receiptKey);
    assert.equal(stage?.status, 'unknown');
    assert.equal(stage.turn, 1);
    assert.equal(stage.scopeKey, active.receipt.scopeKey);
    assert.equal(stage.revisionId, active.receipt.revisionId);
    assert.equal(stage.sourceDigest, active.receipt.sourceDigest);
    assert.equal(stage.physicalAttemptsUsed, 0);
    assert.equal(stage.logicalAttempts, 0);
    assert.equal(stage.attemptId, '');
    assert.deepEqual(Array.from(stage.history), []);
    assert.equal(localRows(fallback.local).filter(row => row.value?.schema === 'libra.micro_work.v1'
      && row.value.receiptKey === active.receiptKey).length, 0, 'fallback must not backfill automatic work');
    assert.equal(fallback.f.control.calls.length, 0, 'fallback receipt without planned proof cannot start Micro');
    assert.deepEqual((await fallback.f.r.api.getReceiptRecoveryStatus()).microJobs, status.microJobs);
    assert.equal(fallback.f.control.calls.length, 0, 'status read remains provider-silent');
    console.log('PASS fallback capture provenance persists without provider');
  } finally { await fallback.cleanup(); }

  let faultListener;
  const fault = await serverFixture({mode: 'mirror', host: {
    addRisuChatListener: async (_kind, handler) => { faultListener = handler; return true; }
  }});
  let faultEvidence = null;
  let failCapture = true, faultHits = 0, captureWriteAttempts = 0, failedCapture = null;
  try {
    fault.f.chat.message = fault.f.chat.message.slice(0, 2);
    fault.f.chat.messages = fault.f.chat.message;
    const originalSet = fault.backend.setItem;
    fault.backend.setItem = async (key, value) => {
      if (String(key).includes(':source-receipt-capture:')) {
        captureWriteAttempts += 1;
        if (failCapture) {
          failCapture = false;
          faultHits += 1;
          failedCapture = {key: String(key), raw: value};
          throw new Error('injected local capture provenance failure');
        }
      }
      return await originalSet(key, value);
    };
    const event = {char: fault.f.character, chat: fault.f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    faultListener(event);
    // The capture fails before persistCompletedTurnReceipt returns. Its caller sets
    // receiptStatus/receiptError; captureStatus is not assigned on this path.
    await waitFor(() => fault.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'pending_reconciliation', 10000);
    assert.equal(faultHits, 1, 'the intended one-shot local capture failure actually occurred');
    assert.ok(failedCapture?.key);
    const failedDiagnostic = fault.f.r.api.getCaptureBackendState().lastOutputCapture;
    assert.equal(failedDiagnostic.rawDurable, false);
    assert.match(failedDiagnostic.receiptError, /LIBRA_COMPLETED_TURN_RAW_PENDING_RECONCILIATION:/);
    const active = await fault.f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(active.status, 'verified',
      'provenance copy failure must not retract the already verified source receipt');
    assert.equal(active.receipt.assistant.text, fault.f.chat.message[1].data);
    const receiptBytes = fault.local.get(active.receiptKey), headBytes = fault.local.get(active.headKey);
    assert.equal(typeof receiptBytes, 'string');
    assert.equal(typeof headBytes, 'string');
    assert.equal(fault.storedRows().find(row => row.key === active.receiptKey)?.raw, receiptBytes);
    assert.equal(fault.storedRows().find(row => row.key === active.headKey)?.raw, headBytes);
    const expectedCapture = JSON.parse(failedCapture.raw);
    assert.equal(expectedCapture.receiptKey, active.receiptKey);
    assert.equal(expectedCapture.revisionId, active.receipt.revisionId);
    assert.equal(expectedCapture.scopeKey, active.receipt.scopeKey);
    assert.equal(expectedCapture.turn, 1);
    assert.equal(expectedCapture.captureSource, 'risu_chat_output');
    assert.equal(fault.local.has(failedCapture.key), false, 'capture really is split before repair');
    assert.equal(fault.storedRows().find(row => row.key === failedCapture.key)?.raw, failedCapture.raw);
    await waitFor(() => fault.f.r.api.getCaptureBackendState().lastMicroPublication?.revisionId === active.receipt.revisionId
      && fault.f.r.api.getCaptureBackendState().microQueuedJobs === 0, 10000);
    const refusedRaw = await fault.f.r.api.debugReadActiveRawPacket(1);
    assert.equal(refusedRaw.status, 'pending_reconciliation');
    assert.equal(refusedRaw.packet, null, 'split capture must not expose the inline raw as verified');
    assert.match(refusedRaw.reason, /LIBRA_VERIFIED_STORAGE_COPY_MISMATCH:/);
    assert.notEqual((await fault.f.r.api.debugReadActiveMicroMemory(1)).status, 'verified');
    assert.equal(fault.f.control.calls.length, 0, 'no provider invocation is allowed while raw is unverified');

    // The official producer reserves before writing receipt/head/capture. Prove the
    // existing same-runtime plan rather than treating its first safe call as a rerun.
    const plannedRows = localRows(fault.local).filter(row => row.value?.schema === 'libra.micro_work.v1'
      && row.value.receiptKey === active.receiptKey);
    assert.equal(plannedRows.length, 1);
    const {key: workKey, value: planned} = plannedRows[0];
    assert.equal(fault.storedRows().find(row => row.key === workKey)?.raw, fault.local.get(workKey));
    assert.equal(planned.scopeKey, active.receipt.scopeKey);
    assert.equal(planned.worldlineId, active.receipt.worldlineId);
    assert.equal(planned.sessionEpoch, active.receipt.sessionEpoch);
    assert.equal(planned.turn, 1);
    assert.equal(planned.sourceRevisionId, active.receipt.revisionId);
    assert.equal(planned.sourceDigest, active.receipt.sourceDigest);
    assert.equal(planned.status, 'reserved');
    assert.equal(planned.phase, 'planned');
    assert.equal(planned.planProvenance, 'risu_chat_output_fresh_receipt');
    assert.ok(planned.planRuntimeToken);
    assert.equal(planned.logicalAttempts, 1);
    assert.equal(planned.physicalAttemptsUsed, 0);
    assert.equal(Boolean(planned.invocationStartedAt), false);
    assert.deepEqual(planned.attemptHistory, []);
    assert.equal(planned.result, null);
    const beforeStatus = await fault.f.r.api.getReceiptRecoveryStatus();
    const plannedStage = beforeStatus.microJobs.find(row => row.receiptRef === active.receiptKey);
    assert.equal(plannedStage?.status, 'never_started', 'status validates current runtime/restore plan proof');
    assert.equal(plannedStage.revisionId, active.receipt.revisionId);
    assert.equal(plannedStage.attemptId, planned.attemptId);
    assert.equal(plannedStage.physicalAttemptsUsed, 0);
    assert.equal(fault.f.control.calls.length, 0, 'status must not invoke the admitted plan');
    faultEvidence = {stage: 'split_observed', faultHits, captureWriteAttempts, failedCapture,
      failedDiagnostic, receiptKey: active.receiptKey, headKey: active.headKey,
      receiptBytes, headBytes, refusedRaw, plannedStage};
    console.log(JSON.stringify({test: 'libra_completed_turn_scope_lifecycle', faultEvidence}));

    faultEvidence.stage = 'await_duplicate_exact_capture_repair';
    faultListener(event);
    // This positive remains mandatory. Do not replace a failed convergence with a
    // pending/unknown assertion or repair the map on behalf of the product.
    await waitFor(() => fault.f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true
      && fault.f.r.api.getCaptureBackendState().lastOutputCapture?.captureStatus === 'verified'
      && fault.local.get(failedCapture.key) === failedCapture.raw
      && fault.storedRows().find(row => row.key === failedCapture.key)?.raw === failedCapture.raw, 10000);
    const localCapture = JSON.parse(fault.local.get(failedCapture.key));
    const remoteCapture = fault.storedRows().find(row => row.key === failedCapture.key)?.value;
    assert.deepEqual(localCapture, remoteCapture, 'duplicate repairs the same provenance payload across mirror copies');
    assert.deepEqual(localCapture, expectedCapture, 'all already-durable raw variants and refs are preserved');
    assert.equal(fault.local.get(active.receiptKey), receiptBytes);
    assert.equal(fault.storedRows().find(row => row.key === active.receiptKey)?.raw, receiptBytes);
    assert.equal(fault.local.get(active.headKey), headBytes);
    assert.equal(fault.storedRows().find(row => row.key === active.headKey)?.raw, headBytes);
    faultEvidence.stage = 'capture_converged_await_initial_analysis';
    const repairedRaw = await fault.f.r.api.debugReadActiveRawPacket(1);
    assert.equal(repairedRaw.status, 'verified');
    assert.deepEqual(JSON.parse(JSON.stringify(repairedRaw.packet)), JSON.parse(receiptBytes).rawSourcePacket);
    assert.deepEqual(JSON.parse(JSON.stringify(repairedRaw.rawPacketRef)), expectedCapture.rawPacketRef);
    await waitFor(() => fault.f.r.api.getCaptureBackendState().lastMicroPublication?.revisionId === active.receipt.revisionId
      && fault.f.r.api.getCaptureBackendState().lastMicroPublication?.status === 'verified'
      && fault.f.r.api.getCaptureBackendState().microQueuedJobs === 0, 10000);
    assert.equal(fault.f.control.calls.length, 1, 'repaired current plan admits exactly its first safe call');
    assert.match(JSON.stringify(fault.f.control.calls[0]), /LIBRA MICRO SOURCE CONTRACT/);
    const completedWork = JSON.parse(fault.local.get(workKey));
    assert.equal(completedWork.attemptId, planned.attemptId);
    assert.equal(completedWork.logicalAttempts, 1);
    assert.equal(completedWork.physicalAttemptsUsed, 1);
    assert.equal(completedWork.status, 'result_ready');
    faultEvidence.stage = 'await_duplicate_no_reanalysis';
    const callsAfterInitialAnalysis = fault.f.control.calls.length;
    const priorDiagnosticAt = fault.f.r.api.getCaptureBackendState().lastOutputCapture.at;
    faultListener(event);
    await waitFor(() => fault.f.r.api.getCaptureBackendState().lastOutputCapture?.at !== priorDiagnosticAt
      && fault.f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true
      && fault.f.r.api.getCaptureBackendState().lastOutputCapture?.captureStatus === 'verified'
      && fault.f.r.api.getCaptureBackendState().microQueuedJobs === 0, 10000);
    await fault.f.r.api.getReceiptRecoveryStatus();
    assert.equal((await fault.f.r.api.debugReadActiveCompletedTurnReceipt(1)).status, 'verified');
    assert.equal((await fault.f.r.api.debugReadActiveRawPacket(1)).status, 'verified');
    assert.equal(fault.f.control.calls.length, callsAfterInitialAnalysis,
      'a subsequent duplicate and status reads never rerun the completed initial analysis');
    assert.equal(fault.local.get(failedCapture.key), failedCapture.raw);
    assert.equal(fault.storedRows().find(row => row.key === failedCapture.key)?.raw, failedCapture.raw);
    assert.equal(faultHits, 1);
    console.log('PASS one-sided mirror capture repairs; one initial analysis, no redundant analysis');
  } catch (error) {
    console.error(JSON.stringify({test: 'libra_completed_turn_scope_lifecycle',
      failedCase: 'mirror_split_capture_lifecycle', faultEvidence, faultHits, captureWriteAttempts,
      currentLocalCapture: failedCapture ? fault.local.get(failedCapture.key) ?? null : null,
      currentRemoteCapture: failedCapture ? fault.storedRows().find(row => row.key === failedCapture.key)?.raw ?? null : null,
      finalCaptureState: fault.f.r.api.getCaptureBackendState(), providerCalls: fault.f.control.calls.length}));
    throw error;
  } finally { await fault.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
