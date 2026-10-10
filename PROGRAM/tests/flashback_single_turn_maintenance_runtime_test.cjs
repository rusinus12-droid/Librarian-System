'use strict';
// Zero-vector fault isolation contract (fix document section 4).
//
// A-1  one zero-vector turn must not take healthy turns down with it
// A-2  a turn that succeeds on the individual retry is NOT left pending
// A-3  a turn that is zero on batch AND on retry is reported pending, and the
//      run is a partial success rather than a thrown failure
// A-4  the validator itself is untouched: a zero vector is still rejected, and
//      the low-level clone integrity contract stays fail-closed
//
// This asserts the CORRECTED behaviour (it is a gate, not a defect probe).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');

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
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};

const DIM = 16;
const unit = seed => { const v = new Array(DIM).fill(0); v[seed % DIM] = 1; return v; };
const zero = () => new Array(DIM).fill(0);

// Embedding endpoint mock: `plan` decides, per requested text, whether the
// response carries a real unit vector or a zero vector.
let plan = () => unit(1);
let batchCalls = 0;
let singleCalls = 0;

const embeddingFetch = async (url, init = {}) => {
  const body = JSON.parse(String(init.body || '{}'));
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  if (inputs.length > 1) batchCalls += 1; else singleCalls += 1;
  const data = inputs.map((text, index) => ({ index, embedding: plan(String(text), inputs.length) }));
  return {
    ok: true,
    status: 200,
    async json() { return { data, model: 'mock-embed' }; },
    async text() { return JSON.stringify({ data, model: 'mock-embed' }); }
  };
};

const pluginStorage = createStore();
const safeLocalStorage = createStore();
const chat = { id: 'zv-chat', chatId: 'zv-chat', name: 'Zero Vector Chat', message: [], messages: [], bindedPersona: '' };
const character = { id: 'zv-char', chaId: 'zv-char', name: 'Zero Vector Character', chats: [chat] };

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
  nativeFetch: embeddingFetch,
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async removePluginChannelHandler() { return true; },
  async offPluginChannelMessage() { return true; },
  async postPluginChannelMessage() { return true; },
  async onUnload() { return true; },
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

const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask, AbortController, AbortSignal, DOMException,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone,
  performance: globalThis.performance,
  fetch: embeddingFetch,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: globalThis.FormData, Blob: globalThis.Blob,
  atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null
});


(async()=>{
 vm.runInContext(source,context,{filename:'Flashback_Memory.js'});
 const api=await waitFor(()=>context.__FlashbackMemory,'Flashback API');
 const cfg={...await api.loadSettings(),embeddingProvider:'openai_compatible',embeddingModel:'mock-embed',embeddingUrl:'http://127.0.0.1:65530/v1/embeddings',embeddingApiKey:'test-key',embeddingDimensions:DIM,embeddingEnabled:true,fallbackHashEmbedding:false,autoEpisodeIndex:false,episodeIndexEnabled:false,autoColdStart:false};
 await api.saveSettings(cfg);await api._test.saveEmbeddingKeyLocal('test-key');
 // Let the product's one-time 4.5s startup restore finish on the empty chat.
 // It must not race this test's intentional mutations of the live fixture.
 await new Promise(resolve=>setTimeout(resolve,5000));
 const message=n=>[{role:'user',id:'u'+n,chatId:'u'+n,data:'Inspect the archive for turn '+n+'.'},{role:'assistant',id:'a'+n,chatId:'a'+n,data:'For turn '+n+', Alice inspected the archive desk and confirmed that the blue ledger was still sealed. She placed the sealed document beside the wooden box and waited for the visitor to respond.'}];
 chat.message=Array.from({length:31},(_,i)=>message(i+1)).flat();chat.messages=chat.message;
 plan=()=>unit(2);
 await api.ingestLiveChatColdStart({scope:'current',canonical:true,settings:cfg,skipEpisodeRebuild:true});
 const scope=await api.resolveCurrentScope();const baseline=await api._test.loadScopeRecords(scope.scopeKey);assert.equal(baseline.records.filter(x=>!x.autoEpisode).length,31);
 chat.message.push(...message(32));
 const raw=JSON.stringify(chat.message);
 plan=text=>String(text).includes('turn 32')?zero():unit(2);
 const result=await api.runMemoryMaintenance('auto',{settings:cfg});
 console.log('RESULT',JSON.stringify({healthy:result.healthy,missing:result.after.missingTurns,pending:result.operation.sync.isolatedPending,requests:result.execution.requestCount}));
 const after=await api._test.loadScopeRecords(scope.scopeKey);
 assert.equal(result.healthy,false,'T32 cannot be reported repaired');assert.equal(after.records.filter(x=>!x.autoEpisode).length,31,'31 old records preserved, zero vector not stored');assert.equal(JSON.stringify(chat.message),raw,'source U+A unchanged');
 const text=api._test.maintenanceResultText(result);assert.match(text,/보류/,'pending repair shown through actual executor, not helper only');assert.match(text,/0 벡터|유효하지 않은/);
 // Explicit retry after provider recovery; T32 is now stored, no duplicate old turns.
 plan=()=>unit(2);const repaired=await api.runMemoryMaintenance('auto',{settings:cfg});
 const final=await api._test.loadScopeRecords(scope.scopeKey);assert.equal(final.records.filter(x=>!x.autoEpisode).length,32);assert.equal(repaired.after.missingTurns,0);
 console.log('PASS actual auto maintenance: T32 alone zero -> pending, 31 prior rows preserved -> explicit retry repairs T32');
 chat.message.push(...message(33));
 const beforeRebuild=await api._test.loadScopeRecords(scope.scopeKey);
 const beforeCommit=beforeRebuild.manifest.commitId;
 plan=text=>String(text).includes('turn 33')?zero():unit(2);
 await assert.rejects(()=>api.rebuildCurrentChatMemory({settings:cfg,allowHashFallback:false}),error=>error.code==='FLASHBACK_REBUILD_EMBEDDING_INCOMPLETE');
 const unchanged=await api._test.loadScopeRecords(scope.scopeKey);
 assert.equal(unchanged.manifest.commitId,beforeCommit,'incomplete full rebuild cannot swap manifest');
 assert.equal(unchanged.records.length,beforeRebuild.records.length,'old records intact after rejected full rebuild');
 console.log('PASS full rebuild missing vector remains fail-closed, previous commit unchanged');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
