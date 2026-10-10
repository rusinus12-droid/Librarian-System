'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const { awaitScopeRetirement } = require('./fixtures/flashback_retirement_lifecycle.cjs');
const originalSource = fs.readFileSync(pluginPath, 'utf8');
const exposure = '  globalThis.__FlashbackMemory = publicApi;';
assert.equal(originalSource.split(exposure).length, 2, 'fixture lifecycle exposure marker is unique');
// Test-only Runtime access, never part of the shipping plugin.
const source = originalSource.replace(exposure, '  globalThis.__portableFixtureRuntime = Runtime;\n' + exposure);

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

let releaseKeysBarrier, exportInFlight, concurrentSave;
(async () => {
 try {
  vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });
  const flashback = await waitFor(() => context.__FlashbackMemory, 'Flashback API');
  const portable = await waitFor(() => context.__FlashbackPortableMemoryBackup, 'Flashback portable API');
  assert.equal(flashback.version, source.match(/^[\/][\/]@version\s+(\S+)/m)[1]);
  assert.equal(portable.pluginVersion, source.match(/^[\/][\/]@version\s+(\S+)/m)[1]);

  await waitFor(() => flashback.uiStatus().registered.after, 'Flashback initialization');
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

  const commitShardKey = `vector_rag_memory:scope:${initialSaved.manifest.storageHash}:records:commit:${initialSaved.manifest.commitId}:shard:0000`;
  const legacyShardKey = `vector_rag_memory:scope:${initialSaved.manifest.storageHash}:records:shard:0000`;
  const activeCommitShard = await pluginStorage.getItem(commitShardKey);
  assert.ok(activeCommitShard, 'active commit shard exists before compatibility relocation');
  await pluginStorage.setItem(legacyShardKey, activeCommitShard);
  await pluginStorage.removeItem(commitShardKey);
  const legacyFallbackLoaded = await flashback._test.loadScopeRecords(scope.scopeKey);
  assert.equal(legacyFallbackLoaded.records.length, 1, 'runtime accepts commit-matching legacy shard fallback');

  await awaitScopeRetirement(context.__portableFixtureRuntime, scope.scopeKey);
  pluginStorage.keysBarrier = new Promise(resolve => { releaseKeysBarrier = resolve; });
  exportInFlight = portable.exportCurrentScope();
  await waitFor(() => portable.status().busy && portable.status().operationId, 'portable operation gate');
  await waitFor(() => pluginStorage.keysBarrierEntries > 0, 'portable export scope-lock barrier');
  await assert.rejects(
    () => flashback.runMemoryMaintenance('auto'),
    error => error?.code === 'FLASHBACK_PORTABLE_MEMORY_BUSY',
    'maintenance rejects concurrent portable backup work'
  );
  await assert.rejects(
    () => portable.exportCurrentScope(),
    error => error?.code === 'FLASHBACK_PORTABLE_MEMORY_BUSY',
    'a second portable operation cannot overlap the first'
  );
  let concurrentSaveSettled = false;
  concurrentSave = flashback._test.saveAllRecords([{
    ...originalRecord,
    id: 'portable-concurrent-turn',
    hash: 'portable-concurrent-turn',
    text: 'This commit must wait until portable export releases the scope lock.'
  }], null, scope).then(result => {
    concurrentSaveSettled = true;
    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(concurrentSaveSettled, false, 'scope commit waits while portable export snapshots records and sidecars');
  releaseKeysBarrier();
  pluginStorage.keysBarrier = null;
  const envelope = await exportInFlight;
  const concurrentSaved = await concurrentSave;
  assert.equal(concurrentSaveSettled, true, 'scope commit resumes after portable export releases its lock');
  assert.equal(concurrentSaved.manifest.count, 1, 'deferred scope commit completes durably');
  assert.equal(portable.status().busy, false, 'portable operation gate releases after export');
  assert.equal(portable.status().operationId, '', 'portable operation id clears after export');
  assert.equal(envelope.source.scopeKey, scope.scopeKey, `portable lock scope must match the canonical Flashback scope (portable=${envelope.source.scopeKey}, canonical=${scope.scopeKey})`);
  assert.equal(envelope.plugin.version, source.match(/^[\/][\/]@version\s+(\S+)/m)[1], 'envelope carries real plugin version');
  assert.ok(envelope.records.some(record => record.key === legacyShardKey), 'portable export preserves the active commit-matching legacy shard fallback');
  assert.ok(!envelope.records.some(record => record.key === commitShardKey), 'portable export does not invent a missing commit shard');
  assert.equal(envelope.inventory.localVectorSidecarCount, 1, 'one local vector sidecar exported');
  assert.equal(envelope.inventory.vectorReferenceCount, 1, 'one vector reference accounted');
  assert.equal(envelope.localVectorSidecars.length, 1, 'sidecar payload embedded in JSON envelope');
  assert.equal(envelope.localVectorSidecars[0].key, vectorKey, 'sidecar key preserved');
  assert.ok(envelope.localVectorSidecars[0].value?.data, 'sidecar Float32 base64 payload present');

  await safeLocalStorage.removeItem(vectorKey);
  assert.equal(await safeLocalStorage.getItem(vectorKey), null, 'sidecar removed before restore');

  const restored = await portable.restoreCurrentScope(envelope);
  assert.equal(restored.ok, true);
  assert.equal(restored.vectorSidecars, 1);
  assert.equal(restored.vectorReferences, 1);
  assert.ok(await safeLocalStorage.getItem(vectorKey), 'JSON-only restore recreated sidecar');

  const hydrated = await flashback._test.hydrateFlashbackVectorRecords(persisted.records);
  assert.equal(hydrated.missingPayloads, 0, 'restored vector ref resolves');
  assert.deepEqual(Array.from(hydrated.records[0].vector), originalRecord.vector, 'restored Float32 vector values match source');

  // Rollback path: no sidecar exists before restore; sidecar write succeeds, then pluginStorage fails.
  await safeLocalStorage.removeItem(vectorKey);
  pluginStorage.failWrites = true;
  await assert.rejects(() => portable.restoreCurrentScope(envelope), /simulated_plugin_storage_write_failure|portable_backup_write_rejected/);
  pluginStorage.failWrites = false;
  assert.equal(await safeLocalStorage.getItem(vectorKey), null, 'failed restore rolls newly written sidecar back');

  console.log('flashback_portable_vector_sidecar_test: PASS');
 } finally {
  releaseKeysBarrier?.(); pluginStorage.keysBarrier = null;
  await Promise.allSettled([exportInFlight, concurrentSave].filter(Boolean));
  for (const handler of unloadHandlers) await handler().catch(() => {});
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
 }
})().catch(error => {
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  console.error(error);
  process.exitCode = 1;
});
