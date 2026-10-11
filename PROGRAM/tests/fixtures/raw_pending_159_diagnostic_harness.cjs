'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const { createHash }=require('node:crypto');
const { AsyncLocalStorage }=require('node:async_hooks');
let diagnosticFixtureId=0;
async function createFlashback(program,fixtureOptions={}){
const fixtureId=++diagnosticFixtureId, started=performance.now(), lineage=new AsyncLocalStorage();
let sequence=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const observerEntered=deferred(),observerRelease=deferred(),observerCompleted=deferred(),restoreAcquired=deferred(),restoreRelease=deferred();
let observerHeld=false;
const diagnostics=[];
const trace=(event,details={})=>{diagnostics.push({event,lineage:lineage.getStore()||'unscoped',...details});if(event==='observer_exit'&&observerHeld)observerCompleted.resolve(details);return process.stdout.write('DIAG159 '+JSON.stringify({fixtureId,sequence:++sequence,atUtc:new Date().toISOString(),elapsedMs:performance.now()-started,event,lineage:lineage.getStore()||'unscoped',...details})+'\n');};
const observerBarrier=async reason=>{if(!fixtureOptions.controlObserver||observerHeld)return;observerHeld=true;observerEntered.resolve({reason});await observerRelease.promise;};
const restoreBarrier=async kind=>{if(!fixtureOptions.controlRestore||kind!=='restore')return;restoreAcquired.resolve({kind});await restoreRelease.promise;};
const bytesDigest=value=>{const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value)??'null');return {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};};
const physicalTrace=(event,key,value)=>trace(event,{key:String(key),...(value===undefined?{}:bytesDigest(value)),stack:new Error('physical storage operation').stack.split('\n').slice(2,14)});
const replaceOnce=(source,anchor,replacement)=>{if(source.split(anchor).length!==2)throw Error('DIAG159_ANCHOR_NOT_UNIQUE');return source.replace(anchor,replacement);};
const diagnosticTransform=source=>{
 source=replaceOnce(source,"  const cloneScopeStorage = async (fromScopeMeta, toScope, settings, cloneMeta = {}) => {", "  const cloneScopeStorage = async (fromScopeMeta, toScope, settings, cloneMeta = {}) => {\n    globalThis.__rawPendingDiagnosticTrace('clone_scope_enter',{sourceScopeKey:fromScopeMeta?.scopeKey,targetScopeKey:toScope?.scopeKey,reason:cloneMeta.reason,mode:cloneMeta.mode,portableOperationId:Runtime.portableMemoryActiveOperationId});");
 source=replaceOnce(source,"  const runNativeCopyObserverAdoptionProbe = async (reason = 'observer') => {", "  const runNativeCopyObserverAdoptionProbe = async (reason = 'observer') => globalThis.__rawPendingDiagnosticRun('native_copy_observer:'+reason, async () => {\n    globalThis.__rawPendingDiagnosticTrace('observer_enter',{reason});\n    if(globalThis.__rawPendingControlObserverEnabled)await globalThis.__rawPendingObserverBarrier(reason);");
 source=replaceOnce(source,"      observer.inFlight = false;\n    }\n  };\n\n  const scheduleNativeCopyObserverFollowups", "      observer.inFlight = false;\n      globalThis.__rawPendingDiagnosticTrace('observer_exit',{reason,lastResult:observer.lastResult?{adopted:observer.lastResult.adopted,reason:observer.lastResult.reason,scopeKey:observer.lastResult.scope?.scopeKey}:null,lastError:observer.lastError});\n    }\n  });\n\n  const scheduleNativeCopyObserverFollowups");
 source=replaceOnce(source,"      return { snapshot, scope, live, liveState, loaded, manifest, empty };", "      globalThis.__rawPendingDiagnosticTrace('portable_target_preflight',{scopeKey:scope.scopeKey,chatId:scope.chatId,records:loaded.records.length,count:Number(manifest.count||0),shardCount:Number(manifest.shardCount||0),hasArchive:!!normalizeFlashbackArchiveRef(manifest.archiveRef),copyAdoptedComplete:manifest.copyAdoptedComplete===true,empty,portableOperationId:Runtime.portableMemoryActiveOperationId,nativeObserverInFlight:Runtime.nativeCopyObserver.inFlight});\n      return { snapshot, scope, live, liveState, loaded, manifest, empty };");
 source=replaceOnce(source,"      const payload = await inspectPortableFlashbackPayload(envelope);\n      const target = await portableTargetContext();", "      const payload = await inspectPortableFlashbackPayload(envelope);\n      globalThis.__rawPendingDiagnosticTrace('portable_source_inspected',{sourceScopeKey:payload.source.scopeKey,records:payload.records.length});\n      const target = await portableTargetContext();");
 source=replaceOnce(source,"      Runtime.portableMemoryActiveOperationId = operationId;\n      try {", "      Runtime.portableMemoryActiveOperationId = operationId;\n      globalThis.__rawPendingDiagnosticTrace('portable_operation_acquired',{kind,operationId});\n      try {");
 source=replaceOnce(source,"    const releasePortableOperation = operationId => {", "    const releasePortableOperation = operationId => {\n      globalThis.__rawPendingDiagnosticTrace('portable_operation_release',{operationId});");
 source=replaceOnce(source,"      try { return await task(operationId); }", "      try { if(globalThis.__rawPendingControlRestoreEnabled)await globalThis.__rawPendingRestoreBarrier(kind); return await task(operationId); }");
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
    async setItem(key, value) { physicalTrace('physical_write',key,value); values.set(String(key), value); return true; },
    async removeItem(key) { physicalTrace('physical_remove',key); values.delete(String(key)); return true; },
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
  __rawPendingDiagnosticTrace:trace,
  __rawPendingControlObserverEnabled:fixtureOptions.controlObserver===true,
  __rawPendingControlRestoreEnabled:fixtureOptions.controlRestore===true,
  __rawPendingObserverBarrier:observerBarrier,
  __rawPendingRestoreBarrier:restoreBarrier,
  __rawPendingDiagnosticRun:(owner,run)=>lineage.run(owner,run),
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
source=diagnosticTransform(source);
await vm.runInContext(source, context, {filename:'Flashback_Memory.js'});
const api=await waitFor(()=>context.__FlashbackMemory);
if(fixtureOptions.waitForLoaded)await waitFor(()=>api.uiStatus().registered.after);
return {diagnostics,control:{observerEntered:observerEntered.promise,releaseObserver:()=>observerRelease.resolve(),observerCompleted:observerCompleted.promise,restoreAcquired:restoreAcquired.promise,releaseRestore:()=>restoreRelease.resolve()},api,audit:context.__FlashbackEmbeddingAudit,host,context,networkCalls,vectorByText,pluginStorage,safeLocalStorage,argumentValues,async cleanup(){trace('cleanup_enter');for(const h of unloadHandlers.slice().reverse()){try{await h();}catch{}} for(const t of activeTimeouts)clearTimeout(t);for(const t of activeIntervals)clearInterval(t);}};
}
module.exports={createFlashback};
