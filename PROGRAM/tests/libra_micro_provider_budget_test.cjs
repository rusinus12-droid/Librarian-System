'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const prepareT1 = async () => {
  let listener;
  const snapshot = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
  }});
  const {f} = snapshot;
  f.chat.message = f.chat.message.slice(0, 2);
  f.chat.messages = f.chat.message;
  listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
  await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
  await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
  return snapshot;
};

(async () => {
  const ready = await prepareT1();
  try {
    const {f} = ready;
    assert.equal(typeof f.r.api.debugAnalyzeCompletedReceipt, 'function');
    const quote = '기록회가 관리하는 도서관';
    f.control.onCall = () => ({type: 'success', result: JSON.stringify({
      schema: 'libra.micro_producer_envelope.v1',
      personCandidates: {spans: [{role: 'user', startOffset: 0, endOffset: 2,
        exactQuote: '민아', name: '민아', personType: 'person'}], relations: []},
      micro: {schema: 'libra.micro_memory.v1', scopeKey: 'seventh-server-scope',
        worldlineId: 'main', sessionEpoch: 0, turn: 1,
        sourceRevisionId: '', sourceDigest: '', claims: [{
          changeKind: 'world', text: '기록회가 도서관을 관리한다.', actor: '기록회', target: '도서관',
          temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
          stateChangeType: 'set', evidence: {role: 'assistant', messageId: 't1-a',
            startOffset: 0, endOffset: quote.length, exactQuote: quote}
        }]}
    })});
    const active = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(active.status, 'verified');
    // The controlled model echoes the verified source identity, not an in-memory turn counter.
    const originalOnCall = f.control.onCall;
    f.control.onCall = args => {
      const output = originalOnCall(args);
      const envelope = JSON.parse(output.result);
      envelope.micro.scopeKey = active.receipt.scopeKey;
      envelope.micro.worldlineId = active.receipt.worldlineId;
      envelope.micro.sourceRevisionId = active.receipt.revisionId;
      envelope.micro.sourceDigest = active.receipt.sourceDigest;
      return {...output, result: JSON.stringify(envelope)};
    };
    const priorCalls = f.control.calls.length;
    const result = await f.r.api.debugAnalyzeCompletedReceipt(1);
    assert.equal(result.status, 'candidate_ready', JSON.stringify({micro: result.micro, binding: {
      scopeKey: active.receipt.scopeKey, worldlineId: active.receipt.worldlineId,
      assistantMessageId: active.receipt.assistant?.chatId}}));
    assert.equal(result.micro.status, 'source_bound_candidate');
    assert.equal(result.personInventory.status, 'classified_candidates');
    assert.equal(result.personInventory.spans.some(span => span.name === '민아'), true);
    assert.equal(f.control.calls.length - priorCalls, 1, 'explicit analyzer uses one logical model request');
    assert.equal(result.provider.invocationPlan.taskKind, 'micro_memory');
    assert.ok(result.provider.invocationPlan.maxPhysicalCalls <= 2, 'the planned physical budget is bounded');
    assert.ok(result.provider.execution.requestCount <= 2, 'physical calls stay inside the micro budget');
    assert.ok(result.provider.invocationPlan.effective.outputCap <= 4096);
    assert.equal((await f.r.api.debugReadActiveCompletedTurnReceipt(1)).status, 'verified');
    console.log('PASS one bounded Micro job yields independently validated person and Micro candidates');
  } finally { await ready.cleanup(); }

  const fifth = await serverFixture({mode: 'plugin_only'});
  try {
    assert.equal((await fifth.f.run()).completed, 1, 'T5 Canonical commits independently');
    await waitFor(() => fifth.f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);
    const active = await fifth.f.r.api.debugReadActiveCompletedTurnReceipt(5);
    assert.equal(active.status, 'verified');
    const priorCalls = fifth.f.control.calls.length;
    const quote = active.receipt.assistant.text.slice(0, 50);
    fifth.f.control.onCall = () => ({type: 'success', result: JSON.stringify({
      schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
      micro: {schema: 'libra.micro_memory.v1', scopeKey: active.receipt.scopeKey,
        worldlineId: active.receipt.worldlineId, sessionEpoch: active.receipt.sessionEpoch,
        turn: 5, sourceRevisionId: active.receipt.revisionId, sourceDigest: active.receipt.sourceDigest,
        claims: [{changeKind: 'event', text: 'T5 완료 장면', actor: '', target: '',
          temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
          stateChangeType: 'none', evidence: {role: 'assistant',
            messageId: active.receipt.assistant.chatId, startOffset: 0, endOffset: quote.length,
            exactQuote: quote}}]}
    })});
    assert.equal((await fifth.f.r.api.debugAnalyzeCompletedReceipt(5)).micro.status, 'source_bound_candidate');
    assert.equal(fifth.f.control.calls.length - priorCalls, 1, 'T5 candidate uses one Micro call');
    const manifestKey = [...fifth.local.keys()].find(key => key.endsWith(':manifest'));
    assert.ok(manifestKey && JSON.parse(fifth.local.get(manifestKey)).memories?.['1'],
      'T5 Micro candidate does not remove the durable Canonical');
    console.log('PASS T5 Micro candidate remains independent of Canonical');
  } finally { await fifth.cleanup(); }

  const stale = await prepareT1();
  try {
    const priorCalls = stale.f.control.calls.length;
    stale.f.control.onCall = () => {
      stale.f.chat.message[1].data += ' 수정된 응답.';
      return {type: 'success', result: '{}'};
    };
    const result = await stale.f.r.api.debugAnalyzeCompletedReceipt(1);
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'source_changed_after_provider');
    assert.equal(result.minimumSourceBound, null, 'retired source cannot become a fallback Micro');
    assert.equal(stale.f.control.calls.length - priorCalls, 1, 'stale model output is not retried against another revision');
    console.log('PASS source edit discards a delayed Micro candidate');
  } finally { await stale.cleanup(); }

  const unavailable = await prepareT1();
  try {
    const priorCalls = unavailable.f.control.calls.length;
    unavailable.f.control.modelFails = true;
    const result = await unavailable.f.r.api.debugAnalyzeCompletedReceipt(1);
    assert.equal(result.status, 'pending');
    assert.equal((await unavailable.f.r.api.debugReadActiveCompletedTurnReceipt(1)).status, 'verified',
      'provider failure never deletes the completed source receipt');
    assert.ok(unavailable.f.control.calls.length - priorCalls <= 2, 'provider failure remains bounded');
    assert.equal(result.minimumSourceBound?.authority, 'source_only');
    assert.equal(result.minimumSourceBound?.claims.length, 0, 'fallback never guesses a state change');
    assert.ok(result.provider?.execution?.requestCount <= 2, 'failed physical attempts remain visible');
    console.log('PASS provider failure retains the verified source receipt');
  } finally { await unavailable.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
