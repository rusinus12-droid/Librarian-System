'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const waitFor = async (predicate, label, timeoutMs = 15000, publicationTime = null) => {
  const started = Date.now();
  const timely = value => {
    if (!value) return false;
    if (typeof publicationTime !== 'function') return true;
    const publishedAt = publicationTime(value);
    return Number.isFinite(publishedAt) && publishedAt <= started + timeoutMs;
  };
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (timely(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // A busy plugin can delay the poll beyond the deadline after publishing its
  // API on time. Only its recorded publication time may admit that late poll.
  if (typeof publicationTime === 'function') {
    const value = predicate();
    if (timely(value)) return value;
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const createStore = () => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async clear() { values.clear(); return true; },
    async key(index) { return Array.from(values.keys())[Number(index)] ?? null; },
    async keys() { return Array.from(values.keys()); },
    async length() { return values.size; }
  };
};

const createValidPacket = (overrides = {}) => {
  const turn = Math.max(1, Number(overrides.turn || 1) || 1);
  const subject = String(overrides.subject || `Alice-${turn}`);
  const scene = String(overrides.scene || `scene-${turn}`);
  const summary = String(overrides.summary || `${subject} completed the established event for turn ${turn}.`);
  return {
    meta: {
      schema: 'hayaku_packet_v1',
      packet_type: String(overrides.packetType || 'current_snapshot'),
      packet_schema_rev: 2,
      scene_id: scene,
      turn_anchor: summary,
      confidence: 0.82,
      summary_memory: {
        summary,
        recallAnchors: [subject, scene],
        recallAliases: { en: [summary] },
        canonicalAnchors: [`person:${subject}`, `event:turn_${turn}`, `place:${scene}`],
        mentionedEntityNames: [subject],
        directEvidenceSnippets: [summary],
        related_refs: [],
        confidence: 0.82
      }
    },
    entity: {
      characters: [{ name: subject, current_state: `state-${turn}` }],
      relations: [],
      pov_memories: [],
      secrets: []
    },
    world: {
      location: scene,
      time: `turn-${turn}`,
      scene,
      weather: '',
      active_events: [{ summary }],
      historical_events: [],
      world_rules: [],
      offscreen_threads: [],
      factions: [],
      regions: []
    },
    narrative: {
      scene_phase: 'active',
      current_arc: `arc-${turn}`,
      pacing: 'steady',
      conflict_traces: [],
      scene_deltas: [{ summary }],
      theme_motifs: [],
      critical_dialogue: []
    },
    planner: {
      continuity_locks: [{ summary: `${subject} remains associated with ${scene}.` }],
      do_not_resolve_yet: [],
      consequence_ledger: [],
      payoff_tracker: [],
      open_invitations: []
    },
    importance: { overall: 0.72, reason: [`turn ${turn} evidence`] }
  };
};

const hiddenPacketMessage = (visibleText, packet) => (
  `${String(visibleText || '').trim()}\n<!-- HAYAKU_STATE_PACKET_START ${JSON.stringify(packet)} HAYAKU_STATE_PACKET_END -->`
);

const createHayakuRuntime = async (options = {}) => {
  const pluginRoot = path.resolve(__dirname, '..', '..', 'plugins');
  const pluginStorage = options.pluginStorage || createStore();
  const safeLocalStorage = options.safeLocalStorage || createStore();
  const listeners = new Map();
  const unloadHandlers = [];
  const llmCalls = [];
  const fetchCalls = [];
  const argumentsMap = new Map(Object.entries({
    memory_suite_server_mode: 'plugin_only',
    hayaku_debug: 'false',
    hayaku_after_request_auto_repair: options.afterRequestAutoRepair === false ? 'false' : 'true',
    hayaku_background_auto_repair: (options.backgroundAutoRepair ?? options.autoRepair) === true ? 'true' : 'false',
    hayaku_native_auto_repair: options.autoRepair === true ? 'true' : 'false',
    hayaku_failed_recovery_automation: options.failedRecoveryAutomation || 'off',
    ...(options.arguments || {})
  }));
  const chat = {
    id: options.chatId || 'hayaku-runtime-chat',
    chatId: options.chatId || 'hayaku-runtime-chat',
    name: options.chatName || 'HAYAKU Runtime Test',
    message: Array.isArray(options.messages) ? options.messages : [],
    messages: Array.isArray(options.messages) ? options.messages : [],
    bindedPersona: ''
  };
  const character = {
    id: options.characterId || 'hayaku-runtime-character',
    chaId: options.characterId || 'hayaku-runtime-character',
    name: options.characterName || 'HAYAKU Runtime Test',
    chatPage: 0,
    chats: [chat]
  };
  const addListener = (channel, handler) => {
    const key = String(channel);
    const rows = listeners.get(key) || new Set();
    rows.add(handler);
    listeners.set(key, rows);
    return { channel: key, handler };
  };
  const removeListener = (channel, handler) => {
    const rows = listeners.get(String(channel));
    if (!rows) return false;
    rows.delete(handler);
    return true;
  };

  let llmResponder = typeof options.llmResponder === 'function'
    ? options.llmResponder
    : async () => ({ type: 'success', result: JSON.stringify(createValidPacket()) });

  // Registered replacers, keyed by mode. The real RisuAI host hands beforeRequest/afterRequest
  // handlers to the plugin and calls them around a model request; this fixture used to accept
  // addRisuReplacer and DISCARD the handler, so no test could ever reach the real hook (the same
  // defect the LIBRA fixture had to fix to drive its pipeline). Storing them makes
  // `runtime.replacers.beforeRequest(messages, type)` the real entry point.
  const replacers = new Map();
  const chatListeners = new Map();

  const host = {
    pluginStorage,
    safeLocalStorage,
    listeners,
    unloadHandlers,
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) { return argumentsMap.get(String(name)) ?? ''; },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument(name, value) { argumentsMap.set(String(name), value); return true; },
    async setArg(name, value) { return await host.setArgument(name, value); },
    async nativeFetch(url, fetchOptions = {}) {
      fetchCalls.push({ url: String(url), options: fetchOptions });
      if (typeof options.nativeFetch === 'function') return await options.nativeFetch(url, fetchOptions);
      throw new Error('fixture_native_fetch_unavailable');
    },
    async runLLMModel(callOptions) {
      llmCalls.push(callOptions);
      return await llmResponder(callOptions, llmCalls.length);
    },
    async addPluginChannelListener(channel, handler) { return addListener(channel, handler); },
    async removePluginChannelListener(channel, handler) { return removeListener(channel, handler); },
    async unregisterPluginChannelListener(channel, handler) { return removeListener(channel, handler); },
    async postPluginChannelMessage(target, channel, message) {
      const targetId = String(target || '');
      // The real RisuAI host supplies the calling plugin identity. The fixture
      // shares one host object between HAYAKU and RE:TRACE, so infer the sender
      // from the destination to preserve the authenticated IPC contract.
      const sender = targetId === 'hayaku_locator_continuity'
        ? 'flashback_hayaku_bridge'
        : (targetId === 'flashback_hayaku_bridge' ? 'hayaku_locator_continuity' : 'fixture_plugin');
      for (const handler of Array.from(listeners.get(String(channel)) || [])) {
        await handler(message, { sender });
      }
      return true;
    },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async unregisterSetting() { return true; },
    async unregisterButton() { return true; },
    async unregisterUIPart() { return true; },
    async addRisuReplacer(mode, handler) {
      // Store the handler so tests can invoke the REAL hook. Returning true without keeping it (the
      // previous behaviour) made every hook-level claim unverifiable.
      const key = String(mode || '');
      if (key) replacers.set(key, handler);
      return true;
    },
    async removeRisuReplacer(mode) { replacers.delete(String(mode || '')); return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async addRisuChatListener(mode, handler) { chatListeners.set(String(mode), handler); return true; },
    async removeRisuChatListener(mode) { chatListeners.delete(String(mode)); return true; },
    async registerBodyIntercepter() { return 'body-interceptor-fixture'; },
    async unregisterBodyIntercepter() { return true; },
    async getDatabase(fields) {
      const all = {
        characters: [character],
        personas: [],
        selectedPersona: '',
        plugins: [],
        maxContext: 128000,
        maxResponse: 8192
      };
      if (!Array.isArray(fields)) return all;
      return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
    },
    async setDatabase() { return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return character; },
    async getChar() { return character; },
    async getCharacterFromIndex() { return character; },
    async getChat() { return chat; },
    async getCurrentChat() { return chat; },
    async getChatFromIndex() { return chat; },
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'web', saveMethod: 'local' }; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getRootDocument() { return null; },
    async getRootContainer() { return null; },
    async getPluginRoot() { return null; }
  };

  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  const trackedSetTimeout = (handler, delay, ...args) => {
    let timer = null;
    timer = setTimeout((...innerArgs) => {
      activeTimeouts.delete(timer);
      handler(...innerArgs);
    }, delay, ...args);
    activeTimeouts.add(timer);
    return timer;
  };
  const trackedClearTimeout = timer => {
    activeTimeouts.delete(timer);
    clearTimeout(timer);
  };
  const trackedSetInterval = (handler, delay, ...args) => {
    const timer = setInterval(handler, delay, ...args);
    activeIntervals.add(timer);
    return timer;
  };
  const trackedClearInterval = timer => {
    activeIntervals.delete(timer);
    clearInterval(timer);
  };
  const quietConsole = options.console || { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const context = vm.createContext({
    risuai: host,
    Risuai: host,
    console: quietConsole,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
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
    confirm: () => false,
    alert: () => {},
    prompt: () => null
  });

  Object.assign(host, options.hostOverrides || {});
  const originalHayakuSource = fs.readFileSync(options.pluginSourceFile || path.join(pluginRoot, 'HAYAKU_Locator_Continuity.js'), 'utf8');
  const hayakuSource=typeof options.transformSource==='function'?options.transformSource(originalHayakuSource):originalHayakuSource;
  let publishedHayaku = null;
  let hayakuPublishedAt = null;
  Object.defineProperty(context, 'HAYAKU', {
    configurable: true,
    enumerable: true,
    get: () => publishedHayaku,
    set: value => {
      publishedHayaku = value;
      hayakuPublishedAt = value ? Date.now() : null;
    }
  });
  vm.runInContext(hayakuSource, context, { filename: 'HAYAKU_Locator_Continuity.js' });
  const hayaku = await waitFor(() => context.HAYAKU, 'HAYAKU public API', 15000,
    value => value === publishedHayaku ? hayakuPublishedAt : null);

  let retrace = null;
  if (options.loadRetrace === true) {
    if (typeof options.beforeRetraceLoad === 'function') await options.beforeRetraceLoad(host, context);
    const retraceSource = fs.readFileSync(path.join(pluginRoot, 'RETRACE.js'), 'utf8');
    vm.runInContext(retraceSource, context, { filename: 'RETRACE.js' });
    retrace = await waitFor(() => context.__RETRACE, 'RE:TRACE public API');
  }

  const setMessages = messages => {
    chat.message = Array.isArray(messages) ? messages : [];
    chat.messages = chat.message;
  };
  const setLlmResponder = responder => { llmResponder = responder; };
  const dispose = async () => {
    for (const handler of [...unloadHandlers].reverse()) {
      try { await handler(); } catch (_) {}
    }
    for (const timer of activeTimeouts) clearTimeout(timer);
    for (const timer of activeIntervals) clearInterval(timer);
    activeTimeouts.clear();
    activeIntervals.clear();
  };

  return {
    sourceSha256:require('node:crypto').createHash('sha256').update(hayakuSource).digest('hex'),
    context,
    host,
    hayaku,
    retrace,
    chat,
    character,
    pluginStorage,
    safeLocalStorage,
    llmCalls,
    fetchCalls,
    argumentsMap,
    setMessages,
    setLlmResponder,
    // The registered replacers, so a test can call the REAL hook the plugin registered.
    replacers,
    chatListeners,
    callChatOutput: async event => {
      const handler = chatListeners.get('output');
      if (typeof handler !== 'function') throw new Error('no output chat listener registered');
      return handler(event);
    },
    callBeforeRequest: (messages, type = 'model') => {
      const handler = replacers.get('beforeRequest');
      if (typeof handler !== 'function') throw new Error('no beforeRequest replacer registered');
      return handler(messages, type);
    },
    callAfterRequest: (response, type = 'model') => {
      const handler = replacers.get('afterRequest');
      if (typeof handler !== 'function') throw new Error('no afterRequest replacer registered');
      return handler(response, type);
    },
    dispose
  };
};

module.exports = {
  createStore,
  createValidPacket,
  hiddenPacketMessage,
  createHayakuRuntime,
  waitFor
};
