'use strict';
// Current-contract regression: regeneration and derived-vector retry serialize on
// the same owner queue. saveManifest additionally performs a read-basis CAS.
// Observe only reads made inside the actual writer lock; context/preflight reads
// are not writers. The operation identity follows async continuations, never a
// mutable global tag. Hold the first real regeneration read until the competing
// retry has queued, then hold its provider to exercise the scan busy guard.
// LIBRA_REGENERATE_RACE_PLUGIN_SOURCE supports an external mutation control.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const targetPath = process.env.LIBRA_REGENERATE_RACE_PLUGIN_SOURCE
  ? path.resolve(process.env.LIBRA_REGENERATE_RACE_PLUGIN_SOURCE)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const { AsyncLocalStorage } = require('node:async_hooks');
const operation = new AsyncLocalStorage(), lock = new AsyncLocalStorage();
const queueRows = [], lockWindows = [];
const originalSource = fs.readFileSync(targetPath, 'utf8');
const marker = 'const next = previous.catch(() => null).then(task).finally(() => {';
assert.equal(originalSource.split(marker).length, 2, 'one observable owner queue');
const source = originalSource.replace(marker,
  'globalThis.__QUEUE_OBSERVE__(scopeKey); const next = previous.catch(() => null).then(() => globalThis.__LOCK_OBSERVE__(scopeKey, task)).finally(() => {');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const readRelease = deferred(), providerRelease = deferred();
let heldRead = false, holdProvider = false, providerHeldSeen = false;

const values = new Map();
let manifestKey = null;

// Every manifest read window, tagged by which operation was holding it.
const readWindows = [];

const storage = {
  async getItem(key) {
    const k = String(key);
    const isManifest = manifestKey && k === manifestKey;
    if (!isManifest) return values.has(k) ? values.get(k) : null;
    const record = { tag: operation.getStore() || 'background', scope: lock.getStore() || '', enter: performance.now(), exit: 0 };
    readWindows.push(record);
    if (record.tag === 'regeneration' && !heldRead) {
      heldRead = true; await readRelease.promise;
    }
    record.exit = performance.now();
    return values.has(k) ? values.get(k) : null;
  },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return Array.from(values.keys()); }
};

const chat = { id: 'regen-lock-chat', chatId: 'regen-lock-chat', name: 'Regen Lock', message: [], bindedPersona: '' };
for (let turn = 1; turn <= 12; turn += 1) {
  chat.message.push({ role: 'user', data: `User ${turn}`, chatId: `t${turn}-u` });
  chat.message.push({ role: 'assistant', data: `Alice signed agreement ${turn}.`, chatId: `t${turn}-a` });
}
chat.messages = chat.message;
const character = { id: 'regen-lock-character', name: 'Regen Lock', chatPage: 0, chats: [chat] };
const unloadHandlers = [];
const host = {
  pluginStorage: storage, safeLocalStorage: storage,
  async getLocalPluginStorage() { return storage; },
  async getArgument(name) {
    const key = String(name);
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    if (key.includes('enable_character_ito')) return 'false';
    if (key.includes('enable_plot_ito')) return 'false';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async runLLMModel(options) {
    if (holdProvider && operation.getStore() === 'regeneration') { providerHeldSeen = true; await providerRelease.promise; }
    const second = JSON.stringify(options).includes('[t6-u]');
    const turn = second ? 6 : 1;
    return { type: 'success', result: JSON.stringify(require('./fixtures/librarian_event_fixture.cjs')(`Alice signed agreement ${turn}.`, `t${turn}-a`)) };
  },
  async nativeFetch() { throw new Error('runtime test has no server'); },
  async onUnload(handler) { unloadHandlers.push(handler); return true; },
  async registerSetting() { return true; }, async unregisterSetting() { return true; },
  async registerButton() { return true; }, async unregisterButton() { return true; },
  async registerUIPart() { return true; }, async unregisterUIPart() { return true; },
  async addRisuReplacer() { return true; }, async removeRisuReplacer() { return true; },
  async addRisuChatListener() { return true; }, async removeRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; }, async removeRisuScriptHandler() { return true; },
  async addPluginChannelListener() { return true; }, async removePluginChannelListener() { return true; },
  async postPluginChannelMessage() { return true; },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
    return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, all[field] ?? null])) : all;
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
  async getCharacter() { return character; }, async getCharacterFromIndex() { return character; },
  async getChat() { return chat; }, async getCurrentChat() { return chat; }, async getChatFromIndex() { return chat; },
  async showContainer() { return true; }, async hideContainer() { return true; }, async getRootContainer() { return null; }, async getPluginRoot() { return null; }
};

const activeTimeouts = new Set(), activeIntervals = new Set();
const trackedSetTimeout = (h, d, ...a) => { let t; t = setTimeout((...i) => { activeTimeouts.delete(t); h(...i); }, d, ...a); activeTimeouts.add(t); return t; };
const trackedClearTimeout = t => { activeTimeouts.delete(t); clearTimeout(t); };
const trackedSetInterval = (h, d, ...a) => { const t = setInterval(h, d, ...a); activeIntervals.add(t); return t; };
const trackedClearInterval = t => { activeIntervals.delete(t); clearInterval(t); };

const context = vm.createContext({
  risuai: host,
  __QUEUE_OBSERVE__: scopeKey => queueRows.push({ scopeKey, tag: operation.getStore() || 'background' }),
  __LOCK_OBSERVE__: (scopeKey, task) => lock.run(scopeKey, async () => {
    const row = { scopeKey, tag: operation.getStore() || 'background', enter: performance.now(), exit: 0 }; lockWindows.push(row);
    try { return await task(); } finally { row.exit = performance.now(); }
  }),
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout,
  setInterval: trackedSetInterval, clearInterval: trackedClearInterval,
  queueMicrotask, AbortController, AbortSignal, DOMException,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
  performance: globalThis.performance, fetch: globalThis.fetch,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: globalThis.FormData, Blob: globalThis.Blob,
  atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null
});

const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { const v = predicate(); if (v) return v; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('LIBRA runtime load timed out');
};
const overlaps = (a, b) => a.enter < b.exit && b.enter < a.exit;

(async () => {
  vm.runInContext(source, context, { filename: 'LIBRA-regenerate-lock.js' });
  const api = await waitFor(() => context.__LIBRA__);
  await api.getLibraProviderConfig();

  const settings = await api.getLibraMemorySettings();
  await api.saveLibraMemorySettings({ ...settings, enableCharacterAide: false, enableWorldAide: false, enablePlotAide: false, stateTrackingEnabled: false });
  const setup = await api.runManualColdStart();
  assert.equal(setup.completed, 2, JSON.stringify(setup));
  await api.retryPendingUnifiedVectors();
  manifestKey = Array.from(values.keys()).find(k => k.startsWith('libra') && k.endsWith(':manifest'));
  assert.ok(manifestKey, 'scope manifest created');
  const manifest0 = JSON.parse(values.get(manifestKey));
  const ref = manifest0.memories['6'];
  assert.equal(ref.status, 'committed', 'T6 canonical really committed');
  const canonicalBytes = values.get(ref.key), sourceBytes = JSON.stringify(chat);
  const canonicalRefs = JSON.stringify(manifest0.memories);
  holdProvider = true;

  // --- the race ---
  readWindows.length = 0;
  const regeneration = operation.run('regeneration', () => api.regenerateCanonicalMemory({ startTurn: 6, memoryId: ref.memoryId, revision: ref.revision }));
  await waitFor(() => heldRead);
  const competing = operation.run('competing', () => api.retryPendingUnifiedVectors());
  await waitFor(() => queueRows.some(row => row.tag === 'competing' && row.scopeKey === manifest0.scopeKey));
  // Capture queue entry before releasing the held read. This asserts actual queue
  // contention without relying on scheduling offsets or arbitrary read delays.
  assert.equal(lockWindows.some(row => row.tag === 'competing'), false, 'retry waits for regeneration owner lock');
  readRelease.resolve();
  await waitFor(() => providerHeldSeen);
  await assert.rejects(api.scanMemoryNow(), /canonical_job_busy/, 'scan refuses while regeneration provider is held');
  providerRelease.resolve();
  const [regenResult, competingResult] = await Promise.all([regeneration, competing]);
  assert.equal(regenResult.state, 'awaiting_choice', JSON.stringify(regenResult));
  const scan = await api.scanMemoryNow();
  assert.ok(['completed', 'completed_with_warnings'].includes(scan.state), JSON.stringify(scan));
  assert.equal(values.get(ref.key), canonicalBytes, 'candidate generation and retry preserve active canonical bytes');
  assert.equal(JSON.stringify(chat), sourceBytes, 'source unchanged');
  assert.equal(JSON.stringify(JSON.parse(values.get(manifestKey)).memories), canonicalRefs, 'canonical refs and derived vector metadata preserved');

  const regenReads = readWindows.filter(w => w.tag === 'regeneration' && w.scope === manifest0.scopeKey);
  const competingReads = readWindows.filter(w => w.tag === 'competing' && w.scope === manifest0.scopeKey);
  let overlapPairs = 0;
  for (const a of regenReads) for (const b of competingReads) if (overlaps(a, b)) overlapPairs += 1;

  const report = {
    test: 'libra_canonical_regeneration_lock_serialization',
    regenerationManifestReads: regenReads.length,
    competingManifestReads: competingReads.length,
    overlappingReadWindows: overlapPairs,
    regenerationState: regenResult.state,
    competingCompleted: competingResult.ok,
    scanAfterRelease: scan.state
  };
  console.log(JSON.stringify(report, null, 1));

  // Non-vacuity guards.
  assert.ok(regenReads.length >= 1,
    'the regeneration really read the scope manifest (it reached the locked section)');
  assert.ok(competingReads.length >= 1,
    'the competing operation really read the scope manifest (it was actually attempted)');
  assert.equal(competingResult.ok, true,
    'the competing operation completed — no deadlock from the added lock');
  assert.equal(overlapPairs, 0,
    `same-scope writers must not overlap inside the scope lock (observed ${overlapPairs} overlapping manifest-read windows)`);

  for (const handler of unloadHandlers.slice().reverse()) { try { await handler(); } catch (_) {} }
  for (const t of activeTimeouts) clearTimeout(t);
  for (const t of activeIntervals) clearInterval(t);
  process.stdout.write('libra_canonical_regeneration_lock_serialization_test: PASS\n');
})().catch(error => {
  for (const t of activeTimeouts) clearTimeout(t);
  for (const t of activeIntervals) clearInterval(t);
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
