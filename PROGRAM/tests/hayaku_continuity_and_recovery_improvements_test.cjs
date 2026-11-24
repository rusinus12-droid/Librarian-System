'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage,
  createStore,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');
const { fixture, quotes } = require('./fixtures/hayaku_reanalysis_fixture.cjs');
const { envelope } = require('./fixtures/shared_reanalysis_owner_fixture.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });

test('1. stale source_record snapshots are demoted out of LATEST VALID STATE while current state stays current', async () => {
  const packets = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    const p = createValidPacket({ turn, subject: 'Alice', scene: turn === 3 ? 'observatory' : 'courtyard', summary: `Turn ${turn} summary.` });
    p.entity.characters = [{
      id: 'char_alice',
      name: 'Alice',
      location: turn === 3 ? 'observatory' : 'courtyard',
      current_state: turn === 3 ? 'Inspecting telescope NOW_CURRENT_STATE' : `Waiting OLD_TURN_${turn}_STATE`,
      time_scope: 'current'
    }];
    packets.push({
      raw: JSON.stringify(p),
      hash: `pkt-t${turn}`,
      messageIndex: turn * 2 - 1,
      worldlineOrdinal: turn,
      targetPairIndex: turn
    });
  }
  const h = await createHayakuRuntime({ autoRepair: false, afterRequestAutoRepair: false, arguments: { memory_suite_server_mode: 'plugin_only' } });
  try {
    const t = h.hayaku._test;
    const store = t.emptyStore();
    for (const pkt of packets) t.ingestPacket(store, pkt.raw, pkt.hash, pkt);
    store.worldlineHeadOrdinal = 3;
    const settings = { ...h.hayaku.settings(), maxItemsPerAxis: 8, retrievalRecentContext: { topics: [] } };
    t.rebuildIndex(store, { settings, deadlineAt: Date.now() + 10000, skipUnusedDerivedStructures: true });
    await t.localRecallPrepareSources(packets, store, settings, 'stale-demote-scope', Date.now() + 10000);

    const oldRow = store._recallSourceRows.find(r => r.publicText.includes('OLD_TURN_1_STATE'));
    const currentRow = store._recallSourceRows.find(r => r.publicText.includes('NOW_CURRENT_STATE'));
    assert.ok(oldRow && currentRow, 'both source_records exist in _recallSourceRows');
    assert.ok(Number(oldRow.locator?.distanceFromLatest) > 0, 'older source_record retains distanceFromLatest > 0');
    assert.notEqual(t.continuityEvidenceLaneFor(oldRow.axis, oldRow), 'latest_state', 'old source_record must not pollute latest_state');
    assert.equal(t.continuityEvidenceLaneFor(currentRow.axis, currentRow), 'latest_state', 'latest turn source_record stays in latest_state');
  } finally {
    await h.dispose();
  }
});

test('2. semanticLane is honored for reserved and eviction-protected continuity lanes', async () => {
  const h = await createHayakuRuntime({ autoRepair: false, arguments: { memory_suite_server_mode: 'plugin_only' } });
  try {
    const t = h.hayaku._test;
    const query = 'Alice vault secret promise';
    const settings = { ...h.hayaku.settings(), maxItemsPerAxis: 4 };
    const rows = [
      {
        id: 'summary-filler-1', publicRef: 'sum-1', packetHash: 'p1', axis: 'narrative', category: 'summary_memory',
        publicText: 'summary: Alice walked along the outer stone path mentioning vault details and long architectural hallways.',
        score: 0.99, _localRecall: true, _recallDirectRank: 0,
        visibility: { privacy: 'public' }, lifecycle: { status: 'active', timeScope: 'past' },
        locator: { sourcePairIndex: 1, worldlineOrdinal: 1, messageIndex: 1 }
      },
      {
        id: 'boundary-1', publicRef: 'secret-1', packetHash: 'p2', axis: 'entity', category: 'secret',
        publicText: 'Vault combination is 4829, hidden from Bob.',
        score: 0.45, _localRecall: true, _recallDirectRank: 0,
        visibility: { privacy: 'secret', ownerEntityId: 'Alice', visibleToEntityIds: ['Alice'], deniedToEntityIds: ['Bob'] }, lifecycle: { status: 'active', timeScope: 'current' },
        locator: { sourcePairIndex: 2, worldlineOrdinal: 2, messageIndex: 3 }
      },
      {
        id: 'lock-1', publicRef: 'lock-1', packetHash: 'p3', axis: 'planner', category: 'continuity_lock',
        publicText: 'Alice must keep the brass key sealed until midnight.',
        score: 0.44, _localRecall: true, _recallDirectRank: 0,
        visibility: { privacy: 'public' }, lifecycle: { status: 'open', timeScope: 'current' },
        locator: { sourcePairIndex: 3, worldlineOrdinal: 3, messageIndex: 5 }
      }
    ];
    const prepared = t.prepareHayakuRecallRows(rows, query, settings, { worldlineHeadOrdinal: 3 }, [], []);
    assert.ok(prepared.entity.length === 1 && prepared.planner.length === 1);
    const plan = t.selectHayakuEvidencePlan(prepared, query, settings, 960);
    const quota = plan.plan.temporalQuota;
    assert.ok(plan.text.includes('[KNOWLEDGE BOUNDARIES]'), 'knowledge_boundaries lane preserved');
    assert.ok(plan.text.includes('[UNRESOLVED CONSTRAINTS]'), 'unresolved_constraints lane preserved');
    assert.ok(quota.protectedSourceTurns >= 2, 'protected core lanes counted accurately instead of falling into derived_summaries');
  } finally {
    await h.dispose();
  }
});

test('3. buildSceneBaton accepts valid-ordinal recovery_snapshot and preserves durable attire/carrying & locks', async () => {
  const h = await createHayakuRuntime({ autoRepair: false, arguments: { memory_suite_server_mode: 'plugin_only' } });
  try {
    const t = h.hayaku._test;
    const p1 = createValidPacket({ turn: 1, subject: 'Alice', scene: 'vault-wing' });
    p1.world.location = 'Vault Wing';
    p1.entity.characters = [{ name: 'Alice', attire: 'cobalt raincoat', carrying: ['brass lantern'] }];

    const p2 = createValidPacket({ turn: 2, packetType: 'recovery_snapshot', subject: 'Alice', scene: 'vault-wing' });
    p2.world.location = 'Vault Wing';
    p2.world.time = '23:40';
    p2.entity.characters = [{ name: 'Alice', current_state: 'unlocking the cabinet' }];
    p2.planner.continuity_locks = ['Do not open the inner drawer before midnight'];
    p2.entity.pov_memories = [{ ownerEntityId: 'Alice', privacy: 'private', deniedToEntityIds: ['Bob'], summary: 'Alice hid the cipher' }];

    const baton = t.buildSceneBaton([
      { raw: JSON.stringify(p1), hash: 'h1', worldlineOrdinal: 1, targetPairIndex: 1 },
      { raw: JSON.stringify(p2), hash: 'h2', worldlineOrdinal: 2, targetPairIndex: 2 }
    ], { memoryLanguage: 'en', capChars: 800 });

    assert.match(baton.text, /\[HAYAKU ACTIVE SCENE HEAD\]/);
    assert.match(baton.text, /cobalt raincoat/, 'durable attire carried forward');
    assert.match(baton.text, /brass lantern/, 'durable carrying carried forward');
    assert.match(baton.text, /Do not open the inner drawer/, 'continuity lock survives cap');
    assert.match(baton.text, /Alice hid the cipher/, 'knowledge boundary survives cap');
  } finally {
    await h.dispose();
  }
});

test('4. standalone handleBeforeRequest respects recallPreset light 3000-char ceiling', async () => {
  const messages = [];
  for (let turn = 1; turn <= 12; turn += 1) {
    const p = createValidPacket({
      turn,
      subject: `Envoy${turn}`,
      scene: `sector-${turn}`,
      summary: `In sector ${turn}, Envoy${turn} transported archival crate ${turn * 11} containing calibrated prism instruments to checkpoint alpha-${turn}.`
    });
    messages.push(user(`preset-u${turn}`, `Check sector ${turn} crate ${turn * 11}.`));
    messages.push(assistant(`preset-a${turn}`, hiddenPacketMessage(`Logged sector ${turn}.`, p)));
  }
  const h = await createHayakuRuntime({
    autoRepair: false,
    afterRequestAutoRepair: false,
    messages,
    arguments: {
      memory_suite_server_mode: 'plugin_only',
      hayaku_recall_preset: 'light',
      hayaku_packet_recovery: 'false'
    }
  });
  try {
    h.hayaku._test.stopWorldlineTopologyObserver();
    await h.callBeforeRequest([{ role: 'user', content: 'Summarize every archival crate transported across checkpoints.' }], 'model');
    const dbg = h.hayaku.lastDebug().lastBeforeRequest;
    assert.ok(dbg.memoryBudgetChars <= 3000, `light preset budget exceeded 3000: ${dbg.memoryBudgetChars}`);
    assert.ok(dbg.memoryContextChars <= 3000, `light preset rendered chars exceeded 3000: ${dbg.memoryContextChars}`);
  } finally {
    await h.dispose();
  }
});

test('5. Korean Scene Head peer detection, windowed verbatim recovery passages, and LIBRA complementarity', async () => {
  const longBody = Array.from({ length: 45 }, (_, i) => (
    `문장 ${i + 1}: 유나는 ${i === 25 ? '붉은 인장이 찍힌 비밀 장부를 다락방 마루 밑에 숨겼다' : '복도를 천천히 걸으며 창밖의 빗소리를 들었다'}.`
  )).join(' ');
  assert.ok(longBody.length > 1500);

  const secretTurnP = createValidPacket({ turn: 2, subject: '유나', scene: 'attic', summary: '유나가 다락방을 살폈다.' });
  secretTurnP.entity.characters = [{ name: '유나', current_state: '비밀 점검' }];
  secretTurnP.entity.secrets = [{
    title: '비밀 장부 위치',
    ownerEntityId: '유나',
    visibleToEntityIds: ['유나'],
    deniedToEntityIds: ['민수'],
    privacy: 'secret',
    summary: '유나만 비밀 장부의 위치를 알고 민수는 모른다.'
  }];
  const historyMsgs = [
    user('libra-u1', '다락방 장부 얘기'),
    assistant('libra-a1', longBody),
    user('libra-u2', '장부를 숨겼어.'),
    assistant('libra-a2', hiddenPacketMessage('유나가 비밀을 지켰다.', secretTurnP))
  ];
  for (let turn = 3; turn <= 8; turn += 1) {
    const p = createValidPacket({ turn, subject: '유나', scene: 'hall', summary: `턴 ${turn} 일상 대화.` });
    historyMsgs.push(user(`libra-u${turn}`, `질문 ${turn}`), assistant(`libra-a${turn}`, hiddenPacketMessage(`응답 ${turn}.`, p)));
  }

  const h = await createHayakuRuntime({
    autoRepair: false,
    afterRequestAutoRepair: false,
    messages: historyMsgs,
    arguments: { memory_suite_server_mode: 'plugin_only', hayaku_packet_recovery: 'false', hayaku_recall_preset: 'light' }
  });
  try {
    h.hayaku._test.stopWorldlineTopologyObserver();
    const t = h.hayaku._test;
    const sdkCtx = {};
    const sdkSource = fs.readFileSync(path.join(__dirname, '../sdk/MemorySuiteSourceInput.libra.source.js'), 'utf8');
    vm.runInNewContext(sdkSource + '\nglobalThis.memorySuitePeerRecallIndex = memorySuitePeerRecallIndex;', sdkCtx);
    const koIdx = sdkCtx.memorySuitePeerRecallIndex([
      { role: 'system', content: '[HAYAKU 활성 장면 헤드]\n- 장소 / 시간: 도서관\n- 현장 인물: [유나] — 장부 확인\n[HAYAKU RUNTIME PACKET SHAPE]' }
    ], 'libra');
    assert.ok(koIdx.owners.includes('hayaku'), 'LIBRA detects Korean [HAYAKU 활성 장면 헤드]');
    assert.ok(fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8').includes('\\[HAYAKU 활성 장면 헤드\\]'), 'LIBRA carries synced Korean Scene Head marker');

    const scope = await t.currentChatScope();
    const snapshot = t.authoritativeChatSnapshot(scope.chatMessages, scope);
    const ledger = await t.loadStorageLedger(scope, { hydrateArchive: false });
    const worldline = t.reconcileTurnWorldline(ledger.worldline, snapshot, scope);
    await t.upsertRecoveryVaultEvidence({ scope, lineage: { requestNonce: 'n1', targetPairIndex: 1 } }, { pair: snapshot.conversationPairs[0], liveScope: scope }, 'missing_test');
    const rawRecall = await t.searchRecoveryVaultRawPassages(scope, '붉은 인장 비밀 장부 다락방', scope.chatMessages, h.hayaku.settings(), snapshot, worldline);
    assert.ok(rawRecall.active && rawRecall.records.length > 0, 'windowed raw passage recovered');
    assert.ok(rawRecall.records.every(r => r.text.length <= 700), 'split passage stays within window cap so render cap admits it');
    assert.ok(rawRecall.records.some(r => r.text.includes('붉은 인장이 찍힌 비밀 장부')), 'relevant window found');

    // End-to-end LIBRA peer block injection preserves HAYAKU's knowledge_boundaries & windowed verbatim evidence
    const injected = await h.callBeforeRequest([
      { role: 'system', content: '<LIBRA_CLASSIC_RECALL>\n[Episode 1] 유나가 며칠 전 다락방을 둘러보았다.\n</LIBRA_CLASSIC_RECALL>' },
      { role: 'user', content: '유나는 다락방의 붉은 인장 비밀 장부를 어디에 숨겼지?' }
    ], 'model');
    const joined = injected.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    assert.match(joined, /KNOWLEDGE BOUNDARIES/, 'knowledge boundaries surfaced alongside LIBRA');
    assert.match(joined, /VERBATIM PAST EVIDENCE/, 'windowed verbatim evidence surfaced alongside LIBRA');

    const deniedInjected = await h.callBeforeRequest([
      { role: 'system', content: '<LIBRA_CLASSIC_RECALL>\n[Episode 1] 유나가 며칠 전 다락방을 둘러보았다.\n</LIBRA_CLASSIC_RECALL>' },
      { role: 'user', content: '민수는 다락방의 비밀 장부 위치를 알고 있나?' }
    ], 'model');
    const deniedJoined = deniedInjected.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    assert.ok(!deniedJoined.includes('유나만 비밀 장부의 위치를 알고 민수는 모른다.'), 'denied entity query must not leak protected secret knowledge');
  } finally {
    await h.dispose();
  }
});

test('6. Mode B budget freedom, wrapper placement, curly-quote grounding, and editOutput-strip rescue', async () => {
  const assistantText = 'Alice opened the door and whispered, "Wait here."';
  const curlyQuoteEvidence = 'whispered, “Wait here.”';
  const rows = [user('modeb-u1', 'Open the door.')];
  const pluginStorage = createStore();
  await pluginStorage.setItem('hayaku.v2.settings.source-tracking.v1', JSON.stringify({ mode: 'off', epoch: 0 }));
  const h = await createHayakuRuntime({
    pluginStorage,
    messages: rows,
    afterRequestAutoRepair: false,
    arguments: { hayaku_otherax_canonical_packet: 'true' }
  });
  try {
    h.hayaku._test.stopWorldlineTopologyObserver();
    const t = h.hayaku._test;

    // Curly-quote typography normalization in validateNativeRepairGrounding
    const pCurly = createValidPacket({ turn: 1, subject: 'Alice', summary: assistantText });
    for (const ax of ['entity', 'world', 'narrative', 'planner']) for (const [k, v] of Object.entries(pCurly[ax])) if (Array.isArray(v)) pCurly[ax][k] = [];
    pCurly.narrative.critical_dialogue = [{ speaker: 'Alice', quote: 'Wait here.' }];
    pCurly.meta.summary_memory = { summary: assistantText };
    const envCurly = {
      schema: 'hayaku.native_repair_output.v1',
      packet: pCurly,
      grounding: [
        { path: 'meta.summary_memory.summary', source: 'target', evidence: [assistantText] },
        { path: 'narrative.critical_dialogue[0]', source: 'target', evidence: [curlyQuoteEvidence] }
      ]
    };
    assert.equal(t.validateNativeRepairGrounding(envCurly, { targetText: assistantText }).ok, true, 'curly quotes accepted when normalized');

    // Mode B stays active under tight host budget & honors <Answer>...</Answer> wrapper placement
    await h.callBeforeRequest([
      { role: 'system', content: 'Wrap your actual response strictly inside <Answer>...</Answer> tags only.' },
      { role: 'user', chatId: 'modeb-u1', id: 'modeb-u1', content: 'Open the door.' }
    ], 'model', { maxContext: 1200, maxResponse: 800 });
    const dbg = h.hayaku.lastDebug().lastBeforeRequest;
    assert.equal(dbg.packetWriteActive, true, 'Mode B remains active despite tight main-model context');
    assert.equal(dbg.mandatoryPacketCoreTargetChars, 0, 'Mode B reserves 0 main-model packet-writing chars');
    assert.equal(dbg.hardContextExhaustion, false, 'Mode B never triggers hard_context_exhaustion');

    const scope = await t.currentChatScope();
    const pending = t.selectPendingCapture([], scope, 'model');
    assert.equal(pending?.packetPlacement?.mode, 'inside_terminal_wrapper', 'pending remembers </Answer> wrapper placement');

    const pOut = createValidPacket({ turn: 1, summary: assistantText });
    pOut.meta.packet_type = 'current_snapshot';
    pOut.meta.lineage = {
      parent_turn_node_id: pending.lineage.parentTurnNodeId || '', logical_turn_id: pending.lineage.logicalTurnId,
      request_nonce: pending.lineage.requestNonce, identity_version: 2, lineage_schema: pending.lineage.lineageSchema,
      turn_owner_key: pending.lineage.turnOwnerKey, generation_attempt_id: pending.lineage.generationAttemptId
    };
    pOut.meta.turn_anchor = assistantText;
    pOut.meta.summary_memory = { summary: assistantText, directEvidenceSnippets: [assistantText], confidence: 0.9 };
    for (const ax of ['entity', 'world', 'narrative', 'planner']) for (const [k, v] of Object.entries(pOut[ax])) if (Array.isArray(v)) pOut[ax][k] = [];
    h.setLlmResponder(async () => ({
      type: 'success',
      result: JSON.stringify({
        schema: 'hayaku.native_repair_output.v1',
        packet: pOut,
        grounding: [{ path: 'meta.summary_memory.summary', source: 'target', evidence: [assistantText] }]
      })
    }));

    const afterText = await h.callAfterRequest(`<Answer>${assistantText}</Answer>`, 'model');
    assert.match(afterText, /HAYAKU_STATE_PACKET_START[\s\S]*<\/Answer>\s*$/, 'Mode B inserts packet inside </Answer> wrapper');

    // Simulate downstream editOutput regex stripping all HTML comments before chat commit
    const strippedByEditOutput = `<Answer>${assistantText}</Answer>`;
    rows.push(assistant('modeb-a1', strippedByEditOutput));
    h.setMessages(rows);
    await t.processRisuChatOutputEvent({ char: h.character, chat: h.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });

    let rescued = null;
    for (const started = Date.now(); !rescued && Date.now() - started < 15000; await new Promise(resolve => setTimeout(resolve, 50))) {
      rescued = Array.from((await h.hayaku.ledger.inspect({ includeRecords: true })).records || [])
        .find(r => r.recordState === 'active' && Number(r.targetPairIndex) === 1) || null;
    }
    assert.ok(rescued, 'verified afterRequest packet rescued into ledger despite downstream comment strip');
    assert.equal(rescued.packetAuthor, 'otherax_canonical');
  } finally {
    await h.dispose();
  }
});

test('7. selected reanalysis exposes cancellable: true and reuses durable per-turn checkpoints after mid-batch failure', async () => {
  const f = await fixture();
  try {
    const inventory = await f.api.listReanalysisRanges();
    let calls = 0;
    let sawCancellable = false;
    f.r.setLlmResponder(async call => {
      calls += 1;
      const job = f.api.recovery.jobStatus();
      if (job?.kind === 'source_edit' && job?.cancellable === true) sawCancellable = true;
      const target = (call.messages.find(row => row.role === 'user')?.content || '').split('[CONTEXT ONLY')[0];
      if (calls === 2) return { type: 'fail', result: 'transient mid-batch failure' };
      const quote = quotes.find(v => target.includes(v)) || quotes[0];
      return { type: 'success', result: JSON.stringify(envelope(quote)) };
    });

    const selection = { ...inventory, ranges: inventory.ranges.filter(r => ['1', '2'].includes(r.key)) };
    const first = await f.api.reanalyzeSelectedRanges(selection);
    assert.equal(first.ok, false, 'first multi-turn run stops at failed turn 2');
    assert.equal(sawCancellable, true, 'source_edit job exposed cancellable: true while running');
    assert.equal(calls, 2);

    // Retry the exact same selection: Turn 1 checkpoint is reused (only Turn 2 calls LLM)
    const second = await f.api.reanalyzeSelectedRanges(selection);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.reusedChunks, 1, 'turn 1 verified chunk reused from checkpoint');
    assert.equal(calls, 3, 'total LLM calls = 2 (run 1) + 1 (turn 2 only on retry)');
  } finally {
    await f.close();
  }
});
