'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const installedVersion = name => {
  const text = fs.readFileSync(path.join(root, 'plugins', name), 'utf8');
  const version = text.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1];
  assert.ok(version, name + ' installation header');
  return version;
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await wait(10);
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
    async keys() { return Array.from(values.keys()); },
    async key(index) { return Array.from(values.keys())[index] ?? null; },
    async length() { return values.size; },
    async clear() { values.clear(); return true; }
  };
};

(async () => {
  const listeners = new Map();
  const unloadHandlers = [];
  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  const pluginStorage = createStore();
  const localStorage = createStore();
  const chat = { id: 'native-owner-chat', chatId: 'native-owner-chat', name: 'Native owner', message: [], messages: [], bindedPersona: '' };
  const character = { id: 'native-owner-character', chaId: 'native-owner-character', name: 'Native owner', chats: [chat], chatPage: 0 };
  const requestChannels = new Set(['hayaku_memory_bridge_request_v1']);
  const responseSenders = Object.freeze({ hayaku_memory_bridge_response_v1: 'hayaku_locator_continuity' });
  let llmCalls = 0;

  const trackedSetTimeout = (handler, delay, ...args) => {
    let timer = null;
    timer = setTimeout((...innerArgs) => {
      activeTimeouts.delete(timer);
      handler(...innerArgs);
    }, delay, ...args);
    activeTimeouts.add(timer);
    return timer;
  };
  const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
  const trackedSetInterval = (handler, delay, ...args) => {
    const timer = setInterval(handler, delay, ...args);
    activeIntervals.add(timer);
    return timer;
  };
  const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
  const addListener = (channel, handler) => {
    const key = String(channel);
    const rows = listeners.get(key) || new Set();
    rows.add(handler);
    listeners.set(key, rows);
    return true;
  };
  const removeListener = (channel, handler) => {
    const rows = listeners.get(String(channel));
    if (!rows) return false;
    rows.delete(handler);
    return true;
  };

  const host = {
    pluginStorage,
    safeLocalStorage: localStorage,
    async getLocalPluginStorage() { return localStorage; },
    async getArgument(name) {
      const key = String(name);
      if (key.includes('memory_suite_server_mode')) return 'plugin_only';
      if (key.includes('enable_gui')) return 'false';
      if (key === 'hayaku_enabled') return 'true';
      if (key === 'hayaku_native_auto_repair') return 'false';
      if (key === 'retrace_hayaku_auto_repair') return 'true';
      return '';
    },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument() { return true; },
    async requestPluginPermission() { return true; },
    async nativeFetch() { throw new Error('fixture_offline'); },
    async addPluginChannelListener(channel, handler) { return addListener(channel, handler); },
    async removePluginChannelListener(channel, handler) { return removeListener(channel, handler); },
    async removePluginChannelHandler(channel, handler) { return removeListener(channel, handler); },
    async offPluginChannelMessage(channel, handler) { return removeListener(channel, handler); },
    async postPluginChannelMessage(_target, channel, message) {
      const key = String(channel);
      const sender = responseSenders[key] || (requestChannels.has(key) ? 'flashback_hayaku_bridge' : '');
      for (const handler of Array.from(listeners.get(key) || [])) {
        await handler(message, { sender });
      }
      return true;
    },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async addRisuChatListener() { return true; },
    async removeRisuChatListener() { return true; },
    async registerBodyIntercepter() { return 'fixture-interceptor'; },
    async unregisterBodyIntercepter() { return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async unregisterUIPart() { return true; },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return character; },
    async getChar() { return character; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
    async getDatabase(fields) {
      const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
      if (!Array.isArray(fields)) return all;
      return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
    },
    async setDatabase() { return true; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'node', saveMethod: 'local' }; },
    async runLLMModel() { llmCalls += 1; throw new Error('RE:TRACE must not invoke provider for native HAYAKU'); }
  };

  const context = vm.createContext({
    risuai: host,
    Risuai: host,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
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
    alert() {},
    prompt: () => null
  });

  try {
    for (const file of ['HAYAKU_Locator_Continuity.js', 'RETRACE.js']) {
      const source = fs.readFileSync(path.join(root, 'plugins', file), 'utf8');
      vm.runInContext(source, context, { filename: file });
    }

    const hayaku = await waitFor(() => context.HAYAKU, 'HAYAKU public API');
    const retrace = await waitFor(() => context.__RETRACE, 'RE:TRACE public API');
    await waitFor(() => (listeners.get('hayaku_memory_bridge_request_v1')?.size || 0) > 0, 'HAYAKU owner request listener');
    await waitFor(() => (listeners.get('hayaku_memory_bridge_response_v1')?.size || 0) > 0, 'RE:TRACE response listener');

    assert.match(hayaku.version, /^3\./, 'current HAYAKU major remains the native recovery owner');
    assert.equal(retrace.version, installedVersion('RETRACE.js')); 

    const gate = await retrace._test.probeLiveHayakuOwner({ force: true, timeoutMs: 3000 });
    assert.equal(gate.ready, true, 'authenticated HAYAKU owner is available');
    for (const removed of [
      'hayakuNativeRecoveryCapabilities', 'hayakuNativeRepairSupported',
      'hayakuNativeColdStartSupported', 'requestHayakuNativeRecoveryStatus',
      'runHayakuAutoRepairSweep', 'scheduleHayakuAutoRepairSweep',
      'delegateHayakuNativeRepair', 'delegateHayakuNativeColdStart', 'callProfile'
    ]) assert.equal(removed in retrace._test, false, `RE:TRACE recovery/provider API removed: ${removed}`);
    assert.equal(llmCalls, 0, 'RE:TRACE owner probe does not invoke a provider/LLM worker');

    await wait(40);
    assert.equal(llmCalls, 0, 'RE:TRACE schedules no delayed recovery/provider call');
  } finally {
    for (const handler of unloadHandlers.reverse()) {
      try { await handler(); } catch (_) {}
    }
    for (const timer of activeTimeouts) clearTimeout(timer);
    for (const timer of activeIntervals) clearInterval(timer);
    activeTimeouts.clear();
    activeIntervals.clear();
  }

  console.log('PASS retrace_hayaku_native_owner_deference_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
