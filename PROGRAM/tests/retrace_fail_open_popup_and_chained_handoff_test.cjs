'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument } = require('./fixtures/retrace_gui_dom_fixture.cjs');
const { createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const unifiedRows = require('./fixtures/unified_vertical_source.json').sourceRows;
const libraArtifact = require('./fixtures/libra_unified_runtime_fixture.cjs').artifact();
const { microReply } = require('./fixtures/libra_reanalysis_kinds_fixture.cjs');

const programRoot = path.resolve(__dirname, '..');
const PLUGIN_FILES = [
  'Flashback_Memory.js',
  'HAYAKU_Locator_Continuity.js',
  'LIA_Persona_Linker.js',
  'LIBRA.js',
  'GRADIA.js',
  'RETRACE.js'
];

const REQUEST_CHANNELS = Object.freeze({
  flashback: 'flashback_memory_bridge_request_v1',
  hayaku: 'hayaku_memory_bridge_request_v1',
  lia: 'lia_persona_handoff_request_v1',
  libra: 'libra_memory_bridge_request_v1',
  gradia: 'gradia_memory_bridge_request_v1'
});

const RESPONSE_SENDERS = Object.freeze({
  flashback_memory_bridge_response_v1: 'flashback_memory',
  hayaku_memory_bridge_response_v1: 'hayaku_locator_continuity',
  lia_persona_handoff_response_v1: 'lia_persona_linker',
  libra_memory_bridge_response_v1: 'libra',
  gradia_memory_bridge_response_v1: 'serial_gradation_agents_for_rp'
});

const plain = value => JSON.parse(JSON.stringify(value));

const waitFor = async (predicate, label, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const val = await predicate();
    if (val) return val;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const createMemoryStore = (initialEntries = null) => {
  const values = new Map(initialEntries instanceof Map ? initialEntries : Object.entries(initialEntries || {}));
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};

function injectLiaDebugAudit(source) {
  const marker = '      getScopePersonaCatalog: readLiaScopePersonaCatalog,';
  if (!source.includes(marker)) throw new Error('LIA debugAudit anchor missing');
  return source.replace(marker, `      debugAudit: {
        setGeneratedOutputText,
        removeGenerated,
        saveEditedResultToCurrentPersona,
        createBlankPersonaDraft,
        resetPersonaProofForBindingChange,
        getContext,
        PersonaBindingManager,
        buildPersonaPanelState
      },
${marker}`);
}

const createSixPluginHost = (options = {}) => {
  const pluginStorage = options.pluginStorage || createMemoryStore();
  const safeLocalStorage = options.safeLocalStorage || createMemoryStore();
  const listeners = new Map();
  const replacers = new Map();
  const chatListeners = [];
  const unloadHandlers = [];
  const guiCallbacks = new Map();
  const faults = options.faults || {};

  const initialChats = options.chats || [
    {
      id: 'chat-a',
      chatId: 'chat-a',
      name: 'Session A',
      note: 'Source note',
      localLore: [{ key: '비밀 금고', comment: '금고 규칙', content: '열쇠는 서재 서랍에 있다.', alwaysActive: false }],
      bindedPersona: options.initialBindedPersona ?? 'persona-1',
      message: [],
      fmIndex: -1
    }
  ];
  const chats = initialChats;
  const character = options.character || {
    id: 'char-main',
    chaId: 'char-main',
    name: '민아',
    chatPage: 0,
    chats
  };
  character.chats = chats;

  const db = options.db || {
    personas: [
      { id: 'persona-1', name: 'Source Persona', personaPrompt: 'Source persona prompt', note: '' },
      { id: 'persona-2', name: 'Alt Persona', personaPrompt: 'Alt prompt', note: '' }
    ],
    selectedPersona: 0,
    characters: [character],
    plugins: []
  };

  const activeChat = () => {
    const idx = Number.isInteger(Number(character.chatPage)) && Number(character.chatPage) >= 0 && Number(character.chatPage) < chats.length
      ? Number(character.chatPage)
      : 0;
    return chats[idx] || chats[0];
  };

  const pluginArgs = {
    enable_character_ito: 'false',
    enable_world_ito: 'false',
    enable_plot_ito: 'false',
    ...(options.args || {})
  };

  const host = {
    pluginStorage,
    safeLocalStorage,
    listeners,
    replacers,
    unloadHandlers,
    guiCallbacks,
    chats,
    character,
    db,
    faults,
    document: options.document || null,
    getStorage: () => pluginStorage,
    setStorage: () => {},
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) {
      const key = String(name || '');
      if (Object.prototype.hasOwnProperty.call(pluginArgs, key)) return pluginArgs[key];
      if (key.includes('memory_suite_server_mode')) return options.mode || 'plugin_only';
      if (key.includes('memory_suite_server_url')) return options.serverUrl || '';
      if (key.includes('enable_gui')) return 'false';
      return '';
    },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument(name, value) { pluginArgs[name] = String(value ?? ''); return true; },
    async nativeFetch(target, init) { return await fetch(target, init); },
    async runLLMModel(...args) {
      const payloadText = JSON.stringify(args);
      if (typeof options.onRunLLMModel === 'function') {
        const custom = await options.onRunLLMModel(args, payloadText);
        if (custom !== undefined) return custom;
      }
      if (payloadText.includes('[LIBRA STORY STRUCTURE]')) {
        return { type: 'success', result: '{"arcs":[],"turningPoints":[],"motifs":[]}' };
      }
      if (payloadText.includes('[LIBRA PREFERENCE AND BOUNDARY CHECK]')) {
        return { type: 'success', result: '{"items":[]}' };
      }
      if (payloadText.includes('[LIBRA MICRO SOURCE CONTRACT]')) {
        return microReply(args);
      }
      return { type: 'success', result: JSON.stringify(libraArtifact) };
    },
    async addPluginChannelListener(channel, handler) {
      const key = String(channel);
      const rows = listeners.get(key) || new Set();
      rows.add(handler);
      listeners.set(key, rows);
      return { channel: key, handler };
    },
    async removePluginChannelListener(channel, handler) {
      const rows = listeners.get(String(channel));
      if (!rows) return false;
      rows.delete(handler);
      return true;
    },
    async removePluginChannelHandler(channel, handler) { return await host.removePluginChannelListener(channel, handler); },
    async offPluginChannelMessage(channel, handler) { return await host.removePluginChannelListener(channel, handler); },
    async dispatchNarrativeRequest() {
      const rows = Array.from(replacers.get('beforeRequest') || []);
      let payload = [];
      for (const fn of rows) {
        try {
          const next = await fn(payload, 'model');
          if (Array.isArray(next)) payload = next;
        } catch (_) {}
      }
      return payload;
    },
    async postPluginChannelMessage(_target, channel, message) {
      const key = String(channel);
      if ((faults.silentOwners || []).some(owner => REQUEST_CHANNELS[owner] === key)) return true;
      if (typeof faults.interceptChannel === 'function') {
        const overridden = await faults.interceptChannel(key, message, { listeners });
        if (overridden === true) return true;
      }
      if (key === REQUEST_CHANNELS.libra && message?.action === 'memory_suite_prepare_handoff_target') {
        await host.dispatchNarrativeRequest();
      }
      const sender = RESPONSE_SENDERS[key] || (Object.values(REQUEST_CHANNELS).includes(key) ? 'flashback_hayaku_bridge' : '');
      const rows = Array.from(listeners.get(key) || []);
      for (const handler of rows) {
        await handler(message, { sender });
      }
      return true;
    },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async registerSetting(_name, callback, _icon, _type, id) { if (id) guiCallbacks.set(id, callback); return { id: id || _name }; },
    async registerButton(opts, callback) { if (opts?.id) guiCallbacks.set(opts.id, callback); return { id: opts?.id || 'btn' }; },
    async unregisterUIPart(id) { guiCallbacks.delete(id); return true; },
    async unregisterSetting() { return true; },
    async unregisterButton() { return true; },
    async addRisuReplacer(kind, handler) {
      const key = String(kind);
      const rows = replacers.get(key) || [];
      rows.push(handler);
      replacers.set(key, rows);
      return true;
    },
    async removeRisuReplacer(kind, handler) {
      const rows = replacers.get(String(kind)) || [];
      const idx = rows.indexOf(handler);
      if (idx >= 0) rows.splice(idx, 1);
      return true;
    },
    async addRisuScriptHandler(_mode, handler) { chatListeners.push(handler); return true; },
    async removeRisuScriptHandler(_mode, handler) { const idx = chatListeners.indexOf(handler); if (idx >= 0) chatListeners.splice(idx, 1); return true; },
    async addRisuChatListener(_mode, handler) { chatListeners.push(handler); return true; },
    async removeRisuChatListener(_mode, handler) { const idx = chatListeners.indexOf(handler); if (idx >= 0) chatListeners.splice(idx, 1); return true; },
    async getDatabase(fields) {
      if (!Array.isArray(fields)) return db;
      return Object.fromEntries(fields.map(field => [field, db[field] ?? null]));
    },
    async setDatabase(patch) { Object.assign(db, patch || {}); return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() {
      const active = activeChat();
      const idx = chats.indexOf(active);
      return idx >= 0 ? idx : 0;
    },
    async getCharacter() { return character; },
    async getChar() { return character; },
    async getCharacterFromIndex() { return character; },
    async getChat() { return activeChat(); },
    async getCurrentChat() { return activeChat(); },
    async getChatFromIndex(_characterIndex, chatIndex) {
      const wanted = Number(chatIndex === undefined ? _characterIndex : chatIndex);
      if (Number.isInteger(wanted) && wanted >= 0 && wanted < chats.length) return chats[wanted];
      return activeChat();
    },
    async setChatToIndex(_characterIndex, chatIndex, payload) {
      const wanted = Number(chatIndex);
      if (!Number.isInteger(wanted) || wanted < 0 || !payload) return false;
      chats[wanted] = payload;
      character.chats = chats;
      return true;
    },
    async setCharacterToIndex(index, payload) {
      if (index === 0 && payload && Array.isArray(payload.chats)) {
        host.character = payload;
        character.chatPage = Number(payload.chatPage ?? 0);
        chats.length = 0;
        chats.push(...payload.chats);
        character.chats = chats;
      }
      return true;
    },
    async setCharacter(payload) {
      return await host.setCharacterToIndex(0, payload);
    },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getRootContainer() { return null; },
    async getPluginRoot() { return null; },
    activateChat(chatId) {
      const idx = chats.findIndex(c => String(c?.id || c?.chatId || '') === String(chatId));
      if (idx < 0) throw new Error(`Chat not found: ${chatId}`);
      if (idx > 0) {
        const [picked] = chats.splice(idx, 1);
        chats.unshift(picked);
      }
      character.chatPage = 0;
      character.chats = chats;
      return chats[0];
    }
  };
  return host;
};

const bootSixPlugins = async (host, opts = {}) => {
  const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const timers = new Set();
  const intervals = new Set();
  const doc = opts.document || host.document || createDocument();
  if (doc && typeof doc.getElementById !== 'function') {
    doc.getElementById = id => doc.querySelector(`#${String(id || '')}`);
  }
  host.document = doc;
  const context = vm.createContext({
    risuai: host,
    RisuAI: host,
    Risuai: host,
    document: doc,
    console: quietConsole,
    setTimeout: (handler, delay, ...args) => {
      const timer = setTimeout((...inner) => { timers.delete(timer); handler(...inner); }, delay, ...args);
      timers.add(timer);
      return timer;
    },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
    setInterval: (handler, delay, ...args) => {
      const timer = setInterval(handler, delay, ...args);
      timer.unref?.();
      intervals.add(timer);
      return timer;
    },
    clearInterval: timer => { intervals.delete(timer); clearInterval(timer); },
    queueMicrotask,
    AbortController,
    AbortSignal,
    DOMException,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone,
    performance: globalThis.performance,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    confirm: () => true,
    alert: () => {},
    prompt: () => null
  });

  const files = Array.isArray(opts.plugins) && opts.plugins.length ? opts.plugins : PLUGIN_FILES;
  for (const file of files) {
    let source = fs.readFileSync(path.join(programRoot, 'plugins', file), 'utf8');
    if (file === 'LIA_Persona_Linker.js' && opts.injectLiaAudit !== false) {
      source = injectLiaDebugAudit(source);
    }
    if (typeof opts.transformSource === 'function') {
      source = opts.transformSource(file, source);
    }
    vm.runInContext(source, context, { filename: file });
  }

  const retrace = await waitFor(() => context.__RETRACE || context.RETRACE, 'RE:TRACE API');
  const flashback = files.includes('Flashback_Memory.js') ? await waitFor(() => context.__FlashbackMemory, 'Flashback API') : null;
  const hayaku = files.includes('HAYAKU_Locator_Continuity.js') ? await waitFor(() => context.HAYAKU, 'HAYAKU API') : null;
  const libra = files.includes('LIBRA.js') ? await waitFor(() => context.__LIBRA__, 'LIBRA API') : null;
  const gradia = files.includes('GRADIA.js') ? await waitFor(() => context.__SerialGradationAgentsForRP, 'GRADIA API') : null;
  const lia = files.includes('LIA_Persona_Linker.js') ? await waitFor(() => context.__lia_persona_linker_runtime_v1__, 'LIA runtime') : null;

  for (const [owner, channel] of Object.entries(REQUEST_CHANNELS)) {
    const fileMap = {
      flashback: 'Flashback_Memory.js',
      hayaku: 'HAYAKU_Locator_Continuity.js',
      lia: 'LIA_Persona_Linker.js',
      libra: 'LIBRA.js',
      gradia: 'GRADIA.js'
    };
    if (!files.includes(fileMap[owner])) continue;
    if ((host.faults.silentOwners || []).includes(owner)) continue;
    await waitFor(() => (host.listeners.get(channel)?.size || 0) > 0, `${channel} listener`);
  }

  const shutdown = async () => {
    for (const handler of host.unloadHandlers.slice().reverse()) {
      try { await handler(); } catch (_) {}
    }
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
  };

  return { context, doc, retrace, flashback, hayaku, libra, gradia, lia, shutdown, host };
};

const seedChatMessages = (chat, turns = 5) => {
  const SUMMARY = 'Alice turned the brass valve and steam began flowing through the blue pipe.';
  const msgs = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const u = unifiedRows.find(r => r.ref === `t${turn}-u`);
    const a = unifiedRows.find(r => r.ref === `t${turn}-a`);
    msgs.push({ role: 'user', id: `t${turn}-u`, chatId: `t${turn}-u`, data: u?.text || `User turn ${turn}` });
    msgs.push({
      role: 'char',
      id: `t${turn}-a`,
      chatId: `t${turn}-a`,
      data: hiddenPacketMessage(a?.text || `${SUMMARY} turn ${turn}`, createValidPacket({ turn, subject: 'Alice', scene: 'workshop', summary: SUMMARY }))
    });
  }
  chat.message = msgs;
  chat.messages = msgs;
  return msgs;
};

const buildLargeRawEvidence = (label, minChars = 13200) => {
  const unit = `[${label}] Alice calibrated the bronze condenser in the workshop corridor at dawn. `;
  return unit.repeat(Math.ceil(minChars / unit.length) + 1);
};

test('Scenario 1: All 6 plugins restore extended handoff slices cleanly and support LIA COW fork & dangling persona strip', async (t) => {
  const genPersonaId = 'lia-persona-generated::char-main::chat-a::p1';
  const host = createSixPluginHost({
    db: {
      personas: [
        { id: 'persona-2', name: 'Alt Persona', personaPrompt: 'Alt prompt', note: '' },
        { id: genPersonaId, name: 'Source Persona', personaPrompt: 'Source persona prompt', note: '' }
      ],
      selectedPersona: 0,
      characters: [],
      plugins: []
    },
    chats: [
      {
        id: 'chat-a',
        chatId: 'chat-a',
        name: 'Session A',
        note: 'Source note',
        localLore: [
          { key: '서재 규칙', comment: '로컬 로어', content: '열쇠는 비밀 서랍 아래에 숨겼다.', alwaysActive: false }
        ],
        bindedPersona: genPersonaId,
        message: [],
        fmIndex: -1
      }
    ]
  });
  host.db.characters = [host.character];
  seedChatMessages(host.chats[0], 5);

  const booted = await bootSixPlugins(host);
  t.after(async () => { await booted.shutdown(); });

  const { retrace, flashback, hayaku, libra, gradia, lia } = booted;

  // 1a. Seed LIBRA canonical cold start on intact 5 turns FIRST, then append turn 6 (>12k raw) for HAYAKU sidecar recovery vault
  const libSettings = await libra.getLibraMemorySettings();
  await libra.saveLibraMemorySettings({ ...libSettings, memoryEngine: 'unified' });
  const coldStart = await libra.runManualColdStart();
  assert.equal(coldStart.completed, 1, 'LIBRA canonical cold start seeded');
  await libra.setStoryClockAnchor('2026-03-10');
  await libra.correctStoryClockTurn(2, { day: 3, date: '2026-03-12', timeOfDay: '야간' });
  await libra.setNarrativeDirection({
    softPreferences: ['서재 중심 추리 분위기를 유지하되 서두르지 않음'],
    doNotForce: ['범인 조기 자백 금지']
  });
  const reviewCatalog = await libra.listMemoryReviews();
  const reviewRows = plain(reviewCatalog.rows || reviewCatalog.items || []);
  if (reviewRows.length > 0) {
    await libra.setMemoryReviewDecision({
      scopeKey: reviewCatalog.scopeKey,
      previewDigest: reviewCatalog.previewDigest,
      ids: [reviewRows[0].id],
      status: 'confirmed'
    });
  }

  // Append turn 6 (>12k raw passage, no packet) for HAYAKU sidecar recovery_vault
  host.chats[0].message.push({ role: 'user', id: 't6-u', chatId: 't6-u', data: 'Inspect the bronze condenser pressure.' });
  host.chats[0].message.push({ role: 'char', id: 't6-a', chatId: 't6-a', data: buildLargeRawEvidence('SCENARIO1_RAW_PASSAGE', 13500) });

  const hyScope = await hayaku._test.currentChatScope();
  await hayaku._test.reconcileObservedChatTopology(
    hyScope,
    hayaku._test.authoritativeChatSnapshot(hyScope.chatMessages, hyScope),
    'scenario1_seed'
  );
  const freshScope = await hayaku._test.currentChatScope();
  const snap = hayaku._test.authoritativeChatSnapshot(freshScope.chatMessages, freshScope);
  const pair6 = snap.conversationPairs.find(p => Number(p.pairIndex) === 6);
  const vaultSaved = await hayaku._test.upsertRecoveryVaultEvidence(
    { scope: freshScope },
    { scopeKey: freshScope.key, pair: pair6, liveScope: freshScope },
    'oversize_seed'
  );
  assert.equal(vaultSaved.durable, true, 'HAYAKU >12k sidecar recovery_vault seeded');

  const basePacket4 = createValidPacket({ turn: 4, subject: 'Alice', scene: 'workshop', summary: 'Alice archived the silver ledger.' });
  const u4Text = unifiedRows.find(r => r.ref === 't4-u').text.trim();
  const a4Visible = unifiedRows.find(r => r.ref === 't4-a').text.trim();
  const partialSaved = await hayaku._test.saveAcceptedPartialMemory({
    scopeKey: freshScope.key,
    source: {
      turn: 4,
      text: `[Turn 4]\n[User attempt]\n${u4Text}\n\n[Assistant outcome]\n${a4Visible}`
    },
    proposedCanonical: {
      ...basePacket4,
      meta: {
        ...basePacket4.meta,
        record_admission: { schema: 'hayaku.record_admission.v1', status: 'partial', derived: [], rejected: [] }
      },
      entity: {
        ...basePacket4.entity,
        characters: [{ name: '민아', id: 'archivist-mina', summary: '서재 아키비스트' }]
      }
    }
  });
  assert.equal(partialSaved.saved, true, 'HAYAKU partial_memory seeded');

  // 1b. Seed Flashback episode_index + child response records + uncovered tail turn
  const fbScope = await flashback.resolveCurrentScope(false);
  const fbBaseSettings = { ...(await flashback.loadSettings()), embeddingProvider: 'openai_compat', embeddingModel: 'ep-test', embeddingDimensions: 4, embeddingEnabled: true, episodeIndexEnabled: true, episodeMinRecords: 2 };
  const makeFbResp = (turn, id, hash, text, vec) => flashback._test.cleanRecordForMemory({
    id, hash, sourceType: 'response', sourceId: `chat-a:turn:${turn}`, scopeKey: fbScope.scopeKey,
    pairIndex: turn, turnIndex: turn, sourceTurn: turn, text, title: `Turn ${turn}`,
    vector: vec, dim: 4, provider: 'openai_compat', model: 'ep-test',
    embeddingProvider: 'openai_compat', embeddingModel: 'ep-test', embeddingDimensions: 4,
    embeddingProfileId: flashback._test.embeddingProfileId(fbBaseSettings, 4, 'openai_compat', 'ep-test'),
    lifecycleStatus: 'active', sourceHash: `fb-src-${turn}`
  }, { scopeKey: fbScope.scopeKey }, { authoritativeSource: true }).record;
  const fbResp1 = makeFbResp(1, 'fb-resp-1', 'h-resp-1', '서재에서 은빛 열쇠를 발견했다.', [1, 0, 0, 0]);
  const fbResp2 = makeFbResp(2, 'fb-resp-2', 'h-resp-2', '지호가 서재 열쇠를 빌려 갔다.', [0.95, 0.05, 0, 0]);
  const [fbEp1] = flashback._test.buildEpisodeIndexRecords([fbResp1, fbResp2], fbBaseSettings, fbScope);
  assert.ok(fbEp1, 'source episode_index built for turns 1-2');
  const fbResp3 = makeFbResp(3, 'fb-resp-3', 'h-resp-3', '준호가 공연 허가서를 가지고 도서관에 도착했다.', [0, 1, 0, 0]);
  await flashback._test.saveAllRecords([fbResp1, fbResp2, fbEp1, fbResp3], fbBaseSettings, fbScope);

  // 1c. Seed GRADIA extended stores (manual + romancePrefs + gauge_continuity/sleep + world_sim_log + pending relationship)
  const gradiaInspect0 = await gradia.inspectGradiaSessionHandoff({ sourceChatId: 'chat-a' });
  const gradiaSourceScope = gradiaInspect0.scopeKey;
  await host.pluginStorage.setItem('serial_gradation_agents_for_rp:runtime_settings:v2', JSON.stringify({
    version: 3,
    savedAt: new Date().toISOString(),
    settings: {
      npcDisposition: { [gradiaSourceScope]: { default: 'neutral', npcs: [{ id: 'nd-1', name: '지호', level: 'trust', note: '열쇠 협력자' }] } },
      forcedBondCards: { [gradiaSourceScope]: [{ id: 'fb-1', from: '민아', to: '지호', relation: '공조', note: '서재 조사' }] },
      bodyStateCards: { [gradiaSourceScope]: [{ id: 'bs-1', name: '민아', constitution: '보통', canConceive: false, cycleLength: 28, contraception: 'none', basis: '기본' }] },
      gaugeConfig: { [gradiaSourceScope]: { enabled: true, scale: 100 } }
    }
  }));
  await host.pluginStorage.setItem('serial_gradation_agents_for_rp:lore_cards:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    cards: {
      bodyState: {},
      forcedBond: {},
      npcDisposition: {},
      romancePrefs: { [gradiaSourceScope]: [{ id: 'rp-1', name: '지호', orientation: 'bisexual', origin: 'lore' }] },
      dismissed: { bodyState: {}, forcedBond: {}, npcDisposition: {}, romancePrefs: { [gradiaSourceScope]: ['dismissed-rp::1'] } }
    }
  }));
  await host.pluginStorage.setItem('serial_gradation_agents_for_rp:intimacy_cards:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    cards: { [gradiaSourceScope]: [{ id: 'int-1', name: '지호', likedPositions: '기본', dislikedPositions: '없음', origin: 'user' }] }
  }));
  await host.pluginStorage.setItem('serial_gradation_agents_for_rp:gauge_continuity:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    gauges: { [gradiaSourceScope]: { settled: { '유저::지호': { arousal: 25, fatigue: 10 } }, pending: [] } },
    sleep: { [gradiaSourceScope]: { at: 1700000000000, items: [{ name: '민아', wakefulnessGauge: 80, depth: 30, stage: 'light', line: '얕은 선잠' }], people: { minah: { depth: 30, verdict: 'asleep', at: 1700000000000 } } } }
  }));
  await host.pluginStorage.setItem('serial_gradation_agents_for_rp:world_sim_log:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    logs: { [gradiaSourceScope]: [{ id: 'ws-1', at: Date.now(), summary: '도서관 외곽 경비가 교대했다.', actors: ['지호'], place: '도서관 외곽' }] }
  }));
  await host.pluginStorage.setItem('serial_gradation_agents_for_rp:relationship_state:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    chats: {
      [gradiaSourceScope]: {
        pairs: { '유저::지호': { intimacy: 60, trust: 65 } },
        pending: [{ id: 'pend-1', pairId: '유저::지호', status: 'pending', appliedToState: false, intimacyDelta: 6, trustDelta: 4, reason: '야간 경계 공유' }],
        profiles: {},
        notes: [{ at: Date.now(), text: '서재 열쇠 정산 대기' }],
        history: [],
        lastTurn: 5
      }
    }
  }));

  // Seed verified LIA persona proof on source chat A
  await lia.debugAudit.resetPersonaProofForBindingChange(await lia.debugAudit.getContext(), genPersonaId);

  // Execute handoff A -> B
  const handoffResult = await retrace.continueToNextSession();
  assert.equal(handoffResult.ok, true, `Scenario 1 handoff failed: ${JSON.stringify(handoffResult)}`);
  assert.equal(handoffResult.chatSettingsHandoff?.localLoreCount, 1);
  assert.ok(handoffResult.appliedSlices?.includes('lia:persona_proof'), 'LIA persona proof adopted');

  const targetChat = host.chats.find(c => String(c.id || c.chatId) === handoffResult.targetChatId);
  assert.ok(targetChat, 'Target chat B exists');
  assert.equal(targetChat.localLore?.length, 1, 'localLore cloned onto target chat');
  assert.equal(targetChat.bindedPersona, genPersonaId, 'valid bindedPersona preserved onto target chat');

  // Verify GRADIA restored slices & pending settlement
  const targetGradiaInspect = await gradia.inspectGradiaSessionHandoff({ sourceChatId: targetChat.id });
  assert.equal(targetGradiaInspect.ok, true);
  assert.ok(targetGradiaInspect.counts.worldSimLogs >= 1, 'GRADIA worldSimLogs handed off');
  assert.ok(targetGradiaInspect.counts.bodyStateSleep >= 1, 'GRADIA bodyStateSleep handed off');
  assert.ok(targetGradiaInspect.counts.relationshipState >= 1, 'GRADIA relationshipState handed off');

  // Verify Flashback remapped childIds, sourceRecordId, archive hydration, uncovered tail synthesis, and cross-session latentEpisodeCueScore
  const fbTargetScope = await flashback.resolveCurrentScope(false);
  const recallLoaded = await flashback._test.loadScopeRecordsForRecall(
    fbTargetScope.scopeKey,
    null,
    { archiveQuery: { queryText: '서재 열쇠 공연 허가서', rawQuery: '서재 열쇠 공연 허가서' } }
  );
  const recallRecords = Array.isArray(recallLoaded?.records) ? recallLoaded.records : [];
  const ep = recallRecords.find(r => r.sourceType === 'episode_index' && !r.synthesizedInMemory);
  assert.ok(ep, 'Flashback episode_index handed off via archive hydration');
  assert.ok(Array.isArray(ep.childIds) && ep.childIds.length === 2, 'episode childIds preserved');
  assert.ok(ep.childIds.every(cid => recallRecords.some(r => r.id === cid)), 'remapped childIds point to target archive child records');
  assert.ok(ep.sourceRecordId, 'sourceRecordId preserved on inherited episode record');
  assert.ok(
    recallRecords.some(r => r.sourceType === 'episode_index' && r.synthesizedInMemory === true && Number(r.turnRange?.end || 0) >= 3),
    'uncovered tail response turn synthesized into in-memory episode_index for recall'
  );
  const withoutInheritedOffset = flashback._test.latentEpisodeCueScore(
    { ...ep, archiveReferenceOnly: true },
    { locations: ['서재'], objects: ['은빛 열쇠'] },
    1,
    {}
  );
  const withInheritedOffset = flashback._test.latentEpisodeCueScore(
    { ...ep, archiveReferenceOnly: true },
    { locations: ['서재'], objects: ['은빛 열쇠'] },
    1,
    { maxInheritedTurn: 12, liveLatestTurn: 1 }
  );
  assert.equal(withoutInheritedOffset, null, 'without cross-session maxInheritedTurn offset, turn-1 session B blocks reactivation');
  assert.ok(withInheritedOffset && Number(withInheritedOffset.signal) > 0, 'with cross-session maxInheritedTurn offset, latentEpisodeCueScore reactivates inherited episode');

  // Verify LIBRA storyClock, goal-less narrativeDirection, and memoryReview inheritance
  const targetClock = await libra.getStoryClock();
  assert.equal(targetClock.effectiveAnchorDate || targetClock.anchorDate, '2026-03-10', 'LIBRA storyClock anchorDate inherited');
  const targetDirection = await libra.getNarrativeDirection();
  assert.deepEqual(plain(targetDirection.softPreferences), ['서재 중심 추리 분위기를 유지하되 서두르지 않음']);
  assert.deepEqual(plain(targetDirection.doNotForce), ['범인 조기 자백 금지']);
  const targetReview = await libra.listMemoryReviews();
  assert.equal(targetReview.scopeKey, (await libra.getHostLineageStatus()).scopeKey, 'LIBRA memoryReview rewritten to target scopeKey');

  // Verify HAYAKU >12k sidecar recovery_vault & partial_memory search + receipt preservation on subsequent ledger write
  const hyTargetScope = await hayaku._test.currentChatScope();
  const hyVaultHits = await hayaku._test.searchRecoveryVaultRawPassages(hyTargetScope, 'bronze condenser', []);
  assert.ok(hyVaultHits?.active === true && Array.isArray(hyVaultHits.records) && hyVaultHits.records.length >= 1, 'HAYAKU >12k sidecar recovery_vault searchable on target');
  const hyPartialHits = await hayaku._test.searchAcceptedPartialMemory(hyTargetScope, '서재 아키비스트');
  assert.ok(JSON.stringify(hyPartialHits).includes('서재 아키비스트'), 'HAYAKU partial_memory searchable on target');
  const targetLedgerRaw = await host.pluginStorage.getItem(`hayaku.v2.ledger.${hyTargetScope.key}`);
  const parsedLedger = JSON.parse(targetLedgerRaw);
  const ledgerBefore = parsedLedger?.sessionHandoff;
  assert.ok(ledgerBefore?.recoveryVaultHandoff || ledgerBefore?.partialMemoryHandoff, 'HAYAKU sessionHandoff receipt present');
  await hayaku._test.writeStorageLedgerDirect(hyTargetScope, parsedLedger, 'post_handoff_preserve');
  const ledgerAfter = JSON.parse(await host.pluginStorage.getItem(`hayaku.v2.ledger.${hyTargetScope.key}`));
  assert.equal(Boolean(ledgerAfter?.sessionHandoff?.recoveryVaultHandoff), Boolean(ledgerBefore?.recoveryVaultHandoff), 'recoveryVaultHandoff preserved across ledger write');
  assert.equal(Boolean(ledgerAfter?.sessionHandoff?.partialMemoryHandoff), Boolean(ledgerBefore?.partialMemoryHandoff), 'partialMemoryHandoff preserved across ledger write');

  // Verify LIA COW fork & removeGenerated multi-chat bound protection
  await lia.debugAudit.setGeneratedOutputText(JSON.stringify({
    name: 'Forked Target Persona',
    personaPrompt: 'Updated role in target chat B.',
    note: 'Forked in target B'
  }));
  const cowRes = await lia.debugAudit.saveEditedResultToCurrentPersona();
  assert.ok(cowRes !== false, 'saveEditedResultToCurrentPersona succeeded');
  const updatedTargetPersonaId = String(host.chats[0].bindedPersona || '');
  assert.notEqual(updatedTargetPersonaId, genPersonaId, 'COW fork assigns new persona id on target chat B');
  const forkedPersona = host.db.personas.find(p => String(p.id) === updatedTargetPersonaId);
  assert.ok(forkedPersona && forkedPersona.forkedFromPersonaId === genPersonaId, 'forked persona retains forkedFromPersonaId');
  assert.equal(host.db.personas.find(p => p.id === genPersonaId)?.personaPrompt, 'Source persona prompt', 'source generated persona remains untouched');

  // removeGenerated while active chat uses forkedPersona must NOT delete genPersonaId still bound on source chat A
  await lia.debugAudit.removeGenerated();
  assert.ok(host.db.personas.some(p => p.id === genPersonaId), 'source-bound persona protected by multi-chat binding guard');
  assert.equal((await flashback.resolveCurrentScope(false)).scopeKey, fbTargetScope.scopeKey);
});

test('Scenario 1b: LIBRA micro-only detection triggers includeLibra and dangling bindedPersona is stripped', async (t) => {
  const host = createSixPluginHost({
    chats: [
      {
        id: 'micro-chat-a',
        chatId: 'micro-chat-a',
        name: 'Micro Source Chat',
        localLore: [{ key: '마이크로 로어', content: '미크로 확인용' }],
        bindedPersona: 'ghost-deleted-persona',
        message: [],
        fmIndex: -1
      }
    ]
  });
  seedChatMessages(host.chats[0], 2);

  const booted = await bootSixPlugins(host);
  t.after(async () => { await booted.shutdown(); });

  const { retrace, hayaku } = booted;
  const microOnlyNormalized = retrace._test.normalizeLibraInspection({
    ok: true,
    schema: 'libra.retrace.inspect.v1',
    scope: { scopeKey: 'micro-scope-s1', chatId: 'micro-chat-a' },
    recordCount: 0,
    microOwnerRecords: 2,
    integrity: { ok: true }
  }, { chatId: 'micro-chat-a' });
  assert.equal(microOnlyNormalized.available, true, 'microOwnerRecords > 0 makes normalizeLibraInspection.available true');

  const hyScope = await hayaku._test.currentChatScope();
  await hayaku._test.reconcileObservedChatTopology(hyScope, hayaku._test.authoritativeChatSnapshot(hyScope.chatMessages, hyScope), 'scenario1b');

  const res = await retrace.continueToNextSession();
  assert.equal(res.ok, true, `Micro+dangling handoff failed: ${JSON.stringify(res)}`);
  assert.equal(res.chatSettingsHandoff?.strippedDanglingPersonaId, 'ghost-deleted-persona');
  assert.ok(res.skippedSlices?.some(s => s.owner === 'lia' && s.slice === 'bindedPersona' && s.reason === 'persona_not_found_in_db'));
  const tgt = host.chats.find(c => c.id === res.targetChatId);
  assert.equal(tgt.bindedPersona, '', 'dangling bindedPersona stripped from target chat');
});

test('Scenario 2: 2-layer Fail-Open and persistent result popup lifecycle via GUI', async (t) => {
  const doc = createDocument();
  const host = createSixPluginHost({
    document: doc,
    chats: [
      {
        id: 'failopen-a',
        chatId: 'failopen-a',
        name: 'Fail-Open A',
        localLore: [{ key: '유지 로어', content: '이 로어는 승계되어야 한다.' }],
        bindedPersona: 'persona-1',
        message: [],
        fmIndex: -1
      }
    ]
  });
  seedChatMessages(host.chats[0], 5);

  const booted = await bootSixPlugins(host, { document: doc });
  t.after(async () => { await booted.shutdown(); });

  const { retrace, hayaku, libra, gradia } = booted;
  const hyScope = await hayaku._test.currentChatScope();
  await hayaku._test.reconcileObservedChatTopology(
    hyScope,
    hayaku._test.authoritativeChatSnapshot(hyScope.chatMessages, hyScope),
    'failopen_seed'
  );
  const libSettings = await libra.getLibraMemorySettings();
  await libra.saveLibraMemorySettings({ ...libSettings, memoryEngine: 'unified' });
  const cs = await libra.runManualColdStart();
  assert.equal(cs.completed, 1, 'Scenario 2 LIBRA coldStart seeded');

  const gInspect = await gradia.inspectGradiaSessionHandoff({ sourceChatId: 'failopen-a' });
  await host.pluginStorage.setItem('serial_gradation_agents_for_rp:runtime_settings:v2', JSON.stringify({
    version: 3,
    settings: { npcDisposition: { [gInspect.scopeKey]: { default: 'neutral', npcs: [{ id: 'n1', name: '민아', level: 'like', note: 'ok' }] } } }
  }));
  await host.pluginStorage.setItem('serial_gradation_agents_for_rp:world_sim_log:v1', JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    logs: { [gInspect.scopeKey]: [{ id: 'ws-fail', at: Date.now(), summary: '선택 조각 실패 테스트', actors: ['민아'], place: '서재' }] }
  }));

  const origSetItem = host.pluginStorage.setItem.bind(host.pluginStorage);
  let worldSimSliceWriteFaultInjected = false;
  let adoptStarted = false;
  host.pluginStorage.setItem = async (key, value) => {
    if (adoptStarted && !worldSimSliceWriteFaultInjected && String(key) === 'serial_gradation_agents_for_rp:world_sim_log:v1') {
      worldSimSliceWriteFaultInjected = true;
      throw new Error('synthetic_world_sim_slice_write_fault');
    }
    return await origSetItem(key, value);
  };

  let libraPrepareFaultCount = 0;
  host.faults.interceptChannel = async (channel, msg) => {
    if (channel === REQUEST_CHANNELS.gradia && msg?.action === 'adopt_session_handoff') {
      adoptStarted = true;
    }
    if (channel === REQUEST_CHANNELS.libra && msg?.action === 'prepare_session_handoff') {
      libraPrepareFaultCount += 1;
      const respListeners = Array.from(host.listeners.get('libra_memory_bridge_response_v1') || []);
      for (const fn of respListeners) {
        await fn({
          schema: msg.schema,
          kind: 'response',
          requestId: msg.requestId,
          action: msg.action,
          ok: false,
          error: 'synthetic_libra_prepare_outage'
        }, { sender: 'libra' });
      }
      return true;
    }
    return false;
  };

  const entryCb = await waitFor(() => host.guiCallbacks.get('retrace-main-hamburger'), 'RE:TRACE hamburger callback');
  await entryCb();
  const root = doc.querySelector('#flashback-hayaku-bridge-root');
  assert.ok(root?.isConnected);
  await root.querySelector('[data-tab="session"]').emit('click');
  await waitFor(() => !root.querySelector('#createSession').disabled, '#createSession enabled');
  const clickDone = root.querySelector('#createSession').emit('click');
  await waitFor(() => !root.querySelector('#dlg-next').hidden, '#dlg-next visible');
  await root.querySelector('#dlg-next [data-dialog-confirm]').emit('click');
  await clickDone;

  const jobNext = root.querySelector('#job-next');
  assert.equal(jobNext.hidden, false, '#job-next remains visible');

  const overlay = root.querySelector('#retraceHandoffResultOverlay');
  await waitFor(() => overlay && overlay.hidden === false, '#retraceHandoffResultOverlay open after handoff');
  assert.ok(libraPrepareFaultCount >= 1, 'LIBRA prepare fault exercised');
  assert.ok(worldSimSliceWriteFaultInjected, 'GRADIA optional slice write fault exercised');
  const last = retrace.lastTransition();
  assert.equal(Boolean(last?.ok), true, 'fail-open completed despite LIBRA & slice faults');
  assert.equal(Boolean(last?.skippedOwners?.libra), true, 'LIBRA recorded in skippedOwners');
  assert.ok(last?.skippedSlices?.some(s => s.owner === 'gradia' && s.slice === 'worldSimLogs'), 'GRADIA worldSimLogs recorded in skippedSlices');
  assert.ok(overlay.querySelector('[data-handoff-popup-succeeded]').textContent.includes('HAYAKU'), 'popup shows succeeded owner');
  assert.ok(overlay.querySelector('[data-handoff-popup-skipped]').textContent.includes('LIBRA'), 'popup shows skipped owner');

  // Close UI without ack -> reopen UI -> popup must auto-reopen
  await retrace.closeUi();
  overlay.hidden = true;
  await retrace.showUi();
  await waitFor(() => root.querySelector('#retraceHandoffResultOverlay')?.hidden === false, 'unacknowledged popup reopens automatically on showUi');

  // Ack popup -> closes and persists ack
  const ackBtn = root.querySelector('#retraceHandoffResultOverlay [data-handoff-popup-ack]');
  await ackBtn.emit('click');
  await waitFor(() => root.querySelector('#retraceHandoffResultOverlay').hidden === true, 'popup closes on ack');

  await retrace.closeUi();
  await retrace.showUi();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(root.querySelector('#retraceHandoffResultOverlay').hidden, true, 'acknowledged popup does not auto-reopen');

  // Reopen via #retraceOpenHandoffPopup button in #handoffResult
  const reopenBtn = root.querySelector('#retraceOpenHandoffPopup');
  assert.ok(reopenBtn && reopenBtn.hidden === false, '#retraceOpenHandoffPopup visible');
  await reopenBtn.emit('click');
  await waitFor(() => root.querySelector('#retraceHandoffResultOverlay').hidden === false, 'reopen button opens result popup');
});

test('Scenario 2b: Adopt-stage [data-handoff-accept-partial] and hard fail-closed invariants', async (t) => {
  const doc2 = createDocument();
  const host2 = createSixPluginHost({
    document: doc2,
    chats: [{ id: 'failopen-2a', chatId: 'failopen-2a', name: 'Adopt Partial 2A', localLore: [], bindedPersona: 'persona-1', message: [], fmIndex: -1 }]
  });
  seedChatMessages(host2.chats[0], 5);
  const booted2 = await bootSixPlugins(host2, { document: doc2 });
  t.after(async () => { await booted2.shutdown(); });

  const { retrace, hayaku, libra } = booted2;
  const hyScope = await hayaku._test.currentChatScope();
  await hayaku._test.reconcileObservedChatTopology(hyScope, hayaku._test.authoritativeChatSnapshot(hyScope.chatMessages, hyScope), 'seed2b');
  await libra.saveLibraMemorySettings({ ...(await libra.getLibraMemorySettings()), memoryEngine: 'unified' });
  const cs = await libra.runManualColdStart();
  assert.equal(cs.completed, 1, 'Scenario 2b LIBRA coldStart seeded');

  host2.faults.interceptChannel = async (channel, msg) => {
    if (channel === REQUEST_CHANNELS.libra && msg?.action === 'adopt_session_handoff') {
      const respListeners = Array.from(host2.listeners.get('libra_memory_bridge_response_v1') || []);
      for (const fn of respListeners) {
        await fn({
          schema: msg.schema,
          kind: 'response',
          requestId: msg.requestId,
          action: msg.action,
          ok: false,
          error: 'synthetic_adopt_failure'
        }, { sender: 'libra' });
      }
      return true;
    }
    return false;
  };

  const resPending = await retrace.continueToNextSession();
  assert.equal(resPending.ok, false);
  assert.equal(resPending.handoffJournalState, 'pending_owner_handoffs');

  await retrace.showUi();
  const root2 = booted2.doc.querySelector('#flashback-hayaku-bridge-root');
  const acceptBtn = await waitFor(() => root2.querySelector('#retraceHandoffResultOverlay [data-handoff-accept-partial]'), '[data-handoff-accept-partial] visible');
  await acceptBtn.emit('click');
  await waitFor(() => retrace.lastTransition()?.handoffJournalState === 'partial_accepted', 'partial_accepted committed via popup button');

  // Hard fail-closed check 1: RETRACE_HANDOFF_STORAGE_GATE_BLOCKED via mixed owner storage modes
  host2.activateChat('failopen-2a');
  host2.faults.interceptChannel = async (channel, msg) => {
    if (channel === REQUEST_CHANNELS.libra && msg?.action === 'memory_suite_storage_status') {
      const respListeners = Array.from(host2.listeners.get('libra_memory_bridge_response_v1') || []);
      for (const fn of respListeners) {
        await fn({
          schema: msg.schema,
          kind: 'response',
          requestId: msg.requestId,
          action: msg.action,
          ok: true,
          result: {
            ok: true,
            owner: 'libra',
            namespace: 'libra',
            installed: true,
            connected: true,
            supported: true,
            ready: true,
            mode: 'server_only',
            storageMode: 'server_only',
            effectiveMode: 'server_only'
          }
        }, { sender: 'libra' });
      }
      return true;
    }
    return false;
  };
  await assert.rejects(
    () => retrace.continueToNextSession({ failOpen: true }),
    err => String(err?.code || err?.message).includes('RETRACE_HANDOFF_STORAGE_GATE_BLOCKED')
  );

  // Hard fail-closed check 2: SOURCE_MUTATION_DETECTED rejects even with failOpen: true
  host2.faults.silentOwners = [];
  host2.faults.interceptChannel = async (channel, msg) => {
    if (channel === REQUEST_CHANNELS.hayaku && msg?.action === 'adopt_session_handoff') {
      const respListeners = Array.from(host2.listeners.get('hayaku_memory_bridge_response_v1') || []);
      for (const fn of respListeners) {
        await fn({
          schema: msg.schema,
          kind: 'response',
          requestId: msg.requestId,
          action: msg.action,
          ok: false,
          error: 'SOURCE_MUTATION_DETECTED',
          result: { ok: false, sourcePreserved: false, code: 'SOURCE_MUTATION_DETECTED', reason: 'SOURCE_MUTATION_DETECTED' }
        }, { sender: 'hayaku_locator_continuity' });
      }
      return true;
    }
    return false;
  };
  await assert.rejects(
    () => retrace.continueToNextSession({ failOpen: true }),
    err => String(err?.code || err?.message).includes('SOURCE_MUTATION_DETECTED')
  );
});

test('Scenario 3: Chained multi-generation re-handoff (A -> B -> C) for 0-turn immediate and multi-turn partial_accepted', async (t) => {
  const host = createSixPluginHost({
    chats: [{ id: 'chain-a', chatId: 'chain-a', name: 'Chain A', localLore: [{ key: '계보 로어', content: 'A->B->C 계승' }], bindedPersona: 'persona-1', message: [], fmIndex: -1 }]
  });
  seedChatMessages(host.chats[0], 5);
  const booted = await bootSixPlugins(host);
  t.after(async () => { await booted.shutdown(); });

  const { retrace, flashback, hayaku, libra } = booted;

  // LIBRA coldStart on 5 intact turns first, then append turn 6 (>12k raw) for HAYAKU sidecar recovery vault
  await libra.saveLibraMemorySettings({ ...(await libra.getLibraMemorySettings()), memoryEngine: 'unified' });
  const cs = await libra.runManualColdStart();
  assert.equal(cs.completed, 1, 'Chain A LIBRA coldStart seeded');
  await libra.setStoryClockAnchor('2026-04-01');
  await libra.correctStoryClockTurn(2, { day: 4, date: '2026-04-04', timeOfDay: '황혼' });

  host.chats[0].message.push({ role: 'user', id: 't6-u', chatId: 't6-u', data: 'Inspect bronze condenser.' });
  host.chats[0].message.push({ role: 'char', id: 't6-a', chatId: 't6-a', data: buildLargeRawEvidence('CHAIN_RAW_PASSAGE', 13000) });

  const hyScopeA = await hayaku._test.currentChatScope();
  await hayaku._test.reconcileObservedChatTopology(hyScopeA, hayaku._test.authoritativeChatSnapshot(hyScopeA.chatMessages, hyScopeA), 'chainA');
  const freshScopeA = await hayaku._test.currentChatScope();
  const snapA = hayaku._test.authoritativeChatSnapshot(freshScopeA.chatMessages, freshScopeA);
  const pair6A = snapA.conversationPairs.find(p => Number(p.pairIndex) === 6);
  const vaultSavedA = await hayaku._test.upsertRecoveryVaultEvidence(
    { scope: freshScopeA },
    { scopeKey: freshScopeA.key, pair: pair6A, liveScope: freshScopeA },
    'chain_oversize'
  );
  assert.equal(vaultSavedA.durable, true, 'Chain A >12k sidecar recovery_vault seeded');

  const fbScopeA = await flashback.resolveCurrentScope(false);
  await flashback._test.saveAllRecords([
    { id: 'fb-c-1', hash: 'hc-1', type: 'response', sourceType: 'response', text: '서재의 고문서에 기록된 첫 단서', dim: 4, vector: [1, 0, 0, 0], turnIndex: 1, sourceTurn: 1, lifecycleStatus: 'active' }
  ], null, fbScopeA);

  // A -> B
  const resAB = await retrace.continueToNextSession();
  assert.equal(resAB.ok, true, `A -> B failed: ${JSON.stringify(resAB)}`);
  assert.equal(resAB.handoffGeneration, 1);

  // Track 1: Zero-turn immediate B -> C
  const chatB = host.chats.find(c => c.id === resAB.targetChatId);
  assert.equal((chatB.message || []).length, 0);
  const resBC = await retrace.continueToNextSession();
  assert.equal(resBC.ok, true, `0-turn B -> C failed: ${JSON.stringify(resBC)}`);
  assert.equal(resBC.handoffGeneration, 2);
  assert.equal(resBC.handoffLineage?.length, 2, 'C has 2-step handoffLineage');
  assert.equal(resBC.handoffLineage[0].sourceChatId, 'chain-a');
  assert.equal(resBC.handoffLineage[1].sourceChatId, chatB.id);

  // Bounded fixed-length history: IDs on C's recovery vault (both inline records and >12k debtRefs sidecars)
  const hyScopeC = await hayaku._test.currentChatScope();
  const vaultRawC = await host.pluginStorage.getItem(`hayaku.v2.recovery_vault.${hyScopeC.key}`);
  const vaultC = typeof vaultRawC === 'string' ? JSON.parse(vaultRawC) : vaultRawC;
  const vaultRefsC = [...(vaultC?.records || []), ...(vaultC?.debtRefs || [])];
  assert.ok(vaultRefsC.length >= 1, 'HAYAKU recovery vault inherited through 0-turn B onto C');
  assert.ok(
    vaultRefsC.every(ref => /^history:h64[a-z0-9]+$/.test(String(ref.recordId || '')) && !String(ref.recordId || '').includes('history:inherited:history:inherited:')),
    'bounded fixed-length history: recordId without prefix explosion'
  );
  const hitsC = await hayaku._test.searchRecoveryVaultRawPassages(hyScopeC, 'bronze condenser', []);
  assert.ok(hitsC?.active === true && Array.isArray(hitsC.records) && hitsC.records.length >= 1, 'HAYAKU >12k sidecar searchable across 0-turn B onto C');

  // LIBRA storyClock Day/Time/Date continuity across 0-turn B -> C
  const clockC = await libra.getStoryClock();
  assert.equal(clockC.effectiveAnchorDate || clockC.anchorDate, '2026-04-01', 'LIBRA storyClock anchorDate preserved A->B->C');

  // Flashback archiveRef recall across 0-turn B onto C
  const fbScopeC = await flashback.resolveCurrentScope(false);
  const fbLoadedC = await flashback._test.loadScopeRecords(fbScopeC.scopeKey);
  assert.ok(fbLoadedC.records.some(r => String(r.text || '').includes('첫 단서')), 'Flashback record inherited across 0-turn B onto C');

  // Source A & B preserved
  assert.equal(host.chats.find(c => c.id === 'chain-a')?.message?.length, 12);
  assert.equal(host.chats.find(c => c.id === chatB.id)?.message?.length, 0);

  // Track 2: Multi-turn + partial_accepted B -> C2
  chatB.memorySessionBridge.handoffJournal.state = 'partial_accepted';
  chatB.memorySessionBridge.handoffJournal.partialAccepted = true;
  host.activateChat(chatB.id);
  seedChatMessages(chatB, 2);
  const hyScopeB2 = await hayaku._test.currentChatScope();
  await hayaku._test.reconcileObservedChatTopology(hyScopeB2, hayaku._test.authoritativeChatSnapshot(hyScopeB2.chatMessages, hyScopeB2), 'chainB2');
  const resB2C2 = await retrace.continueToNextSession();
  assert.equal(resB2C2.ok, true, `Multi-turn partial_accepted B -> C2 failed: ${JSON.stringify(resB2C2)}`);
  assert.equal(resB2C2.handoffGeneration, 2);
  assert.equal(resB2C2.handoffLineage.length, 2);
});
