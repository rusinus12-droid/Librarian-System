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

// filterOnly (원문 태그 필터 원칙, docs/SOURCE_TAG_FILTER_PRINCIPLE_20261119.md): everything that
// moved is something the current source tag filter does not see (a rule was added or removed, or
// only filtered markup changed). The turn was not revised at all: the default receipt reader keeps
// the stored receipt, recovery writes no new revision, and nothing reruns.
const microCase = async ({rules = null, first = withPlaceholder, rawOnly = illustrated, label = 'illustration', rulesAfter = null, filterOnly = true} = {}) => {
  let outputListener;
  const fixture = await serverFixture({mode: 'server_only', host: {addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; }}});
  try {
    const {f} = fixture;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    if (rules) await f.r.api.setSourceEditRules(rules);
    f.chat.message[1].data = first;
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

    // rulesAfter: the message stays byte-for-byte; only the source rules change (a tag rule is added).
    if (rulesAfter) await f.r.api.setSourceEditRules(rulesAfter); else f.chat.message[1].data = rawOnly;
    const preRecaptureReader = await f.r.api.readActiveMicroMemoryForTurn(1);
    assert.equal(preRecaptureReader.status, 'verified', 'Micro reader stays verified before receipt recapture on illustration-only raw edit: ' + JSON.stringify({status: preRecaptureReader.status, reason: preRecaptureReader.reason}));
    // 같은 턴 판정의 단일 기준 (2026-11-19): the stored receipt row agrees with Micro instead of
    // reporting the turn missing, and State admission is not blocked by the receipt.
    const preRecaptureStatus = await f.r.api.getReceiptRecoveryStatus();
    assert.equal(preRecaptureStatus.receiptStages?.[0]?.status, 'verified', 'the stored receipt stays valid for a ' + label + ' change: ' + JSON.stringify(preRecaptureStatus.receiptStages?.[0]));
    assert.equal((preRecaptureStatus.microJobs || []).find(job => Number(job.turn) === 1)?.status, 'succeeded', 'micro job stage remains succeeded on text-equivalent raw edit');
    const admissionBlocked = result => result?.status === 'stale_source' && ['micro_receipt_changed', 'current_pair_revision_changed'].includes(result.reason);
    const preRecaptureAdmission = await f.r.api.debugAdmitActiveMicroStateClaim(1, 0);
    assert.ok(!admissionBlocked(preRecaptureAdmission), 'State admission reads the same-turn receipt before recapture: ' + JSON.stringify(preRecaptureAdmission));
    if (filterOnly) {
      const direct = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
      assert.equal(direct.status, 'verified', label + ': the default (strict) receipt reader agrees; a filter change is not a revision: ' + JSON.stringify({status: direct.status, reason: direct.reason}));
      const recheck = await f.r.api.recheckReceiptRecovery({turn: 1});
      if (recheck?.jobId && recheck.status !== 'verified') await f.r.api.runReceiptRecoveryJob({jobId: recheck.jobId}).catch(() => null);
      assert.equal(await receiptRevision(), analyzed, label + ': receipt recovery keeps the stored receipt; no new revision is written');
      const kept = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(kept.status, 'verified', label + ': Micro stays verified: ' + JSON.stringify({status: kept.status, reason: kept.reason}));
    } else {
      await recapture();
      assert.notEqual(await receiptRevision(), analyzed, 'a change the filter still sees makes a new receipt');
      const carried = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(carried.status, 'verified', 'Micro stays verified: ' + JSON.stringify({status: carried.status, reason: carried.reason}));
      assert.equal(carried.carriedFromRevisionId, analyzed, 'it is the analysis of the earlier, text-equivalent receipt');
    }
    const jobs = (await f.r.api.getReceiptRecoveryStatus()).microJobs || [];
    const row = jobs.find(job => Number(job.turn) === 1);
    assert.ok(!row || row.reason !== 'micro_work_missing', 'the turn is not reported as micro_work_missing: ' + JSON.stringify(row));
    assert.equal(f.control.calls.length, 1, 'no Micro job reruns for a ' + label + ' change');
    // The record is carried from (or still bound to) the earlier receipt; admission binds to it.
    const carriedAdmission = await f.r.api.debugAdmitActiveMicroStateClaim(1, 0);
    assert.ok(!admissionBlocked(carriedAdmission), 'State admission accepts a carried Micro record: ' + JSON.stringify(carriedAdmission));

    f.chat.message[1].data = rewritten;
    const staleReader = await f.r.api.readActiveMicroMemoryForTurn(1);
    assert.equal(staleReader.status, 'stale_source', 'Micro reader marks a real text change stale immediately');
    const staleStatus = await f.r.api.getReceiptRecoveryStatus();
    assert.equal(staleStatus.receiptStages?.[0]?.status, 'stale_source', 'a real text change still reports the receipt stale');
    const staleAdmission = await f.r.api.debugAdmitActiveMicroStateClaim(1, 0);
    assert.equal(staleAdmission?.status, 'stale_source', 'State admission still refuses a real text change: ' + JSON.stringify(staleAdmission));
    await recapture();
    const stale = await f.r.api.debugReadActiveMicroMemory(1);
    assert.notEqual(stale.status, 'verified', 'a real text change still needs a new analysis');
  } finally { await fixture.close?.(); }
};

// Adding a tag rule changes the analyzed text of every turn carrying that tag, but not the turn:
// the raw bytes are the same, so lens notes stay current. A real text change still makes them stale.
const lensRuleCase = async () => {
  const f = await lensFixture({ beforeRun: async f => { const row = f.chat.message.find(m => m.role !== 'user'); row.data = row.data + '\n<status-window>HP 10</status-window>'; } });
  try {
    f.setReply({ items: [{ label: '약속', text: '지호의 은빛 열쇠 반환 약속', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다', target: '지호' }] });
    await f.add('약속 렌즈', 'active', { recall: { role: 'relevant' } });
    const recall = async () => JSON.parse(JSON.stringify(await f.api.recallLensMemories({ query: '지호 은빛 열쇠 약속', canonicalBudgetChars: 12000 })));
    const staleCount = result => (result.skippedCandidates || []).filter(row => row.reasonCode === 'stale_source_revision').length;
    assert.ok((await recall()).injectedItems.length > 0, 'the note is recalled');
    await f.api.setSourceEditRules(STATUS_RULES);
    const afterRule = await recall();
    assert.equal(staleCount(afterRule), 0, 'adding a tag rule does not make the note stale');
    assert.ok(afterRule.injectedItems.length > 0, 'the note is still recalled after the rule change');
    const row = f.chat.message.find(m => m.role !== 'user');
    row.data = `${row.data} 그리고 전혀 다른 문장이 덧붙었다.`;
    assert.ok(staleCount(await recall()) > 0, 'a real text change after the rule change still makes the note stale');
  } finally { await f.close?.(); }
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

// 원문 재분석의 태그 관리: a tag the user set to be ignored changes only raw bytes, so the turn
// keeps its analysis the same way an illustration does (it used to need a fresh Micro job).
const STATUS_RULES = {version: 1, ignoredTags: ['lb-xnai', 'status-window'], unwrapTags: [], sourceTags: [], controls: ['html-comment', 'lbdata']};
const withStatus = hp => `${BODY}\n\n<status-window>HP ${hp} · 위치: 침실</status-window>`;

const recallAndCanonicalAcrossTextEquivalentRevisionCase = async () => {
  let outputListener;
  const fixture = await serverFixture({
    mode: 'server_only',
    host: {addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; }}
  });
  try {
    const {f} = fixture;
    const baseTurn1 = f.chat.message[1].data;
    f.chat.message[1].data = `${baseTurn1}\n\n---\n[LBDATA START]\n<lb-lazy id="lb-xnai" />\n[LBDATA END]\n---`;
    f.control.onCall = async args => {
      const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
      const quote = receipt.assistant.text.slice(0, 20);
      return {
        type: 'success',
        result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []},
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
              text: 'turn 1 micro event',
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
    outputListener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus
      && f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status, 'verified');

    // Text-equivalent edit to turn 1 before Canonical cold start must not trigger CANONICAL_COMPLETED_RECEIPT_UNAVAILABLE:.
    f.chat.message[1].data = `${baseTurn1}\n\n<lb-xnai id="scene-11" operation="bc5aa5af-291e-459d-b3b6-9728866a269b" scene="11">{{inlay::e301919e-a602-4d23-84ea-c33e5c71ed4e}}</lb-xnai>\n\n---\n[LBDATA START]\n[LBDATA END]\n---`;
    f.control.onCall = async () => ({type: 'success', result: JSON.stringify(f.control.artifact)});
    const cold = await f.run();
    assert.equal(cold.completed, 1, 'Canonical cold start completes across text-equivalent turn-1 revision: ' + JSON.stringify(cold));
    const mem1 = await f.getMemory(1);
    assert.equal(mem1?.status, 'committed', 'memory 1 commits cleanly across text-equivalent revision');

    // Capture turn 6 with both a State-admitted Micro claim and a recallable Micro claim, then exercise live recall across text-equivalent edits.
    f.chat.message.push(
      {role: 'user', chatId: 't6-u', data: '도서관 정문과 은밀한 비밀 열쇠함을 확인한다.'},
      {role: 'assistant', chatId: 't6-a', data: '도서관 정문이 열렸다. 도서관 비밀 열쇠함에는 붉은 인장이 찍혀 있다.\n\n---\n[LBDATA START]\n<lb-lazy id="lb-xnai" />\n[LBDATA END]\n---'}
    );
    f.control.onCall = async args => {
      const input = JSON.parse(args[0].messages[1].content);
      const q1 = '도서관 정문이 열렸다';
      const q2 = '도서관 비밀 열쇠함에는 붉은 인장이 찍혀 있다';
      const s1 = input.assistant.text.indexOf(q1);
      const s2 = input.assistant.text.indexOf(q2);
      assert(s1 >= 0 && s2 >= 0, 'turn 6 quotes must match analyzed assistant text');
      return {
        type: 'success',
        result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []},
          micro: {
            schema: 'libra.micro_memory.v1',
            ...input.binding,
            claims: [
              {
                changeKind: 'world',
                text: `${q1}.`,
                actor: '',
                target: '도서관',
                temporalRole: 'current',
                certainty: 'confirmed',
                epistemicStatus: 'observed',
                stateChangeType: 'set',
                stateIntent: {
                  domain: 'world',
                  target: {entityName: '도서관'},
                  field: 'doorStatus',
                  operation: 'set',
                  value: '열렸다'
                },
                evidence: {
                  role: 'assistant',
                  messageId: input.assistant.messageId,
                  startOffset: s1,
                  endOffset: s1 + q1.length,
                  exactQuote: q1
                }
              },
              {
                changeKind: 'world',
                text: `${q2}.`,
                actor: '',
                target: '비밀 열쇠함',
                temporalRole: 'current',
                certainty: 'confirmed',
                epistemicStatus: 'observed',
                stateChangeType: 'none',
                evidence: {
                  role: 'assistant',
                  messageId: input.assistant.messageId,
                  startOffset: s2,
                  endOffset: s2 + q2.length,
                  exactQuote: q2
                }
              }
            ]
          }
        })
      };
    };
    outputListener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11});
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6
      && f.r.api.getCaptureBackendState().lastMicroPublication?.stateAdmission?.admitted >= 1, 15000);
    const analyzedRev6 = (await f.r.api.debugReadActiveCompletedTurnReceipt(6))?.receipt?.revisionId || '';
    assert.ok(analyzedRev6, 'turn 6 receipt revision exists');
    const callsAfterTurn6 = f.control.calls.length;
    f.control.onCall = async () => { throw new Error('recall must not invoke a drafting provider'); };

    f.chat.message[11].data = '도서관 정문이 열렸다. 도서관 비밀 열쇠함에는 붉은 인장이 찍혀 있다.\n\n<lb-xnai id="scene-12" operation="bc5aa5af-291e-459d-b3b6-9728866a269b" scene="12">{{inlay::e301919e-a602-4d23-84ea-c33e5c71ed4e}}</lb-xnai>\n\n---\n[LBDATA START]\n[LBDATA END]\n---';

    const verifyRecallAndState = async phase => {
      const ctx = await f.r.api.getResponseContext({currentInput: '도서관 비밀 열쇠함과 도서관 정문 상태를 반영해서 이어줘.'});
      assert.equal((await f.r.api.validateResponseContext(ctx)).current, true, `${phase}: ResponseContext stays current`);
      const lib = ctx.values.currentHead.world.find(row => row.name === '도서관');
      assert.equal(lib?.state?.doorStatus, '열렸다', `${phase}: Micro-derived State stays active`);
      const delivered = await f.control.hooks.beforeRequest([{role: 'user', content: '도서관 비밀 열쇠함과 도서관 정문 상태를 반영해서 이어줘.'}], 'model');
      const injectionMeta = f.r.api.getRuntime().lastMemoryInjectionMeta;
      assert.ok(!injectionMeta?.errorCode, `${phase}: beforeRequest succeeds without CONSUMER_MICRO_CHANGED: ${JSON.stringify(injectionMeta)}`);
      assert.equal(injectionMeta?.finalVerification?.status, 'verified', `${phase}: finalVerification stays verified`);
      const viewerRows = Array.from(f.r.api.getLastMemoryRecallViewer()?.rows || []);
      assert.ok(viewerRows.some(row => row.family === 'micro'), `${phase}: Micro row is indexed and recalled`);
      const deliveredText = JSON.stringify(delivered);
      assert.ok(deliveredText.includes('붉은 인장') && deliveredText.includes('열렸다'), `${phase}: delivered recall contains Micro observation and State field`);
      assert.equal(f.control.calls.length, callsAfterTurn6, `${phase}: no redundant Micro job ran`);
    };

    await verifyRecallAndState('before-recapture');

    const recovery = await f.r.api.recheckReceiptRecovery({turn: 6});
    if (recovery?.jobId && recovery.status !== 'verified') {
      await f.r.api.runReceiptRecoveryJob({jobId: recovery.jobId}).catch(() => null);
    }
    // The illustration is filtered out (원문 태그 필터 원칙): turn 6 was not revised, so recovery
    // keeps the analyzed receipt instead of writing a new revision, and its Micro stays bound to it.
    const keptReceipt6 = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
    assert.equal(keptReceipt6?.status, 'verified', 'turn 6 receipt stays verified under the strict reader');
    assert.equal(keptReceipt6?.receipt?.revisionId, analyzedRev6, 'a filtered-only edit writes no new receipt revision');
    const keptTurn6 = await f.r.api.debugReadActiveMicroMemory(6);
    assert.equal(keptTurn6.status, 'verified', 'turn 6 Micro record stays verified');

    await verifyRecallAndState('after-recapture');
  } finally {
    await fixture.cleanup();
  }
};

// When an earlier batch's raw message receives an illustration/tag edit (text-equivalent under
// unchanged-slot ownership), State replay (allowIncompletePrefix: true, used by post-commit
// memory-first State tracking and recovery) must still accept the preserved slot without failing
// on UNIFIED_REPLAY_SOURCE_CHANGED, while a reroll (changed chatId) or rollback still fails closed.
// ruleChange: turn 1 already carries a status window when its batch commits; afterwards only a
// source tag rule for it is added (원문 태그 필터 원칙). The committed canonical batches stay bound.
const stateReplayAcrossPreservedSlotAndTextEquivalentEditCase = async ({ruleChange = false} = {}) => {
  const seam = '    const unifiedStateReadProjection = head =>';
  const fixture = await serverFixture({
    mode: 'server_only',
    transformSource: source => {
      assert.ok(source.includes(seam), 'missing unifiedStateReadProjection seam');
      return source.replace(seam,
        '    globalThis.__stateReplayProbe = { rebuildUnifiedStateForWorldline, resolveContext };\n' + seam);
    }
  });
  try {
    const {f} = fixture;
    if (ruleChange) f.chat.message[1].data = `${f.chat.message[1].data}\n\n<status-window>HP 10 · 위치: 서고</status-window>`;
    const baseT1 = f.chat.message[1].data;
    assert.equal((await f.run()).completed, 1, 'batch 1 commits');
    assert.equal(fixture.getHead()?.throughTurn, 5);
    require('./fixtures/libra_server_runtime_fixture.cjs').fiveMore(f);
    assert.equal((await f.run()).completed, 1, 'batch 2 commits');
    assert.equal(fixture.getHead()?.throughTurn, 10);

    // Apply an illustration-only raw edit to turn 1 (same chatId slot) after T1..T10 committed.
    if (ruleChange) await f.r.api.setSourceEditRules(STATUS_RULES);
    else f.chat.message[1].data = `${baseT1}\n\n<lb-xnai id="scene-99" operation="op-99" scene="99">{{inlay::e301919e-a602-4d23-84ea-c33e5c71ed4e}}</lb-xnai>`;
    const callsBeforeReplay = f.control.calls.length;
    const probe = f.r.context.__stateReplayProbe;
    const context = await probe.resolveContext();
    const replay = await probe.rebuildUnifiedStateForWorldline({
      context,
      manifest: fixture.getManifest(),
      reason: 'memory_first_contiguous_state',
      allowIncompletePrefix: true
    });
    assert.equal(replay.ok, true, 'allowIncompletePrefix replay succeeds across text-equivalent edit: ' + JSON.stringify(replay));
    assert.equal(replay.head?.throughTurn, 10);
    assert.equal(replay.head?.status, 'ready');
    assert.equal(f.control.calls.length, callsBeforeReplay, 'replay uses no model calls');

    // Reroll / branch change on turn 1 (changed assistant chatId) MUST still fail closed with UNIFIED_REPLAY_SOURCE_CHANGED.
    f.chat.message[1].chatId = 'rerolled-t1-a';
    const rerolledContext = await probe.resolveContext();
    const blocked = await probe.rebuildUnifiedStateForWorldline({
      context: rerolledContext,
      manifest: fixture.getManifest(),
      reason: 'memory_first_contiguous_state',
      allowIncompletePrefix: true
    });
    assert.equal(blocked.ok, false, 'changed chatId slot still fails replay');
    assert.match(String(blocked.error || blocked.code || ''), /UNIFIED_REPLAY_SOURCE_CHANGED/);
  } finally {
    await fixture.cleanup();
  }
};

(async () => {
  await microCase();
  await microCase({rules: STATUS_RULES, label: 'illustration-with-saved-rules'});
  // An unfiltered line the current filter still sees: a real source change, carried by line-bounded equivalence.
  await microCase({first: BODY, rawOnly: `${BODY}\n\n[상태창: HP 100]`, label: 'line-bounded module block', filterOnly: false});
  await microCase({rules: STATUS_RULES, first: withStatus(10), rawOnly: withStatus(9), label: 'user-ignored tag'});
  // The tag existed before any rule for it; adding the rule keeps the turn's analysis.
  await microCase({first: withStatus(10), rulesAfter: STATUS_RULES, label: 'tag-rule-added'});
  // Removing that rule again (the tag is seen again) is no revision either: the raw bytes are the same.
  await microCase({rules: STATUS_RULES, first: withStatus(10), rulesAfter: {version: 1, ignoredTags: ['lb-xnai'], unwrapTags: [], sourceTags: [], controls: ['html-comment', 'lbdata']}, label: 'tag-rule-removed'});
  await lensRuleCase();
  await lensCase();
  await recallAndCanonicalAcrossTextEquivalentRevisionCase();
  await stateReplayAcrossPreservedSlotAndTextEquivalentEditCase();
  await stateReplayAcrossPreservedSlotAndTextEquivalentEditCase({ruleChange: true});
  console.log('libra_text_equivalent_revision_test: ok');
})().catch(error => { console.error(error); process.exit(1); });
