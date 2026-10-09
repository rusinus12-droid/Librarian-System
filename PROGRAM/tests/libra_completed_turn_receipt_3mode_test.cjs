'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const receiptRows = rows => rows.filter(row => row.value?.schema === 'libra.completed_turn_receipt.v1');
const headRows = rows => rows.filter(row => row.value?.schema === 'libra.completed_turn_head.v1');
const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});
const waitForHistoricalUnknown = async (api, count) => {
  const started=Date.now();
  while(Date.now()-started<15000){
    const jobs=(await api.getReceiptRecoveryStatus()).microJobs;
    if(jobs.length===count && jobs.every(job=>job.status==='unknown'))return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('Historical Micro work did not settle to unknown without physical invocation');
};

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let outputListener;
    const fixture = await serverFixture({mode, host: {addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; }}});
    try {
      const {f} = fixture;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
        const receipt = active.receipt;
        const quote = receipt.assistant.text.slice(0, 50);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
            turn: receipt.turn, sourceRevisionId: receipt.revisionId,
            sourceDigest: receipt.sourceDigest, claims: [{changeKind: 'event',
              text: '완료된 한 턴의 장면', actor: '', target: '', temporalRole: 'current',
              certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none',
              evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
                startOffset: 0, endOffset: quote.length, exactQuote: quote}}]}
        })};
      };
      const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
      assert.equal(typeof outputListener, 'function', `${mode}: production output listener registered`);
      outputListener(event);
      const first = await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus && f.r.api.getCaptureBackendState().lastOutputCapture, 10000);
      assert.equal(first.turn, 1, `${mode}: completed pair`);
      assert.equal(first.receiptStatus, 'verified', `${mode}: receipt must pass physical readback`);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
      assert.equal(f.control.calls.length, 1, `${mode}: verified receipt starts one independent Micro job`);
      assert.match(JSON.stringify(f.control.calls[0]), /LIBRA MICRO SOURCE CONTRACT/);

      const local = localRows(fixture.local), remote = fixture.storedRows();
      const expectedLocal = mode !== 'server_only' ? 1 : 0;
      const expectedRemote = mode !== 'plugin_only' ? 1 : 0;
      assert.equal(receiptRows(local).length, expectedLocal, `${mode}: local immutable receipt count`);
      assert.equal(headRows(local).length, expectedLocal, `${mode}: local active head count`);
      assert.equal(receiptRows(remote).length, expectedRemote, `${mode}: server immutable receipt count`);
      assert.equal(headRows(remote).length, expectedRemote, `${mode}: server active head count`);
      const row = receiptRows(mode === 'server_only' ? remote : local)[0]?.value;
      assert.equal(row?.turn, 1);
      assert.equal(row?.user?.text, f.chat.message[0].data);
      assert.equal(row?.assistant?.text, f.chat.message[1].data);

      outputListener(event);
      const duplicate = await waitFor(() => f.r.api.getCaptureBackendState().duplicateDrops > 0 && f.r.api.getCaptureBackendState().lastOutputCapture, 10000);
      assert.equal(duplicate.receiptStatus, 'verified', `${mode}: duplicate rechecks durable state`);
      assert.equal(receiptRows(localRows(fixture.local)).length, expectedLocal, `${mode}: duplicate does not create local revision`);
      assert.equal(receiptRows(fixture.storedRows()).length, expectedRemote, `${mode}: duplicate does not create server revision`);
      assert.equal(f.control.calls.length, 1, `${mode}: duplicate does not call the model again`);

      f.chat.message[1].data += ' 수정된 완료 응답.';
      outputListener(event);
      const revised = await waitFor(() => {
        const current = f.r.api.getCaptureBackendState().lastOutputCapture;
        return current?.revision === 2 && current.receiptStatus === 'verified' && current;
      }, 10000);
      assert.notEqual(revised.receiptRevisionId, first.receiptRevisionId, `${mode}: edit creates a distinct source revision`);
      assert.equal(receiptRows(localRows(fixture.local)).length, expectedLocal * 2, `${mode}: local old revision retained`);
      assert.equal(receiptRows(fixture.storedRows()).length, expectedRemote * 2, `${mode}: server old revision retained`);
      const active = headRows(mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local))[0]?.value;
      assert.equal(active?.revisionId, revised.receiptRevisionId, `${mode}: new revision alone is active`);
      console.log(`PASS completed-turn receipt in ${mode}`);
    } finally { await fixture.cleanup(); }
  }

  const fallback = await serverFixture({mode: 'plugin_only'});
  try {
    fallback.f.chat.message = fallback.f.chat.message.slice(0, 2);
    fallback.f.chat.messages = fallback.f.chat.message;
    fallback.f.control.modelFails = true;
    await fallback.f.run();
    assert.equal(receiptRows(localRows(fallback.local)).length, 1, 'manual completed-pair reconcile captures T1');
    await waitForHistoricalUnknown(fallback.f.r.api,1);
    assert.equal((await fallback.f.r.api.getReceiptRecoveryStatus()).microJobs[0].status,'unknown',
      'a historical reconcile has no durable proof of a never-started Micro call');
    assert.equal(fallback.f.control.calls.filter(args=>JSON.stringify(args).includes('LIBRA MICRO SOURCE CONTRACT')).length,0,
      'historical receipt reconciliation cannot infer a free model call');
    console.log('PASS T1 completed-pair reconcile without provider');
  } finally { await fallback.cleanup(); }

  const fiveTurns = await serverFixture({mode: 'plugin_only'});
  try {
    await fiveTurns.f.run();
    await waitForHistoricalUnknown(fiveTurns.f.r.api,5);
    assert.equal(receiptRows(localRows(fiveTurns.local)).length, 5, 'T5 scan preserves each completed U+A receipt');
    const manifest = localRows(fiveTurns.local).find(row => row.key.endsWith(':manifest'))?.value;
    assert(manifest?.memories?.['1'], 'T5 Canonical remains independently committed');
    assert.deepEqual(Array.from((await fiveTurns.f.r.api.getReceiptRecoveryStatus()).microJobs, row=>row.status),
      ['unknown','unknown','unknown','unknown','unknown'],
      'historical receipts remain available without an inferred Micro invocation');
    console.log('PASS T5 records five receipts alongside Canonical');
  } finally { await fiveTurns.cleanup(); }

  let restartListener;
  const restartable = await serverFixture({mode: 'plugin_only', host: {addRisuChatListener: async (_kind, handler) => { restartListener = handler; return true; }}});
  try {
    restartable.f.chat.message = restartable.f.chat.message.slice(0, 2);
    restartable.f.chat.messages = restartable.f.chat.message;
    restartListener({char: restartable.f.character, chat: restartable.f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await waitFor(() => restartable.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
    const firstKey = receiptRows(localRows(restartable.local))[0].key;
    const resumed = await restartable.restart();
    resumed.chat.message = resumed.chat.message.slice(0, 2);
    resumed.chat.messages = resumed.chat.message;
    restartListener({char: resumed.character, chat: resumed.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await waitFor(() => resumed.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
    assert.equal(receiptRows(localRows(restartable.local)).length, 1, 'restart does not create another immutable revision');
    assert.equal(receiptRows(localRows(restartable.local))[0].key, firstKey, 'revision key is stable across restart');
    console.log('PASS completed-turn revision survives restart');
  } finally { await restartable.cleanup(); }

  let legacyOutput;
  const legacy = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async () => false,
    addRisuScriptHandler: async (kind, handler) => { if (kind === 'output') legacyOutput = handler; return true; }
  }});
  try {
    legacy.f.chat.message = legacy.f.chat.message.slice(0, 2);
    legacy.f.chat.messages = legacy.f.chat.message;
    assert.equal(typeof legacyOutput, 'function');
    legacyOutput('completed legacy output');
    await waitFor(() => receiptRows(localRows(legacy.local)).length === 1, 10000);
    assert.equal(headRows(localRows(legacy.local)).length, 1, 'legacy T1 reconcile publishes a verified head');
    await waitForHistoricalUnknown(legacy.f.r.api,1);
    assert.equal((await legacy.f.r.api.getReceiptRecoveryStatus()).microJobs[0].status,'unknown');
    assert.equal(legacy.f.control.calls.length, 0, 'legacy output has no durable never-started marker');
    console.log('PASS legacy completed output reconciles T1 without waiting for T5');
  } finally { await legacy.cleanup(); }

  let faultyListener;
  const faulty = await serverFixture({mode: 'mirror', host: {addRisuChatListener: async (_kind, handler) => { faultyListener = handler; return true; }}});
  try {
    faulty.f.chat.message = faulty.f.chat.message.slice(0, 2);
    faulty.f.chat.messages = faulty.f.chat.message;
    const originalSet = faulty.backend.setItem;
    let failLocalCopy = true;
    faulty.backend.setItem = async (key, value) => {
      if (failLocalCopy && String(key).includes(':source-receipt:')) {
        failLocalCopy = false;
        throw new Error('injected local receipt copy failure');
      }
      return await originalSet(key, value);
    };
    const event = {char: faulty.f.character, chat: faulty.f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    faultyListener(event);
    const pending = await waitFor(() => faulty.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'pending_reconciliation'
      && faulty.f.r.api.getCaptureBackendState().lastOutputCapture, 10000);
    assert.match(pending.receiptError, /COPY_MISMATCH|READBACK|copy failure/i);
    assert.equal(receiptRows(faulty.storedRows()).length, 1, 'server receipt is retained after local copy failure');
    assert.equal(headRows(faulty.storedRows()).length, 0, 'one-sided receipt cannot publish a head');
    faultyListener(event);
    const repaired = await waitFor(() => faulty.f.r.api.getCaptureBackendState().duplicateDrops > 0
      && faulty.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified'
      && faulty.f.r.api.getCaptureBackendState().lastOutputCapture, 10000);
    assert.equal(repaired.receiptError, '');
    assert.equal(receiptRows(localRows(faulty.local)).length, 1);
    assert.equal(headRows(localRows(faulty.local)).length, 1);
    assert.equal(headRows(faulty.storedRows()).length, 1);
    await waitFor(() => faulty.f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
    assert.equal(faulty.f.control.calls.length, 1, 'receipt repair starts the first Micro job only after readback');
    console.log('PASS one-sided mirror receipt remains pending and duplicate repairs it');
  } finally { await faulty.cleanup(); }

  let headListener;
  const headFault = await serverFixture({mode: 'mirror', host: {addRisuChatListener: async (_kind, handler) => { headListener = handler; return true; }}});
  try {
    headFault.f.chat.message = headFault.f.chat.message.slice(0, 2);
    headFault.f.chat.messages = headFault.f.chat.message;
    const originalSet = headFault.backend.setItem;
    let failHeadCopy = true;
    headFault.backend.setItem = async (key, value) => {
      if (failHeadCopy && String(key).includes(':source-receipt-head:')) {
        failHeadCopy = false;
        throw new Error('injected local head copy failure');
      }
      return await originalSet(key, value);
    };
    const event = {char: headFault.f.character, chat: headFault.f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    headListener(event);
    await waitFor(() => headFault.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'pending_reconciliation', 10000);
    assert.equal(receiptRows(headFault.storedRows()).length, 1);
    assert.equal(headRows(headFault.storedRows()).length, 1, 'server pointer survives local copy failure');
    assert.equal(headRows(localRows(headFault.local)).length, 0, 'local pointer is still missing');
    headListener(event);
    await waitFor(() => headFault.f.r.api.getCaptureBackendState().duplicateDrops > 0
      && headFault.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
    assert.equal(headRows(localRows(headFault.local)).length, 1, 'duplicate repairs local pointer');
    assert.equal(receiptRows(headFault.storedRows()).length, 1, 'repair does not create a new revision');
    await waitFor(() => headFault.f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
    assert.equal(headFault.f.control.calls.length, 1, 'head repair starts one Micro job after readback');
    console.log('PASS one-sided mirror head is repaired from the same source revision');
  } finally { await headFault.cleanup(); }

  let missingListener;
  const missingCopy = await serverFixture({mode: 'mirror', host: {addRisuChatListener: async (_kind, handler) => { missingListener = handler; return true; }}});
  try {
    missingCopy.f.chat.message = missingCopy.f.chat.message.slice(0, 2);
    missingCopy.f.chat.messages = missingCopy.f.chat.message;
    const event = {char: missingCopy.f.character, chat: missingCopy.f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    missingListener(event);
    await waitFor(() => missingCopy.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
    const receiptKey = receiptRows(localRows(missingCopy.local))[0]?.key;
    missingCopy.local.delete(receiptKey);
    missingListener(event);
    await waitFor(() => missingCopy.f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true
      && missingCopy.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
    assert.equal(receiptRows(localRows(missingCopy.local)).length, 1, 'missing local receipt copy is restored');
    assert.equal(headRows(localRows(missingCopy.local)).length, 1, 'verified head remains active');
    assert.equal(receiptRows(missingCopy.storedRows()).length, 1, 'no new server revision key');
    console.log('PASS duplicate capture repairs a missing mirror receipt copy');
  } finally { await missingCopy.cleanup(); }

  let staleListener;
  const stale = await serverFixture({mode: 'plugin_only', host: {addRisuChatListener: async (_kind, handler) => { staleListener = handler; return true; }}});
  try {
    stale.f.chat.message = stale.f.chat.message.slice(0, 2);
    stale.f.chat.messages = stale.f.chat.message;
    const originalSet = stale.backend.setItem;
    let editDuringWrite = true;
    stale.backend.setItem = async (key, value) => {
      const result = await originalSet(key, value);
      if (editDuringWrite && String(key).includes(':source-receipt:')) {
        editDuringWrite = false;
        stale.f.chat.message[1].data += ' 저장 중 편집됨.';
      }
      return result;
    };
    const event = {char: stale.f.character, chat: stale.f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    staleListener(event);
    const rejected = await waitFor(() => stale.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'pending_reconciliation'
      && stale.f.r.api.getCaptureBackendState().lastOutputCapture, 10000);
    assert.match(rejected.receiptError, /SOURCE_CHANGED/);
    assert.equal(receiptRows(localRows(stale.local)).length, 1, 'old immutable receipt survives');
    assert.equal(headRows(localRows(stale.local)).length, 0, 'stale source cannot publish head');
    staleListener(event);
    const current = await waitFor(() => stale.f.r.api.getCaptureBackendState().lastOutputCapture?.revision === 2
      && stale.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified'
      && stale.f.r.api.getCaptureBackendState().lastOutputCapture, 10000);
    assert.equal(receiptRows(localRows(stale.local)).length, 2);
    assert.equal(headRows(localRows(stale.local))[0]?.value.revisionId, current.receiptRevisionId);
    console.log('PASS source edit during storage cannot activate stale receipt');
  } finally { await stale.cleanup(); }

  const settling = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async () => false,
    addRisuScriptHandler: async () => false
  }});
  try {
    settling.f.chat.message = settling.f.chat.message.slice(0, 2);
    settling.f.chat.messages = settling.f.chat.message;
    const finalText = settling.f.chat.message[1].data + ' 완료 직전 수정.';
    await settling.f.r.sourceEditBoundary();
    setTimeout(() => { settling.f.chat.message[1].data = finalText; }, 160);
    await waitFor(() => headRows(localRows(settling.local)).length === 1, 10000);
    const receipts = receiptRows(localRows(settling.local));
    assert.equal(receipts.length, 1, 'fallback settles the current pair before its first receipt write');
    assert.equal(receipts[0].value.assistant.text, finalText);
    console.log('PASS fallback waits for stable completed source before persisting');
  } finally { await settling.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
