'use strict';
// A Micro claim whose own value/quote cannot satisfy the field contract is a decision, not a wait:
// re-reading it decides the same way, so it must not keep the State projection pending forever.
// It is still reported (settledClaims) so the card can say what was not applied.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const quoteSpan = (text, quote, messageId) => ({ role: 'assistant', messageId,
  startOffset: text.indexOf(quote), endOffset: text.indexOf(quote) + quote.length, exactQuote: quote });

(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    let listener;
    const fixture = await serverFixture({ mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    } });
    try {
      const { f } = fixture;
      assert.equal((await f.run()).completed, 1, `${mode}: T5 Canonical baseline commits`);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);
      f.chat.message.push(
        { role: 'user', chatId: 't6-u', data: '열쇠와 문을 확인해 줘.' },
        { role: 'assistant', chatId: 't6-a', data: '도서관 문이 열렸다. 손을 뻗어 열쇠를 주웠다.' }
      );
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
        const receipt = active.receipt, body = receipt.assistant.text;
        const evidence = { role: 'assistant', messageId: receipt.assistant.chatId };
        return { type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] },
          micro: { schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch, turn: 6,
            sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [
              { changeKind: 'world', text: '도서관 문이 열렸다.', actor: '', target: '도서관',
                temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
                stateIntent: { domain: 'world', target: { entityName: '도서관', entityKind: 'location' },
                  field: 'doorStatus', operation: 'set', value: '열렸다' },
                evidence: quoteSpan(body, '도서관 문이 열렸다', evidence.messageId) },
              // The quote never names the holder, so no read can ever bind this value: settled, never pending.
              { changeKind: 'world', text: '손을 뻗어 열쇠를 주웠다.', actor: '', target: '은빛 열쇠',
                temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
                stateIntent: { domain: 'world', target: { entityName: '은빛 열쇠', entityKind: 'object' },
                  field: 'holderRef', operation: 'set', value: '민아' },
                evidence: quoteSpan(body, '손을 뻗어 열쇠를 주웠다.', evidence.messageId) }
            ] }
        }) };
      };
      listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11 });
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);

      const projected = await f.r.api.debugLoadContinuityStateForResponse();
      const projection = projected.authority?.microProjection || {};
      assert.equal((projection.pendingClaims || []).length, 0,
        `${mode}: an uncitable value is not a wait`);
      const settled = Array.from(projection.settledClaims || []);
      assert.equal(settled.length, 1, `${mode}: the rejected claim is reported as settled`);
      assert.equal(settled[0].reason, 'state_value_not_source_bound');
      assert.equal(settled[0].turn, 6);
      assert.equal(projection.status, 'current', `${mode}: the projection itself is current`);
      assert.equal(projected.authority?.current, true,
        `${mode}: readers may treat the State as current while reporting what was not applied`);
      assert.equal(projected.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus, '열렸다',
        `${mode}: the rest of the turn still applies`);

      const overview = await f.r.api.getRecentWorkOverview();
      const job = (overview.jobs || []).find(row => row.id === 'state');
      assert.equal(job.status, 'ok', `${mode}: the State projection card is not waiting`);
      assert.equal(job.headline, '현재 상태 반영 · T5까지', `${mode}: the card reports the canonical basis`);
      assert.equal(job.note, '기록 1건 반영 안 함 · T6 · 값 이름이 인용문에 없음',
        `${mode}: the card names what was not applied and why`);
      console.log('ok', mode);
    } finally { await fixture.cleanup(); }
  }
  console.log('ok micro settled projection');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
