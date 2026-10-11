'use strict';
// Retained current-consumer contract: Live Tail changes the explicitly enabled
// recent dialogue, while durable Micro must reach actual Classic output in both arms.
// Historical Planner-provider marker/delta expectations are retired with that
// executor. The filename remains stable for the original regression inventory.
//
// Run: node tests/libra_live_tail_planner_dialogue_source_test.cjs
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');


// Same-request evidence is taken from the real hook and its current response
// context/viewer. A selected viewer row alone is not a delivery witness.
async function readClassicDelivery(f, query, expectedLiveTail) {
  await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
  const scopeKey = (await f.r.api.getHostLineageStatus()).scopeKey;
  const previous = f.r.api.getLastResponseContext();
  let providerCalls = 0;
  f.control.onCall = async () => { providerCalls++; return { type: 'error', result: 'unexpected provider call during Classic recall' }; };
  const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: query }], 'model');
  const context = f.r.api.getLastResponseContext();
  const viewer = f.r.api.getLastMemoryRecallViewer();
  assert.ok(scopeKey && context?.requestId);
  assert.notEqual(context.requestId, previous?.requestId, 'witness belongs to this new request');
  assert.equal(context.route, 'classic');
  assert.equal(context.scopeKey, scopeKey);
  assert.equal(context.values?.currentInput, query);
  assert.equal(viewer?.scopeKey, scopeKey);
  assert.equal(viewer?.queryText, query);
  assert.equal(viewer?.responseContextRequestId, context.requestId);
  assert.equal(viewer?.responseContextDigest, context.contextDigest);
  const validity = await f.r.api.validateResponseContext(context);
  assert.equal(validity.ok, true, JSON.stringify(validity));
  assert.equal(validity.current, true);
  assert.equal(providerCalls, 0, 'current Classic retrieval has no retired Planner provider call');
  const injected = messages.filter(row => row.role === 'system' && String(row.content || '').includes('[LIBRA CLASSIC RECALL'));
  assert.ok(injected.length > 0, 'actual outbound messages carry Classic recall');
  const block = injected.map(row => String(row.content || '')).join('\n');
  const microRows = Array.from(viewer.rows || []).filter(row => row.kind === 'micro' && row.classicUsed === true && row.injected === true);
  assert.ok(microRows.length > 0, 'durable Micro is delivered, not merely selected');
  for (const row of microRows) {
    const exact = String(row.selectedText || row.text || '');
    assert.ok(exact.length > 0 && block.includes(exact), 'whole selected Micro text reaches the actual block');
  }
  assert.equal(viewer.liveTailInjected === true, expectedLiveTail);
  return { delivered: messages.map(row => String(row.content || '')).join('\n'), block,
    microUsed: microRows.length > 0, providerCalls, requestId: context.requestId, contextDigest: context.contextDigest };
}

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

    const delivery = await readClassicDelivery(f, '도서관의 정숙 규칙을 고려해서 이어줘.', liveOn);
    return {
      hasDialogueUser: delivery.block.includes(DIALOGUE_USER),
      hasDialogueAssistant: delivery.block.includes(DIALOGUE_ASSISTANT),
      hasRecentDialogueMarker: delivery.block.includes('RECENT DIALOGUE'),
      microUsed: delivery.microUsed,
      deliveredChars: delivery.delivered.length,
      requestId: delivery.requestId,
      contextDigest: delivery.contextDigest,
      providerCalls: delivery.providerCalls
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

    // Current Classic raw dialogue is supplied only by explicitly enabled Live Tail.
    assert.equal(on.hasDialogueUser, true, `${mode}: enabled Classic receives the actual recent user turn`);
    assert.equal(on.hasDialogueAssistant, true, `${mode}: enabled Classic receives the actual recent assistant turn`);
    assert.equal(on.hasRecentDialogueMarker, true, `${mode}: enabled dialogue has its ownership-bearing section`);
    assert.equal(off.hasDialogueUser, false, `${mode}: disabled Live Tail does not smuggle the raw user turn into Micro`);
    assert.equal(off.hasRecentDialogueMarker, false, `${mode}: disabled Live Tail has no recent-dialogue section`);
    assert.equal(on.providerCalls + off.providerCalls, 0);

    // (3) The memory read set is independent of Live Tail: the durable Micro reaches the consumer in
    // both arms, so what changes is the recent-dialogue framing, not the recalled evidence.
    assert.equal(on.microUsed, true,
      `${mode}: the durable Micro reaches the consumer with Live Tail on`);
    assert.equal(off.microUsed, true,
      `${mode}: the durable Micro reaches the consumer with Live Tail off as well`);
  }
  console.log('libra_live_tail_planner_dialogue_source_test: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
