'use strict';
// Task 9 (plan line 337): which consumer's recent-dialogue block actually comes from Live Tail.
//
// The T1 and T5/T6 gates measure the Classic block. This one asks the same question of the Planner, and
// the answer is the opposite of what the first draft assumed:
//   - the Planner's '[RECENT DIALOGUE — COMPLETED TURNS]' block comes from the evidence packet
//     (enforcePlannerEvidenceProfile), so it is present with Live Tail ON and OFF;
//   - Live Tail's only contribution to the Planner input is the per-turn markers ('[TURN n]',
//     '[chatId=…]'), measured at 34 chars.
// By contrast the SGA Shadow prompt reads `evidencePacket.terminal_scene` directly, and that field IS
// filled from the Live Tail transcript when available (buildRecallEvidencePacket). So the Live Tail
// dependency lives in the SGA/GRADIA consumer path, not the Planner's dialogue block - and this file
// records the measurement that separates them.
//
// Two dead ends are kept here on purpose, because both produced green-looking runs on empty data:
//   1. an earlier version drove debugUnifiedLoreMaterial, which builds a different structure
//      (buildUnifiedResponseLoreMaterial) and never receives a live tail - measured liveTailAvailable
//      false in BOTH arms;
//   2. the next version asserted the Planner dialogue was Live-Tail-only and FAILED, because the
//      dialogue arrives through the evidence packet regardless.
// Reading the real provider input is what made both visible.
//
// Run: node tests/libra_live_tail_planner_dialogue_source_test.cjs
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const DETAIL = '도서관 전체는 정숙 구역';
// The fixture's own scene text and the Live Tail transcript are different strings, so finding this
// needle in the consumer input can only come from the recent-dialogue transcript.
const DIALOGUE_USER = '민아는 도서관의 이용 규칙을 물었다';
const DIALOGUE_ASSISTANT = '기록회가 관리하는 도서관 안에 서재와 공연실이 있다';

const runArm = async (mode, liveOn) => {
  let listener;
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
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    f.control.onCall = async args => {
      const input = JSON.parse(args[0].messages[1].content);
      const startOffset = input.assistant.text.indexOf(DETAIL);
      if (startOffset < 0) return { type: 'error', result: 'detail absent from source' };
      return { type: 'success', result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1',
        personCandidates: { spans: [], relations: [] },
        micro: { schema: 'libra.micro_memory.v1', ...input.binding,
          claims: [{ changeKind: 'world', text: `${DETAIL}이다.`, actor: '', target: '도서관',
            temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
            stateChangeType: 'none', evidence: { role: 'assistant',
              messageId: input.assistant.messageId, startOffset,
              endOffset: startOffset + DETAIL.length, exactQuote: DETAIL } }] }
      }) };
    };
    listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);

    // The Planner path reads the evidence packet, so its provider input is where the scene anchor the
    // SGA/GRADIA stages share becomes observable.
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'planner' });
    let providerInput = '';
    f.control.onCall = async args => {
      providerInput = args[0].messages.map(row => String(row.content || '')).join('\n');
      return { type: 'success', result: 'BRIEF' };
    };
    const delivered = await f.control.hooks.beforeRequest([
      { role: 'user', content: '도서관의 정숙 규칙을 고려해서 이어줘.' }
    ], 'model');
    const viewer = f.r.api.getLastMemoryRecallViewer();
    return {
      providerInput,
      inputChars: providerInput.length,
      hasDialogueUser: providerInput.includes(DIALOGUE_USER),
      hasDialogueAssistant: providerInput.includes(DIALOGUE_ASSISTANT),
      hasRecentDialogueMarker: providerInput.includes('RECENT DIALOGUE'),
      microUsed: Array.from(viewer?.rows || []).some(row => row.kind === 'micro'),
      deliveredChars: delivered.map(row => String(row.content || '')).join('\n').length
    };
  } finally {
    try { await fx.cleanup(); } catch { /* fixture already closed */ }
  }
};

(async () => {
  const measured = {};
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    measured[mode] = { on: await runArm(mode, true), off: await runArm(mode, false) };
    if (process.env.GRADIA_DUMP) {
      require('node:fs').writeFileSync(`${process.env.GRADIA_DUMP}-${mode}.json`,
        JSON.stringify(measured[mode], null, 1));
    }
    console.log(JSON.stringify({ test: 'libra_live_tail_planner_dialogue_source', mode,
      on: { ...measured[mode].on, providerInput: undefined },
      off: { ...measured[mode].off, providerInput: undefined } }));
  }

  for (const mode of Object.keys(measured)) {
    const { on, off } = measured[mode];

    // (1) MEASURED: the Planner input carries the recent dialogue in BOTH arms - the Planner's
    // '[RECENT DIALOGUE — COMPLETED TURNS]' block comes from the evidence packet, not from Live Tail.
    // Only the per-turn '[TURN n]' / '[chatId=…]' markers are added when Live Tail is on (measured 34
    // chars). An earlier version of this file asserted the dialogue was Live-Tail-only for the Planner
    // and FAILED, which is why the Planner is not the consumer this gate judges.
    assert.ok(on.hasDialogueUser && off.hasDialogueUser,
      `${mode}: the Planner receives the recent dialogue with and without Live Tail`);

    // (2) Live Tail's contribution to the Planner is the ownership markers only, and it is small.
    const plannerGain = on.inputChars - off.inputChars;
    assert.ok(plannerGain > 0 && plannerGain < 200,
      `${mode}: Live Tail adds only the turn/chatId markers to the Planner input (measured ${plannerGain} chars)`);
    assert.ok(on.hasRecentDialogueMarker,
      `${mode}: the Planner dialogue block is present on the Live Tail arm`);

    // (3) The memory read set is independent of Live Tail: the durable Micro reaches the consumer in
    // both arms, so what changes is the recent-dialogue framing, not the recalled evidence.
    assert.equal(on.microUsed, true,
      `${mode}: the durable Micro reaches the consumer with Live Tail on`);
    assert.equal(off.microUsed, true,
      `${mode}: the durable Micro reaches the consumer with Live Tail off as well`);
  }
  console.log('libra_live_tail_planner_dialogue_source_test: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
