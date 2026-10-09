'use strict';
// Task 26 Step 2 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
// LIBRA branch-specific correction isolation — `setStateWorldline` →
// `inheritStateCorrectionsForWorldlineFork`.
//
// WHY THIS IS `plugin_only`/legacy AND NOT 3-mode. Step 1 measured that
// `setWorldManagerWorldline` is bounded two ways:
//   - `mirror`/`server_only`: `UNIFIED_BACKEND_NOT_SUPPORTED` (the unified server writer
//     does not implement worldline switching — pinned by
//     `libra_world_manager_state_3mode_parity_test.cjs`).
//   - unified-v4 canonicals in ANY mode: `UNIFIED_USE_NATIVE_BRANCH_FOR_FORK` — a fork
//     must use the HOST's native branch instead of a plugin worldline switch (pinned by
//     `libra_unified_mode_cutover_v1_test.cjs`).
// So `inheritStateCorrectionsForWorldlineFork` is only reachable from a legacy
// (non-unified) canonical in plugin_only. That is the path this test drives; no 3-mode
// parity is claimed for it, and the two bounded paths stay pinned by the tests above.
//
// COVERAGE GAP THIS CLOSES. `libra_world_manager_worldline_transaction_rc2_test.cjs`
// drives a successful fork and asserts meta/Head/cache persistence, but it seeds an
// EMPTY correction journal — so the inheritance function itself was never executed by
// any test (its only other mention in the suite is a comment).
//
// ASSERTED (the real isolation contract):
//   1. a fork inherits the parent's ACTIVE corrections anchored at or before the fork
//      turn, re-identified with fresh ids and full provenance
//   2. suspended parent corrections are NOT inherited
//   3. parent corrections anchored AFTER the fork turn are NOT inherited
//   4. re-running the fork does not duplicate an already-inherited correction
//   5. the parent's own records are unchanged by the fork (isolation both ways)
//   6. the fork persists its worldline identity in meta and Head
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '..', 'plugins', 'LIBRA.js'));
const source = fs.readFileSync(sourcePath, 'utf8');
assert.match(source, /const inheritStateCorrectionsForWorldlineFork = async/,
  'the worldline-fork correction inheritance core is required');

const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA runtime load timed out');
};

const createHarness = async () => {
  const values = new Map();
  const calls = { get: [], set: [], remove: [] };
  const unloadHandlers = [];

  const storage = {
    async getItem(keyValue) { const key = String(keyValue); calls.get.push(key); return values.has(key) ? values.get(key) : null; },
    async setItem(keyValue, value) { const key = String(keyValue); calls.set.push(key); values.set(key, value); return true; },
    async removeItem(keyValue) { const key = String(keyValue); calls.remove.push(key); values.delete(key); return true; },
    async keys() { return Array.from(values.keys()); }
  };

  const chat = { id: 'worldline-chat', chatId: 'worldline-chat', message: [], name: 'Worldline' };
  for (let turn = 1; turn <= 5; turn += 1) {
    chat.message.push({ role: 'user', data: `User ${turn}`, chatId: `u-${turn}` });
    chat.message.push({ role: 'assistant', data: `Assistant ${turn}`, chatId: `a-${turn}` });
  }
  chat.messages = chat.message;
  const character = { id: 'worldline-isolation-character', name: 'Worldline Isolation', chatPage: 0, chats: [chat] };

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
    async nativeFetch() { throw new Error('worldline isolation test has no server or provider'); },
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
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval, clearInterval: trackedClearInterval,
    queueMicrotask, AbortController, AbortSignal, DOMException,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
    performance: globalThis.performance, fetch: globalThis.fetch,
    Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
    FormData: globalThis.Blob, Blob: globalThis.Blob,
    atob: globalThis.atob, btoa: globalThis.btoa,
    confirm: () => false, alert: () => {}, prompt: () => null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
  });

  vm.runInContext(source, context, { filename: sourcePath });
  const api = await waitFor(() => context.__LIBRA__);
  const emptyJournal = await api.getWorldManagerCorrections();
  const scopeKey = String(emptyJournal?.scopeKey || '');
  assert.ok(scopeKey, 'the runtime must expose the resolved scope through the correction store');

  const prefix = `libra:v1:scope:${scopeKey}`;
  const keys = {
    manifest: `${prefix}:manifest`,
    memory: `${prefix}:memory:1:r1`,
    delta: `${prefix}:continuity-delta:worldline_mem_1:r1`,
    meta: `${prefix}:state-worldline-meta:v1`,
    journal: `${prefix}:state-corrections:v2`,
    head: `${prefix}:continuity-state`
  };
  const putJson = (key, value) => values.set(String(key), JSON.stringify(value));
  const readJson = key => { const raw = values.get(String(key)); return raw == null ? null : JSON.parse(String(raw)); };
  const dispose = async () => {
    for (const handler of unloadHandlers.slice().reverse()) { try { await handler(); } catch (_) {} }
    for (const timer of Array.from(activeTimeouts)) clearTimeout(timer);
    for (const timer of Array.from(activeIntervals)) clearInterval(timer);
  };

  return { api, values, calls, scopeKey, keys, putJson, readJson, dispose };
};

// A LEGACY (non-unified) canonical at turn 1~5, so the worldline fork is not blocked by
// UNIFIED_USE_NATIVE_BRANCH_FOR_FORK, plus a correction journal to inherit from.
const seedFixture = harness => {
  const { scopeKey, keys, putJson } = harness;
  const timestamp = new Date().toISOString();
  const memory = {
    schema: 'libra.canonical_memory.v1', memoryId: 'worldline_mem_1', scopeKey, worldlineId: 'main',
    branchId: 'branch-fixture', turnRange: { start: 1, end: 5 },
    sourcePairs: [
      { turn: 1, userChatId: 'u-1', assistantChatId: 'a-1' }, { turn: 2, userChatId: 'u-2', assistantChatId: 'a-2' },
      { turn: 3, userChatId: 'u-3', assistantChatId: 'a-3' }, { turn: 4, userChatId: 'u-4', assistantChatId: 'a-4' },
      { turn: 5, userChatId: 'u-5', assistantChatId: 'a-5' }
    ],
    sourceDigest: 'worldline-source', revision: 1, status: 'committed',
    artifactSchema: 'libra.canonical_artifact.v2', artifactDigest: 'worldline-artifact',
    text: 'Worldline canonical fixture', summary: 'Worldline fixture',
    recallKeys: [], importance: 0.5, sections: {}, anchors: {},
    retrieval: { version: 'libra.retrieval_projection.v2' },
    embedding: { status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2' },
    runId: 'run_worldline_fixture', createdAt: timestamp, updatedAt: timestamp, history: []
  };
  const manifest = {
    schema: 'libra.manifest.v1', version: 'fixture', scopeKey, characterId: 'worldline-isolation-character', chatId: 'worldline-chat',
    batchSize: 5, createdAt: timestamp, updatedAt: timestamp,
    worldlineMeta: { schema: 'libra.worldline_meta.v1', scopeKey, worldlineId: 'main', parentWorldlineId: '', forkTurn: 0, forkFingerprint: '' },
    frontiers: { committedTurn: 5, contiguousCommittedTurn: 5, observedTurn: 5, firstGapStartTurn: 0, contiguousMemoryCount: 1 },
    branchGuard: {}, inheritedMemories: [], archiveRef: null, runIds: [], inFlight: null,
    memories: { '1': {
      memoryId: 'worldline_mem_1', key: keys.memory, deltaKey: keys.delta, revision: 1, sourceDigest: 'worldline-source', status: 'committed',
      worldlineId: 'main', artifactSchema: 'libra.canonical_artifact.v2', artifactDigest: 'worldline-artifact',
      turnRange: { start: 1, end: 5 }, embeddingStatus: 'disabled', pipelineStatus: 'complete',
      createdAt: timestamp, updatedAt: timestamp
    } },
    failedBatches: {},
    stats: { commits: 1, failures: 0, ariadneFailures: 0, itoFailures: 0, partialCommits: 0, staleDiscards: 0, recalls: 0, embeddings: 0, handoffImports: 0 }
  };
  const meta = {
    schema: 'libra.state_worldline_meta.v1', scopeKey, activeWorldlineId: 'main', revision: 1,
    worldlines: { main: { id: 'main', parentId: null, forkTurn: 0, cutoffTurn: null, active: true, createdAt: timestamp, updatedAt: timestamp } },
    updatedAt: timestamp
  };
  const journal = {
    schema: 'libra.state_correction_store.v1', scopeKey, revision: 3,
    records: [
      // active, anchored at turn 2 -> MUST be inherited by a fork at turn 3
      {
        schema: 'libra.state_correction.v1', correctionId: 'corr_early', scopeKey, worldlineId: 'main',
        status: 'active', source: 'user_manual', anchor: { throughTurn: 2 },
        basisVersion: 4, basisFingerprint: '',
        target: { domain: 'world', mode: 'identity_merge' }, patch: { world: [] },
        createdAt: timestamp, updatedAt: timestamp
      },
      // suspended, anchored at turn 1 -> MUST NOT be inherited
      {
        schema: 'libra.state_correction.v1', correctionId: 'corr_suspended', scopeKey, worldlineId: 'main',
        status: 'suspended', source: 'user_manual', anchor: { throughTurn: 1 },
        basisVersion: 4, basisFingerprint: '', userSuspended: true,
        target: { domain: 'world', mode: 'identity_merge' }, patch: { world: [] },
        createdAt: timestamp, updatedAt: timestamp
      },
      // active, anchored at turn 6 -> MUST NOT be inherited by a fork at turn 5
      {
        schema: 'libra.state_correction.v1', correctionId: 'corr_late', scopeKey, worldlineId: 'main',
        status: 'active', source: 'user_manual', anchor: { throughTurn: 6 },
        basisVersion: 4, basisFingerprint: '',
        target: { domain: 'world', mode: 'identity_merge' }, patch: { world: [] },
        createdAt: timestamp, updatedAt: timestamp
      }
    ],
    migratedLegacyOverrideIds: [], updatedAt: timestamp
  };
  const head = {
    schema: 'libra.continuity_state.v2', provenanceVersion: 2, scopeKey, worldlineId: 'main', status: 'ready',
    throughSessionEpoch: 0, throughTurn: 5,
    characters: [], relationships: [], world: [],
    narrative: { schema: 'libra.narrative_state.v1', summary: '', arcs: [], threads: [], turningPoints: [], locks: [], motifs: [], updatedThroughTurn: 0, source: 'fixture', revision: 0 },
    domainStatus: {},
    basis: { sourceFingerprint: 'worldline-source', sourceCount: 1, replayFingerprint: 'worldline-replay' },
    source: null, updatedAt: timestamp
  };

  const delta = {
    schema: 'libra.continuity_delta.v1', memoryId: 'worldline_mem_1', revision: 1,
    sourceDigest: 'worldline-source', turnRange: { start: 1, end: 5 },
    characterPatch: {
      ok: true, reason: '',
      patch: {
        schema: 'libra.continuity_state_patch.v1', domain: 'character_relationship',
        characters: [{ operation: 'upsert', name: '민아', aliases: [], set: { location: '서재' }, clear: [], certainty: 'explicit' }],
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

  putJson(keys.manifest, manifest);
  putJson(keys.memory, memory);
  putJson(keys.delta, delta);
  putJson(keys.meta, meta);
  putJson(keys.journal, journal);
  putJson(keys.head, head);
  return { manifest, meta, journal, head };
};

const recordsOf = (harness, worldlineId) => {
  const journal = harness.readJson(harness.keys.journal);
  return (journal?.records || []).filter(row => String(row?.worldlineId || 'main') === worldlineId);
};
const activeOf = (harness, worldlineId) => recordsOf(harness, worldlineId).filter(row => row?.status === 'active');

(async () => {
  const harness = await createHarness();
  try {
    seedFixture(harness);

    // The fork at turn 5 must inherit ONLY the active correction anchored <= 5.
    const fork = await harness.api.setWorldManagerWorldline({ worldlineId: 'alt', parentId: 'main', forkTurn: 5 });
    assert.equal(fork.ok, true, `the legacy fork must succeed: ${JSON.stringify(fork?.error || fork)}`);

    const childAll = recordsOf(harness, 'alt');
    const inherited = childAll.filter(row => String(row.inheritedFromWorldlineId || '') === 'main');
    const inheritedSources = inherited.map(row => String(row.inheritedFromCorrectionId || '')).sort();

    console.log(JSON.stringify({
      test: 'libra_worldline_correction_isolation',
      parentActiveIds: activeOf(harness, 'main').map(row => row.correctionId).sort(),
      childRecordIds: childAll.map(row => row.correctionId).sort(),
      inheritedSources,
      inheritedHaveFreshIds: inherited.every(row => String(row.correctionId) !== String(row.inheritedFromCorrectionId)),
      inheritedStatuses: inherited.map(row => String(row.status)),
      inheritedSourceField: inherited.map(row => String(row.source)),
      inheritedAnchors: inherited.map(row => Number(row?.anchor?.throughTurn || 0)),
      childHeadWorldline: String(harness.readJson(harness.keys.head)?.worldlineId || ''),
      metaActive: String(harness.readJson(harness.keys.meta)?.activeWorldlineId || '')
    }, null, 1));

    // 1. The active, in-range parent correction is inherited — re-identified with
    //    provenance, as a fork snapshot, re-activated.
    assert.deepEqual(inheritedSources, ['corr_early'],
      `exactly the active in-range parent correction must be inherited (got ${JSON.stringify(inheritedSources)})`);
    assert.equal(inherited.length, 1, 'exactly one correction is inherited');
    assert.notEqual(String(inherited[0].correctionId), 'corr_early',
      'an inherited correction must get a fresh correctionId');
    assert.equal(String(inherited[0].status), 'active', 'an inherited correction is re-activated');
    assert.equal(String(inherited[0].source), 'worldline_fork_snapshot',
      'an inherited correction must record its fork-snapshot provenance');
    assert.equal(Number(inherited[0]?.anchor?.throughTurn || 0), 2,
      'the inherited correction keeps its original anchor turn');

    // 2. A suspended parent correction is NOT inherited.
    assert.equal(inheritedSources.includes('corr_suspended'), false,
      'a suspended parent correction must not be inherited');
    assert.equal(childAll.some(row => String(row.correctionId) === 'corr_suspended'), false,
      'the child must not hold a copy of the suspended correction');

    // 3. An active parent correction anchored AFTER the fork turn is NOT inherited.
    assert.equal(inheritedSources.includes('corr_late'), false,
      'a parent correction anchored after the fork turn must not be inherited');
    assert.equal(childAll.some(row => String(row.correctionId) === 'corr_late'), false,
      'the child must not hold a copy of the post-fork correction');

    // 4. Re-running the same fork must not duplicate the inheritance.
    const childCountBefore = childAll.length;
    await harness.api.setWorldManagerWorldline({ worldlineId: 'alt', parentId: 'main', forkTurn: 5 });
    assert.equal(recordsOf(harness, 'alt').length, childCountBefore,
      're-inheriting must not duplicate an already-inherited correction');

    // 5. The parent's own records are untouched by the fork (isolation both ways).
    assert.deepEqual(activeOf(harness, 'main').map(row => row.correctionId).sort(), ['corr_early', 'corr_late'],
      "the fork must not change the parent worldline's active set");
    assert.equal(recordsOf(harness, 'main').some(row => String(row.inheritedFromCorrectionId || '') !== ''), false,
      'the parent must not receive fork-inherited records');

    // 6. The fork persisted its worldline identity.
    assert.equal(String(harness.readJson(harness.keys.head)?.worldlineId || ''), 'alt',
      'the Head follows the active worldline');
    assert.equal(String(harness.readJson(harness.keys.meta)?.activeWorldlineId || ''), 'alt',
      'the worldline meta records the active worldline');

    process.stdout.write('libra_worldline_correction_isolation_test: PASS\n');
  } finally {
    await harness.dispose();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
