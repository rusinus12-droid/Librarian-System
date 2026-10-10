'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const SOURCE = { sourceType: 'response', sourceId: 'journal-source', sourceHash: 'journal-source-hash', origin: 'live_chat',
  role: 'turn_pair', turnIndex: 1, pairIndex: 1,
  text: 'User:\nWhere is the key?\n\n---\n\nAssistant:\nThe old brass key is tied to a blue ribbon in the north cabinet.' };
const clone = value => JSON.parse(JSON.stringify(value));
const success = init => ({ ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } });
async function setup(options = {}) {
  const h = await createFlashback(PROGRAM, options);
  const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai_compat', embeddingModel: 'journal-model-a', embeddingDimensions: 3,
    embeddingUrl: 'https://provider.invalid/v1', embeddingEnabled: true, embeddingAutoProcess: false, embeddingMaxRetries: 0, autoEpisodeIndex: false });
  if (!options.pluginStorage) await h.api.saveSettings(cfg);
  const scope = await h.api.resolveCurrentScope(false);
  const read = async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
  const manifest = () => h.api._test.loadScopeManifest(scope.scopeKey);
  const replaceRaw = async settings => {
    // Controlled current-marker replacement tests history independently of the later retained-vector migration feature.
    const rows = await h.api._test.buildRecordsFromSources([SOURCE], settings, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(rows, settings, scope); return rows;
  };
  if (!options.pluginStorage) await replaceRaw(cfg);
  return { h, cfg, scope, read, manifest, replaceRaw };
}
function registryFrom(manifest) {
  const raw = manifest.embeddingAttemptRegistry;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

test('the attempt submission registry is durably readable before the first physical request', async () => {
  const x = await setup();
  try {
    let observed, attemptId, calls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; observed = registryFrom(await x.manifest()); attemptId = (await x.read())[0].embeddingWork.attempt.id;
      return success(init);
    };
    const result = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(result.ready, 1); assert.equal(calls, 1);
    assert.equal(observed?.schema, 'flashback.embedding_attempt_registry.v1');
    assert.equal(observed.scopeKey, x.scope.scopeKey);
    assert.equal(observed.entries[attemptId].state, 'submitted');
    assert.equal(observed.entries[attemptId].jobs[0].sourceRevision, (await x.read())[0].embeddingReceipt.sourceRevision);
    assert.equal(Object.keys(registryFrom(await x.manifest()).entries).length, 0, 'known completed work does not grow the unresolved registry');
  } finally { await x.h.cleanup(); }
});

async function unresolvedProfileCycle(x) {
  let aCalls = 0, bCalls = 0;
  x.h.host.nativeFetch = async (_url, init) => {
    if (JSON.parse(init.body).model === x.cfg.embeddingModel) {
      aCalls++; if (aCalls === 1) throw Error('synthetic network failure');
    } else bCalls++;
    return success(init);
  };
  const first = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
  assert.equal(first.uncertain, true);
  const unknownAttempt = (await x.read())[0].embeddingWork.attempt.id;
  const b = { ...x.cfg, embeddingModel: 'journal-model-b' };
  await x.h.api.saveSettings(b); await x.replaceRaw(b);
  assert.equal((await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).ready, 1);
  await x.h.api.saveSettings(x.cfg); await x.replaceRaw(x.cfg);
  return { unknownAttempt, aCalls: () => aCalls, bCalls: () => bCalls };
}

test('A to B to A retains the unresolved A attempt after current work markers are replaced', async () => {
  const x = await setup();
  try {
    const history = await unresolvedProfileCycle(x);
    const result = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(history.aCalls(), 1, 'returning to A must not silently submit its unresolved source/profile job again');
    assert.equal(history.bCalls(), 1); assert.equal(result.ready, 0); assert.equal(result.uncertain, true);
    assert(registryFrom(await x.manifest()).entries[history.unknownAttempt]);
    assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
  } finally { await x.h.cleanup(); }
});

test('fresh runtime and portable same-scope restore retain the unresolved profile history', async () => {
  const x = await setup(); let second;
  try {
    const history = await unresolvedProfileCycle(x);
    const portable = x.h.context.__FlashbackPortableMemoryBackup;
    const backup = await portable.exportCurrentScope();
    await x.h.api._test.saveAllRecords([], x.cfg, x.scope);
    assert.equal((await portable.restoreCurrentScope(backup)).ok, true);
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    let calls = 0; second.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await second.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(calls, 0); assert.equal(result.uncertain, true);
    assert(registryFrom(await second.manifest()).entries[history.unknownAttempt]);
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('malformed existing registry bytes block model work while new raw source remains durable', async () => {
  const x = await setup();
  try {
    const malformed = '{malformed-existing-attempt-registry';
    await x.h.api._test.saveScopeManifest({ ...await x.manifest(), embeddingAttemptRegistry: malformed }, x.scope);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(calls, 0); assert.match(result.reason, /REGISTRY/);
    const next = { ...SOURCE, sourceId: 'new-journal-source', sourceHash: 'new-journal-hash', text: SOURCE.text + ' A new seal is visible.' };
    const rows = await x.h.api._test.buildRecordsFromSources([next], x.cfg, x.scope, { deferEmbedding: true });
    await x.h.api._test.saveAllRecords([...(await x.read()), ...rows], x.cfg, x.scope);
    assert((await x.read()).some(row => row.text === next.text));
    assert.equal((await x.manifest()).embeddingAttemptRegistry, malformed);
  } finally { await x.h.cleanup(); }
});

for (const deniedState of ['reserved', 'submitted']) test(`a ${deniedState} registry write failure submits no model request`, async () => {
  const x = await setup(); let original;
  try {
    original = x.h.pluginStorage.setItem.bind(x.h.pluginStorage); let rejected = 0, calls = 0;
    x.h.pluginStorage.setItem = async (key, value) => {
      if (String(key).endsWith(':manifest:v2')) {
        const manifest = typeof value === 'string' ? JSON.parse(value) : value;
        const registry = registryFrom(manifest);
        if (Object.values(registry?.entries || {}).some(entry => entry.state === deniedState)) { rejected++; return false; }
      }
      return original(key, value);
    };
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert(rejected > 0); assert.equal(calls, 0);
    x.h.pluginStorage.setItem = original;
    const rows = await x.read(); assert.equal(rows[0].text, SOURCE.text); assert.equal(rows[0].vector.length, 0);
  } finally { if (original) x.h.pluginStorage.setItem = original; await x.h.cleanup(); }
});

test('a pre-registry uncertain marker is seeded before a raw rewrite can replace it', async () => {
  let x = await setup();
  try {
    let aCalls = 0;
    const provider = async (_url, init) => {
      if (JSON.parse(init.body).model === x.cfg.embeddingModel && ++aCalls === 1) throw Error('synthetic network failure');
      return success(init);
    };
    x.h.host.nativeFetch = provider;
    await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    const attemptId = (await x.read())[0].embeddingWork.attempt.id;
    // The first fixture was refuted: an in-flight retirement metadata save
    // republished the modern registry after deletion. Build the old format in
    // quiescent physical storage and load it in a fresh runtime instead.
    await x.h.api._test.retireExternalRecordsForScope(x.scope.scopeKey);
    await x.h.cleanup();
    const store = x.h.pluginStorage, local = x.h.safeLocalStorage;
    const manifestKey = (await store.keys()).find(key => String(key).endsWith(':manifest:v2')
      && JSON.parse(store.values.get(key)).scopeKey === x.scope.scopeKey);
    assert(manifestKey);
    const { embeddingAttemptRegistry, ...legacyManifest } = JSON.parse(await store.getItem(manifestKey));
    await store.setItem(manifestKey, JSON.stringify(legacyManifest));
    x = await setup({ pluginStorage: store, safeLocalStorage: local });
    x.h.host.nativeFetch = provider;
    assert.equal((await x.manifest()).embeddingAttemptRegistry, undefined, 'fixture represents a manifest written before registry support');
    const b = { ...x.cfg, embeddingModel: 'journal-model-b' };
    await x.h.api.saveSettings(b); await x.replaceRaw(b);
    assert(registryFrom(await x.manifest())?.entries[attemptId], 'the old current marker is retained before replacement');
    await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    await x.h.api.saveSettings(x.cfg); await x.replaceRaw(x.cfg);
    const result = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(aCalls, 1); assert.equal(result.uncertain, true);
  } finally { await x.h.cleanup(); }
});

test('oversized unresolved history is preserved and blocks new model work without blocking raw retention', async () => {
  const x = await setup();
  try {
    x.h.host.nativeFetch = async () => { throw Error('synthetic network failure'); };
    await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    const original = registryFrom(await x.manifest()), exemplar = Object.values(original.entries)[0];
    const entries = {};
    for (let i = 0; i < 3000; i++) {
      const attemptId = `capacity-fixture-attempt-${String(i).padStart(5, '0')}`;
      entries[attemptId] = { ...clone(exemplar), attemptId };
    }
    const body = { schema: original.schema, scopeKey: original.scopeKey, entries };
    const oversized = { ...body, digest: x.h.audit.MemorySuiteExecutionContract.hash(body) };
    assert(Buffer.byteLength(JSON.stringify(oversized)) > 1024 * 1024);
    await x.h.api._test.saveScopeManifest({ ...await x.manifest(), embeddingAttemptRegistry: oversized }, x.scope);
    const nextSource = { ...SOURCE, sourceId: 'capacity-next-source', sourceHash: 'capacity-next-hash', text: SOURCE.text + ' A new raw observation.' };
    const next = await x.h.api._test.buildRecordsFromSources([nextSource], x.cfg, x.scope, { deferEmbedding: true });
    await x.h.api._test.saveAllRecords([...(await x.read()), ...next], x.cfg, x.scope);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.processPendingEmbeddingWork({ sourceHash: nextSource.sourceHash });
    assert.equal(calls, 0); assert.equal(result.reason, 'FLASHBACK_EMBEDDING_REGISTRY_CAPACITY');
    assert((await x.read()).some(row => row.text === nextSource.text));
    assert.deepEqual(clone((await x.manifest()).embeddingAttemptRegistry), oversized);
  } finally { await x.h.cleanup(); }
});

async function selectChat(h, id) {
  const character = await h.host.getCharacter();
  const target = { id, chatId: id, name: id, message: [], messages: [] };
  character.chats.push(target); const index = character.chats.length - 1; character.chatPage = index;
  h.host.getCurrentChatIndex = async () => index;
  h.host.getCurrentChat = h.host.getChat = async () => target;
  h.host.getChatFromIndex = async (_char, n) => character.chats[n];
  return h.api.resolveCurrentScope(false);
}

test('native copy rebinds physical registry ownership and preserves detached logical history', async () => {
  const x = await setup();
  try {
    const history = await unresolvedProfileCycle(x);
    const before = registryFrom(await x.manifest());
    const target = await selectChat(x.h, 'registry-native-copy');
    const copied = await x.h.api._test.cloneScopeStorage(x.scope, target, x.cfg);
    assert.equal(copied.ok, true);
    const after = registryFrom(await x.h.api._test.loadScopeManifest(target.scopeKey));
    assert.equal(after.scopeKey, target.scopeKey);
    const oldJob = before.entries[history.unknownAttempt].jobs[0], newJob = after.entries[history.unknownAttempt].jobs[0];
    assert.equal(newJob.logicalJobId, oldJob.logicalJobId); assert.notEqual(newJob.jobId, oldJob.jobId);
    assert.equal(newJob.originScopeKey, x.scope.scopeKey);
    const rows = (await x.h.api._test.loadScopeRecords(target.scopeKey)).records;
    assert.equal(rows[0].embeddingOriginScopeKey, x.scope.scopeKey);
    assert.equal((await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).uncertain, true);
    assert.equal(history.aCalls(), 1);
    assert.deepEqual(clone(registryFrom(await x.manifest())), clone(before), 'copy does not mutate the original registry');
  } finally { await x.h.cleanup(); }
});

test('same source hash from copied and native origins is isolated in queue and direct admission', async () => {
  const x = await setup();
  try {
    const history = await unresolvedProfileCycle(x);
    const target = await selectChat(x.h, 'registry-collision-copy');
    assert.equal((await x.h.api._test.cloneScopeStorage(x.scope, target, x.cfg)).ok, true);
    const copiedRows = (await x.h.api._test.loadScopeRecords(target.scopeKey)).records;
    const nativeRows = (await x.h.api._test.buildRecordsFromSources([SOURCE], x.cfg, target, { deferEmbedding: true }))
      .map(row => ({ ...row, id: `native-${row.id}` }));
    await x.h.api._test.saveAllRecords([...copiedRows, ...nativeRows], x.cfg, target);
    const ambiguous = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(ambiguous.reason, 'FLASHBACK_EMBEDDING_SOURCE_ORIGIN_REQUIRED');
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.processPendingEmbeddingQueue();
    assert.equal(result.ready, 1); assert.equal(calls, 1); assert.equal(result.uncertainSources, 1);
    // The logical archive view deduplicates identical text. Inspect the actual
    // physical worker inventory to prove neither origin's work was overwritten.
    const jobs = (await x.h.api.inspectEmbeddingWork()).jobs;
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find(row => row.recordId.startsWith('native-')).status, 'ready');
    assert.equal(jobs.find(row => !row.recordId.startsWith('native-')).durableStatus, 'pending');
    assert.notEqual(jobs[0].jobId, jobs[1].jobId, 'physical jobs in one scope retain distinct logical origins');
    assert.equal(history.aCalls(), 1);
  } finally { await x.h.cleanup(); }
});

test('portable predecessor import preserves detached history without blocking a new native origin', async () => {
  const x = await setup();
  try {
    const history = await unresolvedProfileCycle(x);
    const portable = x.h.context.__FlashbackPortableMemoryBackup, backup = await portable.exportCurrentScope();
    const target = await selectChat(x.h, 'registry-predecessor-target');
    assert.equal((await portable.restoreCurrentScope(backup, { mode: portable.restoreModes.CHAT_MIGRATION })).ok, true);
    const manifest = await x.h.api._test.loadScopeManifest(target.scopeKey);
    const archive = await x.h.api._test.loadScopeManifest(manifest.archiveRef.archiveScopeKey);
    assert(registryFrom(archive)?.entries[history.unknownAttempt], 'immutable imported archive retains detached history');
    assert(registryFrom(manifest)?.entries[history.unknownAttempt], 'active owner retains the history for later archive work');
    assert.equal(registryFrom(archive).scopeKey, archive.scopeKey);
    const native = await x.h.api._test.buildRecordsFromSources([SOURCE], x.cfg, target, { deferEmbedding: true });
    await x.h.api._test.saveAllRecords(native, x.cfg, target);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(result.ready, 1); assert.equal(calls, 1);
    assert(registryFrom(await x.h.api._test.loadScopeManifest(target.scopeKey)).entries[history.unknownAttempt]);
  } finally { await x.h.cleanup(); }
});

for (const state of ['reserved', 'submitted']) test(`verified physical ${state} write survives a false acknowledgement without a duplicate`, async () => {
  let x = await setup(); let original;
  try {
    original = x.h.pluginStorage.setItem.bind(x.h.pluginStorage); let falseAcks = 0, calls = 0;
    x.h.pluginStorage.setItem = async (key, value) => {
      const result = await original(key, value);
      if (String(key).endsWith(':manifest:v2') && Object.values(registryFrom(JSON.parse(value))?.entries || {}).some(entry => entry.state === state)) {
        falseAcks++; return false;
      }
      return result;
    };
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.equal((await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).ready, 1);
    assert(falseAcks); assert.equal(calls, 1);
    x.h.pluginStorage.setItem = original; original = null;
    const store = x.h.pluginStorage, local = x.h.safeLocalStorage;
    await x.h.cleanup(); x = await setup({ pluginStorage: store, safeLocalStorage: local });
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.equal((await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).reason, 'already_ready');
    assert.equal(calls, 1);
  } finally { if (original) x.h.pluginStorage.setItem = original; await x.h.cleanup(); }
});

test('a submitted write with unavailable readback survives restart as uncertain and is never silently resent', async () => {
  let x = await setup(); let get, set;
  try {
    get = x.h.pluginStorage.getItem.bind(x.h.pluginStorage); set = x.h.pluginStorage.setItem.bind(x.h.pluginStorage);
    let submitted = false, calls = 0;
    x.h.pluginStorage.setItem = async (key, value) => {
      const result = await set(key, value);
      if (String(key).endsWith(':manifest:v2') && Object.values(registryFrom(JSON.parse(value))?.entries || {}).some(entry => entry.state === 'submitted')) submitted = true;
      return result;
    };
    x.h.pluginStorage.getItem = async key => {
      if (submitted && String(key).endsWith(':manifest:v2')) throw Error('synthetic unavailable submitted-manifest readback');
      return get(key);
    };
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const first = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(first.uncertain, true); assert.equal(calls, 0);
    x.h.pluginStorage.getItem = get; x.h.pluginStorage.setItem = set; get = set = null;
    const store = x.h.pluginStorage, local = x.h.safeLocalStorage;
    await x.h.cleanup(); x = await setup({ pluginStorage: store, safeLocalStorage: local });
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.equal((await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).uncertain, true);
    assert.equal(calls, 0); assert.equal((await x.read())[0].text, SOURCE.text);
  } finally { if (get) x.h.pluginStorage.getItem = get; if (set) x.h.pluginStorage.setItem = set; await x.h.cleanup(); }
});

test('new work identity rejects origin tampering before a trusted scope rebind', async () => {
  const x = await setup();
  try {
    const [row] = await x.read(), broken = clone(row);
    broken.embeddingWork.originScopeKey = 'foreign-origin';
    assert.throws(() => x.h.api._test.rebindRecordForSameChatPersonaRecovery(broken, x.scope.scopeKey + '|copy'),
      error => error.code === 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID');
    delete broken.embeddingOriginScopeKey;
    assert.throws(() => x.h.api._test.rebindRecordForSameChatPersonaRecovery(broken, x.scope.scopeKey + '|copy'),
      error => error.code === 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID');
    assert.equal(x.h.networkCalls.length, 0);
  } finally { await x.h.cleanup(); }
});

test('trusted copy preserves malformed history for repair while retaining its raw source', async () => {
  const x = await setup();
  try {
    const malformed = '{unresolved-history-needs-repair';
    await x.h.api._test.retireExternalRecordsForScope(x.scope.scopeKey);
    await x.h.api._test.saveScopeManifest({ ...await x.manifest(), embeddingAttemptRegistry: malformed }, x.scope);
    const target = await selectChat(x.h, 'registry-malformed-copy');
    assert.equal((await x.h.api._test.cloneScopeStorage(x.scope, target, x.cfg)).ok, true);
    const manifest = await x.h.api._test.loadScopeManifest(target.scopeKey);
    assert.equal(manifest.embeddingAttemptRegistryBlocked.origins[0].registry, malformed);
    assert.equal((await x.h.api._test.loadScopeRecords(target.scopeKey)).records[0].text, SOURCE.text);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.match((await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).reason, /REGISTRY/);
    assert.equal(calls, 0); assert.equal((await x.manifest()).embeddingAttemptRegistry, malformed);
  } finally { await x.h.cleanup(); }
});

for (const batches of ['single', 'multiple']) test(`a restored reserved registry after submission blocks ${batches === 'single' ? 'final adoption' : 'later physical batches'}`, async () => {
  const x = await setup(); let original;
  try {
    const cfg = x.h.api._test.normalizeSettings({ ...x.cfg, chunkChars: 400, chunkOverlap: 0, embeddingBatchSize: 1 });
    await x.h.api.saveSettings(cfg);
    const source = { ...SOURCE, text: batches === 'multiple' ? SOURCE.text.repeat(15) : SOURCE.text };
    const raw = await x.h.api._test.buildRecordsFromSources([source], cfg, x.scope, { deferEmbedding: true });
    assert.equal(raw.length > 1, batches === 'multiple');
    await x.h.api._test.saveAllRecords(raw, cfg, x.scope);
    original = x.h.pluginStorage.setItem.bind(x.h.pluginStorage); let reserved, calls = 0;
    x.h.pluginStorage.setItem = async (key, value) => {
      if (String(key).endsWith(':manifest:v2')) {
        const registry = registryFrom(JSON.parse(value));
        if (!reserved && Object.values(registry?.entries || {}).some(entry => entry.state === 'reserved')) reserved = clone(registry);
      }
      return original(key, value);
    };
    x.h.host.nativeFetch = async (_url, init) => {
      calls++;
      if (calls === 1) {
        assert(reserved, 'capture the actual authoritative reserved snapshot');
        await x.h.api._test.saveScopeManifest({ ...await x.manifest(), embeddingAttemptRegistry: reserved }, x.scope);
      }
      return success(init);
    };
    const result = await x.h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    assert.equal(calls, 1); assert.equal(result.ready, 0); assert.equal(result.uncertain, true);
    assert((await x.read()).every(record => record.vector.length === 0 && !record.embeddingReceipt));
    assert.deepEqual(clone(registryFrom(await x.manifest())), reserved);
  } finally { if (original) x.h.pluginStorage.setItem = original; await x.h.cleanup(); }
});
