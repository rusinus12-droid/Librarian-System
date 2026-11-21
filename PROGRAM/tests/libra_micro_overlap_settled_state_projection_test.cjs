'use strict';
// Once Canonical covers a turn, its Micro claims are read only through the decisions the
// post-Canonical admission refresh stored. A stored rejection that cannot change by waiting
// (the quote never names the value) must stay a settled report there too, not turn into an
// endless `overlap_not_previously_admitted` hold that keeps the State projection card waiting.
// Real-chat measurement (ffeb99ef_19:0): T30 c10·c11 were settled while Canonical stood at T25
// and became "미크로 보류" as soon as Canonical reached T30.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

// LIBRA_TEST_SOURCE=<file> runs the same scenario on another plugin build (red check).
const transformSource = process.env.LIBRA_TEST_SOURCE
  ? () => require('node:fs').readFileSync(process.env.LIBRA_TEST_SOURCE, 'utf8') : undefined;

(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    let listener;
    const fx = await serverFixture({ mode, transformSource, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    } });
    try {
      const { f } = fx;
      assert.equal((await f.run()).completed, 1, `${mode}: T1–T5 Canonical baseline commits`);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);
      // T6–T10 repeat T1–T5 so the next Canonical artifact can cite them (same rule as fiveMore).
      const extra = f.chat.message.slice(0, 10).map((m, i) => ({ ...m, chatId: `t${6 + Math.floor(i / 2)}-${i % 2 ? 'a' : 'u'}` }));
      // The appended sentence keeps every Canonical quote of T1 a substring of T6.
      extra[1] = { ...extra[1], data: `${extra[1].data} 도서관 문이 열렸다. 손을 뻗어 열쇠를 주웠다.` };
      f.chat.message.push(...extra.slice(0, 2));
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
        const receipt = active.receipt, body = receipt.assistant.text;
        // A sentence that never names the holder: no read can ever bind this value.
        const quote = '손을 뻗어 열쇠를 주웠다.';
        const startOffset = body.indexOf(quote);
        assert.ok(startOffset >= 0, 'T6 carries the quoted sentence');
        return { type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] },
          micro: { schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch, turn: 6,
            sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [{ changeKind: 'world', text: '도서관 문이 열렸다.', actor: '', target: '도서관',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
              stateIntent: { domain: 'world', target: { entityName: '도서관', entityKind: 'location' },
                field: 'doorStatus', operation: 'set', value: '열렸다' },
              evidence: { role: 'assistant', messageId: receipt.assistant.chatId,
                startOffset: body.indexOf('도서관 문이 열렸다'), endOffset: body.indexOf('도서관 문이 열렸다') + '도서관 문이 열렸다'.length,
                exactQuote: '도서관 문이 열렸다' } },
            { changeKind: 'world', text: quote, actor: '', target: '은빛 열쇠',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
              stateIntent: { domain: 'world', target: { entityName: '은빛 열쇠', entityKind: 'object' },
                field: 'holderRef', operation: 'set', value: '지호' },
              evidence: { role: 'assistant', messageId: receipt.assistant.chatId,
                startOffset, endOffset: startOffset + quote.length, exactQuote: quote } }] }
        }) };
      };
      listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11 });
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);
      const ahead = (await f.r.api.debugLoadContinuityStateForResponse()).authority?.microProjection || {};
      assert.equal(JSON.stringify((ahead.settledClaims || []).map(row => [row.turn, row.reason])), JSON.stringify([[6, 'state_value_not_source_bound']]),
        `${mode}: ahead of Canonical the claim is already settled (baseline of the previous fix)`);

      // Canonical now reaches T10, so T6 is read through the overlap path.
      f.chat.message.push(...extra.slice(2));
      f.chat.messages = f.chat.message;
      f.control.onCall = null;
      f.control.artifact = artifact();
      for (const x of [...f.control.artifact.entities, ...f.control.artifact.facts])
        for (const e of x.evidenceSpans) e.ref = e.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + 5}`);
      assert.equal((await f.run()).completed, 1, `${mode}: T6–T10 Canonical commits`);

      let projected, projection;
      await waitFor(async () => {
        projected = await f.r.api.debugLoadContinuityStateForResponse();
        projection = projected.authority?.microProjection || {};
        return [...(projection.pendingClaims || []), ...(projection.settledClaims || [])].some(row => row.turn === 6);
      }, 15000);
      assert.equal((projection.pendingClaims || []).filter(row => row.turn === 6).length, 0,
        `${mode}: a covered claim whose quote cannot bind its value is not a wait: ${JSON.stringify(projection.pendingClaims)}`);
      assert.equal(JSON.stringify((projection.settledClaims || []).filter(row => row.turn === 6).map(row => row.reason)),
        JSON.stringify(['state_value_not_source_bound']), `${mode}: it is still reported as not applied, with its stored reason`);
      assert.notEqual(projected.authority?.pending, true, `${mode}: nothing is left waiting`);

      const job = ((await f.r.api.getRecentWorkOverview()).jobs || []).find(row => row.id === 'state');
      assert.notEqual(job.status, 'waiting', `${mode}: the State projection card is not waiting (${job.note})`);
      assert.match(job.note, /기록 1건 반영 안 함 · T6 · 값 이름이 인용문에 없음/, `${mode}: the card names it`);
      console.log('ok', mode);
    } finally { await fx.cleanup(); }
  }
  console.log('ok micro overlap settled projection');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
