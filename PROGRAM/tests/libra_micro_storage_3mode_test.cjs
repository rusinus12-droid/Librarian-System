'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});
const records = (rows, schema) => rows.filter(row => row.value?.schema === schema);
const microRetryInput = async f => {
  const active=await f.r.api.debugReadActiveCompletedTurnReceipt(1);
  return {scope:{scopeKey:active.receipt.scopeKey,characterId:active.receipt.characterId,
    chatId:active.receipt.chatId},receiptRef:active.receiptKey,
    revision:active.receipt.revisionId,digest:active.receipt.sourceDigest,expectedGeneration:0};
};
const microEnvelope = receipt => {
  const quote = receipt.assistant.text.slice(0, Math.min(50, receipt.assistant.text.length));
  return {type: 'success', result: JSON.stringify({
    schema: 'libra.micro_producer_envelope.v1',
    personCandidates: {spans: [], relations: []},
    micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
      worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
      turn: receipt.turn, sourceRevisionId: receipt.revisionId,
      sourceDigest: receipt.sourceDigest, claims: [{changeKind: 'event',
        text: '완료된 한 턴의 장면', actor: '', target: '', temporalRole: 'current',
        certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
        stateIntent: {domain: 'narrative', target: {scope: 'current_narrative'},
          field: 'summary', operation: 'set', value: '완료된 한 턴의 장면'},
        evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
          startOffset: 0, endOffset: quote.length, exactQuote: quote}}]}
  })};
};

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fixture = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fixture;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
        assert.equal(active.status, 'verified');
        return microEnvelope(active.receipt);
      };
      const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
      listener(event);
      await waitFor(() => {
        const rows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
        return records(rows, 'libra.micro_memory_head.v1').length === 1;
      }, 15000);
      const active = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(active.status, 'verified', `${mode}: active Micro has physical readback`);
      assert.equal(active.record.analysisStatus, 'verified');
      assert.equal(active.record.claims.length, 1);
      assert.equal(active.record.claims[0].stateIntent?.field, 'summary',
        `${mode}: typed intent survives durable Micro publication without State approval`);
      assert.equal(active.record.authority, 'candidate_only');
      const local = localRows(fixture.local), remote = fixture.storedRows();
      const rows = mode === 'server_only' ? remote : local;
      assert.equal(records(rows, 'libra.micro_memory.v1').length, 1);
      assert.equal(records(rows, 'libra.micro_memory_head.v1').length, 1);
      assert.equal(records(rows, 'libra.micro_work.v1').length, 1);
      if (mode === 'mirror') {
        for (const schema of ['libra.micro_work.v1', 'libra.micro_memory.v1', 'libra.micro_memory_head.v1']) {
          assert.deepEqual(records(local, schema)[0].value, records(remote, schema)[0].value,
            `${schema}: mirror copies match`);
        }
      }
      assert.equal(f.control.calls.length, 1, `${mode}: one model call for one U+A`);
      listener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true, 10000);
      assert.equal(f.control.calls.length, 1, `${mode}: duplicate output reuses the durable result`);
      const firstRevision = active.record.sourceRevisionId;
      f.chat.message[1].data += ' 편집된 완료 장면.';
      listener(event);
      await waitFor(() => {
        const current = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
        return records(current, 'libra.micro_memory.v1').length === 2
          && records(current, 'libra.micro_memory_head.v1')[0]?.value.sourceRevisionId !== firstRevision;
      }, 15000);
      const edited = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(edited.status, 'verified');
      assert.notEqual(edited.record.sourceRevisionId, firstRevision,
        `${mode}: only the edited source revision is active`);
      assert.equal(f.control.calls.length, 2, `${mode}: edited U+A earns one new analysis job`);
      console.log(`PASS T1 Micro automatic durable publication in ${mode}`);
    } finally { await fixture.cleanup(); }
  }

  let listener;
  const splitWork = await serverFixture({mode: 'mirror', host: {
    addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
  }});
  let releaseSplitRepair = () => {};
  try {
    const {f} = splitWork;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    f.control.onCall = async () => microEnvelope((await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt);
    const originalSet = splitWork.backend.setItem;
    let failResultCopy = true;
    let releaseResultRepair;
    const resultRepairGate = new Promise(resolve => { releaseResultRepair = resolve; });
    releaseSplitRepair = releaseResultRepair;
    let holdResultRepair = true;
    splitWork.backend.setItem = async (key, value) => {
      if (String(key).includes(':micro-work:') && JSON.parse(value).status === 'result_ready') {
        if (failResultCopy) {
          failResultCopy = false;
          throw new Error('injected local Micro result-copy failure');
        }
        if (holdResultRepair) await resultRepairGate;
      }
      return originalSet(key, value);
    };
    const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    listener(event);
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.status === 'pending_reconciliation', 15000);
    assert.equal(records(splitWork.storedRows(), 'libra.micro_work.v1')[0].value.status, 'result_ready');
    assert.equal(records(localRows(splitWork.local), 'libra.micro_work.v1')[0].value.status, 'reserved');
    assert.equal(f.control.calls.length, 1);
    holdResultRepair = false;
    releaseResultRepair();
    listener(event);
    await waitFor(() => records(localRows(splitWork.local), 'libra.micro_memory_head.v1').length === 1, 15000);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status, 'verified');
    assert.equal(f.control.calls.length, 1, 'a surviving result journal repairs without another model call');
    assert.deepEqual(records(localRows(splitWork.local), 'libra.micro_work.v1')[0].value,
      records(splitWork.storedRows(), 'libra.micro_work.v1')[0].value);
    console.log('PASS one-sided mirror result journal repairs without model replay');
  } finally { releaseSplitRepair(); await splitWork.cleanup(); }

  let headListener;
  const splitHead = await serverFixture({mode: 'mirror', host: {
    addRisuChatListener: async (_kind, handler) => { headListener = handler; return true; }
  }});
  try {
    const {f} = splitHead;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    f.control.onCall = async () => microEnvelope((await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt);
    const originalSet = splitHead.backend.setItem;
    let failHeadCopy = true;
    splitHead.backend.setItem = async (key, value) => {
      if (failHeadCopy && String(key).includes(':micro-memory-head:')) {
        failHeadCopy = false;
        throw new Error('injected local Micro head failure');
      }
      return originalSet(key, value);
    };
    const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    headListener(event);
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.status === 'pending_reconciliation', 15000);
    assert.equal(records(splitHead.storedRows(), 'libra.micro_memory_head.v1').length, 1);
    assert.equal(records(localRows(splitHead.local), 'libra.micro_memory_head.v1').length, 0);
    headListener(event);
    await waitFor(() => records(localRows(splitHead.local), 'libra.micro_memory_head.v1').length === 1, 15000);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status, 'verified');
    assert.equal(f.control.calls.length, 1, 'head repair transports the existing Micro');
    console.log('PASS one-sided mirror Micro head repairs without model replay');
  } finally { await splitHead.cleanup(); }

  let recordListener;
  const splitRecord = await serverFixture({mode: 'mirror', host: {
    addRisuChatListener: async (_kind, handler) => { recordListener = handler; return true; }
  }});
  try {
    const {f} = splitRecord;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    f.control.onCall = async () => microEnvelope((await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt);
    const originalSet = splitRecord.backend.setItem;
    let failRecordCopy = true;
    splitRecord.backend.setItem = async (key, value) => {
      if (failRecordCopy && String(key).includes(':micro-memory:')) {
        failRecordCopy = false;
        throw new Error('injected local Micro record failure');
      }
      return originalSet(key, value);
    };
    const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    recordListener(event);
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.status === 'pending_reconciliation', 15000);
    assert.equal(records(splitRecord.storedRows(), 'libra.micro_memory.v1').length, 1);
    assert.equal(records(localRows(splitRecord.local), 'libra.micro_memory.v1').length, 0);
    assert.equal(records(splitRecord.storedRows(), 'libra.micro_memory_head.v1').length, 0);
    recordListener(event);
    await waitFor(() => records(localRows(splitRecord.local), 'libra.micro_memory_head.v1').length === 1, 15000);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status, 'verified');
    assert.equal(f.control.calls.length, 1, 'record repair reuses the journaled model result');
    console.log('PASS one-sided mirror Micro record repairs without model replay');
  } finally { await splitRecord.cleanup(); }

  let restartedListener;
  const restarted = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { restartedListener = handler; return true; }
  }});
  try {
    restarted.f.chat.message = restarted.f.chat.message.slice(0, 2);
    restarted.f.chat.messages = restarted.f.chat.message;
    restarted.f.control.onCall = async () => microEnvelope(
      (await restarted.f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt);
    restartedListener({char: restarted.f.character, chat: restarted.f.chat,
      characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await waitFor(() => records(localRows(restarted.local), 'libra.micro_memory_head.v1').length === 1, 15000);
    const before = records(localRows(restarted.local), 'libra.micro_memory.v1')[0].key;
    const resumed = await restarted.restart();
    resumed.chat.message = resumed.chat.message.slice(0, 2);
    resumed.chat.messages = resumed.chat.message;
    restartedListener({char: resumed.character, chat: resumed.chat,
      characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await waitFor(() => resumed.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
    assert.equal((await resumed.r.api.debugReadActiveMicroMemory(1)).status, 'verified');
    assert.equal(records(localRows(restarted.local), 'libra.micro_memory.v1')[0].key, before);
    assert.equal(resumed.control.calls.length, 0, 'restart reuses the committed Micro without a model call');
    console.log('PASS Micro survives restart with physical readback');
  } finally { await restarted.cleanup(); }

  let fifthListener;
  const fifth = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { fifthListener = handler; return true; }
  }});
  try {
    fifth.f.control.onCall = async args => {
      if (JSON.stringify(args).includes('LIBRA MICRO SOURCE CONTRACT')) {
        const active = await fifth.f.r.api.debugReadActiveCompletedTurnReceipt(5);
        return microEnvelope(active.receipt);
      }
      return {type: 'success', result: JSON.stringify(fifth.f.control.artifact)};
    };
    fifthListener({char: fifth.f.character, chat: fifth.f.chat,
      characterIndex: 0, chatIndex: 0, messageIndex: 9});
    await waitFor(() => records(localRows(fifth.local), 'libra.micro_memory_head.v1')
      .some(row => row.value.turn === 5), 15000);
    assert.equal((await fifth.f.r.api.debugReadActiveMicroMemory(5)).status, 'verified');
    await waitFor(() => {
      const manifest = localRows(fifth.local).find(row => row.key.endsWith(':manifest'))?.value;
      return manifest?.memories?.['1'];
    }, 20000);
    assert.equal(records(localRows(fifth.local), 'libra.micro_memory.v1').filter(row => row.value.turn === 5).length, 1);
    console.log('PASS T5 Micro and Canonical publish independently');
  } finally { await fifth.cleanup(); }

  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const upgrading = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = upgrading;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
        const response = microEnvelope(receipt);
        if (f.control.calls.length === 1) {
          const envelope = JSON.parse(response.result);
          envelope.micro.claims = [];
          return {...response, result: JSON.stringify(envelope)};
        }
        return response;
      };
      const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
      listener(event);
      await waitFor(() => records(mode === 'server_only' ? upgrading.storedRows() : localRows(upgrading.local),
        'libra.micro_memory_head.v1')[0]?.value.analysisStatus === 'minimum_source_bound', 15000);
      const minimum = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(minimum.status, 'verified');
      assert.equal(minimum.record.claims.length, 0);
      assert.equal(f.control.calls.length, 1, `${mode}: rejected analysis used one physical call`);
      listener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true, 10000);
      await f.r.api.debugProduceMicroForTurn(1); // join the duplicate's existing publication check
      assert.equal(f.control.calls.length,1,`${mode}: duplicate output does not auto-retry failed Micro`);
      const manual=await f.r.api.retryMicroAnalysis(await microRetryInput(f));
      assert.equal(manual.status,'verified',`${mode}: ${JSON.stringify(manual)}`);
      assert.equal(manual.record?.analysisStatus,'verified',`${mode}: manual attempt stayed source-only`);
      await waitFor(() => records(mode === 'server_only' ? upgrading.storedRows() : localRows(upgrading.local),
        'libra.micro_memory_head.v1')[0]?.value.analysisStatus === 'verified', 15000);
      const upgraded = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(upgraded.status, 'verified');
      assert.notEqual(upgraded.record.analysisRevisionId, minimum.record.analysisRevisionId);
      assert.equal(upgraded.record.claims.length, 1);
      assert.equal(f.control.calls.length, 2, `${mode}: bounded upgrade consumes the remaining attempt`);
      const rows = mode === 'server_only' ? upgrading.storedRows() : localRows(upgrading.local);
      assert.equal(records(rows, 'libra.micro_memory.v1').length, 2,
        `${mode}: minimum remains immutable after verified upgrade`);
      const work = records(rows, 'libra.micro_work.v1')[0].value;
      assert.equal(work.physicalAttemptsUsed, 1);
      assert.equal(work.logicalAttempts, 2);
      assert.equal(work.attemptHistory.length,2);
      listener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true, 10000);
      assert.equal(f.control.calls.length, 2, `${mode}: successful upgrade is not analyzed again`);
      console.log(`PASS bounded source-only Micro upgrade in ${mode}`);
    } finally { await upgrading.cleanup(); }
  }

  let retryListener;
  const splitRetry = await serverFixture({mode: 'mirror', host: {
    addRisuChatListener: async (_kind, handler) => { retryListener = handler; return true; }
  }});
  try {
    const {f} = splitRetry;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    f.control.onCall = async () => {
      const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
      const response = microEnvelope(receipt);
      if (f.control.calls.length === 1) {
        const envelope = JSON.parse(response.result);
        envelope.micro.claims = [];
        return {...response, result: JSON.stringify(envelope)};
      }
      return response;
    };
    const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    retryListener(event);
    await waitFor(() => records(localRows(splitRetry.local), 'libra.micro_memory_head.v1')[0]
      ?.value.analysisStatus === 'minimum_source_bound', 15000);
    await f.r.api.debugProduceMicroForTurn(1);
    const originalSet = splitRetry.backend.setItem;
    let failPlanned = true, failUpgradeResult = true;
    splitRetry.backend.setItem = async (key, value) => {
      if (failPlanned && String(key).includes(':micro-work:')
        && JSON.parse(value).phase === 'manual_planned') {
        failPlanned = false;
        throw new Error('injected local retry-reservation failure');
      }
      if (failUpgradeResult && String(key).includes(':micro-work:')
        && JSON.parse(value).status === 'result_ready'
        && JSON.parse(value).logicalAttempts === 2) {
        failUpgradeResult = false;
        throw new Error('injected local upgraded-result failure');
      }
      return originalSet(key, value);
    };
    const failed = await f.r.api.retryMicroAnalysis(await microRetryInput(f));
    assert.equal(failed.status, 'pending_reconciliation');
    assert.equal(f.control.calls.length, 1, 'one-sided retry reservation occurs before another model call');
    assert.equal(records(splitRetry.storedRows(), 'libra.micro_work.v1')[0].value.phase, 'manual_planned');
    assert.equal(records(localRows(splitRetry.local), 'libra.micro_work.v1')[0].value.status, 'result_ready');
    const resultSplit = await f.r.api.retryMicroAnalysis(await microRetryInput(f));
    assert.equal(resultSplit.status, 'pending_reconciliation');
    assert.equal(f.control.calls.length, 2, 'one-sided second result is saved without a third model call');
    assert.equal(records(splitRetry.storedRows(), 'libra.micro_work.v1')[0].value.status, 'result_ready');
    assert.equal(records(localRows(splitRetry.local), 'libra.micro_work.v1')[0].value.phase, 'invoking');
    const repaired = await f.r.api.debugProduceMicroForTurn(1);
    assert.equal(repaired.status, 'verified');
    assert.equal(repaired.record.analysisStatus, 'verified');
    assert.equal(f.control.calls.length, 2, 'reservation repair spends the remaining call once');
    assert.deepEqual(records(localRows(splitRetry.local), 'libra.micro_work.v1')[0].value,
      records(splitRetry.storedRows(), 'libra.micro_work.v1')[0].value);
    console.log('PASS one-sided mirror retry reservation repairs before bounded analysis');
  } finally { await splitRetry.cleanup(); }

  let exhaustedListener;
  const exhausted = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { exhaustedListener = handler; return true; }
  }});
  try {
    const {f} = exhausted;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    f.control.onCall = async () => {
      const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
      const response = microEnvelope(receipt);
      const envelope = JSON.parse(response.result);
      envelope.micro.claims = [];
      return {...response, result: JSON.stringify(envelope)};
    };
    exhaustedListener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await waitFor(() => records(localRows(exhausted.local), 'libra.micro_memory_head.v1').length === 1, 15000);
    await f.r.api.retryMicroAnalysis(await microRetryInput(f));
    await f.r.api.debugProduceMicroForTurn(1);
    assert.equal(f.control.calls.length, 2, 'an invalid second analysis cannot exceed the physical budget');
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).record.analysisStatus, 'minimum_source_bound');
    assert.equal(records(localRows(exhausted.local), 'libra.micro_work.v1')[0].value.physicalAttemptsUsed, 1);
    assert.equal(records(localRows(exhausted.local), 'libra.micro_work.v1')[0].value.attemptHistory.length, 2);
    console.log('PASS failed Micro upgrade stops at the physical attempt ceiling');
  } finally { await exhausted.cleanup(); }

  let abandonedListener;
  const abandoned = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { abandonedListener = handler; return true; }
  }});
  try {
    const {f} = abandoned;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    const originalSet = abandoned.backend.setItem;
    let failAfterReservation = true;
    abandoned.backend.setItem = async (key, value) => {
      if (failAfterReservation && String(key).includes(':micro-work:')
        && JSON.parse(value).phase === 'invoking') {
        failAfterReservation = false;
        return false;
      }
      return originalSet(key, value);
    };
    const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
    abandonedListener(event);
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.status === 'pending_reconciliation', 15000);
    const workRow = records(localRows(abandoned.local), 'libra.micro_work.v1')[0];
    assert.equal(workRow.value.status, 'reserved');
    assert.equal(workRow.value.phase, 'planned', 'failed invocation marker leaves a durable never-started plan');
    assert.equal(f.control.calls.length, 0, 'reservation failure occurs before any model call');
    abandonedListener(event);
    await waitFor(() => records(localRows(abandoned.local), 'libra.micro_memory_head.v1').length === 1, 15000);
    const recovered = await f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(recovered.status, 'verified');
    assert.equal(recovered.record.analysisStatus, 'minimum_source_bound');
    assert.equal(recovered.record.claims.length, 0, 'unknown provider outcome creates no state claim');
    assert.equal(f.control.calls.length, 1, 'durably planned never-started work resumes once');
    console.log('PASS expired reservation recovers a source-only Micro without model replay');
  } finally { await abandoned.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
