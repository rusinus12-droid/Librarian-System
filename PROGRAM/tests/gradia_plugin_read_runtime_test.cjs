'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const createBus = require('./fixtures/libra_gradia_read_bus.cjs');
const { createHayakuRuntime, createStore, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const writer = require('./fixtures/gradia_input_writer_unified_fixture.cjs');
const h64 = value => { let h = 0xcbf29ce484222325n; for (let i = 0; i < value.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n); return 'h64' + h.toString(36); };
test('three actual plugin owners -> GRADIA generation and Input Writer, with no preceding recall hooks', { timeout: 120000 }, async t => {
  const bus = createBus();
  const libra = await require('./fixtures/libra_direct_memory_reader_fixture.cjs').fixture({ mode: 'plugin_only', hostOverrides: bus.api('libra') });
  t.after(() => libra.cleanup());
  const chat = libra.f.chat, character = libra.f.character, characterId = character.chaId || character.id, chatId = chat.id;
  chat.message.push({ role: 'user', chatId: 'ipc-current', data: '은빛 열쇠를 누가 보관하고 어디에서 기다리는지 확인한다.' });
  chat.messages = chat.message;
  const nativeApi = { getCurrentCharacterIndex: async () => 0, getCurrentChatIndex: async () => 0,
    getCharacter: async () => character, getChar: async () => character, getCharacterFromIndex: async () => character,
    getChat: async () => chat, getCurrentChat: async () => chat, getChatFromIndex: async () => chat,
    getDatabase: async () => ({ characters: [character], personas: [], modules: [] }) };
  const hstore = createStore(), hscope = 'chat_' + h64(characterId + '\n' + chatId);
  const packet = JSON.stringify(createValidPacket({ summary: 'HAYAKU_IPC_MEMORY: 열쇠는 민아에게서 왔다.' }));
  await hstore.setItem('hayaku.v2.settings.source-tracking.v1', JSON.stringify({ mode: 'off', epoch: 0 }));
  await hstore.setItem('hayaku.v2.ledger.' + hscope, JSON.stringify({ version: 'hayaku_storage_ledger_v2', scopeKey: hscope,
    identity: { schema: 'hayaku.scope_identity.v1', scopeKey: hscope, characterId, chatId }, records: [
      { recordId: 'h1', raw: packet, hash: h64(packet), packetType: 'current_snapshot', recordState: 'active', targetPairIndex: 1, capturedAt: 1 }
    ], slotHeads: [], tombstones: [], archiveRef: null }));
  // HAYAKU reads packets out of its own view of the chat, so it gets a copy of the same chat that carries them.
  const hayakuSummary = 'HAYAKU_IPC_MEMORY: 은빛 열쇠는 민아에게서 왔다.';
  const hayakuChat = { ...chat, message: chat.message.map(row => row.role === 'user' ? { ...row } : { ...row,
    data: hiddenPacketMessage(row.data, createValidPacket({ summary: hayakuSummary, subject: '민아' })) }) };
  hayakuChat.messages = hayakuChat.message;
  const hayakuCharacter = { ...character, chats: [hayakuChat] };
  const hayaku = await createHayakuRuntime({ pluginStorage: hstore, autoRepair: false, afterRequestAutoRepair: false,
    hostOverrides: { ...nativeApi, getCharacter: async () => hayakuCharacter, getChar: async () => hayakuCharacter, getCharacterFromIndex: async () => hayakuCharacter,
      getChat: async () => hayakuChat, getCurrentChat: async () => hayakuChat, getChatFromIndex: async () => hayakuChat,
      getDatabase: async () => ({ characters: [hayakuCharacter], personas: [], modules: [] }), ...bus.api('hayaku_locator_continuity') } });
  t.after(() => hayaku.dispose());
  await hayaku.callBeforeRequest([{ role: 'user', content: chat.message.at(-1).data }], 'model');
  const flashback = await createFlashback(path.join(__dirname, '..'), { waitForLoaded: true,
    hostOverrides: { ...nativeApi, ...bus.api('flashback_memory') } });
  t.after(() => flashback.cleanup());
  await writer.wait(()=>flashback.audit.Runtime.lastWorldlineReconciliation?.at,'Flashback startup maintenance',12000);
  const cfg = flashback.api._test.normalizeSettings({embeddingEnabled:false,embeddingAutoProcess:false,autoEpisodeIndex:false});
  await flashback.api.saveSettings(cfg);
  const nativeScope = await flashback.api.resolveCurrentScope(false);
  const rows = await flashback.api._test.buildRecordsFromSources([{sourceType:'response',sourceId:'plugin-ipc-test',sourceHash:'published-source',
    origin:'live_chat',role:'turn_pair',turnIndex:1,pairIndex:1,text:'FLASHBACK_IPC_MEMORY: 준호는 은빛 열쇠를 보관하고 문 앞에서 기다렸다.'}],cfg,nativeScope,{deferEmbedding:true});
  await flashback.api._test.saveAllRecords(rows,cfg,nativeScope);
  const f = await writer.fixture(t, { unified: false, bus, chat, character });
  await f.host.plugin.connectLibReadOnly('', 'plugin_ipc');
  const status = f.host.plugin.getLibReadOnlyStatus().connection;
  assert.equal(status.state, 'connected', JSON.stringify(status));
  assert.equal(status.readSource, 'plugin_ipc'); assert.deepEqual(Array.from(status.activeOwners), ['libra', 'hayaku', 'flashback']);
  const beforeH = JSON.stringify([...hstore.values]), beforeF = JSON.stringify([...flashback.pluginStorage.values]);
  const pipelineModel = async (_count, body) => {
    const stage = (body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n').match(/(aide_\w+) patch JSON/) || [])[1];
    f.controls.output = stage ? JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage,ok:true,domain:{},
      analysis:{summary:'Keep the grounded draft',constraints:[],risks:[]},edits:[]})
      : '민아는 은빛 열쇠를 확인하고 문 앞에서 기다렸다. The grounded scene continued in the quiet room.';
  };
  f.controls.onModel = pipelineModel;
  // Exercise GRADIA before any owner Before Request hook for this input.
  await f.host.plugin.saveRuntimeSettings({ mode: 'normal', default_preset: 'writer', input_assist_mode: 'off', multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true, enable_character_aide: true, enable_world_aide: true, enable_plot_aide: true, failure_mode: 'hard', lore_activation_mode: 'off' });
  await writer.wait(()=>JSON.parse(libra.f.r.values.get('libra:v1:scope:'+libra.scopeKey+':manifest')||'{}').frontiers?.observedTurn===6,'LIBRA startup source audit',10000);
  const messages = chat.message.map(row => ({ role: row.role, content: row.data, chatId: row.chatId, messageId: row.chatId }));
  const output = await f.host.hooks.beforeRequest(messages, 'model');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.prompts.length, 4, JSON.stringify(f.host.plugin.getRuntime().last));
  assert.ok(f.host.plugin.getLibReadOnlyStatus().selection, JSON.stringify({ status:f.host.plugin.getLibReadOnlyStatus(),
    replies:bus.messages.filter(m => m.body.kind === 'response').map(m => ({sender:m.sender,error:m.body.error,action:m.body.action,items:m.body.result?.items?.length})) }));
  for (const body of f.prompts) {
    const raw = JSON.stringify(body);
    assert.ok(raw.includes('HAYAKU_IPC_MEMORY:'), 'HAYAKU source must reach the model');
    assert.ok(raw.includes('LIBRA_CLASSIC_RECALL') || raw.includes('LIBRA_EVIDENCE consumer=gradia'), 'LIBRA recalled memory must reach the model');
    assert.ok(raw.includes('민아가 은빛 열쇠를 준호에게'));
  }
  assert.ok(output.some(row => row.content?.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
  assert.equal(JSON.stringify([...hstore.values]), beforeH); assert.equal(JSON.stringify([...flashback.pluginStorage.values]), beforeF);
  assert.ok(bus.messages.some(m => m.sender === 'flashback_memory' && (m.body.result?.engine?.source === 'owner_selection' || m.body.result?.source === 'plugin_ipc')), 'Flashback answers with its own selection');
  // GRADIA delivers only its draft and does not re-inject <MEMORY_RECALL> into the final response.
  const finalText = output.map(row => String(row.content || '')).join('\n');
  assert.ok(!finalText.includes('<MEMORY_RECALL>'), 'GRADIA does not re-inject memory into the final response');
  // Each memory plugin runs its own recall and direct injection independently, even while GRADIA is active.
  await libra.f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
  const libraFinal = await libra.f.control.hooks.beforeRequest(JSON.parse(JSON.stringify(messages)), 'model');
  assert.notEqual(libra.f.r.api.getRuntime().lastMemoryInjectionMeta?.gradiaCompat, true, 'LIBRA is never put into compatibility mode');
  assert.ok(libraFinal.some(row => String(row.content || '').includes('은빛 열쇠')), 'LIBRA directly injects its own recalled memory');
  const hayakuHook = await hayaku.callBeforeRequest([{ role: 'user', content: chat.message.at(-1).data }], 'model');
  assert.notEqual(hayaku.hayaku.lastDebug().lastBeforeRequest?.gradiaCompat, true, 'HAYAKU is never put into compatibility mode');
  assert.ok(hayakuHook.some(row => String(row.content || '').includes('HAYAKU_IPC_MEMORY')), 'HAYAKU directly injects its own recalled memory');
  assert.ok(hayakuHook.some(row => /HAYAKU_STATE_PACKET_START/.test(String(row.content || ''))), 'HAYAKU still sends its packet instructions');
  assert.equal(hayaku.llmCalls.length, 0); assert.equal(flashback.networkCalls.length, 0);
  assert.equal(bus.messages.filter(m => m.body.kind === 'request' && m.body.action === 'select').length, 3);
  f.prompts.length = 0;
  f.controls.onModel = null; delete f.controls.output;
  await f.host.plugin.saveRuntimeSettings({mode:'off',default_preset:'writer',input_assist_mode:'user_focus',writing_mode:'novel',input_assist_target_chars:500,lore_activation_mode:'off',input_assist_lore_activation_mode:'off'});
  const input = await f.start('UNSUBMITTED_IPC_PROPOSAL: 열쇠를 확인한다.');
  await f.select(); const result = await f.done(input.pending, '복사 후 직접 전송');
  assert.equal(result, true); assert.equal(f.copied.length,1); assert.ok(f.prompts.length >= 1);
  assert.equal(bus.messages.filter(m => m.body.kind === 'request' && m.body.action === 'select').length, 3, 'the Input Writer does not read owner memory');
  assert.ok(!JSON.stringify(f.prompts).includes('HAYAKU_IPC_MEMORY'), 'the Input Writer uses only its own context');
  assert.ok(!JSON.stringify(chat).includes('UNSUBMITTED_IPC_PROPOSAL'));
  // A store changing mid-run does not discard the draft.
  f.prompts.length = 0;
  await f.host.plugin.saveRuntimeSettings({ mode:'normal',default_preset:'writer',input_assist_mode:'off',multi_pipeline_mode:'lightweight',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true,failure_mode:'hard',lore_activation_mode:'off' });
  f.controls.onModel = async (...args) => { await pipelineModel(...args); await hstore.setItem('hayaku.v2.ledger.' + hscope, null); };
  const afterChange = (await f.host.hooks.beforeRequest(messages, 'model')).map(row => String(row.content || '')).join('\n');
  assert.ok(f.prompts.length >= 1);
  assert.ok(afterChange.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1'), 'the draft stays');
  assert.ok(!afterChange.includes('<MEMORY_RECALL>'));
  assert.ok(!JSON.stringify([...f.values]).includes('LIBRA_EVIDENCE consumer=gradia'));
});
