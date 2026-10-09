'use strict';
// Live Tail retirement measurement, promoted to a standing gate (Task 9, plan line 126: "Before
// disabling Live Tail, run side-by-side T1-T4 and T5/T6 response checks with committed Micro, current
// State, and Canonical").
//
// Why this is a gate and not a throwaway probe: the retirement decision depends on a measured fact
// that contradicts the plan's working assumption. The plan's cutover contract says consumers should
// "not silently rebuild an untracked raw-chat tail at request time", which reads as if Micro replaces
// Live Tail. Measured here: it does not. Live Tail supplies the completed user/assistant dialogue
// verbatim (speaker ownership, scene wording), while Micro supplies extracted change claims. Removing
// Live Tail deletes the raw turn text, which no Micro claim carries.
//
// So this file asserts the observed difference in both directions:
//   - with Live Tail enabled, the dialogue block IS present (the information the user would lose)
//   - with it disabled, the Micro evidence is STILL present (Micro does not depend on Live Tail)
// If a future change makes Live Tail removable because Micro grew the raw-turn capability, the second
// half still passes but the first half fails loudly, which is the signal to reopen the retirement.
//
// Run: node tests/libra_live_tail_supply_measurement_test.cjs
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const DETAIL = '도서관 전체는 정숙 구역';
const QUERY = '도서관의 정숙 규칙을 고려해서 이어줘.';
const DIALOGUE_MARK = '[RECENT DIALOGUE';
const MICRO_MARK = 'TURN EVIDENCE (MICRO)';

const measure = async (mode, combo) => {
  let listener;
  const fx = await serverFixture({
    mode,
    args: {
      // Each arm differs in exactly one documented setting. An earlier measurement toggled both Live
      // Tail flags together and could not attribute the difference to either one; measured after
      // splitting them, the Classic dialogue block needs BOTH flags, which is recorded below.
      live_context_enabled: combo.liveContext,
      classic_live_tail_enabled: combo.classicOptIn,
      live_tail_max_turns: '4',
      live_tail_max_chars: '24000'
    },
    host: { addRisuChatListener: async (_kind, handler) => { listener = handler; return true; } }
  });
  try {
    const { f } = fx;
    f.chat.message = f.chat.message.slice(0, 2);
    f.chat.messages = f.chat.message;
    // Commit one durable Micro so every arm shares the same completed-memory state.
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
    const microStatus = (await f.r.api.debugReadActiveMicroMemory(1)).status;

    const read = async route => {
      await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: route });
      let providerInput = '';
      f.control.onCall = async args => {
        providerInput = args[0].messages.map(row => String(row.content || '')).join('\n');
        return { type: 'success', result: route === 'planner' ? 'BRIEF' : 'REPLY' };
      };
      const delivered = await f.control.hooks.beforeRequest([{ role: 'user', content: QUERY }], 'model');
      return {
        delivered: delivered.map(row => String(row.content || '')).join('\n'),
        providerInput
      };
    };
    const classic = await read('classic');
    const planner = await read('planner');
    return { microStatus, classic, planner };
  } finally {
    try { await fx.cleanup(); } catch { /* fixture already closed */ }
  }
};

const combos = [
  { label: 'both_on', liveContext: 'true', classicOptIn: 'true' },
  { label: 'context_only', liveContext: 'true', classicOptIn: 'false' },
  { label: 'classic_only', liveContext: 'false', classicOptIn: 'true' },
  { label: 'both_off', liveContext: 'false', classicOptIn: 'false' }
];

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    const measured = {};
    for (const combo of combos) {
      measured[combo.label] = await measure(mode, combo);
      assert.equal(measured[combo.label].microStatus, 'verified',
        `${mode}/${combo.label}: the arm starts from a durable verified Micro`);
    }

    // (1) The information Live Tail supplies, and that no Micro claim carries: the completed
    // user/assistant dialogue verbatim, with speaker ownership (chatId) intact.
    const on = measured.both_on.classic.delivered;
    assert.ok(on.includes(DIALOGUE_MARK),
      `${mode}: with Live Tail fully enabled the Classic block carries the recent completed dialogue`);
    assert.match(on, /\[USER chatId=[^\]]+\]/,
      `${mode}: the dialogue block preserves user speaker ownership`);
    assert.match(on, /\[ASSISTANT chatId=[^\]]+\]/,
      `${mode}: the dialogue block preserves assistant speaker ownership`);
    assert.ok(on.includes('이용 규칙을 물었다'),
      `${mode}: the raw user turn text reaches the model through Live Tail`);

    // (2) Micro does not depend on Live Tail: the extracted evidence survives with everything off.
    const off = measured.both_off.classic.delivered;
    assert.ok(off.includes(MICRO_MARK),
      `${mode}: the Micro evidence is present even with Live Tail disabled`);
    assert.ok(off.includes(DETAIL),
      `${mode}: the Micro claim text survives Live Tail being disabled`);

    // (3) The measured dependency, recorded so a future change has to re-measure rather than assume.
    // Classic's dialogue block needs BOTH flags: either one alone leaves the block absent.
    assert.ok(!measured.context_only.classic.delivered.includes(DIALOGUE_MARK),
      `${mode}: live_context_enabled alone does not put dialogue in the Classic block`);
    assert.ok(!measured.classic_only.classic.delivered.includes(DIALOGUE_MARK),
      `${mode}: classic_live_tail_enabled alone does not put dialogue in the Classic block`);

    // (4) The Planner receives the same raw turn text through the live-context layer, so the planner
    // path loses it too if Live Tail is removed.
    assert.match(measured.both_on.planner.providerInput, /\[USER chatId=[^\]]+\]/,
      `${mode}: the Planner provider input carries the completed user turn through Live Tail`);
    assert.ok(!measured.both_off.planner.providerInput.includes('chatId=t1-u'),
      `${mode}: with Live Tail off the Planner no longer receives that raw turn`);

    console.log(JSON.stringify({
      test: 'libra_live_tail_supply_measurement',
      mode,
      classicWithLiveTail: on.length,
      classicWithout: off.length,
      dialogueSuppliedChars: on.length - off.length,
      verified: true
    }));
  }
  console.log('libra_live_tail_supply_measurement_test: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
