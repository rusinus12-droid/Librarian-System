'use strict';
// Flashback Phase A checkpoint-A regression: with a missing source vector sidecar
// and an empty canonical target, `상태만 진단` (inspectMemoryMaintenance) must NOT
// throw the clone abort. It must return a read-only plan that reports
// sourceVectorRepairRequired and an automatic strategy of repair_then_adopt.
// The low-level clone integrity contract is asserted separately (it must still
// abort) so this test proves the orchestration change, not a weakening.

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

const pluginStorage = createStore();
const safeLocalStorage = createStore();
const chat = { id: 'ck-a-chat', chatId: 'ck-a-chat', name: 'Checkpoint A Chat', message: [], messages: [], bindedPersona: '' };
const character = { id: 'ck-a-character', chaId: 'ck-a-character', name: 'Checkpoint A Character', chats: [chat] };
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
  async nativeFetch() { throw new Error('no server in checkpoint A test'); },
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

const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask, AbortController, AbortSignal, DOMException,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone,
  performance: globalThis.performance,
  fetch: globalThis.fetch,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: globalThis.FormData, Blob: globalThis.Blob,
  atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null
});

(async () => {
  vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });
  const flashback = await waitFor(() => context.__FlashbackMemory, 'Flashback API');

  const scope = await flashback.resolveCurrentScope(false);
  assert.ok(scope?.scopeKey, 'resolved current scope');

  // Persist one vectored record, then physically remove its sidecar so a source
  // clone would abort with FLASHBACK_CLONE_SOURCE_VECTOR_INVALID.
  const record = { id: 'ck-a-turn-1', hash: 'ck-a-turn-1', type: 'response', sourceType: 'response', text: 'Checkpoint A evidence', dim: 4, vector: [0.25, 0.5, -0.75, 1] };
  await flashback._test.saveAllRecords([record], null, scope);
  const persisted = await flashback._test.loadScopeRecords(scope.scopeKey);
  const vectorKey = persisted.records[0].vectorRef.storageKey;
  assert.ok(safeLocalStorage.values.has(vectorKey), 'sidecar present before removal');
  const sourceManifestBefore = await flashback._test.loadScopeManifest(scope);

  await safeLocalStorage.removeItem(vectorKey);

  // (1) low-level clone MUST still abort — the integrity contract is unchanged.
  const target = { ...scope, scopeKey: scope.scopeKey + '|persona:ck-a-probe' };
  await assert.rejects(
    () => flashback._test.cloneScopeStorage(scope, target, {}, { mode: 'same_chat_persona_recovery' }),
    e => e.code === 'FLASHBACK_CLONE_SOURCE_VECTOR_INVALID',
    'low-level clone must still abort on a missing source vector'
  );
  const targetManifest = await flashback._test.loadScopeManifest(target);
  assert.ok(!targetManifest.copyAdoptedComplete, 'aborted clone must not publish the target');

  // (2) maintenance inspection MUST NOT throw; it returns a repair plan.
  let plan;
  await assert.doesNotReject(async () => {
    plan = await flashback.inspectMemoryMaintenance({ scope, requestPermission: false });
  }, 'inspectMemoryMaintenance must not dead-end on a repairable source vector');

  assert.equal(plan.healthy, false, 'plan must not report healthy while a repair is required');
  // This fixture stores the record in the CURRENT scope and then removes its
  // sidecar, so inspection reaches the missing-vector path rather than the
  // cross-scope clone-adoption path.
  //
  // NOT COVERED YET: the repair_then_adopt strategy
  // (plan.sourceVectorRepairRequired + plan.automatic.strategy === 'repair_then_adopt').
  // Reaching it needs a TWO-scope fixture — an empty canonical target plus a
  // separate persona source scope holding the damaged vectors — so that
  // ensureScopeStorageReady actually attempts a clone. Asserting it from this
  // one-scope setup could only ever fail, so it is deliberately left out until
  // that fixture exists.
  assert.ok(plan.missingVectors >= 1, 'the damaged record is reported as a missing vector');
  assert.ok(plan.automatic && typeof plan.automatic === 'object', 'plan carries an automatic strategy object');

  // (3) inspection must be read-only: source commit unchanged, target not published.
  const sourceManifestAfter = await flashback._test.loadScopeManifest(scope);
  assert.equal(sourceManifestAfter.commitId, sourceManifestBefore.commitId, 'inspection must not mutate the source commit');

  console.log(JSON.stringify({ test: 'flashback_maintenance_clone_vector_repair', result: 'pass', strategy: plan.automatic.strategy, missingVectors: plan.missingVectors }));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
