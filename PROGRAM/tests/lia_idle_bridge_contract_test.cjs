'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins', 'LIA_Persona_Linker.js'), 'utf8');

assert.match(source, releasePattern("\\/\\/@version\\s+{lia}\\b", ""), 'patched LIA version');
assert.doesNotMatch(source, /LIVE_SYNC_POLL_MS|PERSONA_PROOF_BADGE_REFRESH_MS/, 'legacy idle polling constants are removed');
assert.doesNotMatch(source, /liveSyncTimer|personaProofBadgeTimer/, 'legacy idle polling timer handles are removed');
assert.match(source, /reason: "manual_only"/, 'Live tracking is unconditionally retired');
assert.match(source, /async function handlePersonaProofAfterRequest\(content\) \{\s*return content;/, 'legacy proof callback is an inert identity');
assert.match(source, /__lia_persona_linker_runtime_v1__/, 'hot-reload singleton fence exists');
assert.match(source, /personaProofBadgeRenderKey === renderKey/, 'SafeDOM proof badge is diff-only');

const values = new Map();
const storageCounters = { get: 0, set: 0, remove: 0 };
const pluginStorage = {
  async getItem(key) { storageCounters.get += 1; return values.has(String(key)) ? values.get(String(key)) : null; },
  async setItem(key, value) { storageCounters.set += 1; values.set(String(key), value); return true; },
  async removeItem(key) { storageCounters.remove += 1; values.delete(String(key)); return true; },
  async keys() { return [...values.keys()]; }
};
const safeLocalStorage = {
  async getItem() { return null; }, async setItem() { return true; }, async removeItem() { return true; }, async keys() { return []; }
};
const emptyChat = { id: 'lia-idle-chat', chatId: 'lia-idle-chat', name: 'Idle', message: [], messages: [], bindedPersona: '' };
const emptyCharacter = { id: 'lia-idle-character', chaId: 'lia-idle-character', name: 'Idle', chats: [emptyChat] };
const counters = { getCharacterFromIndex: 0, getChatFromIndex: 0, getDatabase: 0 };
let outputListener = null;
const replacers = new Map();
const unloadHandlers = [];

const api = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    if (String(name).includes('memory_suite_server_mode')) return 'plugin_only';
    if (String(name).includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return await api.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch() { throw new Error('idle fixture has no server'); },
  async getDatabase(fields) {
    counters.getDatabase += 1;
    const all = { personas: [], selectedPersona: '', characters: [emptyCharacter], plugins: [] };
    if (!Array.isArray(fields)) return all;
    return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; },
  async getCurrentChatIndex() { return 0; },
  async getCharacter() { return emptyCharacter; },
  async getCharacterFromIndex() { counters.getCharacterFromIndex += 1; return emptyCharacter; },
  async getChat() { return emptyChat; },
  async getCurrentChat() { return emptyChat; },
  async getChatFromIndex() { counters.getChatFromIndex += 1; return emptyChat; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async unregisterSetting() { return true; },
  async unregisterButton() { return true; },
  async addRisuReplacer(type, handler) { replacers.set(type, handler); return true; },
  async removeRisuReplacer(type, handler) { if (replacers.get(type) === handler) replacers.delete(type); return true; },
  async addRisuChatListener(type, handler) { if (type === 'output') outputListener = handler; return true; },
  async removeRisuChatListener(type, handler) { if (type === 'output' && outputListener === handler) outputListener = null; return true; },
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async postPluginChannelMessage() { return true; },
  async addEventListener(type, handler) { if (type === 'unload') unloadHandlers.push(handler); return { type, handler }; },
  async requestPluginPermission(permission) { return permission === 'replacer'; },
  async showContainer() { return true; },
  async hideContainer() { return true; },
  async log() { return true; }
};

const activeIntervals = new Set();
const activeTimeouts = new Set();
const trackedSetInterval = (handler, delay, ...args) => {
  const timer = setInterval(handler, delay, ...args);
  activeIntervals.add(timer);
  return timer;
};
const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
const trackedSetTimeout = (handler, delay, ...args) => {
  let timer = null;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };

const context = vm.createContext({
  risuai: api,
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
  alert: () => {},
  prompt: () => null
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hotPathMetrics = {};

(async () => {
  vm.runInContext(source, context, { filename: 'LIA_Persona_Linker.js' });
  await sleep(1700); // allow startup + one-shot diagnostics to settle
  assert.equal(activeIntervals.size, 0, 'LIA starts no unconditional interval while idle');
  assert.equal(typeof outputListener, 'function', 'output listener offers manual update notices only');

  const before = { ...counters };
  assert.equal(context.__lia_persona_linker_runtime_v1__.debugProcessChatOutput({}).reason, "manual_only");
  await sleep(900); // longer than the 650ms output debounce
  assert.equal(counters.getCharacterFromIndex, before.getCharacterFromIndex, 'Live Sync OFF output does not reload character');
  assert.equal(counters.getChatFromIndex, before.getChatFromIndex, 'Live Sync OFF output does not reload full chat');

  const beforeRequest = replacers.get('beforeRequest') || (messages => messages);
  const afterRequest = replacers.get('afterRequest') || (content => content);
  assert.equal(replacers.has('beforeRequest'), false, 'ordinary requests have no Live before hook');
  assert.equal(replacers.has('afterRequest'), false, 'retired emotion attachment registers no afterRequest hook');
  const beforeHookCounters = { host: { ...counters }, storage: { ...storageCounters } };
  const untouchedMessages = [{ role: 'user', content: 'ordinary request' }];
  assert.equal(await beforeRequest(untouchedMessages, 'model'), untouchedMessages, 'ordinary request is byte/object preserving');
  assert.equal(storageCounters.set, beforeHookCounters.storage.set, 'ordinary request performs no pluginStorage write');
  assert.ok(counters.getCharacterFromIndex - beforeHookCounters.host.getCharacterFromIndex <= 1, 'ordinary request performs at most one character read');
  assert.ok(counters.getChatFromIndex - beforeHookCounters.host.getChatFromIndex <= 1, 'ordinary request performs at most one chat read');
  hotPathMetrics.beforeCharacterReads = counters.getCharacterFromIndex - beforeHookCounters.host.getCharacterFromIndex;
  hotPathMetrics.beforeChatReads = counters.getChatFromIndex - beforeHookCounters.host.getChatFromIndex;
  hotPathMetrics.beforeStorageGets = storageCounters.get - beforeHookCounters.storage.get;
  hotPathMetrics.beforeStorageSets = storageCounters.set - beforeHookCounters.storage.set;

  await afterRequest('ordinary response', 'model');
  const warmedAfter = { host: { ...counters }, storage: { ...storageCounters } };
  assert.equal(await afterRequest('second ordinary response', 'model'), 'second ordinary response', 'empty visual-asset path preserves output');
  assert.deepEqual(counters, warmedAfter.host, 'warmed empty-asset afterRequest performs no host reads');
  assert.deepEqual(storageCounters, warmedAfter.storage, 'warmed empty-asset afterRequest performs no storage I/O');

  for (const handler of unloadHandlers.slice().reverse()) {
    try { await handler(); } catch (_) {}
  }
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  activeTimeouts.clear();
  activeIntervals.clear();
  process.stdout.write(`lia_idle_bridge_contract_test: PASS ${JSON.stringify(hotPathMetrics)}\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
