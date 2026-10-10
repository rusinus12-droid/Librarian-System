'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.FLASHBACK_EPISODE_SOURCE || path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');
async function fixture(runtimeSource = source, initialState = null) {
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
  { role: 'assistant', data: 'At moonrise, Mira meets Rowan alone and whispers silver rain.', chatId: 'source-assistant-2' },
  { role: 'user', data: 'Where does Rowan hide the map?', chatId: 'source-user-3' },
  { role: 'assistant', data: 'Rowan hides the map in the wooden chest beside Mira.', chatId: 'source-assistant-3' },
  { role: 'user', data: 'Does she remember the route?', chatId: 'source-user-4' },
  { role: 'assistant', data: 'Mira remembers the route and leads Rowan through the courtyard.', chatId: 'source-assistant-4' }
];

const pluginStorage = createStore();
const safeLocalStorage = createStore();
// Each case gets independent stores copied from a public-ingest/rebuild snapshot.
// Reuse durable fixture bytes, never a VM, mutable records or a hand-built vector.
if (initialState) {
  for (const [key, value] of structuredClone(initialState.plugin)) pluginStorage.values.set(key, value);
  for (const [key, value] of structuredClone(initialState.vectors)) safeLocalStorage.values.set(key, value);
}
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

const cloneMap = map => new Map(Array.from(map.entries(), ([key, value]) => [key, structuredClone(value)]));
const parseStoredValue = value => typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
const assertMapSubsetUnchanged = (before, after, label) => {
  for (const [key, value] of before) {
    assert.deepEqual(structuredClone(after.get(key)), structuredClone(value), `${label}: ${key}`);
  }
};

  vm.runInContext(runtimeSource, context, { filename: 'Flashback_Memory.js' });
  const api = await waitFor(() => context.__FlashbackMemory, 'Flashback API');
  const portable = await waitFor(() => context.__FlashbackPortableMemoryBackup, 'portable API');
  const stopTimers = () => {
    for (const timer of activeTimeouts) clearTimeout(timer);
    activeTimeouts.clear();
    for (const timer of activeIntervals) clearInterval(timer);
    activeIntervals.clear();
  };
  return { api, portable, pluginStorage, safeLocalStorage, stopTimers,
    target() { stopTimers(); chats[2].message = transcript(); chats[2].messages = chats[2].message; currentChatIndex = 2; },
    async cleanup() { for (const handler of unloadHandlers) await handler().catch(() => {}); stopTimers(); }
  };
}
const { test } = require('node:test');
const plain = value => JSON.parse(JSON.stringify(value));
const aggregateProjection = record => Object.fromEntries(['id','hash','sourceId','sourceHash','text','vector','dim','childIds','childHashes','childCount','turnRange','episodeLevel','embeddingDescriptor','embeddingProvenance','embeddingProfileId'].map(key => [key, plain(record[key] ?? null)]));
let seedTemplate = null;
async function seeded() {
  if (seedTemplate) {
    const f = await fixture(source, seedTemplate);
    f.stopTimers();
    const scope = await f.api.resolveCurrentScope(true);
    const records = (await f.api._test.loadScopeRecords(scope.scopeKey)).records;
    return { ...f, scope, settings: plain(seedTemplate.settings), records };
  }
  const f = await fixture();
  const settings = { ...await f.api.loadSettings(), embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small',
    embeddingUrl: 'https://portable-fixture.invalid/v1/embeddings', embeddingDimensions: 4,
    embeddingEnabled: true, embeddingAutoProcess: false, embeddingMaxRetries: 0,
    episodeIndexEnabled: false, autoEpisodeIndex: false, episodeMinRecords: 2, episodeMaxRecords: 2,
    episodeHierarchyEnabled: true, episodeParentSize: 2 };
  await f.api.saveSettings(settings);
  await f.api.ingestLiveChatColdStart({ scope: 'current', incremental: false, skipEpisodeRebuild: true, skipGuiRefresh: true, allowHashFallback: false });
  const scope = await f.api.resolveCurrentScope(true);
  await f.api.saveSettings({ ...settings, episodeIndexEnabled: true });
  assert.equal((await f.api.rebuildEpisodeIndex(scope)).rebuilt, true);
  await f.api.saveSettings(settings);
  f.stopTimers();
  const loaded = await f.api._test.loadScopeRecords(scope.scopeKey);
  assert.equal(loaded.records.filter(r => r.episodeLevel === 'scene').length, 2);
  assert.equal(loaded.records.filter(r => r.episodeLevel === 'session').length, 1);
  seedTemplate = { plugin: structuredClone(Array.from(f.pluginStorage.values)),
    vectors: structuredClone(Array.from(f.safeLocalStorage.values)), settings: plain(settings) };
  return { ...f, scope, settings, records: loaded.records };
}
const storageForScope = (store, scope) => Array.from(store.values).filter(([key]) => String(key).includes(`:${scope.storageHash}:`));

// These public restore cases fail on the old universal single-turn rebinder.
test('portable copy preserves multiple generated scene and session aggregates without assigning a turn', async () => {
  const f = await seeded();
  try {
    const envelope = await f.portable.exportCurrentScope();
    const before = plain(storageForScope(f.pluginStorage, f.scope));
    const vectors = plain(storageForScope(f.safeLocalStorage, f.scope));
    f.target();
    const inspection = await f.portable.inspectRestoreOptions(envelope);
    assert.equal(inspection.modes.chat_copy_rebind.allowed, true);
    const result = await f.portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' });
    assert.equal(result.ok, true);
    assert.equal(result.activeTurns, 4);
    const loaded = await f.api._test.loadScopeRecords(inspection.target.scope.scopeKey);
    assert.equal(loaded.records.length, f.records.length);
    const copied = loaded.records.filter(r => r.autoEpisode);
    assert.equal(copied.length, 3);
    for (const record of copied) {
      assert.deepEqual(aggregateProjection(record), aggregateProjection(f.records.find(r => r.id === record.id)));
      assert.ok(!record.turnIndex && !record.pairIndex && !record.turnNodeId && !record.logicalTurnId && !record.variantId);
      assert.equal(record.scopeKey, inspection.target.scope.scopeKey);
      assert.equal(record.copiedFromLiveScopeKey, f.scope.scopeKey);
    }
    for (const row of loaded.records.filter(r => r.sourceType === 'response')) assert.ok(row.turnNodeId);
    assert.deepEqual(plain(storageForScope(f.pluginStorage, f.scope)), before);
    assert.deepEqual(plain(storageForScope(f.safeLocalStorage, f.scope)), vectors);
  } finally { await f.cleanup(); }
});

const invalidCases = {
  'missing child': rows => { rows.find(r => r.episodeLevel === 'scene').childIds[0] = 'absent-response'; },
  'mismatched child hash': rows => { rows.find(r => r.episodeLevel === 'scene').childHashes[0] = 'wrong-hash'; },
  'mismatched aggregate source hash': rows => { rows.find(r => r.episodeLevel === 'scene').sourceHash = 'wrong-source'; },
  'partial child range': rows => { rows.find(r => r.episodeLevel === 'scene').turnRange.end = 1; },
  'range outside transcript': rows => { rows.find(r => r.episodeLevel === 'scene').turnRange.end = 5; },
  'duplicate child': rows => { const r = rows.find(r => r.episodeLevel === 'scene'); r.childIds[1] = r.childIds[0]; r.childHashes[1] = r.childHashes[0]; },
  'inherited child source': rows => { const child = rows.find(r => r.id === rows.find(r => r.episodeLevel === 'scene').childIds[0]); child.inheritedSessionHistory = true; child.permanentSessionHistory = true; child.inheritedFromScopeKey = 'other-source'; },
  'wrong hierarchy child type': rows => { const parent = rows.find(r => r.episodeLevel === 'session'); const response = rows.find(r => r.sourceType === 'response'); parent.childIds[0] = response.id; parent.childHashes[0] = response.hash; }
};
for (const [name, change] of Object.entries(invalidCases)) test(`portable copy rejects ${name} before publishing a target`, async () => {
  const f = await seeded();
  try {
    const damaged = plain(f.records); change(damaged);
    await f.api._test.saveAllRecords(damaged, f.settings, f.scope);
    const envelope = await f.portable.exportCurrentScope();
    const sourceBefore = plain(storageForScope(f.pluginStorage, f.scope));
    f.target();
    const inspection = await f.portable.inspectRestoreOptions(envelope);
    await assert.rejects(() => f.portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' }),
      error => error.code === 'FLASHBACK_PORTABLE_CHAT_COPY_EPISODE_BINDING_INVALID');
    const target = await f.api._test.loadScopeRecords(inspection.target.scope.scopeKey);
    assert.equal(target.records.length, 0);
    assert.ok(!target.manifest.portableImportId);
    assert.equal((await f.api._test.loadTurnWorldline(inspection.target.scope.scopeKey)).nodes.length, 0);
    assert.deepEqual(plain(storageForScope(f.pluginStorage, f.scope)), sourceBefore);
  } finally { await f.cleanup(); }
});

test('portable eligibility still excludes static/manual non-response types', async () => {
  const f = await seeded();
  try {
    const episode = f.records.find(r => r.autoEpisode);
    for (const sourceType of ['lorebook', 'persona', 'character', 'manual', 'unknown']) {
      assert.equal(f.api._test.isRetainedMemoryRecord({ ...episode, sourceType }), false, sourceType);
    }
    assert.equal(f.api._test.isRetainedMemoryRecord({ ...episode, autoStatic: true }), false);
    assert.equal(f.api._test.isRetainedMemoryRecord({ ...episode, origin: 'manual_gui' }), false);
  } finally { await f.cleanup(); }
});

test('portable copy keeps inherited response and episode history sealed outside the live turn range', async () => {
  const f = await seeded();
  try {
    const oldSources = [11, 12].map(turn => ({ sourceType: 'response', sourceId: `older-history-${turn}`,
      text: `User:\nTell me the old story ${turn}.\n\n---\n\nAssistant:\nRowan remembers the ancient garden and the red compass ${turn}.`,
      turnIndex: turn, pairIndex: turn, sanitizeMemory: false }));
    const oldRows = await f.api._test.buildRecordsFromSources(oldSources, f.settings, f.scope);
    const oldEpisodes = f.api._test.buildEpisodeIndexRecords(oldRows, f.settings, f.scope);
    assert.equal(oldEpisodes.length, 1);
    const inherited = [...oldRows, ...oldEpisodes].map(row => ({ ...row,
      permanentSessionHistory: true, inheritedSessionHistory: true, inheritedFromScopeKey: 'sealed-prior-session',
      historicalProtection: 'permanent_session_history', retentionProtected: true, deletionProtected: true }));
    await f.api._test.saveAllRecords([...f.records, ...inherited], f.settings, f.scope);
    const envelope = await f.portable.exportCurrentScope();
    f.target();
    const inspection = await f.portable.inspectRestoreOptions(envelope);
    const result = await f.portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' });
    assert.equal(result.ok, true);
    assert.equal(result.activeTurns, 4);
    const loaded = await f.api._test.loadScopeRecords(inspection.target.scope.scopeKey);
    const archived = loaded.records.filter(row => row.inheritedSessionHistory);
    assert.equal(archived.length, inherited.length);
    for (const row of archived) {
      assert.equal(row.inheritedFromScopeKey, 'sealed-prior-session');
      assert.equal(row.permanentSessionHistory, true);
      assert.equal(row.deletionProtected, true);
      assert.ok(!row.turnNodeId);
    }
    assert.deepEqual(aggregateProjection(archived.find(r => r.autoEpisode)), aggregateProjection(oldEpisodes[0]));
  } finally { await f.cleanup(); }
});

test('portable aggregate copy publication failure rolls back target and preserves source', async () => {
  const f = await seeded();
  try {
    const envelope = await f.portable.exportCurrentScope();
    const sourceBefore = plain(storageForScope(f.pluginStorage, f.scope));
    const vectorsBefore = plain(storageForScope(f.safeLocalStorage, f.scope));
    f.target();
    const inspection = await f.portable.inspectRestoreOptions(envelope);
    const targetScope = inspection.target.scope;
    const write = f.pluginStorage.setItem.bind(f.pluginStorage);
    let injected = 0;
    f.pluginStorage.setItem = async (key, value) => {
      if (String(key).includes(`:scope:${targetScope.storageHash}:manifest`) && JSON.parse(typeof value === 'string' ? value : JSON.stringify(value)).count > 0) {
        injected++; throw new Error('fixture target publication rejected');
      }
      return write(key, value);
    };
    await assert.rejects(() => f.portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' }));
    assert.ok(injected > 0, 'the target manifest publication was actually attempted');
    f.pluginStorage.setItem = write;
    const target = await f.api._test.loadScopeRecords(targetScope.scopeKey);
    assert.equal(target.records.length, 0);
    assert.ok(!target.manifest.portableImportId);
    assert.equal((await f.api._test.loadTurnWorldline(targetScope.scopeKey)).nodes.length, 0);
    assert.deepEqual(plain(storageForScope(f.pluginStorage, f.scope)), sourceBefore);
    assert.deepEqual(plain(storageForScope(f.safeLocalStorage, f.scope)), vectorsBefore);
  } finally { await f.cleanup(); }
});

test('portable aggregate copy refuses an occupied destination without changing it', async () => {
  const f = await seeded();
  try {
    const envelope = await f.portable.exportCurrentScope();
    f.target();
    const inspection = await f.portable.inspectRestoreOptions(envelope);
    await f.portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' });
    const before = plain(storageForScope(f.pluginStorage, inspection.target.scope));
    const blocked = await f.portable.inspectRestoreOptions(envelope);
    assert.equal(blocked.modes.chat_copy_rebind.allowed, false);
    assert.equal(blocked.modes.chat_copy_rebind.reason, 'target_not_empty');
    await assert.rejects(() => f.portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' }),
      error => error.code === 'FLASHBACK_PORTABLE_CHAT_COPY_BLOCKED');
    assert.deepEqual(plain(storageForScope(f.pluginStorage, inspection.target.scope)), before);
  } finally { await f.cleanup(); }
});

if (process.env.FLASHBACK_EPISODE_ARTIFACTS) for (const kind of ['Full', 'Min']) {
  test(`portable aggregate copy uses actual ${kind} public API without test exports`, async () => {
    const seed = await seeded(); let artifact;
    try {
      const envelope = await seed.portable.exportCurrentScope();
      const artifactSource = fs.readFileSync(path.join(process.env.FLASHBACK_EPISODE_ARTIFACTS, kind, 'plugins/Flashback_Memory.js'), 'utf8');
      artifact = await fixture(artifactSource);
      assert.equal(artifact.api._test, undefined);
      artifact.target();
      const result = await artifact.portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' });
      assert.equal(result.ok, true);
      assert.equal(result.activeTurns, 4);
      const copiedEnvelope = await artifact.portable.exportCurrentScope();
      const inspection = await artifact.portable.inspectRestoreOptions(copiedEnvelope);
      const copied = inspection.payload.records.filter(r => r.autoEpisode);
      assert.equal(copied.length, 3);
      assert.equal(inspection.payload.records.length, seed.records.length);
      for (const row of copied) {
        assert.deepEqual(aggregateProjection(row), aggregateProjection(seed.records.find(r => r.id === row.id)));
        assert.ok(!row.turnIndex && !row.pairIndex && !row.turnNodeId);
      }
    } finally { await artifact?.cleanup(); await seed.cleanup(); }
  });
}
