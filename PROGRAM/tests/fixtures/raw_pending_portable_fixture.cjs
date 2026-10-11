'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
async function createFlashback(program,fixtureOptions={}){
const nativeHandles=new Map(),nativeTasks=new Set(),nativeEvents=[];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const identityEntered=deferred(),identityRelease=deferred();
let nativeClosed=false;
const note=(event,details={})=>nativeEvents.push({event,...details});
const scheduleNative=(factory,fn,ms,label)=>{
 if(nativeClosed){note('native_admission_closed',{label,ms});return null;}
 let handle;handle=factory(()=>{
  nativeHandles.delete(handle);note('native_callback_enter',{label,ms});
  const task=Promise.resolve(fn());nativeTasks.add(task);
  task.then(()=>{nativeTasks.delete(task);note('native_callback_settled',{label,ms});},()=>{nativeTasks.delete(task);note('native_callback_rejected',{label,ms});});
 },ms);nativeHandles.set(handle,{label,ms});return handle;
};
let closePromise;
const closeNativeCopyObserver=()=>{
 if(closePromise)return closePromise;
 nativeClosed=true;note('native_scheduler_close');
 const cancelOwnedHandles=()=>{for(const [handle,meta] of Array.from(nativeHandles)){trackedClearTimeout(handle);nativeHandles.delete(handle);note('native_handle_cancelled',meta);}};
 cancelOwnedHandles();
 closePromise=(async()=>{
  while(nativeTasks.size){await Promise.allSettled(Array.from(nativeTasks));cancelOwnedHandles();}
  cancelOwnedHandles();
  if(nativeHandles.size||nativeTasks.size)throw Error('RAW_PENDING_NATIVE_OWNERS_NOT_DRAINED');
  note('native_scheduler_drained');
  return {closed:nativeClosed,handles:nativeHandles.size,tasks:nativeTasks.size};
 })();return closePromise;
};
const replaceOnce=(source,anchor,replacement)=>{if(source.split(anchor).length!==2)throw Error('RAW_PENDING_NATIVE_FIXTURE_ANCHOR');return source.replace(anchor,replacement);};
const ownedNativeTransform=source=>{
 source=replaceOnce(source,"      scheduleTimer(() => {\n        runNativeCopyObserverAdoptionProbe(`${reason}_followup_${delayMs}`).catch(error => warn('native copy follow-up probe failed', error));\n      }, delayMs);", "      globalThis.__rawPendingScheduleNative(scheduleTimer, () => runNativeCopyObserverAdoptionProbe(`${reason}_followup_${delayMs}`).catch(error => warn('native copy follow-up probe failed', error)), delayMs, 'followup');");
 source=replaceOnce(source,"observer.timer=scheduleTimer(()=>{poll().catch(error=>warn('native copy observer poll failed',error));},NATIVE_COPY_OBSERVER_POLL_MS)", "observer.timer=globalThis.__rawPendingScheduleNative(scheduleTimer,()=>poll().catch(error=>warn('native copy observer poll failed',error)),NATIVE_COPY_OBSERVER_POLL_MS,'poll')");
 source=replaceOnce(source,"observer.timer=scheduleTimer(()=>{poll().catch(error=>warn('native copy observer startup failed',error));},250)", "observer.timer=globalThis.__rawPendingScheduleNative(scheduleTimer,()=>poll().catch(error=>warn('native copy observer startup failed',error)),250,'initial')");
 source=replaceOnce(source,"        const identity=await lightweightNativeCopyObserverIdentity();", "        if(globalThis.__rawPendingHoldIdentity)await globalThis.__rawPendingIdentityBarrier();\n        const identity=await lightweightNativeCopyObserverIdentity();");
 return source;
};

let source=fs.readFileSync(fixtureOptions.sourcePath || process.env.FLASHBACK_TEST_PLUGIN || path.join(program,'plugins/Flashback_Memory.js'),'utf8');
if(!fixtureOptions.exactSource)source=source.replace('  globalThis.__FlashbackMemory = publicApi;', '  globalThis.__FlashbackEmbeddingAudit = { abortEmbeddingJobs, buildRecordsFromSources, hydrateFlashbackVectorRecords, embeddingProfileSettingsFingerprint, embeddingRequestSettingsFingerprint, parseOpenAiVectors, MemorySuiteExecutionContract, Runtime };\n  globalThis.__FlashbackMemory = publicApi;');
const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out while loading Flashback multilingual probe runtime.');
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

const pluginStorage = fixtureOptions.pluginStorage || createStore();
const safeLocalStorage = fixtureOptions.safeLocalStorage || createStore();
const argumentValues = new Map([
  ['memory_suite_server_mode', 'plugin_only'],
  ['enable_gui', 'false'],
  ['embedding_key', 'test-secret-not-for-output']
]);
const networkCalls = [];
const vectorByText = new Map();
const currentChat = { id: 'multilingual-probe-chat', chatId: 'multilingual-probe-chat', name: 'Probe', message: [], messages: [] };
const character = { id: 'multilingual-probe-character', chaId: 'multilingual-probe-character', name: 'Probe', chats: [currentChat] };
const unloadHandlers = [];

const host = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) { return argumentValues.get(String(name || '')) || ''; },
  async getArg(name) { return await this.getArgument(name); },
  async setArgument(name, value) {
    const key = String(name || '');
    const clean = value == null ? '' : String(value);
    if (clean) argumentValues.set(key, clean);
    else argumentValues.delete(key);
    return true;
  },
  async nativeFetch(url, init = {}) {
    const body = JSON.parse(String(init.body || '{}'));
    const texts = Array.isArray(body.input) ? body.input : [body.input];
    networkCalls.push({ url: String(url), count: texts.length, headers: { ...(init.headers || {}) } });
    if (init.signal?.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    const data = texts.map((input, index) => {
      const vector = vectorByText.get(String(input));
      if (!vector) throw new Error(`unexpected probe input at ${index}`);
      return { index, embedding: vector.slice() };
    });
    return { ok: true, status: 200, async json() { return { data }; } };
  },
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
const trackedSetInterval = (handler, delay, ...args) => {
  const timer = setInterval(handler, delay, ...args);
  activeIntervals.add(timer);
  return timer;
};
const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
const context = vm.createContext({
  risuai: host,
  __rawPendingScheduleNative:scheduleNative,
  __rawPendingHoldIdentity:fixtureOptions.holdNativeIdentity===true,
  __rawPendingIdentityBarrier:async()=>{note('identity_barrier_enter');identityEntered.resolve();await identityRelease.promise;note('identity_barrier_released');},
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
  fetch: async () => { throw new Error('External network is disabled in this fixture.'); },
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


if(fixtureOptions.transformSource)source=fixtureOptions.transformSource(source);
source=ownedNativeTransform(source);
await vm.runInContext(source, context, {filename:'Flashback_Memory.js'});
const api=await waitFor(()=>context.__FlashbackMemory);
if(fixtureOptions.waitForLoaded)await waitFor(()=>api.uiStatus().registered.after);
return {closeNativeCopyObserver,nativeFixture:{identityEntered:identityEntered.promise,releaseIdentity:()=>identityRelease.resolve(),state:()=>({closed:nativeClosed,handles:nativeHandles.size,tasks:nativeTasks.size}),events:nativeEvents},api,audit:context.__FlashbackEmbeddingAudit,host,context,networkCalls,vectorByText,pluginStorage,safeLocalStorage,argumentValues,async cleanup(){for(const h of unloadHandlers.slice().reverse()){try{await h();}catch{}} for(const t of activeTimeouts)clearTimeout(t);for(const t of activeIntervals)clearInterval(t);}};
}
module.exports={createFlashback};
