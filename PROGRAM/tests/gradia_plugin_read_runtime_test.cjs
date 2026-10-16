'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const createBus = require('./fixtures/libra_gradia_read_bus.cjs');
const { createHayakuRuntime, createStore, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const writer = require('./fixtures/gradia_input_writer_unified_fixture.cjs');
const h64 = value => { let h = 0xcbf29ce484222325n; for (let i = 0; i < value.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n); return 'h64' + h.toString(36); };
test('three actual plugin owners -> GRADIA generation and Input Writer, with no preceding recall hooks', { timeout: 120000 }, async t => {
  const bus = createBus();
  const libra = await require('./fixtures/libra_memory_graph_reader_fixture.cjs').fixture({ mode: 'plugin_only', hostOverrides: bus.api('libra') });
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
  const hayaku = await createHayakuRuntime({ pluginStorage: hstore, autoRepair: false, afterRequestAutoRepair: false,
    hostOverrides: { ...nativeApi, ...bus.api('hayaku_locator_continuity') } });
  t.after(() => hayaku.dispose());
  const flashback = await createFlashback(path.join(__dirname, '..'), { waitForLoaded: true,
    hostOverrides: { ...nativeApi, ...bus.api('flashback_memory') } });
  t.after(() => flashback.cleanup());
  await writer.wait(()=>flashback.audit.Runtime.lastWorldlineReconciliation?.at,'Flashback startup maintenance',12000);
  const cfg = flashback.api._test.normalizeSettings({embeddingEnabled:false,embeddingAutoProcess:false,autoEpisodeIndex:false});
  await flashback.api.saveSettings(cfg);
  const nativeScope = await flashback.api.resolveCurrentScope(false);
  const rows = await flashback.api._test.buildRecordsFromSources([{sourceType:'response',sourceId:'plugin-ipc-test',sourceHash:'published-source',
    origin:'live_chat',role:'turn_pair',turnIndex:1,pairIndex:1,text:'FLASHBACK_IPC_MEMORY: 준호는 문 앞에서 기다렸다.'}],cfg,nativeScope,{deferEmbedding:true});
  await flashback.api._test.saveAllRecords(rows,cfg,nativeScope);
  const f = await writer.fixture(t, { unified: false, bus, chat, character });
  const status = await f.host.plugin.connectLibReadOnly('http://127.0.0.1:47630', 'plugin_ipc');
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
  assert.equal(f.prompts.length, 4, JSON.stringify(f.host.plugin.getRuntime().last));
  assert.ok(f.host.plugin.getLibReadOnlyStatus().selection, JSON.stringify({ status:f.host.plugin.getLibReadOnlyStatus(),
    replies:bus.messages.filter(m => m.body.kind === 'response').map(m => ({sender:m.sender,error:m.body.error,action:m.body.action,items:m.body.result?.items?.length})) }));
  for (const body of f.prompts) {
    const raw = JSON.stringify(body);
    assert.ok(raw.includes('HAYAKU_IPC_MEMORY:'), 'HAYAKU source must reach the model');
    assert.ok(raw.includes('FLASHBACK_IPC_MEMORY:'), 'Flashback source must reach the model');
    assert.ok(raw.includes('owner_issued_evidence_bundle'), 'LIBRA owner bundle must reach the model');
    assert.ok(raw.includes('민아가 은빛 열쇠를 준호에게'));
  }
  assert.ok(output.some(row => row.content?.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
  assert.equal(JSON.stringify([...hstore.values]), beforeH); assert.equal(JSON.stringify([...flashback.pluginStorage.values]), beforeF);
  assert.equal(hayaku.llmCalls.length, 0); assert.equal(flashback.networkCalls.length, 0);
  assert.equal(bus.messages.filter(m => m.body.kind === 'request' && m.body.action === 'capture').length, 3);
  f.prompts.length = 0;
  f.controls.onModel = null; delete f.controls.output;
  await f.host.plugin.saveRuntimeSettings({mode:'off',default_preset:'writer',input_assist_mode:'user_focus',writing_mode:'novel',input_assist_target_chars:500,lore_activation_mode:'off',input_assist_lore_activation_mode:'off'});
  const input = await f.start('UNSUBMITTED_IPC_PROPOSAL: 열쇠를 확인한다.');
  await f.select(); const result = await f.done(input.pending, '복사 후 직접 전송');
  assert.equal(result, true); assert.equal(f.copied.length,1); assert.ok(f.prompts.length >= 1);
  assert.ok(f.prompts.every(body => JSON.stringify(body).includes('FLASHBACK_IPC_MEMORY')));
  assert.ok(f.prompts.every(body => JSON.stringify(body).includes('input_writer_proposal')));
  assert.ok(!JSON.stringify(chat).includes('UNSUBMITTED_IPC_PROPOSAL'));
  // A changed source during SHADOW cannot feed AIDE or deliver the draft.
  f.prompts.length = 0;
  await f.host.plugin.saveRuntimeSettings({ mode:'normal',default_preset:'writer',input_assist_mode:'off',multi_pipeline_mode:'lightweight',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true,failure_mode:'hard',lore_activation_mode:'off' });
  f.controls.onModel = async (...args) => { await pipelineModel(...args); await hstore.setItem('hayaku.v2.ledger.' + hscope, null); };
  await assert.rejects(() => f.host.hooks.beforeRequest(messages, 'model'), /LIB_READ_/);
  assert.equal(f.prompts.length, 1);
  assert.ok(!JSON.stringify([...f.values]).includes('owner_issued_evidence_bundle'));
});
