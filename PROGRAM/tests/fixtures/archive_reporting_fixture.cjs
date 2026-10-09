'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
async function createArchiveReportingFixture(){
const source = fs.readFileSync(path.join(__dirname, '../../plugins/Flashback_Memory.js'), 'utf8');
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
const transcript = () => [
  { role: 'user', data: 'The observatory key is hidden beneath the blue sundial.', chatId: 'source-user-1' },
  { role: 'assistant', data: 'Mira pockets the brass key and promises to return at moonrise.', chatId: 'source-assistant-1' },
  { role: 'user', data: 'She should meet Rowan alone and use the phrase silver rain.', chatId: 'source-user-2' },
  { role: 'assistant', data: 'At moonrise, Mira meets Rowan alone and whispers silver rain.', chatId: 'source-assistant-2' }
];

const pluginStorage = createStore();
const safeLocalStorage = createStore();
const chats = [
  { id: 'portable-source-chat', chatId: 'portable-source-chat', name: 'Source worldline', message: transcript(), bindedPersona: '' },
  { id: 'portable-migration-chat', chatId: 'portable-migration-chat', name: 'New empty migration chat', message: [], bindedPersona: '' },
  { id: 'portable-copy-chat', chatId: 'portable-copy-chat', name: 'Copied worldline', message: [], bindedPersona: '' },
  { id: 'portable-collision-chat', chatId: 'portable-collision-chat', name: 'Occupied target', message: [], bindedPersona: '' }
];
for (const chat of chats) chat.messages = chat.message;
const character = { id: 'portable-cross-character', chaId: 'portable-cross-character', name: 'Portable Character', chats };
let currentChatIndex = 0;
const unloadHandlers = [];
const host = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    const key = String(name || '');
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    if (key.includes('embedding_key')) return 'fixture-key';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch(url, init = {}) {
    assert.equal(String(url), 'https://portable-fixture.invalid/v1/embeddings', 'no external transport is permitted');
    const request = JSON.parse(init.body);
    const dimensions = Number(request.dimensions || 4);
    const data = request.input.map((_, index) => ({ index, embedding: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) }));
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
  async getCurrentChatIndex() { return currentChatIndex; },
  async getCharacter() { return character; },
  async getCharacterFromIndex() { return character; },
  async getChat() { return chats[currentChatIndex]; },
  async getCurrentChat() { return chats[currentChatIndex]; },
  async getChatFromIndex(_characterIndex, chatIndex) { return chats[Number(chatIndex ?? currentChatIndex)] || chats[currentChatIndex]; },
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
const newContext = () => vm.createContext({
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
  fetch: async () => { throw new Error('external fetch forbidden in portable fixture'); },
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

let context = newContext();
const cloneMap = map => new Map(Array.from(map.entries(), ([key, value]) => [key, structuredClone(value)]));
const parseStoredValue = value => typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
const assertMapSubsetUnchanged = (before, after, label) => {
  for (const [key, value] of before) {
    assert.deepEqual(structuredClone(after.get(key)), structuredClone(value), `${label}: ${key}`);
  }
};


  vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });
  let flashback = await waitFor(() => context.__FlashbackMemory, 'Flashback API');
  const portable = await waitFor(() => context.__FlashbackPortableMemoryBackup, 'portable API');
  assert.equal(flashback.version, source.match(/^[\/][\/]@version\s+(\S+)/m)[1]);

  const ingested = await flashback.ingestLiveChatColdStart({
    scope: 'current',
    incremental: false,
    skipEpisodeRebuild: true,
    skipGuiRefresh: true,
    allowHashFallback: true
  });
  assert.equal(ingested.liveChatTurns, 2, 'source transcript creates two canonical U+A turns');
  const sourceScope = await flashback.resolveCurrentScope(true);
  const sourceLoaded = await flashback._test.loadScopeRecords(sourceScope.scopeKey);
  assert.ok(sourceLoaded.records.length >= 2, 'source records are durable before export');
  // First preserve the rejected fixture as an explicit negative contract.
  const sourceBeforeInvalid = JSON.stringify(sourceLoaded.records);
  await assert.rejects(() => flashback._test.saveAllRecords(sourceLoaded.records.map((record, index) =>
    index ? record : { ...record, text: record.text + ' stale work binding' })),
    error => error.code === 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID');
  assert.equal(JSON.stringify((await flashback._test.loadScopeRecords(sourceScope.scopeKey)).records), sourceBeforeInvalid);
  console.log('PASS invalid retained source/work binding rejected without changing source');

  const fixtureSettings = flashback._test.normalizeSettings({
    ...await flashback.loadSettings(), embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small',
    embeddingUrl: 'https://portable-fixture.invalid/v1/embeddings', embeddingEnabled: true,
    embeddingDimensions: 4, embeddingAutoProcess: false, embeddingMaxRetries: 0,
    episodeIndexEnabled: false, autoEpisodeIndex: false, episodeMinRecords: 2, episodeHierarchyEnabled: false
  });
  await flashback.saveSettings(fixtureSettings);
  const sourceRows = await flashback._test.buildRecordsFromSources(sourceLoaded.records.map(record => ({
    sourceType: 'response', sourceId: record.sourceId, sourceHash: record.sourceHash,
    text: record.text, turnIndex: record.turnIndex, pairIndex: record.pairIndex, sanitizeMemory: false
  })), fixtureSettings, sourceScope);
  assert.ok(sourceRows.every(record => record.vector.length === 4));
  await flashback._test.saveAllRecords(sourceRows, fixtureSettings, sourceScope);
  await flashback.saveSettings({ ...fixtureSettings, episodeIndexEnabled: true });
  const rebuiltEpisode = await flashback.rebuildEpisodeIndex(sourceScope);
  assert.equal(rebuiltEpisode.rebuilt, true, 'public episode rebuild reaches the production builder and durable commit');
  const episodes = (await flashback._test.loadScopeRecords(sourceScope.scopeKey)).records.filter(record => record.autoEpisode);
  assert.equal(episodes.length, 1, 'public episode rebuild creates the archived episode fixture');
  assert.deepEqual(Array.from(episodes, record => [record.turnRange.start, record.turnRange.end]), [[1, 2]]);
  assert.ok(episodes.every(record => !record.turnIndex && !record.pairIndex), 'real episodes span turns rather than impersonating a response row');
  await flashback.saveSettings(fixtureSettings);
  console.log('PASS public episode rebuild durably creates aggregate episode spanning turns 1-2');

  // Independent three-row diagnostic. The original 643-row acceptance test is unchanged.
  const emit = (name, value) => console.log('DIAG', name, JSON.stringify(value));
  const envelope=await portable.exportCurrentScope();
  currentChatIndex=1;
  const migration=await portable.restoreCurrentScope(envelope,{mode:'chat_migration_archive'});
  assert.equal(migration.ok,true);
  const scope=await flashback.resolveCurrentScope(true);
  await flashback._test.retireExternalRecordsForScope(scope.scopeKey);
  await new Promise(resolve=>setTimeout(resolve,200));
  for(const t of activeTimeouts)clearTimeout(t);activeTimeouts.clear();
  for(const t of activeIntervals)clearInterval(t);activeIntervals.clear();
  let requests=0;
  const provider=host.nativeFetch.bind(host);
  host.nativeFetch=async(url,init)=>{requests++;return provider(url,init)};
  const manifest=await flashback._test.loadScopeManifest(scope.scopeKey);
  const ref=manifest.archiveRef;
  const archiveManifest=await flashback._test.loadScopeManifest(ref.archiveScopeKey);
  const protectedArchive=cloneMap(new Map([...pluginStorage.values].filter(([key])=>key.startsWith(`vector_rag_memory:scope:${archiveManifest.storageHash}:`))));
  const archiveVectors=cloneMap(new Map([...safeLocalStorage.values].filter(([key])=>key.includes(`:${archiveManifest.storageHash}:`))));
  assert.equal(ref.recordCount,3);assert.equal(manifest.count,0);


  const dispose = async () => {
    for(const h of unloadHandlers.splice(0))await h().catch(()=>{});
    for(const t of activeTimeouts)clearTimeout(t);activeTimeouts.clear();
    for(const t of activeIntervals)clearInterval(t);activeIntervals.clear();
  };
  const seedMixed = async settings => {
    const rows=await flashback._test.buildRecordsFromSources([{sourceType:'response',sourceId:'independent-local',sourceHash:'independent-local-hash',origin:'live_chat',role:'turn_pair',turnIndex:1,pairIndex:1,text:'User:\nWhere is the ruby?\n\n---\n\nAssistant:\n'+('The ruby is in a locked drawer near the observatory. '.repeat(24))}],settings,scope,{deferEmbedding:true});
    await flashback._test.saveAllRecords(rows,settings,scope);
    await flashback._test.retireExternalRecordsForScope(scope.scopeKey);
    return rows;
  };
  const restart = async scriptPath => {
    await dispose();context=newContext();
    vm.runInContext(fs.readFileSync(scriptPath,'utf8'),context,{filename:scriptPath});
    flashback=await waitFor(()=>context.__FlashbackMemory,'artifact API');
    await waitFor(()=>flashback.uiStatus().registered.after,'artifact initialization');
    await new Promise(resolve=>setTimeout(resolve,200));
    for(const t of activeTimeouts)clearTimeout(t);activeTimeouts.clear();
    for(const t of activeIntervals)clearInterval(t);activeIntervals.clear();
    return flashback;
  };
  return { get api(){return flashback},get context(){return context},host,scope,fixtureSettings,pluginStorage,safeLocalStorage,ref,archiveManifest,protectedArchive,archiveVectors,
    get requests(){return requests},dispose,seedMixed,restart,assertMapSubsetUnchanged,parseStoredValue,waitFor };

}
module.exports={createArchiveReportingFixture};
