'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');


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
const pluginStorage = createStore();
const safeLocalStorage = createStore();
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
const currentChat = { id: 'flashback-host-chat', chatId: 'flashback-host-chat', name: 'Host', message: [], messages: [] };
const character = { id: 'flashback-character', chaId: 'flashback-character', name: 'Character', chats: [currentChat] };
const unloadHandlers = [];const hooks={};
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
  async nativeFetch() { throw new Error('no server'); },
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
  async addRisuReplacer(k,f) { hooks[k]=f;return true; },
  async removeRisuReplacer() { return true; },
  async addRisuScriptHandler() { return true; },
  async removeRisuScriptHandler() { return true; },
  async addRisuChatListener() { return true; },
  async removeRisuChatListener() { return true; },
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
  let timer;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
const trackedSetInterval = (handler, delay, ...args) => { const timer = setInterval(handler, delay, ...args); activeIntervals.add(timer); return timer; };
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


(async()=>{
 try{
  currentChat.message=[{role:'user',chatId:'u1',data:'What happens?'},{role:'assistant',chatId:'a1',data:'Alice signed the agreement.'},{role:'user',chatId:'u2',data:'Then what?'},{role:'assistant',chatId:'a2',data:'Alice waited outside.'}];currentChat.messages=currentChat.message;
  vm.runInContext(source,context,{filename:'Flashback-source-edit-runtime.js'});
  const api=await waitFor(()=>context.__FlashbackMemory);
  await api.saveSettings({...await api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});
  const initial=await api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await api.resolveCurrentScope();const before=await api._test.loadScopeRecords(scope.scopeKey);
  assert.ok(before.records.some(r=>r.text.includes('signed the agreement.')),'old raw source exists');
  currentChat.message[1].data='Alice did not sign the agreement.';
  const snapshot=await api._test.flashbackSourceEditSnapshot();
  assert.ok(snapshot.units[0]?.identity&&snapshot.units[0]?.sourceDigest,'snapshot binds exact current owner source');
  await api._selectionTest.beforeRequest([{role:'user',chatId:'u3',content:'Continue.'}],'model');
  await api._selectionTest.afterRequest('Next response.','model');
  const unchanged=await api._test.loadScopeRecords(scope.scopeKey);assert.equal(unchanged.records.some(r=>r.text.includes('did not sign')),false,'request must not replace source implicitly');const inventory=await api.listReanalysisRanges();const result=await api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(api.getReanalysisStatus().lastResult.ok,true);
  const after=await api._test.loadScopeRecords(scope.scopeKey);
  assert.ok(after.records.some(r=>r.text.includes('did not sign the agreement.')),'explicit exact-source replacement was saved');
  assert.equal(currentChat.message[1].data,'Alice did not sign the agreement.','source not rewritten');
  assert.ok(after.records.some(r=>r.text.includes('Alice waited outside.')),'unchanged downstream raw source remains active');
  const gated=api._test.applyRecallHardGates(after.records,{scopeKey:scope.scopeKey});
  assert.equal(gated.some(r=>(r.record||r).text.includes('Alice signed the agreement')),false,'old source and any derived episode are absent from recall after replacement');
  assert.equal(gated.some(r=>(r.record||r).text.includes('did not sign')),true,'new active replacement remains recallable');
  const history=await api._test.loadTurnWorldline(scope.scopeKey);assert.ok(history.retiredRecords.some(r=>r.text.includes('Alice signed')),'old source retained as inactive history');
  console.log(JSON.stringify({test:'source_edit_flashback_suffix',passed:9}));
 }finally{
  for(const f of unloadHandlers.slice().reverse())await f().catch(()=>{});
  for(const t of activeTimeouts)clearTimeout(t);for(const t of activeIntervals)clearInterval(t);
 }
})().catch(e=>{console.error(e);process.exitCode=1});
