'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const headerVersion = source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1];
assert.ok(headerVersion, 'plugin version header exists');
assert.equal(source.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1], headerVersion, 'runtime and install versions agree');
assert.match(source, /const flashbackMessageRevisionProjection = \(message, index, cache\) =>/);
assert.match(source, /const normalizeStoredChatMessages = \(chat, scopeKeyInput = '', sourceInfoInput = null\) =>/);
assert.match(source, /normalizedLiveStateCache/);
assert.match(source, /LIVE_CHAT_REVISION_CACHE_MAX_RETAINED_CHARS/);

const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out while loading Flashback cache test runtime.');
};
const createStore = () => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};
async function createFixture(options = {}) {
const pluginStorage = options.pluginStorage || createStore();
const safeLocalStorage = options.safeLocalStorage || createStore();
let blockPluginStorageKeys = false;
let pluginStorageKeyCalls = 0;
const normalPluginStorageKeys = pluginStorage.keys.bind(pluginStorage);
pluginStorage.keys = async () => {
  pluginStorageKeyCalls += 1;
  if (blockPluginStorageKeys) return await new Promise(() => {});
  return await normalPluginStorageKeys();
};
const argumentValues = new Map([
  ['memory_suite_server_mode', 'plugin_only'],
  ['hook_recall_timeout_ms', '1000'],
  ['enable_gui', 'false']
]);
for (const [key, value] of Object.entries(options.arguments || {})) argumentValues.set(key, value);
const currentChat = { id: 'flashback-host-chat', chatId: 'flashback-host-chat', name: 'Host', message: [], messages: [] };
if (options.chat) Object.assign(currentChat, structuredClone(options.chat));
const character = { id: 'flashback-character', chaId: 'flashback-character', name: 'Character', chats: [currentChat] };
if (options.characterId) { character.id = options.characterId; character.chaId = options.characterId; }
const unloadHandlers = [];
const chatListeners = new Map();
const host = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    const key = String(name || '');
    return argumentValues.has(key) ? argumentValues.get(key) : '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument(name, value) {
    const key = String(name || '');
    const clean = value == null ? '' : String(value);
    if (clean) argumentValues.set(key, clean);
    else argumentValues.delete(key);
    return true;
  },
  async nativeFetch(...args) { if (options.nativeFetch) return await options.nativeFetch(...args); throw new Error('no server'); },
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async removePluginChannelHandler() { return true; },
  async offPluginChannelMessage() { return true; },
  async postPluginChannelMessage() { return true; },
  async onUnload(handler) { unloadHandlers.push(handler); return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async unregisterSetting() { return true; },
  async unregisterButton() { return true; },
  async unregisterUIPart() { return true; },
  async addRisuReplacer() { return true; },
  async removeRisuReplacer() { return true; },
  async addRisuScriptHandler() { return true; },
  async removeRisuScriptHandler() { return true; },
  async addRisuChatListener(eventName, handler) {
    if (typeof handler !== 'function') return false;
    const event = String(eventName || '');
    if (!chatListeners.has(event)) chatListeners.set(event, new Set());
    chatListeners.get(event).add(handler);
    return true;
  },
  async removeRisuChatListener(eventName, handler) {
    const listeners = chatListeners.get(String(eventName || ''));
    if (listeners && handler) listeners.delete(handler);
    return true;
  },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
    if (!Array.isArray(fields)) return all;
    return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; },
  async getCurrentChatIndex() { return 0; },
  async getCharacter() { return character; },
  async getCharacterFromIndex() { return character; },
  async getChat() { return currentChat; },
  async getCurrentChat() { return currentChat; },
  async getChatFromIndex() { return currentChat; },
  async showContainer() { return true; },
  async hideContainer() { return true; },
  async getRootContainer() { return null; },
  async getPluginRoot() { return null; }
};
const activeTimeouts = new Set();
const activeIntervals = new Set();
const trackedSetTimeout = (handler, delay, ...args) => {
  if(options.pauseScheduledTimers)return {fixturePausedTimer:true};
  let timer;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
const trackedSetInterval = (handler, delay, ...args) => { if(options.pauseScheduledTimers)return {fixturePausedTimer:true}; const timer = setInterval(handler, delay, ...args); activeIntervals.add(timer); return timer; };
const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
const context = vm.createContext({
  risuai: host,
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

let runtimeSource = options.source || source;
if (options.exposeStorageBridge) runtimeSource = runtimeSource.replace('const RisuCompat = (() => {', 'globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\nconst RisuCompat = (() => {');
if(options.captureBackend==='afterRequest'){
  host.addRisuChatListener=async()=>false;
  host.addRisuScriptHandler=async()=>false;
}
await vm.runInContext(runtimeSource, context, {filename:'Flashback_Memory-native-branch.js'});
const api=await waitFor(()=>context.__FlashbackMemory);
return {api,host,character,currentChat,pluginStorage,context,dispatchRisuChatEvent:async(eventName,event)=>{
 const listeners=[...(chatListeners.get(String(eventName||''))||[])];
 for(const handler of listeners)await handler(event);
 return listeners.length;
},dispose:async()=>{
 for(const handler of unloadHandlers.slice().reverse())try{await handler();}catch(_){}
 if(!options.keepTimersAfterDispose){for(const timer of activeTimeouts)clearTimeout(timer);for(const timer of activeIntervals)clearInterval(timer);}
}};
}
module.exports={createFixture};
