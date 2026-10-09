'use strict';
// Task 9 (plan line 126/171): "When a current-turn receipt/Micro is pending, consumers expose
// `pending` or `last_known` and the verified frontier; they do not silently rebuild an untracked
// raw-chat tail at request time."
//
// Measured before this change: the recall viewer carried no `pending`, `last_known` or frontier field
// at all, and a turn whose analysis never ran is persisted as `analysisStatus: minimum_source_bound`
// (source span only, no extracted change claims). The delivery exposed `evidenceAuthority: source_only`
// per row but never summarised it, so a consumer could not tell a verified one-turn Micro from a
// source-span-only placeholder, nor whether a completed turn was still pending production.
//
// This suite drives both cases through the real hooks and asserts the frontier the consumers read.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor, createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const DETAIL = '도서관 전체는 정숙 구역';

const microEnvelope = (input, startOffset) => JSON.stringify({
  schema: 'libra.micro_producer_envelope.v1',
  personCandidates: { spans: [], relations: [] },
  micro: { schema: 'libra.micro_memory.v1', ...input.binding,
    claims: [{ changeKind: 'world', text: `${DETAIL}이다.`, actor: '', target: '도서관',
      temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
      stateChangeType: 'none', evidence: { role: 'assistant', messageId: input.assistant.messageId,
        startOffset, endOffset: startOffset + DETAIL.length, exactQuote: DETAIL }}] }
});

const frontierOf = viewer => viewer?.microFrontier || null;

// waitFor() in the harness is synchronous-only (it does not await predicates), so poll explicitly.
const waitForAsync = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the Micro record.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

(async () => {
  // --- Case 1: the producer never yields an analysis. The turn is still committed as source-bound
  // evidence, so consumers must be able to see that it is evidence without claims, and that the
  // analytical Micro for that turn is still pending.
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fx = await serverFixture({ mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const { f } = fx;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => ({ type: 'error', result: 'provider absent' });
      listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
      const record = await waitForAsync(async () => {
        const active = await f.r.api.debugReadActiveMicroMemory(1).catch(() => null);
        return active?.record?.analysisStatus === 'minimum_source_bound' ? active : null;
      });
      assert.equal(record.record.analysisStatus, 'minimum_source_bound',
        `${mode}: the absent provider persists source-bound evidence`);

      await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
      f.control.onCall = async () => ({ type: 'success', result: 'BRIEF' });
      await f.control.hooks.beforeRequest([{ role: 'user', content: '도서관 규칙을 고려해서 이어줘.' }], 'model');

      const viewer = f.r.api.getLastMemoryRecallViewer();
      const frontier = frontierOf(viewer);
      assert.ok(frontier, `${mode}: the consumer delivery exposes a Micro frontier`);
      assert.equal(frontier.schema, 'libra.micro_frontier.v1',
        `${mode}: the frontier is versioned`);
      assert.equal(frontier.lastKnownTurn, 1,
        `${mode}: the frontier reports the newest turn with committed Micro evidence (got ${frontier.lastKnownTurn})`);
      assert.ok(frontier.sourceOnlyTurns.includes(1),
        `${mode}: a turn with evidence but no extracted change claims is reported as source-bound only (got ${JSON.stringify(frontier.sourceOnlyTurns)})`);
      assert.equal(frontier.pending, true,
        `${mode}: a turn whose analysis is still absent is reported pending, not as a completed Micro`);
      // NOTE: lastPublication.status is the READBACK status ('verified' means the head is bound to the
      // receipt); the analysis distinction the spec cares about is record.analysisStatus, which the
      // frontier surfaces separately. Asserting the readback status here would have been wrong.
      assert.equal(frontier.analysisStatus, 'minimum_source_bound',
        `${mode}: the frontier reports the source-bound analysis status, not a verified one`);
      assert.ok(frontier.lastPublication && frontier.lastPublication.turn === 1,
        `${mode}: the frontier carries the last producer outcome`);
      console.log(`PASS Micro frontier reports source-bound pending evidence in ${mode}`);
    } finally { await fx.cleanup(); }
  }

  // --- Case 2: a healthy producer. The same turn is analytically verified, so consumers must see it
  // as verified and no longer pending.
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fx = await serverFixture({ mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const { f } = fx;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async args => {
        const input = JSON.parse(args[0].messages[1].content);
        const startOffset = input.assistant.text.indexOf(DETAIL);
        assert.ok(startOffset >= 0, `${mode}: Micro source span binds to the completed assistant`);
        return { type: 'success', result: microEnvelope(input, startOffset) };
      };
      listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);

      await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
      f.control.onCall = async () => ({ type: 'success', result: 'BRIEF' });
      await f.control.hooks.beforeRequest([{ role: 'user', content: '도서관 규칙을 고려해서 이어줘.' }], 'model');

      const frontier = frontierOf(f.r.api.getLastMemoryRecallViewer());
      assert.ok(frontier, `${mode}: the frontier is present for a verified Micro too`);
      assert.equal(frontier.lastKnownTurn, 1, `${mode}: verified Micro sets the frontier turn`);
      assert.ok(frontier.verifiedTurns.includes(1),
        `${mode}: an analytically verified turn is reported as verified (got ${JSON.stringify(frontier.verifiedTurns)})`);
      assert.ok(!frontier.sourceOnlyTurns.includes(1),
        `${mode}: a verified turn must not be reported as source-bound only`);
      assert.equal(frontier.pending, false,
        `${mode}: a verified, produced turn is not pending`);
      assert.equal(frontier.analysisStatus, 'verified',
        `${mode}: the frontier reports the verified analysis status for this turn`);
      console.log(`PASS Micro frontier reports verified evidence in ${mode}`);
    } finally { await fx.cleanup(); }
  }

  // --- Case 3: the frontier builder itself, for the pending-turn path no fixture can produce: a turn
  // in range whose Micro head is absent comes back as a reason instead of a row. The mutation run
  // showed this branch was uncovered (mutation M6 survived), so it is asserted directly.
  {
    const h = await createLibraVmHarness({ enable_character_ito: false, enable_world_ito: false, enable_plot_ito: false }, {});
    try {
      const emptyIndex = { producedTurns: [], verifiedTurns: [], sourceOnlyTurns: [], pendingTurns: [] };
      const withPending = r => h.api.debugMicroFrontier({ rows: [] }, null, r);
      const f = withPending({ ...emptyIndex, pendingTurns: [{ turn: 4, reason: 'micro_head_absent' }], lastKnownTurn: 3 });
      assert.equal(f.pending, true,
        'frontier builder: a turn in range with no Micro head keeps the frontier pending');
      assert.equal(f.lastKnownTurn, 3,
        'frontier builder: the last known turn comes from the enumerated heads, not the reported reason');
      const noPending = withPending(emptyIndex);
      assert.equal(noPending.pending, false,
        'frontier builder: with no pending turn and no source-only turn the frontier is not pending');
      assert.equal(noPending.analysisStatus, 'unavailable',
        'frontier builder: no evidence at all reports unavailable analysis');
      console.log('PASS Micro frontier builder reports pending turns without heads');
    } finally { await h.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
