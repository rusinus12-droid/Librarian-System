'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const OUTPUT = path.join(ROOT, 'test-output', 'libra-scope-transition-regression-test.json');
const checks = [];

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (name, ok, detail = null) => {
  checks.push({ name, ok: !!ok, detail });
  return !!ok;
};
const jsonEntry = (comment, marker, payload = {}) => ({
  key: `${comment}::scope-regression`,
  comment,
  content: JSON.stringify({ schema: `test.${comment}.v1`, marker, ...payload }),
  mode: 'normal',
  insertorder: 5,
  alwaysActive: false
});
const memoryEntry = (key, marker, turn = 1, source = 'scope_regression') => ({
  key,
  comment: 'lmai_memory',
  content: `[META:${JSON.stringify({
    t: turn,
    imp: 8,
    ttl: -1,
    cat: 'event',
    ent: ['Ariel'],
    source,
    sourceHash: crypto.createHash('sha1').update(marker).digest('hex').slice(0, 16),
    sourceMessageIds: [`assistant-${turn}`]
  })}]\n${marker}`,
  mode: 'normal',
  insertorder: 10,
  alwaysActive: false
});

function narrativeSentinel(marker, turn = 1) {
  return {
    storylines: [{
      id: `${marker.toLowerCase()}-arc`,
      name: marker,
      arcKey: marker.toLowerCase(),
      turns: [turn],
      firstTurn: turn,
      lastTurn: turn,
      currentContext: marker,
      keyPoints: [marker],
      ongoingTensions: [`${marker}_TENSION`],
      entities: ['Ariel'],
      summaries: []
    }],
    turnLog: [{ turn, brief: marker, arcKey: marker.toLowerCase(), entities: ['Ariel'] }],
    metaTurnLog: [],
    lastSummaryTurn: turn
  };
}

function worldStateSentinel(marker, turn = 1) {
  return {
    turnLog: [{
      turn,
      activeWorld: ['world-main'],
      rulesSnapshot: { marker },
      globalFlags: {},
      classification: 'scope regression world',
      worldSummary: marker,
      currentTime: `T${turn}`,
      currentLocation: marker,
      currentScene: `${marker}_SCENE`,
      activeEvents: [`${marker}_EVENT`],
      offscreenThreads: [],
      ruleHighlights: [marker],
      notes: marker
    }],
    consolidated: [{ turn, type: 'critical', description: marker, timestamp: Date.now() }],
    lastConsolidationTurn: turn
  };
}

function worldGraphSentinel(marker) {
  return {
    schema: 'libra.world.graph.compact.v2',
    version: '6.1',
    rootId: 'world-main',
    global: {
      multiverse: false,
      dimensionTravel: false,
      timeTravel: false,
      metaNarrative: false,
      virtualReality: false,
      dreamWorld: false,
      reincarnationPossession: false,
      systemInterface: false
    },
    nodes: [['world-main', {
      id: 'world-main',
      name: marker,
      layer: 'dimension',
      parent: null,
      children: [],
      isActive: true,
      isPrimary: true,
      accessCondition: null,
      rules: {
        exists: {}, systems: {},
        setting: { places: [marker], organizations: [], socialRules: [marker] },
        physics: { special_phenomena: [] },
        inheritance: { mode: 'extend', exceptions: [] }
      },
      dimensional: null,
      connections: [],
      meta: { created: 1, updated: 1, source: 'scope-regression', notes: marker, worldSummary: marker, classification: 'test', worldMetadata: { marker } }
    }]],
    activePath: ['world-main'],
    interference: { level: 0, recentEvents: [] },
    meta: { created: 1, updated: 1, complexity: 1, marker }
  };
}

function structuredSnapshot(arcMarker, worldMarker, turn = 3) {
  return {
    narrative: `${arcMarker} summary`,
    narrativeDetails: {
      storylines: [{
        name: arcMarker,
        context: `${arcMarker} current context`,
        keyPoints: [`${arcMarker} key point`],
        ongoingTensions: [`${arcMarker} tension`],
        entities: ['Ariel']
      }]
    },
    entities: [{
      name: 'Ariel',
      role: 'scope regression witness',
      appearance: '',
      personality: 'careful',
      background: `${arcMarker} background`,
      occupation: 'observer',
      currentState: { summary: `${arcMarker} entity state`, cognitiveFocus: [arcMarker] },
      continuity: { openThreads: [{ label: `${arcMarker} thread`, status: 'active', pressure: 1 }] },
      quality: { confidence: 0.9, importance: 0.8, salience: 0.8 }
    }],
    relations: [],
    world: {
      tech: '',
      summary: worldMarker,
      description: `${worldMarker} description`,
      classification: { primary: 'scope regression fantasy', complexity: 'simple' },
      exists: { magic: true },
      systems: { magic: worldMarker },
      setting: { places: [worldMarker], organizations: [], socialRules: [worldMarker] },
      physics: { special_phenomena: [] },
      phenomena: [`${worldMarker} phenomenon`],
      rules: [`${worldMarker} rule`],
      state: {
        time: `T${turn}`,
        location: worldMarker,
        scene: `${worldMarker} scene`,
        active_events: [`${worldMarker} event`],
        offscreen_threads: []
      },
      custom: { scopeRegressionMarker: worldMarker }
    }
  };
}

function makeWorldAdditionalPayload(marker = 'WA_MANUAL_REBASE') {
  return {
    sceneInterventions: [{
      id: 'wa_scope_rebase_scene',
      type: 'scene_intervention',
      title: marker,
      description: `${marker} description grounded in the current chat.`,
      directive: 'Present a non-forcing environmental signal.',
      sourceBasis: ['current assistant scene'],
      relatedEntities: ['Ariel'],
      activationCondition: 'When the observatory is revisited.',
      progressionTier: 'section',
      status: 'armed',
      forceLevel: 'firm',
      userImpact: 'soft'
    }],
    worldDeltas: [],
    characterAdditions: [],
    manifestations: []
  };
}

function buildPluginCode() {
  let code = fs.readFileSync(DIST, 'utf8');
  code = code
    .replace('const PENDING_FINALIZE_MIN_MS = 3500;', 'const PENDING_FINALIZE_MIN_MS = 0;')
    .replace('const PENDING_FINALIZE_REQUIRED_MATCHES = 2;', 'const PENDING_FINALIZE_REQUIRED_MATCHES = 1;')
    .replace('const REFRESH_STABILIZE_MS = 2500;', 'const REFRESH_STABILIZE_MS = 0;')
    .replace('const REFRESH_DELETE_BLOCK_MS = 15000;', 'const REFRESH_DELETE_BLOCK_MS = 0;');
  const exportSnippet = `
;globalThis.__LIBRA_SCOPE_TEST__ = {
  MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,
  MemoryState: typeof MemoryState !== 'undefined' ? MemoryState : null,
  ColdStartManager: typeof ColdStartManager !== 'undefined' ? ColdStartManager : null,
  TransitionManager: typeof TransitionManager !== 'undefined' ? TransitionManager : null,
  LLMProvider: typeof LLMProvider !== 'undefined' ? LLMProvider : null,
  NarrativeTracker: typeof NarrativeTracker !== 'undefined' ? NarrativeTracker : null,
  WorldStateTracker: typeof WorldStateTracker !== 'undefined' ? WorldStateTracker : null,
  CharacterStateTracker: typeof CharacterStateTracker !== 'undefined' ? CharacterStateTracker : null,
  StoryAuthor: typeof StoryAuthor !== 'undefined' ? StoryAuthor : null,
  Director: typeof Director !== 'undefined' ? Director : null,
  WorldAdditionalCore: typeof WorldAdditionalCore !== 'undefined' ? WorldAdditionalCore : null,
  HierarchicalWorldManager: typeof HierarchicalWorldManager !== 'undefined' ? HierarchicalWorldManager : null,
  ScopedRuntimeTransaction: typeof ScopedRuntimeTransaction !== 'undefined' ? ScopedRuntimeTransaction : null,
  IntegrityMetaManager: typeof IntegrityMetaManager !== 'undefined' ? IntegrityMetaManager : null,
  TurnMaintenanceOptimizer: typeof TurnMaintenanceOptimizer !== 'undefined' ? TurnMaintenanceOptimizer : null,
  mergeConcurrentLibraManagedLore: typeof mergeConcurrentLibraManagedLore === 'function' ? mergeConcurrentLibraManagedLore : null,
  purgeLibraManagedLoreForActiveChat: typeof purgeLibraManagedLoreForActiveChat === 'function' ? purgeLibraManagedLoreForActiveChat : null,
  getChatRuntimeScopeKey: typeof getChatRuntimeScopeKey === 'function' ? getChatRuntimeScopeKey : null,
  LibraDataStorage: typeof LibraDataStorage !== 'undefined' ? LibraDataStorage : null
};
`;
  const closeIndex = code.lastIndexOf('\n})();');
  if (closeIndex < 0) throw new Error('plugin IIFE close not found');
  return code.slice(0, closeIndex) + exportSnippet + code.slice(closeIndex);
}

async function createRuntime(chats, options = {}) {
  const state = {
    active: Number(options.active || 0),
    character: {
      id: options.characterId || 'char-scope-regression',
      chaId: options.characterId || 'char-scope-regression',
      name: options.characterName || 'Scope Regression Character',
      chatPage: Number(options.active || 0),
      chats: clone(chats),
      lorebook: [],
      globalLore: [],
      description: 'A deterministic scope and session transition regression character.'
    },
    setCharacterCalls: 0,
    setCharacterToIndexCalls: 0,
    setCharacterDirectCalls: 0,
    setChatCalls: [],
    unloadHandlers: [],
    logs: [],
    storage: options.storage || new Map()
  };
  const args = new Map(Object.entries({
    debug: 'false',
    llm_provider: 'custom_openai',
    llm_url: 'http://mock.invalid/v1/chat/completions',
    llm_key: 'scope-test-key',
    llm_model: 'scope-test-model',
    llm_timeout_ms: '5000',
    llm_stream: 'false',
    embedding_enabled: 'false',
    activity_dashboard: 'off',
    manual_ooc_pause: 'true',
    cold_start_scope_preset: 'all',
    cold_start_history_limit: '0',
    world_additional_enabled: 'true',
    world_additional_mode: 'firm'
  }));
  const database = { personas: [], selectedPersona: null, modules: [], enabledModules: [], moduleIntergration: [], characters: [state.character] };
  const api = {
    apiVersion: '3.0-scope-test',
    async getRuntimeInfo() { return { apiVersion: '3.0-scope-test', platform: 'node-test' }; },
    async getArgument(name) { return args.get(name); },
    async requestPluginPermission() { return true; },
    async getCharacter() {
      if (typeof state.onGetCharacter === 'function') await state.onGetCharacter(state);
      const next = clone(state.character);
      next.chatPage = state.active;
      return next;
    },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return state.active; },
    async getCharacterFromIndex(index) {
      if (Number(index) !== 0) return null;
      const next = clone(state.character);
      next.chatPage = state.active;
      return next;
    },
    async getChatFromIndex(charIndex, chatIndex) {
      return Number(charIndex) === 0 ? clone(state.character.chats[Number(chatIndex)] || null) : null;
    },
    async setChatToIndex(charIndex, chatIndex, nextChat) {
      if (Number(charIndex) !== 0 || !state.character.chats[Number(chatIndex)]) return false;
      state.character.chats[Number(chatIndex)] = clone(nextChat);
      state.setChatCalls.push({ chatIndex: Number(chatIndex), chatId: String(nextChat?.id || '') });
      return true;
    },
    async setCharacterToIndex(index, nextCharacter) {
      if (Number(index) !== 0) return false;
      state.character = clone(nextCharacter);
      state.active = Number(state.character.chatPage || 0);
      database.characters = [state.character];
      state.setCharacterCalls += 1;
      state.setCharacterToIndexCalls += 1;
      return true;
    },
    async setCharacter(nextCharacter) {
      state.character = clone(nextCharacter);
      state.active = Number(state.character.chatPage || 0);
      database.characters = [state.character];
      state.setCharacterCalls += 1;
      state.setCharacterDirectCalls += 1;
      return true;
    },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async registerBodyIntercepter() { return 'scope-test-interceptor'; },
    async unregisterBodyIntercepter() { return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async onUnload(handler) { if (typeof handler === 'function') state.unloadHandlers.push(handler); return true; },
    async getDatabase(keys) {
      const selected = Array.isArray(keys) ? keys : Object.keys(database);
      return Object.fromEntries(selected.map(key => [key, clone(database[key])]));
    },
    pluginStorage: {
      async getItem(key) { return state.storage.has(key) ? state.storage.get(key) : null; },
      async setItem(key, value) { state.storage.set(key, String(value)); return true; },
      async removeItem(key) { state.storage.delete(key); return true; },
      async keys() { return [...state.storage.keys()]; }
    },
    safeLocalStorage: {
      async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }
    },
    async getLocalPluginStorage() {
      return {
        async getItem(key) { return state.storage.has(key) ? state.storage.get(key) : null; },
        async setItem(key, value) { state.storage.set(key, String(value)); return true; },
        async removeItem(key) { state.storage.delete(key); return true; },
        async get(key) { return state.storage.has(key) ? state.storage.get(key) : null; },
        async set(key, value) { state.storage.set(key, String(value)); return true; },
        delete(key) { return state.storage.delete(key); }
      };
    },
    async nativeFetch() { throw new Error('network is disabled in scope regression test'); }
  };
  const context = {
    console: {
      log: (...items) => state.logs.push({ level: 'log', message: items.map(String).join(' ') }),
      warn: (...items) => state.logs.push({ level: 'warn', message: items.map(String).join(' ') }),
      error: (...items) => state.logs.push({ level: 'error', message: items.map(String).join(' ') }),
      debug: (...items) => state.logs.push({ level: 'debug', message: items.map(String).join(' ') })
    },
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID },
    AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async () => { throw new Error('network is disabled in scope regression test'); },
    risuai: api, Risuai: api,
    process: { env: {} },
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  const result = vm.runInContext(buildPluginCode(), context, { filename: DIST, timeout: 20000 });
  if (result && typeof result.then === 'function') await result;
  await sleep(100);
  const exports = context.__LIBRA_SCOPE_TEST__;
  if (!exports?.MemoryEngine || !exports?.ColdStartManager || !exports?.TransitionManager) {
    throw new Error(`missing test exports: ${Object.keys(exports || {}).join(', ')}`);
  }
  exports.ColdStartManager.check = async () => false;
  exports.LLMProvider.isConfigured = () => true;
  Object.assign(exports.MemoryEngine.CONFIG, {
    debug: false,
    activityDashboard: 'off',
    useLLM: true,
    coldStartScopePreset: 'all',
    coldStartHistoryLimit: 0,
    storyAuthorEnabled: true,
    storyAuthorMode: 'proactive',
    directorEnabled: true,
    directorMode: 'standard',
    worldAdditionalEnabled: true,
    worldAdditionalMode: 'firm',
    worldAdditionalAutoIntegrate: true,
    embed: { ...(exports.MemoryEngine.CONFIG.embed || {}), enabled: false, key: '' },
    llm: {
      ...(exports.MemoryEngine.CONFIG.llm || {}),
      provider: 'custom_openai', url: 'http://mock.invalid/v1/chat/completions', key: 'scope-test-key',
      model: 'scope-test-model', timeout: 5000, stream: false, maxCompletionTokens: 12000
    }
  });
  return {
    state,
    exports,
    setActive(index) {
      state.active = Number(index);
      state.character.chatPage = state.active;
    },
    getChat(id) { return state.character.chats.find(chat => String(chat?.id || '') === String(id)); },
    async close() {
      for (const handler of state.unloadHandlers) {
        try { await handler(); } catch (_) {}
      }
    }
  };
}

function chat(id, lore = []) {
  const messages = [
    { role: 'user', content: `${id} user asks about the observatory.`, m_id: `${id}-u1`, time: Date.now() - 1000 },
    { role: 'assistant', content: `${id} assistant confirms a canonical observatory event.`, m_id: `${id}-a1`, time: Date.now() }
  ];
  return { id, name: id, localLore: clone(lore), message: messages, msgs: messages, isStreaming: false };
}

async function testColdScopeRace() {
  const bLore = [
    { key: 'narrative-b', comment: 'lmai_narrative', content: JSON.stringify(narrativeSentinel('ARC_B_PRIVATE', 1)), mode: 'normal', insertorder: 5, alwaysActive: false },
    { key: 'world-state-b', comment: 'lmai_world_states', content: JSON.stringify(worldStateSentinel('WORLD_B_PRIVATE', 1)), mode: 'normal', insertorder: 5, alwaysActive: false },
    { key: 'world-graph-b', comment: 'lmai_world_graph', content: JSON.stringify(worldGraphSentinel('WORLD_B_PRIVATE')), mode: 'normal', insertorder: 5, alwaysActive: false }
  ];
  const runtime = await createRuntime([chat('chat-A'), chat('chat-B', bLore)]);
  const { exports } = runtime;
  const originalBLore = JSON.stringify(runtime.getChat('chat-B').localLore);

  const runWithMidAnalysisSwitch = async (operation, arcMarker, worldMarker) => {
    let calls = 0;
    const candidate = structuredSnapshot(arcMarker, worldMarker, calls + 3);
    exports.LLMProvider.call = async () => {
      calls += 1;
      if (calls === 1) {
        runtime.setActive(1);
        const b = runtime.getChat('chat-B');
        exports.NarrativeTracker.loadState(b.localLore);
        exports.WorldStateTracker.loadState(b.localLore);
        exports.HierarchicalWorldManager.loadWorldGraph(b.localLore, true);
      }
      return {
        content: JSON.stringify(candidate),
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        serviceTier: ''
      };
    };
    return await operation();
  };

  runtime.setActive(0);
  await runWithMidAnalysisSwitch(
    () => exports.ColdStartManager.startAutoSummarization({ confirmationGranted: true, trigger: 'scope-baseline-test' }),
    'ARC_A_BASELINE',
    'WORLD_A_BASELINE'
  );
  // LIBRA 데이터는 이제 로어가 아니라 pluginStorage 에 저장된다. 로어에는
  // 비-LIBRA 항목만 남으므로, 커밋 확인은 로어 + 스토리지 섀도를 함께 본다.
  const loreOf = (id) => {
    const lore = runtime.getChat(id).localLore;
    const chat = runtime.getChat(id);
    let shadowText = '';
    try {
      const sk = exports.LibraDataStorage?.scopeKeyFor?.(runtime.state.character, chat);
      shadowText = JSON.stringify(exports.LibraDataStorage?.getShadowEntries?.(sk) || []);
    } catch (_) {}
    return JSON.stringify(lore) + shadowText;
  };
  const aAfterBaseline = loreOf('chat-A');
  const bAfterBaseline = JSON.stringify(runtime.getChat('chat-B').localLore);
  record('cold_baseline_commits_to_captured_chat_A', aAfterBaseline.includes('ARC_A_BASELINE') && aAfterBaseline.includes('WORLD_A_BASELINE'), {
    aHasArc: aAfterBaseline.includes('ARC_A_BASELINE'), aHasWorld: aAfterBaseline.includes('WORLD_A_BASELINE')
  });
  record('cold_baseline_never_leaks_runtime_B_sentinels_into_A', !aAfterBaseline.includes('ARC_B_PRIVATE') && !aAfterBaseline.includes('WORLD_B_PRIVATE'));
  record('cold_baseline_does_not_mutate_active_chat_B', bAfterBaseline === originalBLore, {
    beforeLength: originalBLore.length, afterLength: bAfterBaseline.length
  });

  runtime.setActive(0);
  await runWithMidAnalysisSwitch(
    () => exports.ColdStartManager.reanalyzeHistoricalConversation({ confirmationGranted: true, trigger: 'scope-reanalysis-test' }),
    'ARC_A_REANALYZED',
    'WORLD_A_REANALYZED'
  );
  const aAfterReanalysis = loreOf('chat-A');
  const bAfterReanalysis = JSON.stringify(runtime.getChat('chat-B').localLore);
  record('historical_reanalysis_commits_to_captured_chat_A', aAfterReanalysis.includes('ARC_A_REANALYZED') && aAfterReanalysis.includes('WORLD_A_REANALYZED'), {
    aHasArc: aAfterReanalysis.includes('ARC_A_REANALYZED'), aHasWorld: aAfterReanalysis.includes('WORLD_A_REANALYZED')
  });
  record('historical_reanalysis_never_leaks_runtime_B_sentinels_into_A', !aAfterReanalysis.includes('ARC_B_PRIVATE') && !aAfterReanalysis.includes('WORLD_B_PRIVATE'));
  record('historical_reanalysis_does_not_mutate_active_chat_B', bAfterReanalysis === originalBLore);

  // 스냅샷 롤백 삭제로 reanalyzeRollbackDeleteCandidates 는 사라졌다. 그 시나리오가
  // 검사하던 계약 — "분석 중 스코프가 전환되어도 결과는 캡처된 채팅에만 커밋되고
  // 활성 채팅을 변형하지 않는다" — 은 위의 두 시나리오(콜드 스타트 베이스라인,
  // 과거 대화 재분석)가 동일하게 검사하므로 중복 시나리오는 제거했다.

  // Model the exact core of the GUI manual-analysis updater: the LLM works
  // against a stale snapshot, a concurrent memory lands, and the result is then
  // rebased onto the newest lore before only World Additional is saved.
  runtime.setActive(0);
  const target = runtime.getChat('chat-A');
  const staleLore = clone(exports.MemoryEngine.getLorebook(runtime.state.character, target));
  const concurrentMemory = memoryEntry('memory-concurrent-during-wa', 'MEMORY_COMMITTED_DURING_WA_ANALYSIS', 9, 'concurrent_wa_turn');
  let manualCalls = 0;
  exports.LLMProvider.call = async () => {
    manualCalls += 1;
    if (manualCalls === 1) target.localLore.push(clone(concurrentMemory));
    const payload = { worldAdditional: makeWorldAdditionalPayload() };
    return { content: JSON.stringify(payload), usage: { prompt_tokens: 10, completion_tokens: 20 }, serviceTier: '' };
  };
  const manualResult = await exports.TurnMaintenanceOptimizer.runWorldAdditionalManual({
    turn: 9,
    historyText: 'ASSISTANT: A canonical observatory alarm is active.',
    worldPrompt: 'The observatory alarm is a grounded world mechanism.',
    worldStatePrompt: 'Current location: observatory.',
    narrativePrompt: 'Continue the investigation without forcing the user.',
    entityContext: 'Ariel is present.',
    existingDirectives: ''
  }, { ...exports.MemoryEngine.CONFIG, worldAdditionalEnabled: true, worldAdditionalMode: 'firm' });
  const latestLore = exports.MemoryEngine.getLorebook(runtime.state.character, target);
  const scopeKey = exports.getChatRuntimeScopeKey(target, runtime.state.character);
  exports.WorldAdditionalCore.loadState(latestLore, { scopeKey, chatId: target.id });
  exports.WorldAdditionalCore.ingestMaintenance(manualResult.payload, '', {
    turn: 9, source: manualResult.source, injectedIds: []
  }, { ...exports.MemoryEngine.CONFIG, worldAdditionalEnabled: true, worldAdditionalMode: 'firm' });
  await exports.WorldAdditionalCore.saveState(latestLore);
  exports.MemoryEngine.setLorebook(runtime.state.character, target, latestLore);
  const afterManual = JSON.stringify(target.localLore);
  const distText = fs.readFileSync(DIST, 'utf8');
  record('wa_manual_analyzes_before_concurrent_memory_arrives', !JSON.stringify(staleLore).includes('MEMORY_COMMITTED_DURING_WA_ANALYSIS'));
  record('wa_manual_latest_lore_rebase_preserves_concurrent_memory', afterManual.includes('MEMORY_COMMITTED_DURING_WA_ANALYSIS') && afterManual.includes('WA_MANUAL_REBASE'), {
    memoryPreserved: afterManual.includes('MEMORY_COMMITTED_DURING_WA_ANALYSIS'),
    worldAdditionalSaved: afterManual.includes('WA_MANUAL_REBASE')
  });
  record('wa_manual_gui_path_uses_latest_lore_updater',
    distText.includes('saveLoreToChar(async (latestLore')
      && distText.includes('WorldAdditionalCore.loadState?.(latestLore')
      && distText.includes('await WorldAdditionalCore.saveState(latestLore)'));

  // Deferred GC must resolve the captured target again. A stale chat snapshot
  // is scheduled, a new memory lands, and the user moves to chat B before GC.
  runtime.setActive(0);
  const staleGcChar = clone(runtime.state.character);
  const staleGcChat = clone(runtime.getChat('chat-A'));
  const concurrentGcMemory = memoryEntry('memory-concurrent-before-gc', 'MEMORY_COMMITTED_BEFORE_DEFERRED_GC', 10, 'concurrent_gc_turn');
  const chatBBeforeGc = JSON.stringify(runtime.getChat('chat-B').localLore);
  const originalIncrementalGc = exports.MemoryEngine.incrementalGC;
  exports.MemoryEngine.incrementalGC = async freshLore => ({ entries: clone(freshLore), deleted: 1 });
  const gcScheduled = exports.MemoryEngine.scheduleDeferredMemoryGc(
    staleGcChar,
    staleGcChat,
    10,
    'scope-regression-deferred-gc',
    { characterId: runtime.state.character.id, characterIndex: 0, chatId: 'chat-A', chatIndex: 0 }
  );
  // 동시 메모리는 로어가 아니라 스토리지 섀도에 들어간다. 두 곳을 함께 본다.
  runtime.getChat('chat-A').localLore.push(clone(concurrentGcMemory));
  try {
    const gcScope = exports.LibraDataStorage?.scopeKeyFor?.(runtime.state.character, runtime.getChat('chat-A'));
    const shadow = exports.LibraDataStorage?.getShadowEntries?.(gcScope) || [];
    exports.LibraDataStorage?.save?.(runtime.state.character, runtime.getChat('chat-A'), [...shadow, clone(concurrentGcMemory)]);
  } catch (_) {}
  runtime.setActive(1);
  await sleep(950);
  exports.MemoryEngine.incrementalGC = originalIncrementalGc;
  const chatAAfterGc = loreOf('chat-A');
  const chatBAfterGc = JSON.stringify(runtime.getChat('chat-B').localLore);
  record('deferred_gc_resolves_fresh_captured_target', gcScheduled === true && chatAAfterGc.includes('MEMORY_COMMITTED_BEFORE_DEFERRED_GC'), {
    scheduled: gcScheduled,
    concurrentMemoryPreserved: chatAAfterGc.includes('MEMORY_COMMITTED_BEFORE_DEFERRED_GC')
  });
  record('deferred_gc_does_not_mutate_visible_other_chat', chatBAfterGc === chatBBeforeGc);

  const baseMemory = memoryEntry('memory-gui-base', 'GUI_BASE_MEMORY', 11, 'gui_base_turn');
  const concurrentMemoryForGui = memoryEntry('memory-gui-concurrent', 'GUI_CONCURRENT_MEMORY', 12, 'gui_concurrent_turn');
  const baseAuthor = jsonEntry('lmai_story_author', 'story-author', { currentArc: 'BASE_ARC', lastPlanTurn: 11 });
  const latestAuthor = jsonEntry('lmai_story_author', 'story-author', { currentArc: 'LATEST_RUNTIME_ARC', lastPlanTurn: 12 });
  const userAuthor = jsonEntry('lmai_story_author', 'story-author', { currentArc: 'USER_EDITED_ARC', lastPlanTurn: 12 });
  const mergeHelper = exports.mergeConcurrentLibraManagedLore;
  const concurrentMerge = mergeHelper([clone(baseMemory), clone(baseAuthor)], [clone(baseMemory), clone(concurrentMemoryForGui), clone(latestAuthor)], [clone(baseMemory), clone(baseAuthor)]);
  const concurrentMergeText = JSON.stringify(concurrentMerge.lore);
  record('gui_three_way_merge_preserves_unseen_concurrent_memory', concurrentMergeText.includes('GUI_CONCURRENT_MEMORY'));
  record('gui_three_way_merge_refreshes_untouched_runtime_record', concurrentMergeText.includes('LATEST_RUNTIME_ARC') && !concurrentMergeText.includes('BASE_ARC'));
  const deletionMerge = mergeHelper([], [clone(baseMemory)], [clone(baseMemory)]);
  record('gui_three_way_merge_respects_explicit_user_deletion', deletionMerge.lore.length === 0);
  const conflictMerge = mergeHelper([clone(userAuthor)], [clone(latestAuthor)], [clone(baseAuthor)]);
  const conflictMergeText = JSON.stringify(conflictMerge.lore);
  record('gui_three_way_merge_keeps_explicit_user_edit_on_conflict', conflictMergeText.includes('USER_EDITED_ARC') && !conflictMergeText.includes('LATEST_RUNTIME_ARC'));

  runtime.setActive(0);
  const purgeTarget = runtime.getChat('chat-A');
  purgeTarget.localLore.push({ key: 'external-lore', comment: 'external_lore', content: 'EXTERNAL_LORE_SURVIVES_PURGE', mode: 'normal' });
  purgeTarget.localLore.push(memoryEntry('purge-managed-memory', 'PURGE_THIS_MANAGED_MEMORY', 13, 'purge_managed_turn'));
  const chatBBeforePurge = JSON.stringify(runtime.getChat('chat-B'));
  let purgeReadCount = 0;
  runtime.state.onGetCharacter = async state => {
    purgeReadCount += 1;
    if (purgeReadCount === 2) {
      const currentA = state.character.chats.find(item => item.id === 'chat-A');
      currentA.message.push({ id: 'concurrent-host-message', role: 'assistant', data: 'CONCURRENT_HOST_MESSAGE_SURVIVES_PURGE' });
    }
  };
  const purgeResult = await exports.purgeLibraManagedLoreForActiveChat(purgeTarget, { purgeGlobal: true });
  runtime.state.onGetCharacter = null;
  const purgedA = runtime.getChat('chat-A');
  const purgedAText = JSON.stringify(purgedA);
  record('purge_rebases_on_latest_character_snapshot', purgeResult?.ok === true && purgedAText.includes('CONCURRENT_HOST_MESSAGE_SURVIVES_PURGE'));
  record('purge_removes_managed_and_preserves_external_lore', !purgedAText.includes('PURGE_THIS_MANAGED_MEMORY') && purgedAText.includes('EXTERNAL_LORE_SURVIVES_PURGE'));
  record('purge_does_not_mutate_other_chat', JSON.stringify(runtime.getChat('chat-B')) === chatBBeforePurge);

  await runtime.close();
}

async function seedTransitionLore(runtime) {
  const { exports } = runtime;
  const source = runtime.getChat('session-source');
  const oldScope = exports.getChatRuntimeScopeKey(source, runtime.state.character);
  exports.MemoryState._activeChatId = source.id;
  exports.MemoryState._activeScopeKey = oldScope;
  exports.MemoryEngine.setTurn(5);
  const lore = [];

  exports.NarrativeTracker.resetState(narrativeSentinel('NARRATIVE_HISTORY_SENTINEL', 5));
  await exports.NarrativeTracker.saveState(lore);
  exports.WorldStateTracker.resetState(worldStateSentinel('WORLD_HISTORY_SENTINEL', 5));
  await exports.WorldStateTracker.saveState(lore);
  exports.StoryAuthor.resetState({
    currentArc: 'STORY_AUTHOR_SENTINEL', narrativeGoal: 'Preserve the inherited arc.',
    activeTensions: ['STORY_AUTHOR_SENTINEL'], nextBeats: ['Continue the observatory clue.'],
    focusCharacters: ['Ariel'], lastPlanTurn: 5, lastUpdated: Date.now()
  });
  await exports.StoryAuthor.saveState(lore);
  exports.Director.resetState({
    sceneMandate: 'DIRECTOR_SENTINEL', requiredOutcomes: ['Preserve continuity.'],
    focusCharacters: ['Ariel'], lastDirectiveTurn: 5, lastUpdated: Date.now()
  });
  await exports.Director.saveState(lore);
  exports.WorldAdditionalCore.resetState({
    scopeKey: oldScope,
    chatId: source.id,
    sceneInterventions: makeWorldAdditionalPayload('WORLD_ADDITIONAL_SENTINEL').sceneInterventions,
    worldDeltas: [], characterAdditions: [], activeDirectives: [], manifestationLog: [],
    lastTurn: 5, lastUpdated: Date.now()
  });
  await exports.WorldAdditionalCore.saveState(lore);

  lore.push(memoryEntry('memory-before-transition', 'MEMORY_BEFORE_TRANSITION', 5));
  lore.push(jsonEntry('lmai_entity', 'ENTITY_SENTINEL', { name: 'Ariel', role: 'observer' }));
  lore.push(jsonEntry('lmai_relation', 'RELATION_SENTINEL', { entityA: 'Ariel', entityB: 'Dohyun', type: 'trust' }));
  lore.push(jsonEntry('lmai_char_states', 'CHAR_STATE_SENTINEL', { turnLog: { Ariel: [{ turn: 5, notes: 'CHAR_STATE_SENTINEL' }] } }));
  lore.push(jsonEntry('lmai_rp_longterm', 'RP_LONGTERM_SENTINEL', { stableFacts: [{ summary: 'RP_LONGTERM_SENTINEL' }] }));
  lore.push({ key: 'world-graph-transition', comment: 'lmai_world_graph', content: JSON.stringify(worldGraphSentinel('WORLD_GRAPH_SENTINEL')), mode: 'normal', insertorder: 5, alwaysActive: false });
  lore.push(jsonEntry('lmai_entity_knowledge_vault', 'ENTITY_VAULT_SENTINEL', { entities: {} }));
  lore.push(jsonEntry('lmai_time_engine', 'TIME_ENGINE_SENTINEL', { currentTime: 'T5', events: [] }));
  lore.push(jsonEntry('lmai_secret_knowledge', 'SECRET_KNOWLEDGE_SENTINEL', { records: [] }));
  lore.push(jsonEntry('lmai_character_lore_cues', 'CHARACTER_LORE_CUE_SENTINEL', { cues: [] }));
  lore.push(jsonEntry('lmai_integrated_packet_journal', 'PACKET_JOURNAL_SENTINEL', { records: [] }));
  lore.push(jsonEntry('lmai_recall_feedback', 'RECALL_FEEDBACK_SENTINEL', { records: [] }));
  lore.push(jsonEntry('lmai_user', 'USER_DB_SENTINEL', { name: 'Test User' }));
  lore.push(jsonEntry('lmai_hypa_v3_source', 'HYPA_SOURCE_SENTINEL', { source: 'test' }));
  // Live source chats have a scoped WAL. It is deliberately excluded from
  // session inheritance and must not leak back through the active shadow.
  lore.push(jsonEntry('lmai_turn_records', 'SOURCE_WAL_SENTINEL', {
    scopeKey: oldScope, chatId: source.id, records: []
  }));

  exports.MemoryEngine.setLorebook(runtime.state.character, source, lore);
  const seeded = await exports.LibraDataStorage.save(runtime.state.character, source, lore);
  if (!seeded.ok) throw new Error('known transition source was not persisted');
  // This is a legacy/external inherited comment and therefore must be appended
  // after setLorebook, whose managed-write API intentionally filters non-lmai.
  source.localLore.push(jsonEntry('hypa_v3_import', 'HYPA_IMPORT_SENTINEL', { source: 'test' }));
  return { source, oldScope };
}

async function testRejectedTransitionSource() {
  const runtime = await createRuntime([chat('unowned-source', [memoryEntry('unowned', 'UNOWNED_SENTINEL', 1)])]);
  const before = JSON.stringify(runtime.state.character);
  const result = await runtime.exports.TransitionManager.executeTransition();
  record('transition_refuses_unowned_source_without_creating_an_empty_successor', result === false && JSON.stringify(runtime.state.character) === before);
  await runtime.close();
}

async function testTransitionAtomicityAndInheritance() {
  const runtime = await createRuntime([chat('session-source')], { characterId: 'char-transition-regression' });
  const { exports } = runtime;
  const { source, oldScope } = await seedTransitionLore(runtime);
  const sourceChatCount = runtime.state.character.chats.length;
  const sourceSetCharacterCalls = runtime.state.setCharacterCalls;
  const sourceIndexedCharacterCalls = runtime.state.setCharacterToIndexCalls;
  const sourceDirectCharacterCalls = runtime.state.setCharacterDirectCalls;

  exports.LLMProvider.call = async () => ({
    content: 'Ariel and Dohyun are continuing the observatory investigation.',
    usage: { prompt_tokens: 10, completion_tokens: 10 }, serviceTier: ''
  });
  const busyToken = exports.ScopedRuntimeTransaction.begin(oldScope, 'afterrequest-test-busy');
  const busyStarted = performance.now();
  const busyResult = await exports.TransitionManager.executeTransition();
  const busyElapsed = performance.now() - busyStarted;
  record('transition_rejects_while_scoped_runtime_transaction_is_busy', busyResult === false && busyElapsed >= 1800, {
    result: busyResult, elapsedMs: Math.round(busyElapsed)
  });
  record('busy_transition_is_atomic_and_keeps_owner_token',
    runtime.state.character.chats.length === sourceChatCount
      && runtime.state.setCharacterCalls === sourceSetCharacterCalls
      && exports.ScopedRuntimeTransaction.owns(busyToken), {
      chatCount: runtime.state.character.chats.length,
      setCharacterCalls: runtime.state.setCharacterCalls,
      token: exports.ScopedRuntimeTransaction.current()
    });
  exports.ScopedRuntimeTransaction.end(busyToken);

  let committedDuringSummary = false;
  exports.LLMProvider.call = async (_config, _system, _user, options = {}) => {
    if (/transition-summary/i.test(String(options?.label || '')) && !committedDuringSummary) {
      committedDuringSummary = true;
      const latestSource = runtime.getChat('session-source');
      latestSource.localLore.push(memoryEntry(
        'memory-committed-during-transition-summary',
        'MEMORY_COMMITTED_DURING_TRANSITION_SUMMARY',
        6,
        'concurrent_transition_summary'
      ));
    }
    return {
      content: 'Ariel and Dohyun are continuing the observatory investigation.',
      usage: { prompt_tokens: 10, completion_tokens: 10 }, serviceTier: ''
    };
  };
  const transitionResult = await exports.TransitionManager.executeTransition();
  const destination = runtime.state.character.chats[0];
  const destinationLore = exports.MemoryEngine.getLorebook(runtime.state.character, destination);
  const destinationText = JSON.stringify(destinationLore);
  record('transition_creates_exactly_one_new_session', transitionResult === true
    && destination.id !== source.id
    && runtime.state.character.chats.length === sourceChatCount + 1, {
    result: transitionResult, sourceId: source.id, destinationId: destination.id,
    chatCount: runtime.state.character.chats.length
  });
  record('transition_commits_with_indexed_character_writer',
    runtime.state.setCharacterToIndexCalls === sourceIndexedCharacterCalls + 1
      && runtime.state.setCharacterDirectCalls === sourceDirectCharacterCalls, {
      indexedCalls: runtime.state.setCharacterToIndexCalls,
      directCalls: runtime.state.setCharacterDirectCalls
    });

  const inheritedMarkers = [
    'ENTITY_SENTINEL', 'RELATION_SENTINEL', 'NARRATIVE_HISTORY_SENTINEL', 'CHAR_STATE_SENTINEL',
    'WORLD_HISTORY_SENTINEL', 'MEMORY_BEFORE_TRANSITION', 'RP_LONGTERM_SENTINEL',
    'STORY_AUTHOR_SENTINEL', 'DIRECTOR_SENTINEL', 'WORLD_ADDITIONAL_SENTINEL',
    'WORLD_GRAPH_SENTINEL', 'ENTITY_VAULT_SENTINEL', 'TIME_ENGINE_SENTINEL',
    'SECRET_KNOWLEDGE_SENTINEL', 'CHARACTER_LORE_CUE_SENTINEL', 'PACKET_JOURNAL_SENTINEL',
    'RECALL_FEEDBACK_SENTINEL', 'USER_DB_SENTINEL', 'HYPA_SOURCE_SENTINEL', 'HYPA_IMPORT_SENTINEL'
  ];
  const missingMarkers = inheritedMarkers.filter(marker => !destinationText.includes(marker));
  record('transition_preserves_all_canonical_independent_databases', missingMarkers.length === 0, { missingMarkers });
  record('transition_rereads_latest_lore_after_summary_commit', destinationText.includes('MEMORY_COMMITTED_DURING_TRANSITION_SUMMARY'), {
    summaryCommitRan: committedDuringSummary
  });
  record('transition_adds_previous_scene_context_without_dropping_memory',
    destinationLore.filter(entry => entry?.comment === 'lmai_memory').length >= 3
      && destinationLore.some(entry => entry?.key === 'LIBRA_SCENE_CONTEXT'));

  const destinationAdmission = await exports.LibraDataStorage.preparePersonaContext(runtime.state.character, destination);
  record('transition_destination_is_admitted_from_durable_owned_data', destinationAdmission.ok === true, destinationAdmission.reason);
  const destinationStored = await exports.LibraDataStorage.readVerified(
    exports.LibraDataStorage.scopeKeyFor(runtime.state.character, destination)
  );
  record('transition_canonical_destination_excludes_source_wal', destinationStored.ok === true
    && !destinationStored.entries.some(entry => entry.comment === 'lmai_turn_records')
    && !JSON.stringify(destinationStored.entries).includes('SOURCE_WAL_SENTINEL'));
  const sourceStored = await exports.LibraDataStorage.readVerified(
    exports.LibraDataStorage.scopeKeyFor(runtime.state.character, source)
  );
  record('transition_keeps_source_wal_in_its_original_scope', sourceStored.ok === true
    && JSON.stringify(sourceStored.entries).includes('SOURCE_WAL_SENTINEL'));
  const fresh = await createRuntime(runtime.state.character.chats, {
    characterId: 'char-transition-regression', storage: new Map(runtime.state.storage)
  });
  try {
    const freshDestination = fresh.getChat(destination.id);
    const freshAdmission = await fresh.exports.LibraDataStorage.preparePersonaContext(fresh.state.character, freshDestination);
    const freshText = JSON.stringify(fresh.exports.MemoryEngine.getLorebook(fresh.state.character, freshDestination));
    record('fresh_runtime_reads_admitted_transition_canon_without_source_wal', freshAdmission.ok === true
      && freshText.includes('MEMORY_BEFORE_TRANSITION')
      && freshText.includes('STORY_AUTHOR_SENTINEL')
      && !freshText.includes('SOURCE_WAL_SENTINEL'), freshAdmission.reason);
  } finally { await fresh.close(); }
  const newScope = exports.getChatRuntimeScopeKey(destination, runtime.state.character);
  const parseEntry = comment => {
    const entry = destinationLore.find(item => item?.comment === comment);
    try { return JSON.parse(entry?.content || '{}'); } catch (_) { return {}; }
  };
  const narrativeAfterTransition = parseEntry('lmai_narrative');
  const worldAfterTransition = parseEntry('lmai_world_states');
  const narrativeIntegrity = exports.IntegrityMetaManager.validateIntegrityMeta(narrativeAfterTransition, {
    domain: 'narrative', recordId: 'narrative_state', scopeKey: newScope
  });
  const worldIntegrity = exports.IntegrityMetaManager.validateIntegrityMeta(worldAfterTransition, {
    domain: 'world', recordId: 'world_state', scopeKey: newScope
  });
  record('transition_rescopes_narrative_and_world_integrity', oldScope !== newScope
    && narrativeAfterTransition?.meta?.integrity?.scopeKey === newScope
    && worldAfterTransition?.meta?.integrity?.scopeKey === newScope
    && narrativeIntegrity.ok === true
    && worldIntegrity.ok === true, {
    oldScope, newScope,
    narrativeScope: narrativeAfterTransition?.meta?.integrity?.scopeKey,
    worldScope: worldAfterTransition?.meta?.integrity?.scopeKey,
    narrativeIntegrity, worldIntegrity
  });

  // Continue one deterministic turn through the real trackers. The inherited
  // histories must remain present after their next save and integrity rewrite.
  exports.MemoryEngine.setTurn(6);
  exports.NarrativeTracker.loadState(destinationLore);
  await exports.NarrativeTracker.recordTurn(
    6,
    'Dohyun checks the inherited observatory clue.',
    'Ariel confirms the inherited clue and records a new canonical observation.',
    ['Ariel', 'Dohyun'],
    { ...exports.MemoryEngine.CONFIG, useLLM: false, llm: { provider: 'none', key: '', url: '', model: '' } },
    {
      chatId: destination.id,
      sourceMessageIds: ['continued-assistant-6'],
      sourceHash: 'continued-hash-6',
      aiHash: 'continued-hash-6',
      responseHash: 'continued-hash-6',
      userTurnKey: 'continued-user-6',
      turnKey: 'continued-turn-6',
      turnAnchorTurn: 6,
      turnLocked: true
    }
  );
  await exports.NarrativeTracker.saveState(destinationLore);
  exports.WorldStateTracker.loadState(destinationLore);
  exports.WorldStateTracker.recordState(6, {
    activePath: ['world-main'],
    rules: { inheritedRule: 'WORLD_HISTORY_SENTINEL' },
    classification: 'continued scope regression world',
    worldSummary: 'WORLD_HISTORY_SENTINEL remains canonical.',
    currentTime: 'T6',
    currentLocation: 'Continued Observatory',
    currentScene: 'Ariel records a new observation.',
    activeEvents: ['CONTINUED_WORLD_EVENT'],
    offscreenThreads: [],
    ruleHighlights: ['WORLD_HISTORY_SENTINEL'],
    notes: 'CONTINUED_WORLD_TURN'
  });
  await exports.WorldStateTracker.saveState(destinationLore);
  exports.MemoryEngine.setLorebook(runtime.state.character, destination, destinationLore);

  const savedLore = exports.MemoryEngine.getLorebook(runtime.state.character, destination);
  const savedNarrativeEntry = savedLore.find(item => item?.comment === 'lmai_narrative');
  let savedNarrativeRaw = {};
  try { savedNarrativeRaw = JSON.parse(savedNarrativeEntry?.content || '{}'); } catch (_) {}
  const savedNarrativeIntegrity = exports.IntegrityMetaManager.validateIntegrityMeta(savedNarrativeRaw, {
    domain: 'narrative', recordId: 'narrative_state', scopeKey: newScope
  });
  exports.NarrativeTracker.loadState(savedLore);
  exports.WorldStateTracker.loadState(savedLore);
  const continuedNarrative = clone(exports.NarrativeTracker.getState());
  const continuedWorld = clone(exports.WorldStateTracker.getState());
  record('continued_turn_preserves_inherited_narrative_history',
    JSON.stringify(continuedNarrative).includes('NARRATIVE_HISTORY_SENTINEL')
      && continuedNarrative.turnLog.some(item => Number(item?.turn || 0) === 5)
      && continuedNarrative.turnLog.some(item => Number(item?.turn || 0) === 6), {
    turns: continuedNarrative.turnLog.map(item => item?.turn),
    storylines: continuedNarrative.storylines.map(item => item?.name),
    savedTurns: Array.isArray(savedNarrativeRaw?.turnLog) ? savedNarrativeRaw.turnLog.map(item => item?.turn) : [],
    savedStorylines: Array.isArray(savedNarrativeRaw?.storylines) ? savedNarrativeRaw.storylines.map(item => item?.name) : [],
    savedNarrativeIntegrity
  });
  record('continued_turn_preserves_inherited_world_history',
    JSON.stringify(continuedWorld).includes('WORLD_HISTORY_SENTINEL')
      && continuedWorld.turnLog.some(item => Number(item?.turn || 0) === 5)
      && continuedWorld.turnLog.some(item => Number(item?.turn || 0) === 6), {
    turns: continuedWorld.turnLog.map(item => item?.turn),
    locations: continuedWorld.turnLog.map(item => item?.currentLocation)
  });

  // ── ★ 재진입(겹친 호출) 방어 — 감사 G2 ──
  //   확인 대화상자 → `await executeTransition()` 사이에 취소 경로도 플래그도 없었다.
  //   실측: 두 번 통과하면 `_generateUUID()` 로 새 채팅이 **두 개** 생기고 상속 데이터가 두 벌이 된다.
  //   정본(RETRACE `transferId`·`resumed:attempt>1`·HandoffJournal)의 취지 = 재시도 안전성.
  {
    const reentryChatsBefore = runtime.state.character.chats.length;
    const reentryWritesBefore = runtime.state.setCharacterCalls;
    // ★ 요약 LLM 으로 붙잡으면 안 된다 — 이 픽스처의 채팅에는 메시지가 없어
    //   `lastMsgs.length === 0` 이면 요약 호출 자체가 **생략**된다(첫 시도가 그래서 즉시 끝났다).
    //   executeTransition 이 **항상** 지나는 지점(`resolveActiveChatContext` → `getCharacter`)에서 붙잡는다.
    let releaseFirst = null;
    const firstPending = new Promise(resolve => { releaseFirst = resolve; });
    let held = false;
    runtime.state.onGetCharacter = async () => {
      if (!held) { held = true; await firstPending; }
    };

    const inflight = exports.TransitionManager.executeTransition();
    await sleep(50);   // 첫 호출이 가드를 세우고 getCharacter 에서 멈춰 있는 동안
    const inflightFlag = exports.TransitionManager.transitionInFlight();
    const second = await exports.TransitionManager.executeTransition();
    const blockedReason = exports.TransitionManager.lastBlockedReason();

    record('concurrent_transition_is_rejected_while_one_is_in_flight',
      second === false && blockedReason === 'transition_already_in_flight' && inflightFlag === true, {
      result: second, flagDuringFirst: inflightFlag, blockedReason,
      note: '겹친 호출은 조용히 거부되어야 한다(부분 상태를 만들지 않는다)'
    });

    runtime.state.onGetCharacter = null;
    releaseFirst();
    const firstResult = await inflight;
    const settledFlag = exports.TransitionManager.transitionInFlight();
    record('rejected_transition_does_not_create_a_second_session',
      firstResult === true
        && runtime.state.character.chats.length === reentryChatsBefore + 1
        && runtime.state.setCharacterCalls === reentryWritesBefore + 1, {
      firstResult, chatsBefore: reentryChatsBefore, chatsAfter: runtime.state.character.chats.length,
      writesBefore: reentryWritesBefore, writesAfter: runtime.state.setCharacterCalls,
      note: '★ 두 번 통과하면 새 채팅이 두 개 생긴다 — 거부가 실제로 막아야 한다'
    });
    record('transition_inflight_flag_clears_after_settlement',
      settledFlag === false, { flag: settledFlag,
      note: '★ 예외·거부 뒤에도 해제되어야 한다 — 안 하면 전환이 영구히 막힌다' });
  }

  await runtime.close();
}

(async () => {
  if (!fs.existsSync(DIST)) throw new Error(`built plugin not found: ${DIST}`);
  await testColdScopeRace();
  await testRejectedTransitionSource();
  await testTransitionAtomicityAndInheritance();
  const failed = checks.filter(item => !item.ok);
  const report = {
    ok: failed.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    failed: failed.map(item => item.name)
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
})().catch(error => {
  const report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    checks,
    failed: checks.filter(item => !item.ok).map(item => item.name),
    error: String(error?.stack || error)
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2), 'utf8');
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
});
