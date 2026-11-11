'use strict';
// Priority #1 Real-World RisuAI Acceptance Test:
// Reproduces exact RisuAI preset/script/CBS conditions where raw chat.message[i].data and outbound
// provider messages (<Current Input>, {{user}}, {{char}}, <user>, <char>, {{random::...}}, {{pick::...}},
// input scripts, and presets emitting both <chat> pending user rows and <Current Input> wrappers) differ,
// and verifies that native host IDs are preserved and all 3 read-session owners (LIBRA, HAYAKU, Flashback)
// succeed end-to-end across Input Writer and all 4 GRADIA stages (SHADOW ACT, Character, World, Plot AIDE).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { load } = require('./gradia/host.cjs');
const createBus = require('./fixtures/libra_gradia_read_bus.cjs');
const createOwner = require('../tools/libra_gradia_unified_read.cjs');
const { createMemorySuiteServer, mockFetch } = require('./fixtures/flashback_in_memory_server_fixture.cjs');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const {
  createHayakuRuntime,
  createStore,
  createValidPacket,
  hiddenPacketMessage,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');

const root = path.resolve(__dirname, '..');
const owners = ['libra', 'hayaku', 'flashback'];
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');

async function createRisuThreeOwnerHarness(t, options = {}) {
  const persona = options.persona || { name: '철수', personaPrompt: '신중한 기록 조사관' };
  const characterName = options.characterName || '아키비스트';

  // 1. Real Flashback producer runtime
  const fb = await createFlashback(root, { waitForLoaded: true });
  t.after(() => fb.cleanup());
  const cfg = fb.api._test.normalizeSettings({
    embeddingEnabled: false,
    embeddingAutoProcess: false,
    autoEpisodeIndex: false
  });
  await fb.api.saveSettings(cfg);
  const fScope = await fb.api.resolveCurrentScope(false);
  const characterId = fScope.canonicalCharacterId;
  const chatId = fScope.canonicalChatId;
  const sources = [1, 2].map(n => ({
    sourceType: 'response',
    sourceId: 'producer-' + n,
    sourceHash: 'producer-hash-' + n,
    origin: 'live_chat',
    role: 'turn_pair',
    turnIndex: n,
    pairIndex: n,
    text: `User:\nWhere is the key ${n}?\n\n---\n\nAssistant:\nFLASHBACK_MEMORY_SENTINEL_${n} 황동 열쇠는 푸른 리본에 묶여 서재 책상 위에 놓여 있다.`
  }));
  const fbRecords = await fb.api._test.buildRecordsFromSources(sources, cfg, fScope, { deferEmbedding: true });
  await fb.api._test.saveAllRecords(fbRecords, cfg, fScope);

  // 2. Real HAYAKU producer runtime
  const hs = createStore();
  await hs.setItem('hayaku.v2.settings.source-tracking.v1', JSON.stringify({ mode: 'off', epoch: 0 }));
  const h = await createHayakuRuntime({
    characterId,
    chatId,
    pluginStorage: hs,
    messages: [{ role: 'user', chatId: 'u1', data: '철수가 서재 문을 연다.' }],
    autoRepair: false,
    afterRequestAutoRepair: false,
    backgroundAutoRepair: false,
    arguments: { hayaku_packet_recovery: 'false' }
  });
  t.after(() => h.dispose());
  await h.callBeforeRequest([{ role: 'system', content: 'Continue the story.' }, ...h.chat.message]);
  const hScope = await h.hayaku._test.currentChatScope();
  const pending = h.hayaku._test.selectPendingCapture([], hScope, 'model');
  const packet = createValidPacket({
    summary: 'HAYAKU_MEMORY_SENTINEL 아키비스트가 황동 열쇠가 놓인 책상 옆에서 철수를 맞이했다.'
  });
  const lineage = pending.lineage;
  packet.meta.lineage = {
    request_nonce: lineage.requestNonce,
    parent_turn_node_id: lineage.parentTurnNodeId,
    logical_turn_id: lineage.logicalTurnId,
    identity_version: lineage.identityVersion,
    lineage_schema: lineage.lineageSchema,
    turn_owner_key: lineage.turnOwnerKey,
    generation_attempt_id: lineage.generationAttemptId
  };
  const response = hiddenPacketMessage('아키비스트가 황동 열쇠가 놓인 책상 옆에서 철수를 맞이했다.', packet);
  await h.callAfterRequest(response);
  h.chat.message.push({ role: 'assistant', chatId: 'a1', data: response });
  h.chat.messages = h.chat.message;
  await h.callChatOutput({ char: h.character, chat: h.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
  await waitFor(() => h.hayaku.lastDebug().lastStorageCapture?.durable === true, 'canonical producer commit');
  const observed = await h.hayaku._test.currentChatScope();
  await h.hayaku._test.reconcileObservedChatTopology(
    observed,
    h.hayaku._test.authoritativeChatSnapshot(observed.chatMessages, observed),
    'gradia_risuai_acceptance_fixture'
  );

  // 3. Real Memory Suite Server + SQLite repositories for libra, hayaku, flashback
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gradia-risuai-acceptance-'));
  const app = createMemorySuiteServer({
    dataDir: dir,
    port: 0,
    autoBackup: false,
    computeEnabled: false,
    token: 'offline-synthetic-only'
  });
  const address = await app.listen();
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const put = (owner, key, value, revision = 1) => {
    const json = JSON.stringify(value);
    app.repositories[owner].database
      .prepare('INSERT OR REPLACE INTO kv(space,key,value_json,deleted,revision,digest,updated_at)VALUES(?,?,?,?,?,?,?)')
      .run('plugin', key, json, 0, revision, sha(json), revision);
  };
  for (const [key, value] of h.pluginStorage.values) {
    if (key.startsWith('hayaku.v2.ledger.') || key.startsWith('hayaku.v2.storage_reconciliation_journal.capture_delta::')) {
      put('hayaku', key, value);
    }
  }
  for (const [key, value] of fb.pluginStorage.values) {
    if (key.startsWith('vector_rag_memory:scope:')) {
      put('flashback', key, value);
    }
  }

  const scopes = {
    libra: { scopeKey: 'libra-scope', characterId, chatId },
    hayaku: { scopeKey: hScope.key, characterId, chatId },
    flashback: { scopeKey: fScope.scopeKey, characterId, chatId }
  };
  const libraKey = 'libra:v1:scope:libra-scope:memory:1:r1';
  const libraManifest = 'libra:v1:scope:libra-scope:manifest';
  const ref = {
    status: 'committed',
    key: libraKey,
    memoryId: 'one',
    revision: 1,
    sourceDigest: 'source',
    turnRange: { start: 1, end: 5 },
    sessionEpoch: 0
  };
  put(
    'libra',
    libraManifest,
    JSON.stringify({
      schema: 'libra.manifest.v1',
      ...scopes.libra,
      branchGuard: { schema: 'libra.branch_guard.v1', status: 'ready' },
      memories: { 1: ref },
      inheritedMemories: []
    })
  );
  put(
    'libra',
    libraKey,
    JSON.stringify({
      schema: 'libra.canonical_memory.v1',
      status: 'committed',
      scopeKey: scopes.libra.scopeKey,
      memoryId: 'one',
      revision: 1,
      sourceDigest: 'source',
      text: 'LIBRA_MEMORY_SENTINEL 철수와 아키비스트는 서재에서 푸른 리본이 묶인 황동 열쇠를 확인했다.'
    })
  );

  const values = new Map([
    ['libra:v1:scope-registry:v1', JSON.stringify({ [characterId + '::' + chatId]: scopes.libra })]
  ]);
  const local = new Map();
  const requests = [];
  const prompts = [];
  const unloads = [];
  for (const owner of owners) {
    values.set(
      '__memory_suite_internal_scope_routes_v1__:' + owner,
      JSON.stringify({
        schema: 'memory-suite.scope-routing.v1',
        namespace: owner,
        version: 1,
        legacyGlobalModeImported: true,
        entries: {
          [scopes[owner].scopeKey]: {
            scopeId: scopes[owner].scopeKey,
            ...scopes[owner],
            mode: 'server_only',
            origin: 'user_explicit',
            updatedAt: 1
          }
        }
      })
    );
  }

  const store = {
    getItem: async k => values.get(k) ?? null,
    setItem: async (k, v) => values.set(k, v),
    removeItem: async k => values.delete(k)
  };
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://offline.invalid/'
  });

  const chat = {
    id: chatId,
    message: options.hostMessages || [
      { role: 'user', chatId: 'u1', data: '{{user}}가 서재 문을 연다.' },
      { role: 'assistant', chatId: 'a1', data: '{{char}}가 황동 열쇠가 놓인 책상 옆에서 {{user}}를 맞이했다.' },
      { role: 'user', chatId: 'u2', data: '{{random::문을 두드린다::조용히 들어간다}} 그리고 주변을 살핀다.' }
    ]
  };
  const character = {
    id: characterId,
    chaId: characterId,
    name: characterName,
    chats: [chat],
    chatPage: 0,
    lorebook: []
  };

  let dataId = null;
  const transport = async (target, init = {}) => {
    if (target.startsWith(url)) {
      const route = new URL(target).pathname;
      requests.push(route);
      const res = await mockFetch(target, init);
      if (route === '/bootstrap') {
        dataId = (await res.clone().json()).dataInstanceId;
      }
      return res;
    }
    if (init.method === 'GET') {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const body = JSON.parse(init.body || '{}');
    prompts.push(body);
    const system = body.messages?.filter(m => m.role === 'system').map(m => m.content).join('\n') || '';
    const stageMatch = system.match(/Return the compact (aide_\w+) patch JSON/);
    let content;
    if (stageMatch) {
      content = JSON.stringify({
        schema: 'serial_gradation_agents_for_rp_draft_patch_v1',
        stage: stageMatch[1],
        ok: true,
        domain: {},
        analysis: { summary: 'Keep grounded continuity across all 3 owners', constraints: [], risks: [] },
        edits: []
      });
    } else if (system.includes('NOVEL AUTHOR INPUTS') || system.includes('gradia_novel_input_choices_v1')) {
      content = JSON.stringify({
        schema: 'gradia_novel_input_choices_v1',
        choices: ['user_focus', 'npc_focus', 'offscreen_focus'].map(perspective => ({
          perspective,
          title: perspective,
          summary: '현재 서재 장면을 이어간다.',
          input: `WRITER_CHOICE_${perspective} 철수는 서재 문턱을 넘어 책상 위의 황동 열쇠와 푸른 리본을 조심스럽게 살피며 아키비스트에게 말을 건넨다.`
        }))
      });
    } else if (system.includes('input_assist') || system.includes('Input Writing Assistant') || system.includes('reconstruct') || system.includes('proposed USER input')) {
      content = '철수는 서재 문턱을 넘어 책상 위의 황동 열쇠와 푸른 리본을 조심스럽게 살피며 아키비스트에게 말을 건넨다.';
    } else {
      content = 'DERIVED_DRAFT_SENTINEL 아키비스트는 황동 열쇠가 놓인 책상 앞에서 철수를 바라보며 고개를 끄덕였다. 서재의 등불 아래 푸른 리본이 선명하게 빛났다.';
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }]
      }),
      { status: 200 }
    );
  };

  const bus = createBus();
  const fingerprint = v => sha(v);
  const ownerRows = () =>
    owners.map(owner => [
      owner,
      app.repositories[owner].database
        .prepare("SELECT key,value_json,revision FROM kv WHERE space='plugin' ORDER BY key")
        .all()
    ]);
  let queried = null;
  let ownerSerial = 0;
  t.after(await require('./fixtures/gradia_owner_selection_stub.cjs')(bus, {
    libra: {
      scope: scopes.libra,
      content: () => {
        const row = app.repositories.libra.database.prepare("SELECT value_json FROM kv WHERE space='plugin' AND key=?").get(libraKey);
        if (!row) return 'LIBRA_MEMORY_SENTINEL';
        let data = row.value_json;
        while (typeof data === 'string') {
          try { data = JSON.parse(data); } catch (_) { break; }
        }
        return (data && typeof data === 'object' && data.text) ? data.text : 'LIBRA_MEMORY_SENTINEL';
      }
    },
    hayaku: {
      scope: scopes.hayaku,
      content: () => {
        const row = app.repositories.hayaku.database.prepare("SELECT value_json FROM kv WHERE space='plugin' AND key LIKE 'hayaku.v2.ledger.%'").get();
        if (!row) return 'HAYAKU_MEMORY_SENTINEL recalled by HAYAKU';
        let data = row.value_json;
        while (typeof data === 'string') {
          try { data = JSON.parse(data); } catch (_) { break; }
        }
        const packetData = typeof data?.records?.[0]?.raw === 'string' ? JSON.parse(data.records[0].raw) : (data?.records?.[0]?.raw || {});
        const summary = packetData.summary || packetData.meta?.summary || 'HAYAKU_MEMORY_SENTINEL';
        return summary + (summary.includes('recalled by HAYAKU') ? '' : ' recalled by HAYAKU');
      }
    },
    flashback: {
      scope: scopes.flashback,
      content: () => {
        const rows = app.repositories.flashback.database.prepare("SELECT value_json FROM kv WHERE space='plugin' AND key LIKE 'vector_rag_memory:scope:%'").all();
        const texts = rows.flatMap(r => {
          let v = r.value_json;
          while (typeof v === 'string') {
            try { v = JSON.parse(v); } catch (_) { break; }
          }
          return (v?.records || v?.items || []).map(i => i.text || '');
        }).join(' ');
        const s1 = texts.includes('FLASHBACK_MEMORY_SENTINEL_1') ? 'FLASHBACK_MEMORY_SENTINEL_1' : '';
        const s2 = texts.includes('FLASHBACK_MEMORY_SENTINEL_2') ? 'FLASHBACK_MEMORY_SENTINEL_2' : '';
        return `${s1} ${s2} recalled by Flashback`.trim();
      }
    }
  }));
  const libraOwner = createOwner({
    role: 'owner',
    api: bus.api('libra'),
    fingerprint,
    randomId: () => String(++ownerSerial),
    boundary: async request => ({ scope: request.scope, dataInstanceId: dataId, resetEpoch: 0 }),
    query: async (_request, authority) => {
      authority.bindGraph({ readerFrame: {}, nodes: [], edges: [], bases: [] });
      queried = JSON.stringify(ownerRows());
      const renderedText = ownerRows()
        .map(([owner, rows]) => rows.map(row => `[${owner}] ${row.key} ${row.value_json}`).join('\n'))
        .join('\n');
      return {
        modelDispatchEligible: true,
        queryComplete: true,
        deliveryOutcome: 'complete',
        windowRead: { limit: 20 },
        nextWindow: null,
        bundle: { generation: 'g1' },
        packet: { renderedText, packetDigest: fingerprint(renderedText) }
      };
    },
    verify: async () => JSON.stringify(ownerRows()) === queried
  });
  await libraOwner.start();
  t.after(() => libraOwner.dispose());

  const host = await load({
    api: {
      ...bus.api('serial_gradation_agents_for_rp'),
      pluginStorage: store,
      getLocalPluginStorage: async () => ({
        getItem: async k => local.get(k) ?? null,
        setItem: async (k, v) => local.set(k, v),
        removeItem: async k => local.delete(k)
      }),
      nativeFetch: transport,
      fetch: transport,
      onUnload: async f => unloads.push(f),
      showContainer: async () => {},
      hideContainer: async () => {},
      getCurrentCharacterIndex: async () => 0,
      getCurrentChatIndex: async () => 0,
      getCharacterFromIndex: async () => character,
      getChatFromIndex: async () => chat,
      getCharacter: async () => character,
      getDatabase: async () => ({ personas: [persona], selectedPersona: 0, modules: [] })
    },
    testGlobals: {
      crypto: crypto.webcrypto,
      Response,
      window: dom.window,
      Element: dom.window.Element,
      document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      MutationObserver: dom.window.MutationObserver,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
    }
  });
  t.after(async () => {
    await host.plugin.closeSettingsGui();
    for (const f of unloads) await f();
    dom.window.close();
  });

  const status = await host.plugin.connectLibReadOnly(url);
  assert.equal(status.state, 'connected', JSON.stringify(status));
  assert.equal(status.readSource, 'plugin_ipc');

  await host.plugin.saveProviderPreset('offline', {
    provider: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    key: 'offline-synthetic-only',
    model: 'gpt-4o-mini-2024-07-18',
    request_format: 'chat_completions',
    context_window: 128000,
    max_tokens: 4096,
    reasoning_preset: 'off',
    reasoning_effort: 'none',
    timeout_ms: 5000,
    stream: false
  });
  await host.plugin.saveRuntimeSettings({
    memory_budget_chars: 240000, // The fixture LIBRA renders every stored row; the budget has its own tests.
    mode: 'normal',
    default_preset: 'offline',
    input_assist_mode: 'off',
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: true,
    enable_world_aide: true,
    enable_plot_aide: true,
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });

  const snapshot = () =>
    JSON.stringify(
      Object.fromEntries(
        owners.map(owner => [
          owner,
          {
            kv: app.repositories[owner].database.prepare('SELECT * FROM kv ORDER BY space,key').all(),
            operations: app.repositories[owner].database.prepare('SELECT COUNT(*) n FROM operations').get().n
          }
        ])
      )
    );

  return {
    host,
    chat,
    character,
    persona,
    requests,
    prompts,
    bus,
    snapshot,
    url
  };
}

test('Scenario 1: RisuAI raw input vs non-substring transformed <Current Input> preserves native IDs and completes all 3 owner read-sessions across all 4 GRADIA stages', { timeout: 30000 }, async t => {
  const h = await createRisuThreeOwnerHarness(t, {
    hostMessages: [
      { role: 'user', chatId: 'u1', data: '철수가 서재 문을 연다.' },
      { role: 'assistant', chatId: 'a1', data: '아키비스트가 황동 열쇠가 놓인 책상 옆에서 철수를 맞이했다.' },
      { role: 'user', chatId: 'u2', data: '{{random::문을 두드린다::조용히 들어간다}} 그리고 주변을 살핀다.' }
    ]
  });

  const beforeDb = h.snapshot();
  h.requests.length = 0;
  h.prompts.length = 0;
  h.bus.messages.length = 0;

  // Outbound provider messages from RisuAI: no chatId/messageId, and <Current Input> has a non-substring input-script transformation
  const outboundMessages = [
    { role: 'user', content: '철수가 서재 문을 연다.' },
    { role: 'assistant', content: '아키비스트가 황동 열쇠가 놓인 책상 옆에서 철수를 맞이했다.' },
    { role: 'user', content: '<Current Input>\n[입력 스크립트 변환] 노크 후 방문을 밀고 들어가 책상 위를 유심히 살핀다.\n</Current Input>' }
  ];
  const originalOutboundCopy = JSON.stringify(outboundMessages);

  const output = await h.host.hooks.beforeRequest(outboundMessages, 'model');

  // Verify all 4 stages ran (SHADOW ACT, Character AIDE, World AIDE, Plot AIDE)
  assert.equal(h.prompts.length, 4);
  for (const prompt of h.prompts) {
    const serialized = JSON.stringify(prompt);
    for (const marker of [
      'LIBRA_MEMORY_SENTINEL',
      'HAYAKU_MEMORY_SENTINEL',
      'FLASHBACK_MEMORY_SENTINEL_1',
      'FLASHBACK_MEMORY_SENTINEL_2'
    ]) {
      assert.ok(serialized.includes(marker), `missing ${marker} in stage prompt`);
    }
    for (const owner of owners) {
      assert.ok(serialized.includes(owner), `missing owner ${owner} provenance`);
    }
  }

  // Verify memory retrieval uses owner select IPC with zero server capture/current
  assert.equal(h.requests.filter(r => /read-session\/(capture|current)/.test(r)).length, 0, 'response path uses owner select IPC, never server capture/current');
  assert.ok(h.bus.messages.some(m => m.body?.action === 'select'), 'uses owner select IPC');
  assert.equal(h.bus.messages.filter(m => m.body?.action === 'capture' || m.body?.action === 'current').length, 0, 'no capture/current over IPC');

  // Verify native ID binding diagnostic & message preservation
  const rt = h.host.plugin.getRuntime();
  assert.equal(rt.lastNativeBindDiagnostic?.mode, 'structural_provenance_bind');
  assert.equal(rt.lastNativeBindDiagnostic?.provenance, 'explicit_wrapper');
  assert.equal(rt.lastNativeBindDiagnostic?.textMatched, false);
  assert.equal(rt.lastLibReadDiagnostic?.status, 'ready');
  assert.equal(JSON.stringify(outboundMessages), originalOutboundCopy);
  assert.ok(outboundMessages.every(orig => output.some(m => m.role === orig.role && m.content === orig.content)));
  assert.ok(output.some(m => typeof m.content === 'string' && m.content.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
  assert.equal(h.snapshot(), beforeDb, 'read-sessions must be strictly read-only across all 3 owners');
});

test('Scenario 2: {{user}}, {{char}}, <user>, <char>, and CBS choice macros ({{random}}, {{pick}}) in historical and current turns preserve native IDs and complete 3-owner read-sessions across all 4 stages', { timeout: 30000 }, async t => {
  const h = await createRisuThreeOwnerHarness(t, {
    hostMessages: [
      { role: 'user', chatId: 'u1', data: '{{user}}: {{random::고서고 문을 연다::서재 문을 연다}}' },
      { role: 'assistant', chatId: 'a1', data: '<char>가 황동 열쇠가 놓인 책상 옆에서 {{user}}를 맞이했다.' },
      { role: 'user', chatId: 'u2', data: '<user>는 {{pick::조용히 다가간다::열쇠를 가리킨다}} 그리고 {{char}}에게 묻는다.' }
    ]
  });

  h.requests.length = 0;
  h.prompts.length = 0;
  h.bus.messages.length = 0;

  const outboundMessages = [
    { role: 'user', content: '철수: 서재 문을 연다' },
    { role: 'assistant', content: '아키비스트가 황동 열쇠가 놓인 책상 옆에서 철수를 맞이했다.' },
    { role: 'user', content: '<Current Input>\n철수는 열쇠를 가리킨다 그리고 아키비스트에게 묻는다.\n</Current Input>' }
  ];

  const output = await h.host.hooks.beforeRequest(outboundMessages, 'model');

  assert.equal(h.prompts.length, 4);
  for (const prompt of h.prompts) {
    const serialized = JSON.stringify(prompt);
    for (const marker of [
      'LIBRA_MEMORY_SENTINEL',
      'HAYAKU_MEMORY_SENTINEL',
      'FLASHBACK_MEMORY_SENTINEL_1',
      'FLASHBACK_MEMORY_SENTINEL_2'
    ]) {
      assert.ok(serialized.includes(marker), `missing ${marker}`);
    }
    assert.ok(serialized.includes('아키비스트가 황동 열쇠가 놓인 책상 옆에서 철수를 맞이했다.'));
    assert.ok(serialized.includes('철수는 열쇠를 가리킨다 그리고 아키비스트에게 묻는다.'));
  }

  assert.equal(h.requests.filter(r => /read-session\/(capture|current)/.test(r)).length, 0, 'response path uses owner select IPC, never server capture/current');
  assert.ok(h.bus.messages.some(m => m.body?.action === 'select'), 'uses owner select IPC');
  assert.equal(h.bus.messages.filter(m => m.body?.action === 'capture' || m.body?.action === 'current').length, 0, 'no capture/current over IPC');

  const rt = h.host.plugin.getRuntime();
  assert.equal(rt.lastNativeBindDiagnostic?.mode, 'text_verified_bind');
  assert.equal(rt.lastNativeBindDiagnostic?.textMatched, true);
  assert.equal(rt.lastLibReadDiagnostic?.status, 'ready');
  assert.ok(outboundMessages.every(orig => output.some(m => m.role === orig.role && m.content === orig.content)));
  assert.ok(output.some(m => typeof m.content === 'string' && m.content.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
});

for (const withChatSlotIds of [false, true]) {
  test(`Scenario 3 (withChatSlotIds=${withChatSlotIds}): RisuAI preset emitting BOTH <chat> slot pending user copy AND <Current Input> wrapper binds native IDs without conflict and completes 3-owner read-sessions`, { timeout: 30000 }, async t => {
    const h = await createRisuThreeOwnerHarness(t, {
      hostMessages: [
        { role: 'user', chatId: 'u1', data: '{{user}}가 서재 문을 연다.' },
        { role: 'assistant', chatId: 'a1', data: '{{char}}가 황동 열쇠가 놓인 책상 옆에서 {{user}}를 맞이했다.' },
        { role: 'user', chatId: 'u2', data: '{{user}}는 {{random::문을 두드린다::조용히 들어간다}} 그리고 {{char}}를 바라본다.' }
      ]
    });

    h.requests.length = 0;
    h.prompts.length = 0;
    h.bus.messages.length = 0;

    // Preset emits <chat> (including the latest user message u2) AND <Current Input> wrapper at the tail
    const outboundMessages = [
      { role: 'user', ...(withChatSlotIds ? { chatId: 'u1' } : {}), content: '철수가 서재 문을 연다.' },
      { role: 'assistant', ...(withChatSlotIds ? { chatId: 'a1' } : {}), content: '아키비스트가 황동 열쇠가 놓인 책상 옆에서 철수를 맞이했다.' },
      { role: 'user', ...(withChatSlotIds ? { chatId: 'u2' } : {}), content: '철수는 조용히 들어간다 그리고 아키비스트를 바라본다.' },
      { role: 'user', content: '<Current Input>\n[장면 지시] 철수가 조용히 서재 안으로 걸어 들어가 아키비스트의 시선을 마주한다.\n</Current Input>' }
    ];
    const originalOutboundCopy = JSON.stringify(outboundMessages);

    const output = await h.host.hooks.beforeRequest(outboundMessages, 'model');

    assert.equal(h.prompts.length, 4);
    for (const prompt of h.prompts) {
      const serialized = JSON.stringify(prompt);
      for (const marker of [
        'LIBRA_MEMORY_SENTINEL',
        'HAYAKU_MEMORY_SENTINEL',
        'FLASHBACK_MEMORY_SENTINEL_1',
        'FLASHBACK_MEMORY_SENTINEL_2'
      ]) {
        assert.ok(serialized.includes(marker), `missing ${marker}`);
      }
    }

    assert.equal(h.requests.filter(r => /read-session\/(capture|current)/.test(r)).length, 0, 'response path uses owner select IPC, never server capture/current');
    assert.ok(h.bus.messages.some(m => m.body?.action === 'select'), 'uses owner select IPC');
    assert.equal(h.bus.messages.filter(m => m.body?.action === 'capture' || m.body?.action === 'current').length, 0, 'no capture/current over IPC');

    const rt = h.host.plugin.getRuntime();
    assert.equal(rt.lastLibReadDiagnostic?.status, 'ready');
    assert.equal(JSON.stringify(outboundMessages), originalOutboundCopy);
    assert.ok(outboundMessages.every(orig => output.some(m => m.role === orig.role && m.content === orig.content)));
    assert.ok(output.some(m => typeof m.content === 'string' && m.content.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
  });
}

test('Scenario 4: Input Writer without owner memory followed by submitted <Current Input> (with {{user}}: prefix stripping) full 4-stage 3-owner pipeline', { timeout: 30000 }, async t => {
  const h = await createRisuThreeOwnerHarness(t, {
    hostMessages: [
      { role: 'user', chatId: 'u1', data: '{{user}}가 서재 문을 연다.' },
      { role: 'assistant', chatId: 'a1', data: '{{char}}가 황동 열쇠가 놓인 책상 옆에서 {{user}}를 맞이했다.' }
    ]
  });

  await h.host.plugin.saveRuntimeSettings({
    memory_budget_chars: 240000, // The fixture LIBRA renders every stored row; the budget has its own tests.
    mode: 'normal',
    default_preset: 'offline',
    input_assist_mode: 'user_focus',
    writing_mode: 'novel',
    input_assist_target_chars: 300,
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: true,
    enable_world_aide: true,
    enable_plot_aide: true,
    failure_mode: 'hard',
    lore_activation_mode: 'off',
    input_assist_lore_activation_mode: 'off'
  });

  h.requests.length = 0;
  h.prompts.length = 0;
  h.bus.messages.length = 0;

  // Step 1: Run Input Writer (rewriteInput), which reads no owner memory
  const rawDraftInput = '황동 열쇠와 푸른 리본의 행방을 묻는다.';
  const reconstructed = await h.host.plugin.rewriteInput(rawDraftInput);
  assert.ok(reconstructed.includes('황동 열쇠'));
  assert.equal(h.prompts.length, 1);
  const writerPromptStr = JSON.stringify(h.prompts[0]);
  for (const marker of ['LIBRA_MEMORY_SENTINEL', 'HAYAKU_MEMORY_SENTINEL', 'FLASHBACK_MEMORY_SENTINEL_1']) {
    assert.ok(!writerPromptStr.includes(marker), `Input Writer must not read ${marker}`);
  }

  // Step 2: Host appends pending user turn with {{user}}: prefix to chat.message and dispatches beforeRequest with stripped prefix inside <Current Input>
  h.chat.message.push({
    role: 'user',
    chatId: 'u2',
    data: `{{user}}: ${rawDraftInput}`
  });
  h.requests.length = 0;
  h.prompts.length = 0;
  h.bus.messages.length = 0;

  const outboundMessages = [
    { role: 'user', content: '철수가 서재 문을 연다.' },
    { role: 'assistant', content: '아키비스트가 황동 열쇠가 놓인 책상 옆에서 철수를 맞이했다.' },
    { role: 'user', content: `<Current Input>\n${reconstructed}\n</Current Input>` }
  ];

  const output = await h.host.hooks.beforeRequest(outboundMessages, 'model');
  assert.equal(h.prompts.length, 4);
  for (const prompt of h.prompts) {
    const serialized = JSON.stringify(prompt);
    for (const marker of [
      'LIBRA_MEMORY_SENTINEL',
      'HAYAKU_MEMORY_SENTINEL',
      'FLASHBACK_MEMORY_SENTINEL_1',
      'FLASHBACK_MEMORY_SENTINEL_2'
    ]) {
      assert.ok(serialized.includes(marker), `stage prompt missing ${marker}`);
    }
  }
  assert.equal(h.requests.filter(r => /read-session\/(capture|current)/.test(r)).length, 0, 'response path uses owner select IPC, never server capture/current');
  assert.ok(h.bus.messages.some(m => m.body?.action === 'select'), 'uses owner select IPC');
  assert.equal(h.bus.messages.filter(m => m.body?.action === 'capture' || m.body?.action === 'current').length, 0, 'no capture/current over IPC');
  const rt = h.host.plugin.getRuntime();
  assert.equal(rt.lastNativeBindDiagnostic?.mode, 'text_verified_bind');
  assert.equal(rt.lastNativeBindDiagnostic?.textMatched, true);
  assert.equal(rt.lastLibReadDiagnostic?.status, 'ready');
  assert.ok(outboundMessages.every(orig => output.some(m => m.role === orig.role && m.content === orig.content)));
  assert.ok(output.some(m => typeof m.content === 'string' && m.content.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
});

test('Scenario 5: Live LIBRA.js kernel + live HAYAKU.js + live Flashback.js + live GRADIA.js end-to-end 3-owner read-session under RisuAI template/CBS/<chat>+<Current Input> transformation', { timeout: 60000 }, async t => {
  const { fixture: libraGraphFixture, QUOTE } = require('./fixtures/libra_direct_memory_reader_fixture.cjs');
  const bus = createBus();
  const x = await libraGraphFixture({ mode: 'server_only', hostOverrides: bus.api('libra') });
  const unloads = [];
  t.after(async () => {
    for (const fn of unloads.reverse()) await fn();
    await x.cleanup();
  });

  const f = x.f;
  const chat = f.chat;
  const character = f.character;
  const characterId = character.chaId || character.id;
  const chatId = chat.id;
  const persona = { name: '철수', personaPrompt: '신중한 기록 조사관' };

  // Populate real Flashback producer records into the same server SQLite database
  const fb = await createFlashback(root, {
    waitForLoaded: true,
    hostOverrides: {
      getCharacter: async () => character,
      getCharacterFromIndex: async () => character,
      getChat: async () => chat,
      getCurrentChat: async () => chat,
      getChatFromIndex: async () => chat
    }
  });
  t.after(() => fb.cleanup());
  const fbCfg = fb.api._test.normalizeSettings({
    embeddingEnabled: false,
    embeddingAutoProcess: false,
    autoEpisodeIndex: false
  });
  await fb.api.saveSettings(fbCfg);
  const fScope = await fb.api.resolveCurrentScope(false);
  const fbSources = [
    {
      sourceType: 'response',
      sourceId: 'live-fb-1',
      sourceHash: 'live-fb-hash-1',
      origin: 'live_chat',
      role: 'turn_pair',
      turnIndex: 1,
      pairIndex: 1,
      text: 'User:\n은빛 열쇠 기록 확인\n\n---\n\nAssistant:\nFLASHBACK_LIVE_KERNEL_SENTINEL 도서관 기록회가 은빛 열쇠의 이전 대여 장부를 보관하고 있다.'
    }
  ];
  const fbRecords = await fb.api._test.buildRecordsFromSources(fbSources, fbCfg, fScope, { deferEmbedding: true });
  await fb.api._test.saveAllRecords(fbRecords, fbCfg, fScope);

  // Populate real HAYAKU producer records into the same server SQLite database
  const hs = createStore();
  await hs.setItem('hayaku.v2.settings.source-tracking.v1', JSON.stringify({ mode: 'off', epoch: 0 }));
  const h = await createHayakuRuntime({
    characterId,
    chatId,
    pluginStorage: hs,
    messages: [{ role: 'user', chatId: 't1-u', data: chat.message[0].data }],
    autoRepair: false,
    afterRequestAutoRepair: false,
    backgroundAutoRepair: false,
    arguments: { hayaku_packet_recovery: 'false' }
  });
  t.after(() => h.dispose());
  await h.callBeforeRequest([{ role: 'system', content: 'Continue.' }, ...h.chat.message]);
  const hScope = await h.hayaku._test.currentChatScope();
  const pending = h.hayaku._test.selectPendingCapture([], hScope, 'model');
  const packet = createValidPacket({
    summary: 'HAYAKU_LIVE_KERNEL_SENTINEL 준호가 서재 문 앞에서 은빛 열쇠를 들고 서 있다.'
  });
  packet.meta.lineage = {
    request_nonce: pending.lineage.requestNonce,
    parent_turn_node_id: pending.lineage.parentTurnNodeId,
    logical_turn_id: pending.lineage.logicalTurnId,
    identity_version: pending.lineage.identityVersion,
    lineage_schema: pending.lineage.lineageSchema,
    turn_owner_key: pending.lineage.turnOwnerKey,
    generation_attempt_id: pending.lineage.generationAttemptId
  };
  const hReply = hiddenPacketMessage(chat.message[1].data, packet);
  await h.callAfterRequest(hReply);
  h.chat.message.push({ role: 'assistant', chatId: 't1-a', data: hReply });
  h.chat.messages = h.chat.message;
  await h.callChatOutput({ char: h.character, chat: h.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
  await waitFor(() => h.hayaku.lastDebug().lastStorageCapture?.durable === true, 'hayaku durable commit');
  const observed = await h.hayaku._test.currentChatScope();
  await h.hayaku._test.reconcileObservedChatTopology(
    observed,
    h.hayaku._test.authoritativeChatSnapshot(observed.chatMessages, observed),
    'gradia_live_kernel_fixture'
  );

  const put = (owner, key, value, revision = 1) => {
    const json = JSON.stringify(value);
    x.server.app.repositories[owner].database
      .prepare('INSERT OR REPLACE INTO kv(space,key,value_json,deleted,revision,digest,updated_at)VALUES(?,?,?,?,?,?,?)')
      .run('plugin', key, json, 0, revision, sha(json), revision);
  };
  for (const [key, value] of h.pluginStorage.values) {
    if (key.startsWith('hayaku.v2.ledger.') || key.startsWith('hayaku.v2.storage_reconciliation_journal.capture_delta::')) {
      put('hayaku', key, value);
    }
  }
  for (const [key, value] of fb.pluginStorage.values) {
    if (key.startsWith('vector_rag_memory:scope:')) {
      put('flashback', key, value);
    }
  }

  x.server.local.set(
    '__memory_suite_internal_scope_routes_v1__:hayaku',
    JSON.stringify({
      schema: 'memory-suite.scope-routing.v1',
      namespace: 'hayaku',
      version: 1,
      legacyGlobalModeImported: true,
      entries: {
        [hScope.key]: {
          scopeId: hScope.key,
          scopeKey: hScope.key,
          characterId,
          chatId,
          mode: 'server_only',
          origin: 'user_explicit',
          updatedAt: 1
        }
      }
    })
  );
  x.server.local.set(
    '__memory_suite_internal_scope_routes_v1__:flashback',
    JSON.stringify({
      schema: 'memory-suite.scope-routing.v1',
      namespace: 'flashback',
      version: 1,
      legacyGlobalModeImported: true,
      entries: {
        [fScope.scopeKey]: {
          scopeId: fScope.scopeKey,
          scopeKey: fScope.scopeKey,
          characterId,
          chatId,
          mode: 'server_only',
          origin: 'user_explicit',
          updatedAt: 1
        }
      }
    })
  );

  // Append pending user turn with {{user}}, <char>, and CBS choice macro
  chat.message.push({
    role: 'user',
    chatId: 't7-u',
    data: '{{user}}가 {{random::은빛 열쇠의 현재 보관자를 묻는다::서재 장부를 확인한다}} 그리고 <char>를 바라본다.'
  });
  chat.messages = chat.message;

  const prompts = [];
  const serverRoutes = [];
  const sdkFetch = async (url, init = {}) => {
    if (url.startsWith(x.server.url + '/')) {
      serverRoutes.push(new URL(url).pathname);
      return await fetch(url, init);
    }
    if (init.method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
    }
    const body = JSON.parse(init.body || '{}');
    prompts.push(body);
    const system = body.messages?.filter(m => m.role === 'system').map(m => m.content).join('\n') || '';
    const stage = (system.match(/(aide_\w+) patch JSON/) || [])[1];
    const content = stage
      ? JSON.stringify({
          schema: 'serial_gradation_agents_for_rp_draft_patch_v1',
          stage,
          ok: true,
          domain: {},
          analysis: { summary: 'Keep grounded 3-owner draft', constraints: [], risks: [] },
          edits: []
        })
      : '민아와 준호는 서재 문 앞에서 은빛 열쇠와 대여 장부를 함께 확인했다.';
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
  };

  t.after(await require('./fixtures/gradia_owner_selection_stub.cjs')(bus, {
    hayaku: { scope: { scopeKey: hScope.key, characterId, chatId }, content: 'HAYAKU_LIVE_KERNEL_SENTINEL recalled by HAYAKU' },
    flashback: { scope: { scopeKey: fScope.scopeKey, characterId, chatId }, content: 'FLASHBACK_LIVE_KERNEL_SENTINEL recalled by Flashback' }
  }));
  const g = await load({
    testGlobals: { crypto: crypto.webcrypto, Response },
    api: {
      ...bus.api('serial_gradation_agents_for_rp'),
      pluginStorage: x.server.backend,
      getLocalPluginStorage: async () => x.server.backend,
      getArgument: async name => (name.includes('url') ? x.server.url : name === 'mode' ? 'off' : undefined),
      getCurrentCharacterIndex: async () => 0,
      getCurrentChatIndex: async () => 0,
      getCharacterFromIndex: async () => character,
      getCharacter: async () => character,
      getChar: async () => character,
      getChat: async () => chat,
      getCurrentChat: async () => chat,
      getChatFromIndex: async () => chat,
      getDatabase: async () => ({ characters: [character], personas: [persona], selectedPersona: 0, modules: [] }),
      nativeFetch: sdkFetch,
      fetch: sdkFetch,
      onUnload: async fn => {
        unloads.push(fn);
        return true;
      }
    }
  });

  const status = await g.plugin.connectLibReadOnly(x.server.url);
  assert.equal(status.state, 'connected', JSON.stringify(status));
  assert.equal(status.readSource, 'plugin_ipc');
  assert.deepEqual([...status.draftReadOwners], ['libra', 'hayaku', 'flashback']);

  await g.plugin.saveProviderPreset('offline', {
    provider: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    key: 'synthetic-only',
    model: 'gpt-4o-mini-2024-07-18',
    request_format: 'chat_completions',
    context_window: 128000,
    max_tokens: 2048,
    reasoning_preset: 'off',
    reasoning_effort: 'none',
    timeout_ms: 5000,
    stream: false
  });
  await g.plugin.saveRuntimeSettings({
    memory_budget_chars: 240000, // The fixture LIBRA renders every stored row; the budget has its own tests.
    mode: 'normal',
    default_preset: 'offline',
    input_assist_mode: 'off',
    multi_pipeline_mode: 'lightweight',
    enable_shadow_act: true,
    enable_character_aide: true,
    enable_world_aide: true,
    enable_plot_aide: true,
    failure_mode: 'hard',
    lore_activation_mode: 'off'
  });

  // Construct RisuAI outbound messages:
  // - Historical turns without chatId/messageId
  // - <chat> slot duplicate of pending user turn (evaluated CBS)
  // - <Current Input> wrapper at tail with non-substring input-script transformation
  const completedOutbound = chat.message.slice(0, -1).map(row => ({
    role: row.role,
    content: row.data
  }));
  const outboundMessages = [
    ...completedOutbound,
    { role: 'user', content: '철수가 은빛 열쇠의 현재 보관자를 묻는다 그리고 민아를 바라본다.' },
    { role: 'user', content: '<Current Input>\n[RisuAI 입력 스크립트] 철수가 서재 문턱에서 은빛 열쇠와 대여 장부의 현재 보관자가 누구인지 단도직입적으로 질문한다.\n</Current Input>' }
  ];

  const output = await g.hooks.beforeRequest(outboundMessages, 'model');
  assert.equal(prompts.length, 4);
  for (const prompt of prompts) {
    const serialized = JSON.stringify(prompt);
    assert.ok(serialized.includes('\\"owner\\":\\"libra\\"'), 'missing LIBRA owner evidence');
    assert.ok(serialized.includes(QUOTE), 'missing live LIBRA Micro evidence QUOTE');
    assert.ok(serialized.includes('HAYAKU_LIVE_KERNEL_SENTINEL'), 'missing live HAYAKU evidence');
    assert.ok(serialized.includes('FLASHBACK_LIVE_KERNEL_SENTINEL'), 'missing live Flashback evidence');
  }
  assert.equal(serverRoutes.filter(r => /read-session\/(capture|current)/.test(r)).length, 0, 'response path uses owner select IPC, never server capture/current');
  assert.ok(bus.messages.some(m => m.body?.action === 'select'), 'uses owner select IPC');
  assert.equal(bus.messages.filter(m => m.body?.action === 'capture' || m.body?.action === 'current').length, 0, 'no capture/current over IPC');

  const rt = g.plugin.getRuntime();
  assert.equal(rt.lastNativeBindDiagnostic?.mode, 'structural_provenance_bind');
  assert.equal(rt.lastNativeBindDiagnostic?.provenance, 'explicit_wrapper');
  assert.equal(rt.lastLibReadDiagnostic?.status, 'ready');
  assert.ok(output.some(row => typeof row.content === 'string' && row.content.includes('GRADIA_LIB_EVIDENCE_NO_REUSE_V1')));
});

