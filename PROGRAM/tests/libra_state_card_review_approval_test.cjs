'use strict';
// A Micro value that conflicts with Canonical is held for the user only when the user's approval
// could actually apply it. When the State already has newer evidence for the field, approving it
// changes nothing, so it must not stay "확인 필요 · 자동 반영 검토에서 검토 가능" — before or after
// the user approves it. Real chat (ffeb99ef_19:0): all 9 held values were approved and 8 stayed
// held (sceneTime with newer evidence, unresolved location/target), so the card never cleared.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const transformSource = process.env.LIBRA_TEST_SOURCE
  ? () => require('node:fs').readFileSync(process.env.LIBRA_TEST_SOURCE, 'utf8') : undefined;
const SENTENCE = '민아는 공연실로 걸어갔다.';
// A held value the review cannot apply (newer evidence, unresolved target) is covered by the real-chat
// replay recorded in the commit; this suite pins the user path: hold -> approve -> the card clears.

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
      const extra = f.chat.message.slice(0, 10).map((m, i) => ({ ...m, chatId: `t${6 + Math.floor(i / 2)}-${i % 2 ? 'a' : 'u'}` }));
      extra[1] = { ...extra[1], data: `${extra[1].data} ${SENTENCE}` };
      f.chat.message.push(...extra.slice(0, 2));
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
        const receipt = active.receipt, body = receipt.assistant.text, quote = '민아는 공연실로 걸어갔다';
        return { type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] },
          micro: { schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch, turn: 6,
            sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [{ changeKind: 'person', text: SENTENCE, actor: '민아', target: '공연실',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
              stateIntent: { domain: 'character', target: { entityName: '민아' }, field: 'locationRef', operation: 'set', value: '공연실' },
              evidence: { role: 'assistant', messageId: receipt.assistant.chatId,
                startOffset: body.indexOf(quote), endOffset: body.indexOf(quote) + quote.length, exactQuote: quote } }] }
        }) };
      };
      listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11 });
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);

      // Canonical T6–T10 places 민아 in 서재 with evidence from T7, after the Micro turn.
      f.chat.message.push(...extra.slice(2));
      f.chat.messages = f.chat.message;
      f.control.onCall = null;
      f.control.artifact = artifact();
      for (const x of [...f.control.artifact.entities, ...f.control.artifact.facts])
        for (const e of x.evidenceSpans) e.ref = e.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + 5}`);
      assert.equal((await f.run()).completed, 1, `${mode}: T6–T10 Canonical commits`);

      // T1–T5 Canonical put 민아 in 서재; the T6 Micro says 공연실 and no later evidence decides it.
      // The user's approval can apply it, so this one is a real check for the user.
      const card = async () => ((await f.r.api.getRecentWorkOverview()).jobs || []).find(row => row.id === 'state');
      const held = (await f.r.api.debugLoadContinuityStateForResponse()).authority?.microProjection?.pendingClaims || [];
      assert.equal(JSON.stringify(Array.from(held).filter(row => row.turn === 6).map(row => row.reason)), JSON.stringify(['canonical_overlap_conflict']),
        `${mode}: the T6 value is held as a Canonical conflict`);
      const before = await card();
      assert.equal(before.status, 'attention', `${mode}: the card asks for a check (${before.note})`);
      assert.equal(before.statusHint, '자동 반영 검토에서 검토 가능');
      const catalog = await f.r.api.listMemoryReviews();
      const row = Array.from(catalog.rows).find(item => item.kind === 'micro' && item.turn === 6);
      assert.equal(row?.stateOutcome, 'not_applied', `${mode}: the review offers it (${row?.stateOutcome} ${row?.stateBlockReason || ''})`);
      assert.equal((await f.r.api.setMemoryReviewDecision({ scopeKey: catalog.scopeKey, previewDigest: catalog.previewDigest, ids: [row.id], status: 'confirmed' })).ok, true);
      // After approval the card reads the State with the review applied, like responses do.
      const view = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(Array.from(view.authority?.microProjection?.pendingClaims || []).length, 0, `${mode}: nothing is held after approval`);
      const after = await card();
      assert.notEqual(after.status, 'attention', `${mode}: an approved value does not keep the card at 확인 필요 (${after.note})`);
      assert.equal(after.statusHint, '', `${mode}: no review hint once the user decided`);
      console.log('ok', mode);
    } finally { await fx.cleanup(); }
  }
  console.log('ok micro review unapplicable conflict');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
