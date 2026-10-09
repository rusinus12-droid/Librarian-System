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

  let faultListener;
  const fault = await serverFixture({mode: 'mirror', host: {
    addRisuChatListener: async (_kind, handler) => { faultListener = handler; return true; }
  }});
  try {
    fault.f.chat.message = fault.f.chat.message.slice(0, 2);
    fault.f.chat.messages = fault.f.chat.message;
    const originalSet = fault.backend.setItem;
    let failCapture = true;
    fault.backend.setItem = async (key, value) => {
      if (failCapture && String(key).includes(':source-receipt-capture:')) {
        failCapture = false;
        throw new Error('injected local capture provenance failure');
      }
      return await originalSet(key, value);
    };
    const event = {char: fault.f.character, chat: fault.f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    faultListener(event);
    await waitFor(() => fault.f.r.api.getCaptureBackendState().lastOutputCapture?.captureStatus === 'pending_reconciliation', 10000);
    await waitFor(() => fault.f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
    const callsBeforeRepair = fault.f.control.calls.length;
    assert.equal((await fault.f.r.api.debugReadActiveCompletedTurnReceipt(1)).status, 'verified',
      'provenance copy failure must not retract the already verified source receipt');
    faultListener(event);
    await waitFor(() => fault.f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true
      && fault.f.r.api.getCaptureBackendState().lastOutputCapture?.captureStatus === 'verified', 10000);
    const localCapture = localRows(fault.local).find(row => row.value?.schema === 'libra.completed_turn_capture.v1')?.value;
    const remoteCapture = fault.storedRows().find(row => row.value?.schema === 'libra.completed_turn_capture.v1')?.value;
    assert.deepEqual(localCapture, remoteCapture, 'duplicate repairs the same provenance payload across mirror copies');
    assert.equal(fault.f.control.calls.length, callsBeforeRepair, 'capture provenance transport never reruns analysis');
    console.log('PASS one-sided mirror capture provenance repairs without analysis');
  } finally { await fault.cleanup(); }

  const fallback = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async () => false,
    addRisuScriptHandler: async () => false
  }});
  try {
    fallback.f.chat.message = fallback.f.chat.message.slice(0, 2);
    fallback.f.chat.messages = fallback.f.chat.message;
    await fallback.f.r.sourceEditBoundary();
    await waitFor(() => localRows(fallback.local).some(row => row.value?.schema === 'libra.completed_turn_capture.v1'), 10000);
    const captured = localRows(fallback.local).find(row => row.value?.schema === 'libra.completed_turn_capture.v1')?.value;
    assert.equal(captured.captureSource, 'completed_pair_reconcile', 'fallback identifies the validated completed-pair path');
    assert.equal(captured.captureSources.length, 1);
    await waitFor(() => fallback.f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
    assert.equal((await fallback.f.r.api.getReceiptRecoveryStatus()).microJobs[0].status,'unknown');
    assert.equal(fallback.f.control.calls.length, 0, 'fallback receipt without planned proof cannot start Micro');
    console.log('PASS fallback capture provenance persists without provider');
  } finally { await fallback.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
