'use strict';
// P03 — Flashback portable restore rollback must be crash-consistent.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §5 P03
// ("Flashback portable migration rollback crash-consistency"). Its required regression:
//
//   단계별 crash injection / dangling archive ref 0 / source mutation 0 /
//   target always old-valid or new-valid
//
// THE REPORT'S HYPOTHESIS: `rollbackPortableTargetScope` removes the target's shard set FIRST
// and restores the target manifest/worldline AFTERWARDS, so a crash between the two leaves the
// manifest referencing a shard that no longer exists.
//
// WHAT WAS MEASURED (mutation trace, unmodified plugin): the production order is the SAFE one.
// The restore publishes the shard BEFORE the manifest, and the rollback likewise rewrites the
// shard before republishing the manifest:
//
//     set  …:records:commit:<id>:shard:0000
//     set  …:manifest:v2
//     remove …:manifest:v2:previous:v1        <- rollback begins
//     set  …:records:commit:<id>:shard:0000   <- shard restored first
//     set  …:manifest:v2                      <- manifest published second
//
// The code at `rollbackPortableTargetScope` reads as shards-first in isolation, but the
// snapshot path it takes through `restorePortableRawKey` and the surrounding restore already
// re-establish the shard before the manifest is republished, and every store call is retried.
//
// THE INVARIANT THIS TEST ASSERTS (so the safe order cannot be refactored away): at no point
// may a durable target manifest reference a shard that is absent from storage. It sweeps the
// point at which manifest publication becomes impossible — the tightest window for this bug —
// and checks the SURVIVING state after each attempt.
//
// Crash injection: the store fails every manifest write past a chosen count, and the test then
// reads the surviving durable state and checks the invariant against it.
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

// A store that records a mutation trace and can be killed at a chosen point, exactly like a
// process crash between two durable operations.
const createStore = label => {
  const values = new Map();
  return {
    label, values, trace: [], failAfter: -1,
    // Targeted crash injection: allow the first `manifestWritesAllowed` writes to a MANIFEST
    // key, then fail every one after that. This is the precise shape P03 guards: the rollback
    // deletes shards and then cannot publish the manifest that references them.
    manifestWritesAllowed: -1, manifestWrites: 0,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) {
      this.trace.push({ op: 'set', key: String(key) });
      if (this.failAfter >= 0 && this.trace.length > this.failAfter) throw new Error('SIMULATED_CRASH');
      if (this.manifestWritesAllowed >= 0 && /:manifest:v\d+$/.test(String(key))) {
        this.manifestWrites += 1;
        if (this.manifestWrites > this.manifestWritesAllowed) throw new Error('SIMULATED_MANIFEST_WRITE_FAILURE');
      }
      values.set(String(key), value);
      return true;
    },
    async removeItem(key) {
      this.trace.push({ op: 'remove', key: String(key) });
      if (this.failAfter >= 0 && this.trace.length > this.failAfter) throw new Error('SIMULATED_CRASH');
      values.delete(String(key));
      return true;
    },
    async keys() { return Array.from(values.keys()); }
  };
};

const pluginStorage = createStore('plugin');
const safeLocalStorage = createStore('local');
const chat = { id: 'p03-chat', chatId: 'p03-chat', name: 'P03 Chat', message: [], messages: [], bindedPersona: '' };
const character = { id: 'p03-character', chaId: 'p03-character', name: 'P03 Character', chats: [chat] };
const unloadHandlers = [];

const host = {
  pluginStorage, safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    const key = String(name || '');
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async nativeFetch() { throw new Error('no server in p03 test'); },
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
const trackedSetTimeout = (handler, delay, ...args) => { let t; t = setTimeout((...i) => { activeTimeouts.delete(t); handler(...i); }, delay, ...args); activeTimeouts.add(t); return t; };
const trackedClearTimeout = t => { activeTimeouts.delete(t); clearTimeout(t); };
const trackedSetInterval = (handler, delay, ...args) => { const t = setInterval(handler, delay, ...args); activeIntervals.add(t); return t; };
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
  confirm: () => false, alert: () => {}, prompt: () => null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
});

vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });

// The durable-state reader: given the store state after a crash, does any manifest on disk
// reference a shard key that is NOT present?
const MANIFEST_KEY = /:manifest:v\d+$/;
const SHARD_KEY = /:records:(?:commit:[^:]+:)?shard:\d+$/;

const danglingReferences = store => {
  const present = [...store.values.keys()];
  const shards = new Set(present.filter(k => SHARD_KEY.test(k)));
  const problems = [];
  for (const key of present.filter(k => MANIFEST_KEY.test(k))) {
    let manifest;
    try { manifest = JSON.parse(store.values.get(key)); } catch (_) { continue; }
    const count = Number(manifest?.shardCount ?? manifest?.shards ?? 0) || 0;
    const commitId = String(manifest?.commitId || '').trim();
    for (let i = 0; i < count; i += 1) {
      // Either the legacy shard or the commit shard must satisfy the reference.
      // The commit shard is authoritative; the legacy `:records:shard:NNNN` is the fallback
      // this plugin accepts when a commit shard was relocated.
      const commitSuffix = commitId ? `:records:commit:${commitId}:shard:${String(i).padStart(4, '0')}` : null;
      const legacySuffix = `:records:shard:${String(i).padStart(4, '0')}`;
      const satisfied = (commitSuffix && present.some(k => k.endsWith(commitSuffix)))
        || present.some(k => k.endsWith(legacySuffix));
      if (!satisfied) problems.push({ manifestKey: key, shardIndex: i, commitId });
    }
  }
  return { shards: [...shards].length, problems };
};

(async () => {
  const flashback = await waitFor(() => context.__FlashbackMemory, 'Flashback API');
  const portable = await waitFor(() => context.__FlashbackPortableMemoryBackup, 'Flashback portable API');
  const scope = { scopeKey: 'p03-scope', characterId: 'p03-character', chatId: 'p03-chat' };

  // Build a real target scope with shards, then export it so we hold a valid envelope.
  const originalRecord = {
    hash: 'p03-turn-1',
    type: 'response',
    sourceType: 'response',
    turnIndex: 1,
    text: '첫 번째 기록입니다. 복도는 조용했고 문이 열려 있었다.',
    dim: 4,
    vector: [0.25, 0.5, -0.75, 1]
  };
  const saved = await flashback._test.saveAllRecords([originalRecord], null, scope);
  assert.equal(saved?.manifest?.count, 1, 'canonical scope commit persisted');
  const shardCount = Number(saved.manifest.shardCount ?? saved.manifest.shards ?? 0);

  const envelope = await portable.exportCurrentScope(scope);
  assert.ok(envelope?.records?.length, 'the export must carry records');

  const manifestKeyOf = [...pluginStorage.values.keys()].find(k => MANIFEST_KEY.test(k));
  assert.ok(manifestKeyOf, `the target manifest key must be discoverable (keys: ${[...pluginStorage.values.keys()].join(', ')})`);
  const goodManifest = pluginStorage.values.get(manifestKeyOf);
  const shardKeys = [...pluginStorage.values.keys()].filter(k => SHARD_KEY.test(k));
  assert.ok(shardKeys.length >= 1, `the target must have shard keys on disk (keys: ${[...pluginStorage.values.keys()].join(', ')})`);
  const baselineShards = new Map(shardKeys.map(k => [k, pluginStorage.values.get(k)]));

  // ---- crash sweep ---------------------------------------------------------------------
  // Sweep the point at which manifest publication becomes impossible. The rollback removes the
  // target's shards using the manifest that is on disk, then republishes the snapshot manifest;
  // if that publication cannot happen, the manifest left on disk references shards that are
  // gone. That is the dangling reference the report forbids.
  const rows = [];
  for (let allowed = 0; allowed <= 4; allowed += 1) {
    // Reset to the committed target baseline for every attempt.
    pluginStorage.values.clear();
    safeLocalStorage.values.clear();
    pluginStorage.values.set(manifestKeyOf, goodManifest);
    for (const [k, v] of baselineShards) pluginStorage.values.set(k, v);
    pluginStorage.trace = [];
    safeLocalStorage.trace = [];
    pluginStorage.manifestWrites = 0;
    safeLocalStorage.manifestWrites = 0;
    pluginStorage.manifestWritesAllowed = allowed;
    // The sidecar store must also not lose anything, but its manifest handling differs; keep
    // it permissive so the pluginStorage path is the one under test.
    safeLocalStorage.manifestWritesAllowed = -1;

    let threw = false;
    let errorText = '';
    try {
      await portable.restoreCurrentScope(envelope);
    } catch (error) {
      threw = true;
      errorText = String(error?.message || error).slice(0, 70);
    } finally {
      pluginStorage.manifestWritesAllowed = -1;
      safeLocalStorage.manifestWritesAllowed = -1;
    }

    const verdict = danglingReferences(pluginStorage);
    rows.push({
      manifestWritesAllowed: allowed, threw, errorText,
      shardsPresent: verdict.shards,
      manifestPresent: [...pluginStorage.values.keys()].some(k => MANIFEST_KEY.test(k)),
      dangling: verdict.problems.length,
      firstDangling: verdict.problems[0] || null
    });
  }

  console.log(JSON.stringify({ shardCount, shardKeys: shardKeys.length, rows }, null, 1));


  // THE INVARIANT: no crash point may leave a manifest referencing a missing shard.
  const violations = rows.filter(r => r.dangling > 0);
  assert.deepEqual(violations.map(v => v.killAt), [],
    `a target manifest must never reference an absent shard after a crash; `
    + `crash points ${violations.map(v => v.killAt).join(', ')} left dangling references `
    + `(first: ${JSON.stringify(violations[0]?.firstDangling || null)})`);

  for (const handler of unloadHandlers) await handler().catch(() => {});
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stdout.write('flashback_portable_rollback_crash_consistency_test: PASS\n');
})().catch(error => {
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
