'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const requestedSource = process.argv[2]
  || process.env.LIBRA_SOURCE_PATH
  || process.env.LIBRA_TEST_SOURCE_PATH
  || path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const sourcePath = path.resolve(requestedSource);
const source = fs.readFileSync(sourcePath, 'utf8');

assert.match(source, /const mutateStateWorldline = async/, 'worldline transaction core is required');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA runtime load timed out');
};

const captureError = async callback => {
  let caught = null;
  try { await callback(); }
  catch (error) { caught = error; }
  assert.ok(caught, 'operation must reject');
  return caught;
};

const createHarness = async () => {
  const values = new Map();
  const faults = { get: null, set: null, remove: null };
  const calls = { get: [], set: [], remove: [] };

  const storage = {
    async getItem(keyValue) {
      const key = String(keyValue);
      calls.get.push(key);
      const action = faults.get ? await faults.get({ key, values, calls }) : null;
      if (action?.throw) throw action.throw;
      if (hasOwn(action, 'value')) return action.value;
      return values.has(key) ? values.get(key) : null;
    },
    async setItem(keyValue, value) {
      const key = String(keyValue);
      calls.set.push(key);
      const action = faults.set ? await faults.set({ key, value, values, calls }) : null;
      if (action?.throw) throw action.throw;
      if (!action?.handled) values.set(key, value);
      return hasOwn(action, 'result') ? action.result : true;
    },
    async removeItem(keyValue) {
      const key = String(keyValue);
      calls.remove.push(key);
      const action = faults.remove ? await faults.remove({ key, values, calls }) : null;
      if (action?.throw) throw action.throw;
      if (!action?.handled) values.delete(key);
      return hasOwn(action, 'result') ? action.result : true;
    },
    async keys() { return Array.from(values.keys()); }
  };

  const chat = {
    id: 'worldline-transaction-chat',
    chatId: 'worldline-transaction-chat',
    name: 'Worldline Transaction',
    message: [],
    bindedPersona: ''
  };
  for (let turn = 1; turn <= 5; turn += 1) {
    chat.message.push({ role: 'user', data: `User ${turn}`, chatId: `u-${turn}` });
    chat.message.push({ role: 'assistant', data: `Assistant ${turn}`, chatId: `a-${turn}` });
  }
  chat.messages = chat.message;
  const character = { id: 'worldline-transaction-character', name: 'Worldline Transaction', chatPage: 0, chats: [chat] };
  const unloadHandlers = [];
  const host = {
    pluginStorage: storage,
    safeLocalStorage: storage,
    async getLocalPluginStorage() { return storage; },
    async getArgument(name) {
      const key = String(name);
      if (key.includes('memory_suite_server_mode')) return 'plugin_only';
      if (key.includes('enable_gui')) return 'false';
      if (key.includes('enable_character_ito') || key.includes('enable_world_ito')) return 'true';
      return '';
    },
    async getArg(name) { return this.getArgument(name); },
    async setArgument() { return true; },
    async nativeFetch() { throw new Error('worldline transaction test has no server or provider'); },
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
    async showContainer() { return true; }, async hideContainer() { return true; },
    async getRootContainer() { return null; }, async getPluginRoot() { return null; }
  };

  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  const trackedSetTimeout = (handler, delay, ...args) => {
    let timer;
    timer = setTimeout((...inner) => {
      activeTimeouts.delete(timer);
      handler(...inner);
    }, delay, ...args);
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

  vm.runInContext(source, context, { filename: sourcePath });
  const api = await waitFor(() => context.__LIBRA__);
  const emptyJournal = await api.getWorldManagerCorrections();
  const scopeKey = String(emptyJournal?.scopeKey || '');
  assert.ok(scopeKey, 'runtime must expose the resolved scope through the correction store');

  const prefix = `libra:v1:scope:${scopeKey}`;
  const keys = {
    manifest: `${prefix}:manifest`,
    memory: `${prefix}:memory:1:r1`,
    delta: `${prefix}:continuity-delta:worldline_mem_1:r1`,
    meta: `${prefix}:state-worldline-meta:v1`,
    journal: `${prefix}:state-corrections:v2`,
    head: `${prefix}:continuity-state`,
    cache: `${prefix}:state-replay-cache:v1`,
    errors: `${prefix}:state-replay-errors:v1`
  };

  const putJson = (key, value) => values.set(String(key), JSON.stringify(value));
  const readJson = key => {
    const raw = values.get(String(key));
    return raw == null ? null : JSON.parse(String(raw));
  };
  const clearCalls = () => {
    calls.get.length = 0;
    calls.set.length = 0;
    calls.remove.length = 0;
  };
  const dispose = async () => {
    for (const handler of unloadHandlers.slice().reverse()) {
      try { await handler(); } catch (_) {}
    }
    for (const timer of Array.from(activeTimeouts)) clearTimeout(timer);
    for (const timer of Array.from(activeIntervals)) clearInterval(timer);
    activeTimeouts.clear();
    activeIntervals.clear();
  };

  return { api, values, faults, calls, scopeKey, keys, putJson, readJson, clearCalls, dispose };
};

const seedFixture = harness => {
  const { scopeKey, keys, putJson } = harness;
  const timestamp = '2026-08-31T00:00:00.000Z';
  const sourceDigest = 'worldline-source-digest-1';
  const memoryId = 'worldline_mem_1';
  const turnRange = { start: 1, end: 5 };
  const manifest = {
    schema: 'libra.manifest.v1', version: 'test', scopeKey,
    characterId: 'worldline-transaction-character', chatId: 'worldline-transaction-chat', batchSize: 5,
    createdAt: timestamp, updatedAt: timestamp,
    frontiers: { observedTurn: 5, committedTurn: 5, contiguousCommittedTurn: 5, firstGapStartTurn: 0, contiguousMemoryCount: 1 },
    branchGuard: {
      schema: 'libra.branch_guard.v1', status: 'bootstrap_pending', batchSignatures: [], verifiedStarts: [],
      observedTurns: 5, completeBatches: 1, lastFullAuditAt: 0, updatedAt: ''
    },
    memories: {
      1: {
        memoryId, key: keys.memory, deltaKey: keys.delta, revision: 1, sourceDigest,
        status: 'committed', turnRange, summary: 'Worldline fixture', embeddingStatus: 'disabled',
        sessionEpoch: 0, inheritedSessionHistory: false, createdAt: timestamp, updatedAt: timestamp, history: []
      }
    },
    inheritedMemories: [], archiveRef: null, runIds: [], inFlight: null,
    stats: { commits: 1, failures: 0, ariadneFailures: 0, itoFailures: 0, partialCommits: 0, staleDiscards: 0, recalls: 0, embeddings: 0, handoffImports: 0 }
  };
  const memory = {
    schema: 'libra.canonical_memory.v1', memoryId, scopeKey, branchId: sourceDigest,
    turnRange, sourceDigest, revision: 1, status: 'committed', sessionEpoch: 0,
    inheritedSessionHistory: false, text: 'Worldline canonical fixture', summary: 'Worldline fixture',
    recallKeys: [], importance: 0.5, sections: {}, anchors: {},
    retrieval: { version: 'libra.retrieval_projection.v2' },
    embedding: { status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2' },
    createdAt: timestamp, updatedAt: timestamp
  };
  const delta = {
    schema: 'libra.continuity_delta.v1', memoryId, revision: 1, sourceDigest, turnRange,
    characterPatch: {
      ok: true, reason: '',
      patch: {
        schema: 'libra.continuity_state_patch.v1', domain: 'character_relationship',
        characters: [{ operation: 'upsert', name: 'Alice', aliases: [], set: { location: 'room' }, clear: [], certainty: 'explicit' }],
        relationships: [], world: []
      }
    },
    worldPatch: {
      ok: true, reason: '',
      patch: { schema: 'libra.continuity_state_patch.v1', domain: 'world', characters: [], relationships: [], world: [] }
    },
    narrativePatch: null,
    domains: {
      character_relationship: { status: 'ready', source: 'fixture' },
      world: { status: 'ready', source: 'fixture' },
      narrative: { status: 'empty', source: 'none' }
    },
    stateTrackingMode: 'basic', createdAt: timestamp
  };
  const meta = {
    schema: 'libra.state_worldline_meta.v1', scopeKey, activeWorldlineId: 'main', revision: 1,
    worldlines: {
      main: { id: 'main', parentId: null, forkTurn: 0, cutoffTurn: null, active: true, createdAt: timestamp, updatedAt: timestamp }
    },
    updatedAt: timestamp
  };
  const journal = {
    schema: 'libra.state_correction_store.v1', scopeKey, revision: 3,
    records: [], migratedLegacyOverrideIds: [], updatedAt: timestamp
  };
  const head = {
    schema: 'libra.continuity_state.v1', provenanceVersion: 2, scopeKey, worldlineId: 'main', status: 'ready',
    throughSessionEpoch: 0, throughTurn: 5,
    characters: [], relationships: [], world: [],
    narrative: { schema: 'libra.narrative_state.v1', summary: '', arcs: [], threads: [], turningPoints: [], locks: [], motifs: [], updatedThroughTurn: 0, source: 'fixture', revision: 0 },
    domainStatus: {}, basis: { sourceFingerprint: 'baseline-source', sourceCount: 1, replayFingerprint: 'baseline-replay' },
    source: null, updatedAt: timestamp
  };
  const cache = {
    schema: 'libra.state_replay_cache.v1', scopeKey, worldlineId: 'main', fingerprint: 'baseline-replay',
    throughTurn: 5, appliedDeltas: 1, appliedCorrections: [], reason: 'fixture', updatedAt: timestamp
  };

  putJson(keys.manifest, manifest);
  putJson(keys.memory, memory);
  putJson(keys.delta, delta);
  putJson(keys.meta, meta);
  putJson(keys.journal, journal);
  putJson(keys.head, head);
  putJson(keys.cache, cache);
  harness.clearCalls();
  return { manifest, memory, delta, meta, journal, head, cache };
};

const assertBaseline = (harness, baseline, names = ['meta', 'journal', 'head', 'cache']) => {
  for (const name of names) assert.deepEqual(harness.readJson(harness.keys[name]), baseline[name], `${name} must match its physical baseline`);
};

const tests = [];
const test = (name, callback) => tests.push({ name, callback });

test('meta semantic corruption rolls back before success', async () => {
  const harness = await createHarness();
  try {
    const baseline = seedFixture(harness);
    let corrupted = false;
    harness.faults.set = ({ key, value, values }) => {
      if (!corrupted && key === harness.keys.meta) {
        corrupted = true;
        const parsed = JSON.parse(String(value));
        parsed.activeWorldlineId = 'semantic-corruption';
        values.set(key, JSON.stringify(parsed));
        return { handled: true, result: true };
      }
      return null;
    };
    const error = await captureError(() => harness.api.setWorldManagerWorldline({ worldlineId: 'alt', parentId: 'main', forkTurn: 5 }));
    assert.equal(error.code, 'STATE_WORLDLINE_TRANSACTION_FAILED');
    assert.equal(corrupted, true, 'meta write fault must execute');
    assertBaseline(harness, baseline);
  } finally { await harness.dispose(); }
});

test('replay ok:false restores meta, journal, Head, and replay cache', async () => {
  const harness = await createHarness();
  try {
    const baseline = seedFixture(harness);
    harness.values.delete(harness.keys.delta);
    const error = await captureError(() => harness.api.setWorldManagerWorldline({ worldlineId: 'alt', parentId: 'main', forkTurn: 5 }));
    assert.equal(error.code, 'STATE_WORLDLINE_TRANSACTION_FAILED');
    assertBaseline(harness, baseline);
  } finally { await harness.dispose(); }
});

test('invalid rollback and fork anchors reject before any meta write', async () => {
  const harness = await createHarness();
  try {
    const baseline = seedFixture(harness);
    const rollbackError = await captureError(() => harness.api.rollbackWorldManagerState({ worldlineId: 'main', throughTurn: 3 }));
    assert.equal(rollbackError.code, 'STATE_WORLDLINE_ROLLBACK_ANCHOR_NOT_COMMITTED');
    const forkError = await captureError(() => harness.api.setWorldManagerWorldline({ worldlineId: 'alt', parentId: 'main', forkTurn: 3 }));
    assert.equal(forkError.code, 'STATE_WORLDLINE_FORK_ANCHOR_NOT_COMMITTED');
    assert.equal(harness.calls.set.filter(key => key === harness.keys.meta).length, 0, 'invalid anchors must not write worldline meta');
    assertBaseline(harness, baseline);
  } finally { await harness.dispose(); }
});

test('successful fork persists the same active non-main worldline in meta and Head', async () => {
  const harness = await createHarness();
  try {
    seedFixture(harness);
    const result = await harness.api.setWorldManagerWorldline({ worldlineId: 'alt', parentId: 'main', forkTurn: 5 });
    const meta = harness.readJson(harness.keys.meta);
    const head = harness.readJson(harness.keys.head);
    const cache = harness.readJson(harness.keys.cache);
    assert.equal(result.ok, true);
    assert.equal(result.worldlineId, 'alt');
    assert.equal(result.meta.activeWorldlineId, 'alt');
    assert.equal(meta.activeWorldlineId, 'alt');
    assert.equal(meta.worldlines.alt.id, 'alt');
    assert.equal(meta.worldlines.alt.parentId, 'main');
    assert.equal(meta.worldlines.alt.forkTurn, 5);
    assert.equal(head.worldlineId, 'alt');
    assert.equal(cache.worldlineId, 'alt');
    assert.deepEqual(JSON.parse(JSON.stringify(result.head)), head, 'success must return the durable Head readback');
  } finally { await harness.dispose(); }
});

test('baseline read failure never becomes a remove-based rollback', async () => {
  const harness = await createHarness();
  try {
    const baseline = seedFixture(harness);
    let failed = false;
    harness.faults.get = ({ key }) => {
      if (!failed && key === harness.keys.head) {
        failed = true;
        return { throw: Object.assign(new Error('synthetic baseline head read failure'), { code: 'SYNTHETIC_BASELINE_READ_FAILED' }) };
      }
      return null;
    };
    const error = await captureError(() => harness.api.setWorldManagerWorldline({ worldlineId: 'alt', parentId: 'main', forkTurn: 5 }));
    assert.equal(error.code, 'STORAGE_READ_FAILED');
    assert.equal(error.cause?.code, 'SYNTHETIC_BASELINE_READ_FAILED', 'storage wrapper must preserve the original read failure');
    assert.equal(failed, true, 'baseline read fault must execute');
    assert.equal(harness.calls.remove.filter(key => Object.values(harness.keys).includes(key)).length, 0, 'read failure must not trigger remove rollback');
    assertBaseline(harness, baseline);
  } finally { await harness.dispose(); }
});

test('rollback conflict preserves an external Head and reports rollback incomplete', async () => {
  const harness = await createHarness();
  try {
    const baseline = seedFixture(harness);
    const externalHead = {
      schema: 'libra.continuity_state.v1', scopeKey: harness.scopeKey, worldlineId: 'external',
      status: 'ready', throughTurn: 5, marker: 'external-writer-head',
      basis: { sourceFingerprint: 'external-source', replayFingerprint: 'external-replay' }
    };
    let injected = false;
    harness.faults.set = ({ key, value, values }) => {
      if (!injected && key === harness.keys.cache) {
        injected = true;
        values.set(key, value);
        const manifest = JSON.parse(String(values.get(harness.keys.manifest)));
        manifest.branchGuard = { ...manifest.branchGuard, updatedAt: 'external-boundary-change' };
        values.set(harness.keys.manifest, JSON.stringify(manifest));
        values.set(harness.keys.head, JSON.stringify(externalHead));
        return { handled: true, result: true };
      }
      return null;
    };
    const error = await captureError(() => harness.api.setWorldManagerWorldline({ worldlineId: 'alt', parentId: 'main', forkTurn: 5 }));
    assert.equal(error.code, 'STATE_CORRECTION_ROLLBACK_INCOMPLETE');
    assert.equal(injected, true, 'external writer simulation must execute');
    assert.deepEqual(harness.readJson(harness.keys.head), externalHead, 'rollback conflict must not overwrite the external Head');
    assertBaseline(harness, baseline, ['meta', 'journal', 'cache']);
  } finally { await harness.dispose(); }
});

(async () => {
  for (const { name, callback } of tests) {
    await callback();
    console.log(`ok - ${name}`);
  }
  console.log(`libra_world_manager_worldline_transaction_rc2_test: ${tests.length}/${tests.length} ok (${sourcePath})`);
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
