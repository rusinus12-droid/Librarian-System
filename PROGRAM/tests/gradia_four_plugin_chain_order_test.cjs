'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const createBus = require('./fixtures/libra_gradia_read_bus.cjs');
const { createHayakuRuntime, createStore, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const writer = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const h64 = value => {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n);
  return 'h64' + h.toString(36);
};

// Unique proof sentences that DO NOT exist in the current user prompt or static prompt templates:
// User prompt: '은빛 열쇠의 행방과 서재 상황을 알려줘.'
const LIBRA_PROOF_FACT = '민아가 은빛 열쇠를 준호에게 잠시 건넸다';
const HAYAKU_PROOF_FACT = 'HAYAKU_PROOF_FACT: 기록실 지하 보관함에 민아의 은빛 인장이 보관되었다.';
const FLASHBACK_PROOF_FACT = 'FLASHBACK_PROOF_FACT: 서재 서랍 속에 오래된 비밀 지도가 숨겨져 있었다.';

test('four-plugin chain integration: Order A (Memory plugins -> GRADIA) and Order B (GRADIA -> Memory plugins)', { timeout: 180000 }, async t => {
  const bus = createBus();
  const libra = await require('./fixtures/libra_memory_graph_reader_fixture.cjs').fixture({ mode: 'plugin_only', hostOverrides: bus.api('libra') });
  t.after(() => libra.cleanup());

  const chat = libra.f.chat, character = libra.f.character;
  const characterId = character.chaId || character.id, chatId = chat.id;
  chat.message.push({ role: 'user', chatId: 'chain-current-user', data: '은빛 열쇠의 행방과 서재 상황을 알려줘.' });
  chat.messages = chat.message;

  const nativeApi = {
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => 0,
    getCharacter: async () => character,
    getChar: async () => character,
    getCharacterFromIndex: async () => character,
    getChat: async () => chat,
    getCurrentChat: async () => chat,
    getChatFromIndex: async () => chat,
    getDatabase: async () => ({ characters: [character], personas: [], modules: [] })
  };

  const hstore = createStore(), hscope = 'chat_' + h64(characterId + '\n' + chatId);
  const packet = JSON.stringify(createValidPacket({ summary: HAYAKU_PROOF_FACT }));
  await hstore.setItem('hayaku.v2.settings.source-tracking.v1', JSON.stringify({ mode: 'off', epoch: 0 }));
  await hstore.setItem('hayaku.v2.ledger.' + hscope, JSON.stringify({
    version: 'hayaku_storage_ledger_v2',
    scopeKey: hscope,
    identity: { schema: 'hayaku.scope_identity.v1', scopeKey: hscope, characterId, chatId },
    records: [
      { recordId: 'h1', raw: packet, hash: h64(packet), packetType: 'current_snapshot', recordState: 'active', targetPairIndex: 1, capturedAt: 1 }
    ],
    slotHeads: [], tombstones: [], archiveRef: null
  }));

  const hayakuChat = {
    ...chat,
    message: chat.message.map(row => row.role === 'user' ? { ...row } : {
      ...row,
      data: hiddenPacketMessage(row.data, createValidPacket({ summary: HAYAKU_PROOF_FACT, subject: '민아' }))
    })
  };
  hayakuChat.messages = hayakuChat.message;
  const hayakuCharacter = { ...character, chats: [hayakuChat] };
  const hayaku = await createHayakuRuntime({
    pluginStorage: hstore, autoRepair: false, afterRequestAutoRepair: false,
    hostOverrides: {
      ...nativeApi,
      getCharacter: async () => hayakuCharacter,
      getChar: async () => hayakuCharacter,
      getCharacterFromIndex: async () => hayakuCharacter,
      getChat: async () => hayakuChat,
      getCurrentChat: async () => hayakuChat,
      getChatFromIndex: async () => hayakuChat,
      getDatabase: async () => ({ characters: [hayakuCharacter], personas: [], modules: [] }),
      ...bus.api('hayaku_locator_continuity')
    }
  });
  t.after(() => hayaku.dispose());

  const flashback = await createFlashback(path.join(__dirname, '..'), {
    waitForLoaded: true,
    hostOverrides: { ...nativeApi, ...bus.api('flashback_memory') }
  });
  t.after(() => flashback.cleanup());
  await writer.wait(() => flashback.audit.Runtime.lastWorldlineReconciliation?.at, 'Flashback startup maintenance', 12000);

  const cfg = flashback.api._test.normalizeSettings({ embeddingEnabled: true, embeddingProvider: 'openai', autoEpisodeIndex: false });
  flashback.host.nativeFetch = async () => ({
    ok: true, status: 200,
    async json() { return { data: [{ index: 0, embedding: [1, 0, 0] }] }; }
  });
  await flashback.api.saveSettings(cfg);
  const nativeScope = await flashback.api.resolveCurrentScope(false);
  const rawFb = await flashback.api._test.buildRecordsFromSources([{
    sourceType: 'response', sourceId: 'plugin-chain-test', sourceHash: 'published-chain-source',
    origin: 'live_chat', role: 'turn_pair', turnIndex: 1, pairIndex: 1,
    text: `User:\n서재에 대해 말해줘.\n\n---\n\nAssistant:\n${FLASHBACK_PROOF_FACT}`
  }], cfg, nativeScope, { deferEmbedding: true });
  const fbRow = rawFb[0];
  delete fbRow.embeddingWork;
  fbRow.vector = [1, 0, 0];
  fbRow.dim = 3;
  fbRow.embeddingProvider = 'openai';
  fbRow.embeddingModel = 'text-embedding-3-small';
  fbRow.embeddingProfileId = 'openai:text-embedding-3-small:3';
  fbRow.embeddingReceipt = {
    receiptVersion: 1, provider: 'openai', model: 'text-embedding-3-small',
    profileId: 'openai:text-embedding-3-small:3', dimensions: 3, sourceHash: fbRow.sourceHash
  };
  await flashback.api._test.saveAllRecords([fbRow], cfg, nativeScope);

  const f = await writer.fixture(t, { unified: false, bus, chat, character });
  await f.host.plugin.connectLibReadOnly('', 'plugin_ipc');
  await f.host.plugin.saveRuntimeSettings({
    mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true, enable_plot_aide: true,
    failure_mode: 'hard', lore_activation_mode: 'off'
  });
  await writer.wait(() => JSON.parse(libra.f.r.values.get('libra:v1:scope:' + libra.scopeKey + ':manifest') || '{}').frontiers?.observedTurn === 6, 'LIBRA startup source audit', 10000);
  await libra.f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });

  f.controls.onModel = async (_count, body) => {
    const stage = (body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n').match(/(aide_\w+) patch JSON/) || [])[1];
    f.controls.output = stage
      ? JSON.stringify({ schema: 'serial_gradation_agents_for_rp_draft_patch_v1', stage, ok: true, domain: {}, analysis: { summary: 'Grounded draft', constraints: [], risks: [] }, edits: [] })
      : '민아는 서재에서 조용히 미소 지었다. The door opened slowly.';
  };

  const rawBaseMessages = chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId }));

  // ==========================================
  // CASE 1: Order A: LIBRA -> HAYAKU -> FLASHBACK -> GRADIA
  // ==========================================
  {
    f.prompts.length = 0;
    const inputA = JSON.parse(JSON.stringify(rawBaseMessages));

    // 1. LIBRA beforeRequest
    const afterLibraA = await libra.f.control.hooks.beforeRequest(inputA, 'model');
    assert.ok(afterLibraA.length >= inputA.length, 'LIBRA runs beforeRequest');

    // 2. HAYAKU beforeRequest
    const afterHayakuA = await hayaku.callBeforeRequest(afterLibraA, 'model');
    assert.ok(afterHayakuA.length >= afterLibraA.length, 'HAYAKU runs beforeRequest');

    // 3. FLASHBACK beforeRequest
    const afterFlashbackA = await flashback.api._test.beforeRequest(afterHayakuA, 'model');
    assert.ok(afterFlashbackA.length >= afterHayakuA.length, 'Flashback runs beforeRequest');

    // 4. GRADIA beforeRequest (accepts chained input with synthetic memories)
    const finalChainA = await f.host.hooks.beforeRequest(afterFlashbackA, 'model');
    assert.ok(finalChainA && finalChainA.length > 0, 'GRADIA completes successfully after memory plugins');

    const combinedTextA = finalChainA.map(m => String(m.content || '')).join('\n');
    assert.ok(combinedTextA.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'), 'GRADIA draft includes evidence anchor in Order A');
    assert.ok(!combinedTextA.includes('<MEMORY_RECALL>'), 'GRADIA does not re-inject <MEMORY_RECALL> in Order A');

    // Strictly verify each memory plugin's UNIQUE stored payload is present (not just static template rules or user prompt words)
    assert.ok(combinedTextA.includes(LIBRA_PROOF_FACT), 'LIBRA unique recalled memory is present in Order A');
    assert.ok(combinedTextA.includes(HAYAKU_PROOF_FACT), 'HAYAKU unique stored payload is present in Order A');
    assert.ok(combinedTextA.includes(FLASHBACK_PROOF_FACT), 'Flashback unique recalled evidence is present in Order A');
    console.log('PASS Order A: LIBRA -> HAYAKU -> Flashback -> GRADIA');
  }

  // ==========================================
  // CASE 2: Order B: GRADIA -> LIBRA -> HAYAKU -> FLASHBACK
  // ==========================================
  {
    f.prompts.length = 0;
    const inputB = JSON.parse(JSON.stringify(rawBaseMessages));

    // 1. GRADIA runs beforeRequest first
    const afterGradiaB = await f.host.hooks.beforeRequest(inputB, 'model');
    assert.ok(afterGradiaB.length >= inputB.length, 'GRADIA runs beforeRequest first');

    // 2. LIBRA beforeRequest runs on GRADIA-augmented messages
    const afterLibraB = await libra.f.control.hooks.beforeRequest(afterGradiaB, 'model');
    assert.ok(afterLibraB.length >= afterGradiaB.length, 'LIBRA runs after GRADIA');

    // 3. HAYAKU beforeRequest
    const afterHayakuB = await hayaku.callBeforeRequest(afterLibraB, 'model');
    assert.ok(afterHayakuB.length >= afterLibraB.length, 'HAYAKU runs after LIBRA');

    // 4. Flashback beforeRequest
    const finalChainB = await flashback.api._test.beforeRequest(afterHayakuB, 'model');
    assert.ok(finalChainB.length >= afterHayakuB.length, 'Flashback runs after HAYAKU');

    const combinedTextB = finalChainB.map(m => String(m.content || '')).join('\n');
    assert.ok(combinedTextB.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'), 'GRADIA draft marker is preserved in downstream hooks');
    assert.ok(!combinedTextB.includes('<MEMORY_RECALL>'), 'No duplicate recall injection in Order B');

    // Strictly verify each memory plugin's UNIQUE stored payload is present (not just static template rules or user prompt words)
    assert.ok(combinedTextB.includes(LIBRA_PROOF_FACT), 'LIBRA unique recalled memory is present in Order B');
    assert.ok(combinedTextB.includes(HAYAKU_PROOF_FACT), 'HAYAKU unique stored payload is present in Order B');
    assert.ok(combinedTextB.includes(FLASHBACK_PROOF_FACT), 'Flashback unique recalled evidence is present in Order B');
    console.log('PASS Order B: GRADIA -> LIBRA -> HAYAKU -> Flashback');
  }
});
