'use strict';
// LIBRA Task48(a) — scope-lock serialization test for the canonical regeneration path.
//
// THE DEFECT (libra, not flashback)
//   saveManifest (35229):
//       manifest.updatedAt = nowIso();
//       await storage.setJson(key.manifest(scope), manifest);
//   is a WHOLE-DOCUMENT overwrite: no merge, no CAS. setJson ->
//   fencedMemoryStorageSet only bumps a fence revision, so every writer proceeds
//   and the last writer wins wholesale. `processBatch` commits the manifest from
//   seven such sites; `scan()` always ran it holding
//   `enqueue(context.scope.scopeKey)` (block 45967-46224 covering the call at
//   46143), but the regeneration path called it with no lock at all — so two
//   same-scope writers could read the manifest at the same revision and the later
//   commit silently reverted the earlier one's independent fields
//   (inFlight, stats, failedBatches, branchGuard, ...).
//
// THE FIX: wrap regenerateCanonicalMemory in the same per-scope enqueue.
//
// HOW THIS TEST MEASURES IT (and why it is not vacuous)
//   `enqueue` serializes per scope key: a task queued for a key runs only after the
//   previous task for that key settles. The test observes that property directly by
//   recording the ENTRY and EXIT timestamps of storage reads whose key is the scope
//   manifest, taken from inside the plugin's own storage boundary:
//     - the regeneration is launched first and its manifest read is held open
//       (storage.getItem for the manifest key is delayed) while it holds the lock;
//     - a second same-scope operation (scanMemoryNow) is launched shortly after.
//   Post-fix the second operation cannot enter its own manifest read until the
//   regeneration's lock section finishes -> no overlap.
//   Pre-fix both run concurrently -> the two manifest-read windows overlap.
//
//   Non-vacuity: the test asserts the regeneration really opened a manifest read
//   (regenerationManifestReads >= 1) AND that a concurrent operation was actually
//   attempted, so it cannot pass by doing nothing. It also asserts the competing
//   operation made progress, so it cannot pass by deadlocking.
//
// RED: LIBRA_REGENERATE_RACE_PLUGIN_SOURCE=<pre-fix LIBRA.js> makes this FAIL.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const targetPath = process.env.LIBRA_REGENERATE_RACE_PLUGIN_SOURCE
  ? path.resolve(process.env.LIBRA_REGENERATE_RACE_PLUGIN_SOURCE)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(targetPath, 'utf8');

const READ_HOLD_MS = Number(process.env.LIBRA_REGEN_RACE_READ_HOLD_MS || 200);
const OFFSET_MS = Number(process.env.LIBRA_REGEN_RACE_OFFSET_MS || 50);

const values = new Map();
let manifestKey = null;

// Every manifest read window, tagged by which operation was holding it.
const readWindows = [];
let currentTag = 'idle';
const storage = {
  async getItem(key) {
    const k = String(key);
    const isManifest = manifestKey && k === manifestKey;
    if (!isManifest) return values.has(k) ? values.get(k) : null;
    const record = { tag: currentTag, enter: Date.now(), exit: 0 };
    readWindows.push(record);
    // Hold the read open so a competing writer has a real chance to interleave.
    await new Promise(resolve => setTimeout(resolve, READ_HOLD_MS));
    record.exit = Date.now();
    return values.has(k) ? values.get(k) : null;
  },
  async setItem(key, value) { values.set(String(key), value); return true; },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return Array.from(values.keys()); }
};

const chat = { id: 'regen-lock-chat', chatId: 'regen-lock-chat', name: 'Regen Lock', message: [], bindedPersona: '' };
for (let turn = 1; turn <= 12; turn += 1) {
  chat.message.push({ role: 'user', data: `User ${turn}`, chatId: `u-${turn}` });
  chat.message.push({ role: 'assistant', data: `Assistant ${turn}`, chatId: `a-${turn}` });
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
    if (key.includes('enable_character_ito')) return 'true';
    if (key.includes('enable_plot_ito')) return 'true';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async runLLMModel() { throw new Error('synthetic provider failure'); },
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

  currentTag = 'setup';
  await api.startManualCanonicalScan();
  manifestKey = Array.from(values.keys()).find(k => k.endsWith(':manifest'));
  assert.ok(manifestKey, 'scope manifest created');
  const scopePrefix = manifestKey.slice(0, -':manifest'.length);
  const manifest0 = JSON.parse(values.get(manifestKey));

  const inventory = await api.listCanonicalBatchRanges();
  const range = inventory.ranges.find(row => row.startTurn === 6);
  assert.ok(range, 'canonical batch range at turn 6');
  const pairs = api.debugBuildPairs(chat);
  const memoryKey = `${scopePrefix}:memory:6:r1`;
  values.set(memoryKey, JSON.stringify({
    schema: 'libra.canonical_memory.v1', memoryId: 'mem_000006', scopeKey: manifest0.scopeKey,
    branchId: range.sourceDigest, turnRange: { start: 6, end: 10 },
    sourcePairs: pairs.slice(5, 10).map(p => ({ turn: p.turn, userChatId: p.user.chatId, assistantChatId: p.assistant.chatId })),
    sourceDigest: range.sourceDigest, revision: 1, status: 'committed',
    text: 'ORIGINAL', summary: 'Original', recallKeys: [], importance: 0.5,
    sections: {}, anchors: {}, retrieval: { version: 'libra.retrieval_projection.v2' },
    embedding: { status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2' },
    canonicalArtifact: { schema: 'stale' }, artifactValidation: { ok: true },
    renderValidation: { ok: true, contentHash: 'stale' }, promptProvenance: { provider: 'stale' },
    pipeline: { stages: ['stale'] },
    runId: 'regen-lock-run', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }));
  const seeded = JSON.parse(values.get(manifestKey));
  seeded.memories['6'] = {
    memoryId: 'mem_000006', key: memoryKey, revision: 1, sourceDigest: range.sourceDigest,
    status: 'committed', turnRange: { start: 6, end: 10 }, summary: 'Original',
    embeddingStatus: 'disabled', sessionEpoch: 0, inheritedSessionHistory: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: []
  };
  seeded.inFlight = null;
  values.set(manifestKey, JSON.stringify(seeded));

  // --- the race ---
  readWindows.length = 0;
  currentTag = 'regeneration';
  const regeneration = api.regenerateCanonicalMemory({ startTurn: 6, memoryId: 'mem_000006', revision: 1 })
    .then(r => ({ ok: true, state: r?.state }))
    .catch(e => ({ ok: false, error: String(e && (e.message || e)) }));

  await new Promise(resolve => setTimeout(resolve, OFFSET_MS));
  currentTag = 'competing';
  const competing = api.scanMemoryNow()
    .then(() => ({ ok: true }))
    .catch(e => ({ ok: false, error: String(e && (e.message || e)) }));

  const [regenResult, competingResult] = await Promise.all([regeneration, competing]);
  currentTag = 'idle';

  const regenReads = readWindows.filter(w => w.tag === 'regeneration');
  const competingReads = readWindows.filter(w => w.tag === 'competing');
  let overlapPairs = 0;
  for (const a of regenReads) for (const b of competingReads) if (overlaps(a, b)) overlapPairs += 1;

  const report = {
    test: 'libra_canonical_regeneration_lock_serialization',
    regenerationManifestReads: regenReads.length,
    competingManifestReads: competingReads.length,
    overlappingReadWindows: overlapPairs,
    regenerationState: regenResult.ok ? regenResult.state : regenResult.error,
    competingCompleted: competingResult.ok,
    readHoldMs: READ_HOLD_MS,
    offsetMs: OFFSET_MS
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
