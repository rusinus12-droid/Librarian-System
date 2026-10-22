'use strict';
// Retirement regression: all combinations of legacy live-tail flags leave raw dialogue
// out of the actual request, while verified Micro evidence remains delivered.
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
  assert.ok(scopeKey && context?.requestId, JSON.stringify({scopeKey,error:viewer?.error,requestId:context?.requestId}));
  assert.notEqual(context.requestId, previous?.requestId, 'witness belongs to this new request');
  assert.equal(context.route, 'classic');
  assert.equal(context.scopeKey, scopeKey);
  assert.equal(context.values?.currentInput, query);
  assert.equal(viewer?.scopeKey, scopeKey);
  assert.equal(viewer?.queryText, query);
  assert.equal(viewer?.responseContextRequestId, context.requestId);
  assert.equal(viewer?.responseContextDigest, context.contextDigest);
  // Assert the returned host handoff itself. Its graph resource may be released
  // after beforeRequest returns; in-flight freshness is covered by the consumed-Micro suite.
  assert.equal(providerCalls, 0, 'current Classic retrieval has no retired Planner provider call');
  const injected = messages.filter(row => row.role === 'system' && String(row.content || '').includes('[LIBRA CLASSIC RECALL'));
  assert.ok(injected.length > 0, 'actual outbound messages carry Classic recall');
  const block = injected.map(row => String(row.content || '')).join('\n');
  const microRows = Array.from(viewer.rows || []).filter(row => row.family === 'micro' && row.injected === true);
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
const QUERY = '도서관의 정숙 규칙을 고려해서 이어줘.';
// The unified Classic renderer (9c03c35, "Replace LIBRA legacy retrieval with the unified memory
// engine") appends Live Tail under this header and labels each evidence row `(n) [family:role]`.
const DIALOGUE_MARK = '[RECENT COMPLETED DIALOGUE]';
const MICRO_MARK = /^\(\d+\) \[micro:[^\]]+\] /m;

const measure = async (mode, combo) => {
  let listener;
  const fx = await serverFixture({
    transformSource: source => source.replace('try { globalThis.__LIBRA__ = publicApi; } catch (_) {}',
      'globalThis.__retirementCaptureSettled=()=>{const s=LibraMemoryCore.state;return !s.microJobs.size&&!s.receiptCaptureJobs.size&&!s.storageWriteFence.size&&!s.timers.has("current_state_snapshot")&&Number(s.snapshot?.refreshedAt||0)>=Number(s.lastMicroPublication?.at||0);};\ntry { globalThis.__LIBRA__ = publicApi; } catch (_) {}'),
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
    // Publication precedes its scheduled snapshot refresh. A concurrent source write
    // correctly revokes recall; measure a completed publication, not that race.
    await waitFor(() => f.r.context.__retirementCaptureSettled(), 15000);

    const classic = await readClassicDelivery(f, QUERY, false);
    return { microStatus, classic };
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
  for (const mode of (process.env.LIBRA_RETIREMENT_MODE ? [process.env.LIBRA_RETIREMENT_MODE] : ['plugin_only', 'mirror', 'server_only'])) {
    const measured = {};
    for (const combo of combos) {
      measured[combo.label] = await measure(mode, combo);
      assert.equal(measured[combo.label].microStatus, 'verified',
        `${mode}/${combo.label}: the arm starts from a durable verified Micro`);
    }

    const on = measured.both_on.classic.delivered;
    for (const combo of combos) {
      assert.ok(!measured[combo.label].classic.delivered.includes(DIALOGUE_MARK),
        `${mode}/${combo.label}: legacy flags cannot append retired raw dialogue`);
      assert.match(measured[combo.label].classic.delivered, MICRO_MARK);
    }

    // (2) Micro does not depend on Live Tail: the extracted evidence survives with everything off.
    const off = measured.both_off.classic.delivered;
    assert.match(off, MICRO_MARK,
      `${mode}: the Micro evidence is present even with Live Tail disabled`);
    assert.ok(off.includes(DETAIL),
      `${mode}: the Micro claim text survives Live Tail being disabled`);

    // Legacy flag combinations cannot reactivate the retired append path.
    assert.ok(!measured.context_only.classic.delivered.includes(DIALOGUE_MARK),
      `${mode}: live_context_enabled alone does not put dialogue in the Classic block`);
    assert.ok(!measured.classic_only.classic.delivered.includes(DIALOGUE_MARK),
      `${mode}: classic_live_tail_enabled alone does not put dialogue in the Classic block`);

    // Retired Planner-provider assertions are not a second current delivery route.
    // Every 2x2 arm above already proves same-request Classic/Micro delivery.

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
