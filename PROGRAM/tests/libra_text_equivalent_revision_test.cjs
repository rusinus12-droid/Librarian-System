'use strict';
// A turn whose raw message changes but whose analyzed text does not (LightBoard illustrations,
// 2026-11-17) keeps its Micro analysis and lens notes. The revision formula is unchanged, so
// records stored earlier keep matching; only validity follows the analyzed text. A real text change
// still invalidates both.
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');
const {lensFixture} = require('./fixtures/libra_lens_handoff_fixture.cjs');

const BODY = '하연은 이불을 끌어안았다. "세지 마."\n\n그녀는 창밖을 보았다.';
const withPlaceholder = `${BODY}\n\n---\n[LBDATA START]\n<lb-lazy id="lb-xnai" />\n[LBDATA END]\n---`;
const illustrated = `하연은 이불을 끌어안았다. "세지 마."\n\n<lb-xnai id="scene-11" operation="bc5aa5af-291e-459d-b3b6-9728866a269b" scene="11">{{inlay::e301919e-a602-4d23-84ea-c33e5c71ed4e}}</lb-xnai>\n그녀는 창밖을 보았다.\n\n---\n[LBDATA START]\n[LBDATA END]\n---`;
const rewritten = `하연은 이불을 걷어찼다. "세도 돼."\n\n그녀는 창밖을 보았다.\n\n---\n[LBDATA START]\n[LBDATA END]\n---`;

const microCase = async () => {
  let outputListener;
  const fixture = await serverFixture({mode: 'server_only', host: {addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; }}});
  try {
    const {f} = fixture;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    f.chat.message[1].data = withPlaceholder;
    f.control.onCall = async () => {
      const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
      const quote = receipt.assistant.text.slice(0, 20);
      return {type: 'success', result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
        micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId,
          sessionEpoch: receipt.sessionEpoch, turn: receipt.turn, sourceRevisionId: receipt.revisionId,
          sourceDigest: receipt.sourceDigest, claims: [{changeKind: 'event', text: '하연이 이불을 끌어안았다',
            actor: '', target: '', temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
            stateChangeType: 'none', evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
              startOffset: 0, endOffset: quote.length, exactQuote: quote}}]}
      })};
    };
    const receiptRevision = async () => (await f.r.api.debugReadActiveCompletedTurnReceipt(1))?.receipt?.revisionId || '';
    const capture = async () => {
      outputListener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus, 10000);
    };
    // A later edit of the same reply reaches LIBRA as a new receipt through receipt recovery, as
    // the next turn's reconcile does in a live chat.
    const recapture = async () => {
      const before = await receiptRevision();
      const first = await f.r.api.recheckReceiptRecovery({turn: 1});
      if (first?.jobId && first.status !== 'verified') await f.r.api.runReceiptRecoveryJob({jobId: first.jobId}).catch(() => null);
      await waitFor(async () => { const now = await receiptRevision(); return now && now !== before; }, 15000);
    };
    await capture();
    await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus && f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
    const analyzed = await receiptRevision();
    assert.equal(f.control.calls.length, 1, 'the first capture runs one Micro job');
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status, 'verified');

    f.chat.message[1].data = illustrated;
    await recapture();
    assert.notEqual(await receiptRevision(), analyzed, 'the raw change still makes a new receipt (formula unchanged)');
    const carried = await f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(carried.status, 'verified', 'Micro stays verified: ' + JSON.stringify({status: carried.status, reason: carried.reason}));
    assert.equal(carried.carriedFromRevisionId, analyzed, 'it is the analysis of the earlier, text-equivalent receipt');
    const jobs = (await f.r.api.getReceiptRecoveryStatus()).microJobs || [];
    const row = jobs.find(job => Number(job.turn) === 1);
    assert.ok(!row || row.reason !== 'micro_work_missing', 'the turn is not reported as micro_work_missing: ' + JSON.stringify(row));
    assert.equal(f.control.calls.length, 1, 'no Micro job reruns for an illustration');

    f.chat.message[1].data = rewritten;
    await recapture();
    const stale = await f.r.api.debugReadActiveMicroMemory(1);
    assert.notEqual(stale.status, 'verified', 'a real text change still needs a new analysis');
  } finally { await fixture.close?.(); }
};

const lensCase = async () => {
  const f = await lensFixture();
  try {
    f.setReply({ items: [{ label: '약속', text: '지호의 은빛 열쇠 반환 약속', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다', target: '지호' }] });
    await f.add('약속 렌즈', 'active', { recall: { role: 'relevant' } });
    const recall = async () => JSON.parse(JSON.stringify(await f.api.recallLensMemories({ query: '지호 은빛 열쇠 약속', canonicalBudgetChars: 12000 })));
    const staleCount = result => (result.skippedCandidates || []).filter(row => row.reasonCode === 'stale_source_revision').length;
    const before = await recall();
    assert.ok(before.injectedItems.length > 0, 'the note is recalled');
    const row = f.chat.message.find(m => m.role !== 'user');
    const original = row.data;
    row.data = `${original}\n<lb-xnai id="scene-3" operation="x" scene="3">{{inlay::abc-123}}</lb-xnai>`;
    const illustratedRecall = await recall();
    assert.equal(staleCount(illustratedRecall), 0, 'an illustration does not make the note stale');
    assert.ok(illustratedRecall.injectedItems.length > 0, 'the note is still recalled');
    row.data = `${original} 그리고 전혀 다른 문장이 덧붙었다.`;
    const rewrittenRecall = await recall();
    assert.ok(staleCount(rewrittenRecall) > 0, 'a real text change still makes the note stale');
  } finally { await f.close?.(); }
};

(async () => {
  await microCase();
  await lensCase();
  console.log('libra_text_equivalent_revision_test: ok');
})().catch(error => { console.error(error); process.exit(1); });
