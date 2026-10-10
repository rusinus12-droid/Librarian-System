'use strict';
// Task 9 (plan line 126/337): the T5/T6 half of the Live Tail side-by-side check. The companion gate
// libra_live_tail_supply_measurement_test.cjs measures a single completed turn; this one measures what
// Live Tail supplies AFTER a Canonical commit, which is the state a long-running chat actually reaches.
//
// The question it answers: once T1-T5 have been synthesized into Canonical memory and the frontier has
// moved past them, is the recent-dialogue block still adding information the Canonical/Micro read set
// does not carry? If Canonical already covers the settled history, Live Tail's contribution at T6
// would be redundant - and removal would be safe. If it still carries recent turns that no memory row
// holds, removal loses them.
//
// Measured, not assumed: both arms commit the same five turns and the same Canonical pass, then read
// the same T6 query with Live Tail on versus off.
//
// Run: node tests/libra_live_tail_t5t6_supply_test.cjs
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const PROMISE = '도서관 전체는 정숙 구역';
const DELAY = '준호가 지호에게서 열쇠를 받아 들었다';
const FULFILL = '공연 허가를 내주기로 확정했다';
// T6 is the turn after the Canonical commit: it is written but not yet synthesized, so it exists only
// as raw dialogue until a later Canonical pass absorbs it.
const T6_USER = '민아가 무대 조명을 점검해도 되는지 물었다';
const T6_ASSISTANT = '무대 조명은 공연 전날에만 점검할 수 있고, 그 외 시간에는 출입이 제한된다';
// FULFILL is the Canonical comparison marker, not a quote in the T5 assistant source.
const observed = new Map([[1, PROMISE], [3, DELAY], [5,
  '공연 허가를 누가 내주는지는 아직 밝혀지지 않았다']]);

const sourceClaim = (input, value) => {
  const text = input.assistant.text;
  const startOffset = text.indexOf(value);
  assert.ok(startOffset >= 0, `T${input.binding.turn} quote belongs to the completed assistant source`);
  return { changeKind: 'event', text: value, actor: '', target: '',
    temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
    stateChangeType: 'set',
    evidence: { role: 'assistant', messageId: input.assistant.messageId, startOffset,
      endOffset: startOffset + value.length, exactQuote: value } };
};

const runArm = async (mode, liveOn, { captureT6 = true } = {}) => {
  let listener;
  const quoteObservations = [], callbackErrors = [];
  const fx = await serverFixture({
    mode,
    args: {
      live_context_enabled: String(liveOn),
      classic_live_tail_enabled: String(liveOn),
      live_tail_max_turns: '4',
      live_tail_max_chars: '24000'
    },
    host: { addRisuChatListener: async (_kind, handler) => { listener = handler; return true; } }
  });
  try {
    const { f } = fx;
    const fullMessages = f.chat.message;
    const canonical = artifact();
    canonical.facts.find(fact => fact.tempFactId === 'f13').values.thread.summary = FULFILL;
    f.control.artifact = canonical;
    f.control.onCall = async args => {
      const messages = args[0].messages;
      if (!String(messages[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')) {
        return { type: 'success', result: JSON.stringify(canonical) };
      }
      const input = JSON.parse(messages[1].content);
      const value = observed.get(input.binding.turn);
      const quote = process.env.T56_BAD_QUOTE === '1' && input.binding.turn === 5
        ? `${value} intentionally absent` : value;
      let claims = [];
      if (value) {
        try {
          const claim = sourceClaim(input, quote);
          quoteObservations.push({ turn: input.binding.turn, source: input.assistant.text,
            quote: claim.evidence.exactQuote, start: claim.evidence.startOffset,
            end: claim.evidence.endOffset });
          claims = [claim];
        } catch (error) {
          callbackErrors.push(error);
          throw error;
        }
      }
      return { type: 'success', result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1',
        personCandidates: { spans: [], relations: [] },
        micro: { schema: 'libra.micro_memory.v1', ...input.binding,
          claims }
      }) };
    };

    // Write T1..T5 and commit their Canonical synthesis, exactly as the timeline gate does.
    for (let turn = 1; turn <= 5; turn += 1) {
      f.chat.message = fullMessages.slice(0, turn * 2);
      f.chat.messages = f.chat.message;
      listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
        messageIndex: turn * 2 - 1 });
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === turn, 15000);
    }
    // Provider callback exceptions may be swallowed as source-only fallback. Assert in the test body.
    assert.deepEqual(callbackErrors, [], `${mode}: quote callback must not fail`);
    for (const turn of observed.keys()) {
      assert.ok(quoteObservations.some(row => row.turn === turn
        && row.start >= 0 && row.source.slice(row.start, row.end) === row.quote),
      `${mode}: T${turn} quote is observed in the assistant source`);
    }
    f.chat.message = fullMessages;
    f.chat.messages = fullMessages;
    const canonicalRun = await f.run();
    assert.equal(canonicalRun.completed + canonicalRun.skipped, 1,
      `${mode} live=${liveOn}: the T5 Canonical pass commits: ${JSON.stringify(canonicalRun)}`);

    // T6: one more completed turn, written after the Canonical commit. Its Micro is produced by the
    // same one-turn producer; the point is whether the dialogue itself still reaches the model.
    const t6 = [
      ...fullMessages,
      { role: 'user', chatId: 't6-u', content: T6_USER },
      { role: 'assistant', chatId: 't6-a', content: T6_ASSISTANT }
    ];
    f.chat.message = t6;
    f.chat.messages = t6;
    if (captureT6) {
      listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11 });
      try {
        await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);
      } catch { /* recorded below through the frontier */ }
    }

    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    const prompts = [];
    f.control.onCall = async args => {
      prompts.push(args[0].messages.map(row => String(row.content || '')).join('\n'));
      return { type: 'success', result: 'REPLY' };
    };
    const delivered = await f.control.hooks.beforeRequest([
      { role: 'user', content: '무대 조명 점검 규칙을 고려해서 이어줘.' }
    ], 'model');
    const block = delivered.map(row => String(row.content || '')).join('\n');
    const viewer = f.r.api.getLastMemoryRecallViewer();
    return {
      block,
      blockChars: block.length,
      hasDialogue: block.includes('[RECENT DIALOGUE'),
      t6UserInBlock: block.includes(T6_USER),
      t6AssistantInBlock: block.includes(T6_ASSISTANT),
      settledInBlock: [PROMISE, DELAY, FULFILL].filter(v => block.includes(v)),
      frontier: viewer ? {
        verifiedTurns: Array.from(viewer.microFrontier?.verifiedTurns || []).map(Number).sort((a, b) => a - b),
        sourceOnlyTurns: Array.from(viewer.microFrontier?.sourceOnlyTurns || []).map(Number).sort((a, b) => a - b),
        pending: viewer.microFrontier?.pending,
        lastKnownTurn: viewer.microFrontier?.lastKnownTurn
      } : null
    };
  } finally {
    try { await fx.cleanup(); } catch { /* fixture already closed */ }
  }
};

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    const on = await runArm(mode, true);
    const off = await runArm(mode, false);
    // Diagnostic first: the arm contents decide what can be asserted. An earlier version of this file
    // asserted that the unsynthesized T6 turn is absent without Live Tail, and it FAILED - so something
    // else supplies that turn and the assertion was a guess. Print both arms before judging.
    if (process.env.T56_DUMP) {
      require('node:fs').writeFileSync(process.env.T56_DUMP + `-${mode}.json`,
        JSON.stringify({ on, off }, null, 1));
    }
    console.log(JSON.stringify({
      test: 'libra_live_tail_t5t6_supply',
      mode,
      withLiveTail: on.blockChars,
      withoutLiveTail: off.blockChars,
      onHasDialogue: on.hasDialogue,
      offHasDialogue: off.hasDialogue,
      onT6: [on.t6UserInBlock, on.t6AssistantInBlock],
      offT6: [off.t6UserInBlock, off.t6AssistantInBlock],
      onSettled: on.settledInBlock.length,
      offSettled: off.settledInBlock.length,
      frontier: off.frontier
    }));

    // (1) Live Tail's own contribution: the recent-dialogue block, present only when enabled.
    assert.ok(on.hasDialogue,
      `${mode}: with Live Tail on, the post-Canonical block carries recent dialogue`);
    assert.ok(!off.hasDialogue,
      `${mode}: with Live Tail off, the same query carries no recent-dialogue block`);

    // (2) The measured difference between arms.
    const lostChars = on.blockChars - off.blockChars;
    assert.ok(lostChars > 0,
      `${mode}: Live Tail supplies text the Live-Tail-off arm does not receive (measured ${lostChars} chars)`);

    // (3) The newest USER text is unique to the receipt-backed recent dialogue block.
    // The assistant text may also appear in OFF only when the indexed Micro or
    // source-only evidence frontier actually contains T6; timing differs by mode.
    assert.ok(on.t6UserInBlock,
      `${mode}: the newest user turn reaches the block through Live Tail`);
    assert.ok(on.t6AssistantInBlock,
      `${mode}: the newest assistant turn reaches the block through Live Tail`);
    if (off.frontier?.verifiedTurns?.includes(6) || off.frontier?.sourceOnlyTurns?.includes(6)) {
      assert.ok(off.t6AssistantInBlock, `${mode}: an indexed Micro/source-only excerpt may retain the assistant turn`);
    } else {
      assert.ok(!off.t6AssistantInBlock, `${mode}: without indexed T6 Micro/source-only evidence, OFF cannot leak raw assistant dialogue`);
    }
    assert.ok(!off.t6UserInBlock,
      `${mode}: the user turn is the part only Live Tail supplies (Micro evidence binds to the assistant role)`);

    console.log('libra_live_tail_t5t6_supply_test: PASS ' + mode);
  }
  // Negative control: T6 exists in the host chat but was never captured. The
  // indexed frontier must not accidentally recover its assistant text from raw chat.
  const missing = await runArm('plugin_only', false, { captureT6: false });
  assert.ok(!missing.frontier?.verifiedTurns?.includes(6)
    && !missing.frontier?.sourceOnlyTurns?.includes(6), 'control has no indexed T6 evidence');
  assert.ok(!missing.t6AssistantInBlock && !missing.t6UserInBlock,
    'without a T6 receipt or Micro evidence, OFF must not read the raw host T6');
  console.log('libra_live_tail_t5t6_supply_test: PASS missing-T6 negative control');
})().catch(error => { console.error(error); process.exitCode = 1; });
