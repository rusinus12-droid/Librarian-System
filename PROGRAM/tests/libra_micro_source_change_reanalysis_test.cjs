'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

function transformSource(source) {
  const anchor = '    const reconcileCompletedTurnReceipts = ';
  assert.ok(source.includes(anchor));
  return source.replace(anchor, `    globalThis.__reconcileMicroSourceChange = async () => {
      const context = await resolveContext(true);
      const pairs = buildPairs(context.chat, context.scope.scopeKey);
      return reconcileCompletedTurnReceipts(context, pairs, { reason: 'risu_output', sourceStabilityDelay: 120 });
    };
` + anchor);
}

test('verified micro turn automatically reanalyzes once when a later module refresh changes the message text', async t => {
  let outputListener;
  const fixture = await serverFixture({
    mode: 'server_only',
    transformSource,
    host: {
      addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; }
    }
  });
  t.after(() => fixture.close?.());

  const { f } = fixture;
  f.chat.message = f.chat.message.slice(0, 2);
  f.chat.messages = f.chat.message;
  f.chat.message[1].data = '소연은 조용히 고개를 끄덕였다.\n\n◈CG\nTIME|2027.04.25(일)|21:31\n@|천소연\n◈';

  let modelCalls = 0;
  f.control.onCall = async () => {
    modelCalls += 1;
    const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
    const quote = receipt.assistant.text.slice(0, 16);
    return {
      type: 'success',
      result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1',
        personCandidates: { spans: [], relations: [] },
        micro: {
          schema: 'libra.micro_memory.v1',
          scopeKey: receipt.scopeKey,
          worldlineId: receipt.worldlineId,
          sessionEpoch: receipt.sessionEpoch,
          turn: receipt.turn,
          sourceRevisionId: receipt.revisionId,
          sourceDigest: receipt.sourceDigest,
          claims: [{
            changeKind: 'event',
            text: '소연이 고개를 끄덕였다',
            actor: '',
            target: '',
            temporalRole: 'current',
            certainty: 'confirmed',
            epistemicStatus: 'observed',
            stateChangeType: 'none',
            evidence: {
              role: 'assistant',
              messageId: receipt.assistant.chatId,
              startOffset: 0,
              endOffset: quote.length,
              exactQuote: quote
            }
          }]
        }
      })
    };
  };

  outputListener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
  await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
  const firstRevision = (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt.revisionId;
  assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status, 'verified');
  assert.equal(modelCalls, 1);

  // Simulate consecutive module refreshes (r2 -> r3 within settle window); only r3 should run.
  f.chat.message[1].data = '소연은 조용히 고개를 끄덕였다.\n\n◈CG\nTIME|2027.04.25(일)|21:31|휴일\n@|천소연\n◈';
  const r2Result = await f.r.context.__reconcileMicroSourceChange();
  assert.equal(r2Result.verified, 1);

  f.chat.message[1].data = '소연은 조용히 고개를 끄덕였다.\n\n◈CG\nTIME|2027.04.25(일)|21:31|휴일\n@|천소연|soyeon\n◈\n\n---\n \n---';

  const reconcileResult = await f.r.context.__reconcileMicroSourceChange();
  assert.equal(reconcileResult.verified, 1);

  await waitFor(() => {
    const pub = f.r.api.getCaptureBackendState().lastMicroPublication;
    return pub?.turn === 1 && pub?.revisionId && pub.revisionId !== firstRevision && pub.status === 'verified';
  }, 10000);

  const secondRevision = (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt.revisionId;
  const activeAfter = await f.r.api.debugReadActiveMicroMemory(1);
  assert.equal(activeAfter.status, 'verified');
  assert.equal(activeAfter.record?.sourceRevisionId, secondRevision);
  assert.notEqual(secondRevision, firstRevision);
  assert.equal(modelCalls, 2, 'revised source triggers exactly one reanalysis');

  // Reconciling again on the same revised text must not call the model again.
  await f.r.context.__reconcileMicroSourceChange();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(modelCalls, 2, 'subsequent reconcile on same revision does not duplicate calls');
});
