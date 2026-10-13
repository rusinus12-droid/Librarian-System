'use strict';
// Task 9 (plan line 329): "For T1 promise → T3 delay → T5 fulfillment, assert that the T5 Micro and
// Canonical both survive, a synthesis query selects the Canonical conclusion, a T3 scene query selects
// its Micro span, and the same source-backed claim appears only once in the final input."
//
// T2 and T4 produce no change claims here: the receipt exists but no Micro body does, which is the
// 'pending' case the plan asks to cover (spec 126: a turn with no verified Micro body is not counted
// as a completed Micro).
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');

const PROMISE = '도서관 전체는 정숙 구역';
const DELAY = '준호가 지호에게서 열쇠를 받아 들었다';
const FULFILL = '공연 허가를 내주기로 확정했다';
const observed = new Map([[1, PROMISE], [3, DELAY], [5, FULFILL]]);

const sourceClaim = (input, value) => {
  const text = input.assistant.text;
  const startOffset = text.indexOf(value);
  assert.ok(startOffset >= 0, `T${input.binding.turn} quote belongs to the completed assistant source`);
  return { changeKind: 'event', text: value, actor: '', target: '',
    temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
    stateChangeType: 'set',
    stateIntent: { domain: 'narrative', target: { scope: 'current_narrative' },
      field: 'summary', operation: 'set', value },
    evidence: { role: 'assistant', messageId: input.assistant.messageId,
      startOffset, endOffset: startOffset + value.length, exactQuote: value } };
};

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fx = await serverFixture({ mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const { f } = fx;
      const fullMessages = f.chat.message;
      const canonical = artifact();
      const conclusion=canonical.facts.find(fact => fact.tempFactId === 'f13');
      conclusion.values.thread.summary=FULFILL;conclusion.text=FULFILL+'.';
      f.control.artifact = canonical;
      f.control.onCall = async args => {
        const messages = args[0].messages;
        if (!String(messages[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')) {
          return { type: 'success', result: JSON.stringify(canonical) };
        }
        const input = JSON.parse(messages[1].content);
        const value = observed.get(input.binding.turn);
        return { type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: { spans: [], relations: [] },
          micro: { schema: 'libra.micro_memory.v1', ...input.binding,
            claims: value ? [sourceClaim(input, value)] : [] }
        })};
      };
      for (let turn = 1; turn <= 5; turn += 1) {
        f.chat.message = fullMessages.slice(0, turn * 2);
        f.chat.messages = f.chat.message;
        listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
          messageIndex: turn * 2 - 1 });
        await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === turn, 15000);
      }

      // T5 Micro and Canonical must both survive the Canonical commit.
      f.chat.message = fullMessages;
      f.chat.messages = fullMessages;
      const canonicalRun = await f.run();
      assert.equal(canonicalRun.completed + canonicalRun.skipped, 1,
        `${mode}: the T5 Canonical pass commits: ${JSON.stringify(canonicalRun)}`);
      assert.equal((await f.r.api.debugReadActiveMicroMemory(5)).status, 'verified',
        `${mode}: the T5 Micro survives the Canonical commit`);
      assert.equal((await f.r.api.debugReadActiveMicroMemory(3)).status, 'verified',
        `${mode}: the T3 Micro survives the Canonical commit`);

      // T2/T4 have receipts but no Micro body: the frontier must not count them as completed Micros.
      await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
      const beforeCalls=f.control.calls.length;
      f.control.onCall=()=>{throw Error('actual Classic must consume durable evidence without generation');};
      const scope=await f.r.api.getHostLineageStatus();
      const synthesis=await actualClassicPacket(f,`${FULFILL} 내용으로 정리해줘.`,scope.scopeKey);
      assert.equal(f.control.calls.length,beforeCalls);
      const viewer = f.r.api.getLastMemoryRecallViewer();
      const frontier = viewer?.microFrontier;
      assert.ok(frontier, `${mode}: the delivery exposes the Micro frontier`);
      if (process.env.TIMELINE_DUMP) {
        require('node:fs').writeFileSync(process.env.TIMELINE_DUMP + `-${mode}.json`, JSON.stringify({
          frontier, rows: (viewer.rows || []).map(row => ({ kind: row.kind, turnRange: row.turnRange,
            evidenceAuthority: row.evidenceAuthority, injected: row.injected, plannerUsed: row.plannerUsed,
            classicUsed: row.classicUsed, sgaUsed: row.sgaUsed,
            text: String(row.selectedText || '').slice(0, 60) })),
          deliveredBlockLength:synthesis.actualClassic.block.length
        }, null, 1));
      }
      const microTurns = (viewer.rows || []).filter(row => row.kind === 'micro')
        .map(row => Number(row.turnRange?.end ?? 0));
      assert.ok(!microTurns.includes(2) && !microTurns.includes(4),
        `${mode}: turns whose analysis produced no Micro body are not delivered as Micro rows (got ${JSON.stringify(microTurns)})`);
      // T5 is persisted source-bound when the Canonical pass commits in the same turn; the existing
      // contract asserts exactly that (libra_micro_state_frontier_3mode_test, 'Canonical-first T5 Micro
      // is absorbed without a second State write'). T1/T3 stay analytically verified.
      // NOTE: frontier arrays are created inside the VM realm, and assert/strict's deepEqual compares
      // prototypes - so a cross-realm [1,3] never deep-equals a test-realm [1,3]. Normalize first
      // (measured: the assertion failed with actual [Array] / expected [Array] while the dumped
      // content was identical).
      const realmArray = value => Array.from(value || []).map(Number).sort((a, b) => a - b);
      assert.deepEqual(realmArray(frontier.verifiedTurns), [1, 3],
        `${mode}: the frontier reports the analytically produced turns (got ${JSON.stringify(frontier.verifiedTurns)})`);
      assert.ok(realmArray(frontier.sourceOnlyTurns).includes(5),
        `${mode}: the T5 turn that Canonical absorbed is reported as source-bound, not verified (got ${JSON.stringify(frontier.sourceOnlyTurns)})`);
      assert.equal(frontier.pending, true,
        `${mode}: the frontier stays pending while a turn in range is source-bound only`);

      // A synthesis query selects the Canonical conclusion; a T3 scene query selects the T3 Micro span.
      const synthesisRows = (viewer.rows || []);
      assert.ok(synthesisRows.some(row => row.kind === 'canonical'),
        `${mode}: the Canonical conclusion is a selectable row for a synthesis query`);
      const t3Recall = await f.r.api.previewUnifiedMemoryRecall(DELAY);
      assert.ok(Array.from(t3Recall.memories || []).some(row => row.memory?.kind === 'micro'
        && Number(row.memory?.turnRange?.start) === 3),
      `${mode}: a T3 scene query selects the T3 Micro span`);

      // Count only the actual returned memory block, excluding the user's query.
      const deliveredInput=synthesis.actualClassic.block;
      assert.equal(deliveredInput.split(FULFILL).length-1,1,`${mode}: canonical conclusion actually reaches the returned recall block exactly once`);
      for(const claim of [PROMISE,DELAY,FULFILL])assert.ok(deliveredInput.split(claim).length-1<=1,
        `${mode}: each exact source claim occurs at most once in delivered memory material`);
      assert.ok(viewer.rows?.some(row=>row.kind==='micro'&&row.classicUsed===true&&row.injected===true),
        `${mode}: actual Classic consumes a durable Micro row`);

      // Bind T3 selection and text to the returned Classic prompt.
      const t3Packet=await actualClassicPacket(f,`${DELAY} 장면을 이어줘.`,scope.scopeKey);
      assert.equal(f.control.calls.length,beforeCalls);
      assert.ok(t3Packet.actualClassic.block.includes(DELAY),`${mode}: exact T3 evidence reaches the actual returned prompt`);
      const t3Viewer = f.r.api.getLastMemoryRecallViewer();
      const t3Micro = Array.from(t3Viewer?.rows || [])
        .find(row => row.kind === 'micro' && Number(row.turnRange?.start) === 3);
      assert.ok(t3Micro,
        `${mode}: a T3 scene query selects the Micro row bound to turn 3 (got ${JSON.stringify(
          Array.from(t3Viewer?.rows || []).map(row => [row.kind, row.turnRange?.start]))})`);
      assert.equal(t3Micro.classicUsed,true);assert.equal(t3Micro.injected,true);
      assert.ok(t3Micro.selectedText.includes(DELAY));
      assert.equal(t3Micro.deduplicatedClaims,0,`${mode}: generic Micro event cannot be equated to canonical typed semantics by text alone`);
      const activeT3=await f.r.api.debugReadActiveMicroMemory(3);
      assert.equal(activeT3.status,'verified');
      assert.equal(t3Micro.sourceReceiptKey,activeT3.record.receiptKey);
      assert.equal(t3Micro.sourceRevisionId,activeT3.record.sourceRevisionId);
      assert.ok(t3Micro.sourceSpans.some(span=>span.role==='assistant'&&span.messageId==='t3-a'&&span.exactQuote.includes(DELAY)));
      const deliveredCanonical=t3Packet.actualClassic.deliveredRows.filter(row=>row.kind==='canonical'&&row.selectedText.includes(DELAY));
      assert.equal(deliveredCanonical.length,1,`${mode}: independently typed canonical row also survives selection`);
      assert.notEqual(deliveredCanonical[0].memoryId,t3Micro.memoryId);
      const ref=t3Packet.actualClassic.context.canonicalRefs.find(row=>row.memoryId===deliveredCanonical[0].memoryId);
      assert.ok(ref?.key);
      const raw=mode==='plugin_only'?fx.local.get(ref.key):fx.storedRows().find(row=>row.key===ref.key)?.raw;
      assert.equal(typeof raw,'string');const memory=JSON.parse(raw);
      assert.ok(memory.canonicalArtifact.facts.some(fact=>fact.text.includes(DELAY)
        &&fact.evidenceSpans.some(span=>span.ref==='t3-a'&&span.quote.includes(DELAY))),
        `${mode}: distinct canonical claim remains bound to sealed original T3 source`);
      assert.equal(t3Micro.evidenceAuthority, 'source_verified_candidate',
        `${mode}: the T3 row is the source-verified Micro candidate, not a Canonical row`);
      console.log(`PASS T1/T3/T5 promise-delay-fulfillment timeline in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
