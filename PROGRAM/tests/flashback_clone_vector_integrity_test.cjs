'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8').replace('hydrateFlashbackVectorRecords, persistFlashbackVectorShard,', 'hydrateFlashbackVectorRecords, invalidateFlashbackVectorShardCache, persistFlashbackVectorShard,');

const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const createStore = () => {
  const values = new Map();
  return {
    values,
    failWrites: false,
    keysBarrier: null,
    keysBarrierEntries: 0,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) {
      if (this.failWrites) throw new Error('simulated_plugin_storage_write_failure');
      values.set(String(key), value);
      return true;
    },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() {
      if (this.keysBarrier) {
        this.keysBarrierEntries += 1;
        await this.keysBarrier;
      }
      return Array.from(values.keys());
    }
  };
};

const pluginStorage = createStore();
const safeLocalStorage = createStore();
const chat = { id: 'portable-sidecar-chat', chatId: 'portable-sidecar-chat', name: 'Portable Sidecar Chat', message: [], messages: [], bindedPersona: '' };
const character = { id: 'portable-sidecar-character', chaId: 'portable-sidecar-character', name: 'Portable Sidecar Character', chats: [chat] };
const unloadHandlers = [];

const host = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    const key = String(name || '');
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch() { throw new Error('no server in portable sidecar test'); },
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
  async getChat() { return chat; },
  async getCurrentChat() { return chat; },
  async getChatFromIndex() { return chat; },
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

(async () => {
  vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });
  const flashback = await waitFor(() => context.__FlashbackMemory, 'Flashback API');
  const portable = await waitFor(() => context.__FlashbackPortableMemoryBackup, 'Flashback portable API');



  const scope = await flashback.resolveCurrentScope(false);
  assert.ok(scope?.scopeKey, 'resolved current Flashback scope');

  const originalRecord = {
    id: 'portable-turn-1',
    hash: 'portable-turn-1',
    type: 'response',
    sourceType: 'response',
    text: 'Portable sidecar evidence',
    dim: 4,
    vector: [0.25, 0.5, -0.75, 1]
  };
  const initialSaved = await flashback._test.saveAllRecords([originalRecord], null, scope);
  assert.equal(initialSaved.manifest.count, 1, 'canonical scope commit persisted');
  const persisted = await flashback._test.loadScopeRecords(scope.scopeKey);
  assert.equal(persisted.records.length, 1);
  assert.ok(persisted.records[0].vectorRef?.storageKey, 'persisted record has local vector ref');
  const vectorKey = persisted.records[0].vectorRef.storageKey;
  assert.ok(safeLocalStorage.values.has(vectorKey), 'sidecar physically present before export');


  const healthyTarget={...scope,scopeKey:scope.scopeKey+'|persona:healthy'};
  const healthy=await flashback._test.cloneScopeStorage(scope,healthyTarget,{}, {mode:'same_chat_persona_recovery'});
  const healthyLoaded=await flashback._test.loadScopeRecords(healthyTarget.scopeKey);
  assert.equal(healthy.ok,true); assert.equal(healthyLoaded.records[0].vector.length,4);
  assert.notEqual(healthyLoaded.records[0].vectorRef.storageKey,vectorKey);

  const originalPayload=await safeLocalStorage.getItem(vectorKey);
  const sourceManifestBefore=await flashback._test.loadScopeManifest(scope);
  // Leave decoded cache hot: clone must verify physical storage anyway.
  await safeLocalStorage.removeItem(vectorKey);
  const target={...scope,scopeKey:scope.scopeKey+'|persona:probe'};
  await assert.rejects(()=>flashback._test.cloneScopeStorage(scope,target,{}, {mode:'same_chat_persona_recovery'}),e=>e.code==='FLASHBACK_CLONE_SOURCE_VECTOR_INVALID');
  const after=await flashback._test.loadScopeManifest(target);
  assert.ok(!after.copyAdoptedComplete);assert.equal(Number(after.count||0),0);
  const sourceAfter=await flashback._test.loadScopeManifest(scope);
  assert.equal(sourceAfter.commitId,sourceManifestBefore.commitId);
  await safeLocalStorage.setItem(vectorKey,originalPayload);
  const retry=await flashback._test.cloneScopeStorage(scope,target,{}, {mode:'same_chat_persona_recovery'});
  assert.equal(retry.ok,true);
  const retryLoaded=await flashback._test.loadScopeRecords(target.scopeKey);
  assert.equal(retryLoaded.records[0].vector.length,4);

  const faultTarget={...scope,scopeKey:scope.scopeKey+'|persona:write-fault'};
  const originalSet=pluginStorage.setItem;
  pluginStorage.setItem=async function(key,value){
    const result=await originalSet.call(this,key,value);
    for(const [localKey,payload] of safeLocalStorage.values){
      const parsed=typeof payload==='string'?JSON.parse(payload):payload;
      if(parsed?.scopeKey===faultTarget.scopeKey)await safeLocalStorage.removeItem(localKey);
    }
    return result;
  };
  await assert.rejects(()=>flashback._test.cloneScopeStorage(scope,faultTarget,{}, {mode:'same_chat_persona_recovery'}),e=>e.code==='FLASHBACK_REBUILD_COMMIT_READBACK_FAILED');
  pluginStorage.setItem=originalSet;
  const faultManifest=await flashback._test.loadScopeManifest(faultTarget);
  assert.ok(!faultManifest.copyAdoptedComplete);assert.equal(Number(faultManifest.count||0),0);
  pluginStorage.failWrites=true;
  await assert.rejects(()=>flashback._test.cloneScopeStorage(scope,{...scope,scopeKey:scope.scopeKey+'|persona:reject'}, {}, {mode:'same_chat_persona_recovery'}));
  pluginStorage.failWrites=false;
  assert.equal((await flashback._test.loadScopeManifest(scope)).commitId,sourceManifestBefore.commitId);
  console.log('PASS: destination vector loss prevents publication; rejected writes preserve source');
  console.log('PASS: healthy clone; hot-cache physical missing payload rejected; target not published; source preserved; repair and retry succeeds');
  for(const handler of unloadHandlers) await handler().catch(()=>{});
  for(const timer of activeTimeouts) clearTimeout(timer);
  for(const timer of activeIntervals) clearInterval(timer);
})().catch(error=>{for(const timer of activeTimeouts)clearTimeout(timer);for(const timer of activeIntervals)clearInterval(timer);console.error(error);process.exitCode=1;});

