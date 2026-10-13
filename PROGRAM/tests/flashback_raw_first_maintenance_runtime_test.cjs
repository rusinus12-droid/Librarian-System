'use strict';
const { dialogElements } = require('./fixtures/flashback_adopted_dialog.cjs');
const assert = require('node:assert/strict'), path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..'), clone = value => JSON.parse(JSON.stringify(value));
const USER = 'Where is the observatory ledger?';
const REPLY = 'The observatory ledger is inside the oak drawer beneath a folded silver map.';
const success = init => ({ ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [0, 1, 0] })) }; } });
async function setup(options = {}) {
  const h = await createFlashback(PROGRAM, { ...options, transformSource: script => script.replace('  globalThis.__FlashbackMemory = publicApi;',
    '  globalThis.__rawMaintenance = { ingest: (...args) => ingestSources(...args), saveWorldline: (...args) => saveTurnWorldline(...args), resolveBundle: (...args) => resolveCurrentScopeBundle(...args), save: (...args) => saveScopeRecords(...args), synchronize: (...args) => synchronizeFlashbackTurnWorldline(...args), liveState: (...args) => liveChatStateFromSnapshot(...args), keys: scopeKeys, mount(root) { guiRoot = root; guiMounted = true; guiVisible = true; Runtime.guiTab = "import"; bindUiEvents(root); } };\n  globalThis.__FlashbackMemory = publicApi;') });
  const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai_compat', embeddingModel: 'raw-first-model', embeddingDimensions: 3,
    embeddingUrl: 'https://provider.invalid/v1', embeddingEnabled: true, embeddingAutoProcess: false, embeddingMaxRetries: 0,
    autoColdStart: false, autoEpisodeIndex: false, episodeIndexEnabled: false, ...options.settings });
  await h.api.saveSettings(cfg);
  const chat = await h.host.getCurrentChat(), character = await h.host.getCharacter();
  chat.message = [{ role: 'user', chatId: 'raw-maintenance-u', data: USER }, { role: 'assistant', chatId: 'raw-maintenance-a', data: options.reply || REPLY }];
  chat.messages = chat.message;
  const scope = await h.api.resolveCurrentScope(false);
  const sources = h.api._test.collectLiveChatSourcesFromSnapshot({ character, chat, characterIndex: 0, chatIndex: 0 });
  assert.equal(sources.length, 1);
  const read = async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
  const manifest = () => h.api._test.loadScopeManifest(scope.scopeKey);
  const call = (entry, options = {}) => entry === 'ingest' ? h.context.__rawMaintenance.ingest(sources, cfg, scope, options)
    : entry === 'coldstart' ? h.api.ingestLiveChatColdStart({ scope: 'current', settings: cfg, historyLimit: 0, incremental: true, ...options })
      : h.api.rebuildCurrentChatMemory({ settings: cfg, ...options });
  return { h, cfg, scope, sources, read, manifest, call };
}
async function seedLegacy(x, vector = [0.25, 0.5, 0.75]) {
  const [old] = await x.h.api._test.buildRecordsFromSources(x.sources, x.cfg, x.scope, { deferEmbedding: true });
  delete old.embeddingWork;
  Object.assign(old, { vector, dim: 3, embeddingDimensions: 3, provider: 'hash', model: 'hash-3',
    embeddingProvider: 'hash', embeddingModel: 'hash-3', embeddingProfileId: 'retained-original' });
  await x.h.api._test.saveAllRecords([old], x.cfg, x.scope);
  await x.h.api._test.retireExternalRecordsForScope(x.scope.scopeKey);
  if (vector.some(value => value !== Number(value.toFixed(6)))) {
    const [stored] = await x.read();
    await x.h.context.__rawMaintenance.save(x.scope, [{ ...stored, vector }], x.cfg, x.scope, { metadataOnly: true });
  }
  return clone((await x.read())[0]);
}
async function physicalScope(x, scope = x.scope) {
  const keys = x.h.context.__rawMaintenance.keys;
  const manifestKey = keys.manifest(scope.scopeKey), worldlineKey = keys.worldline(scope.scopeKey);
  const manifest = JSON.parse(await x.h.pluginStorage.getItem(manifestKey));
  const records = [], shardKeys = [];
  for (let index = 0; index < manifest.shardCount; index++) {
    const key = keys.commitShard(scope.scopeKey, manifest.commitId, index);
    shardKeys.push(key); records.push(...JSON.parse(await x.h.pluginStorage.getItem(key)).records);
  }
  const rawWorldline = await x.h.pluginStorage.getItem(worldlineKey);
  return { manifest, manifestKey, records, shardKeys, worldlineKey, worldline: rawWorldline ? JSON.parse(rawWorldline) : null };
}
for (const entry of ['ingest', 'coldstart', 'rebuild']) test(`${entry} publishes raw source and its reservation before any corpus request`, async () => {
  const x = await setup();
  try {
    let calls = 0, unreserved = 0, missingRaw = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; const records = await x.read(), manifest = await x.manifest();
      const row = records.find(record => record.text.includes(REPLY));
      if (!row) missingRaw++;
      if (!row?.embeddingWork?.attempt || manifest.embeddingAttemptRegistry?.entries[row.embeddingWork.attempt.id]?.state !== 'submitted') unreserved++;
      return success(init);
    };
    const result = await x.call(entry);
    assert.equal(calls, 1); assert.equal(missingRaw, 0); assert.equal(unreserved, 0);
    assert.equal((await x.read())[0].embeddingReceipt?.status, 'ready'); assert.equal(result.embeddingComplete, true);
  } finally { await x.h.cleanup(); }
});
for (const entry of ['ingest', 'coldstart', 'rebuild']) test(`${entry} provider failure retains the new raw source and does not report complete embedding`, async () => {
  const x = await setup();
  try {
    let calls = 0; x.h.host.nativeFetch = async () => { calls++; throw Error('synthetic provider unavailable'); };
    const result = await x.call(entry).catch(error => ({ error: error.code || error.message }));
    const records = await x.read();
    assert(records.some(record => record.text.includes(REPLY)), 'new raw source remains durable despite the provider failure');
    assert.equal(calls, 1); assert.equal(result.embeddingComplete, false); assert(result.embeddingPending > 0);
    assert.equal(result.embeddedVectors || 0, 0);
  } finally { await x.h.cleanup(); }
});
for (const entry of ['ingest', 'coldstart', 'rebuild']) test(`${entry} explicit raw-only mode creates no provider submission`, async () => {
  const x = await setup();
  try {
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.call(entry, { deferEmbedding: true });
    assert.equal(calls, 0); assert((await x.read()).some(record => record.text.includes(REPLY)));
    assert.equal(result.embeddingComplete, false); assert(result.embeddingPending > 0);
  } finally { await x.h.cleanup(); }
});

test('rebuild preserves previously retired raw variants when the provider fails', async () => {
  const x = await setup(); let second;
  try {
    const [old] = await x.h.api._test.buildRecordsFromSources([{ ...x.sources[0], sourceHash: 'older-variant-hash',
      text: `User:\n${USER}\n\n---\n\nAssistant:\nThe former ledger was in the garden alcove.` }], x.cfg, x.scope, { deferEmbedding: true });
    const before = { ...old, turnNodeId: 'retired-node-marker', logicalTurnId: 'old-logical-marker', variantId: 'old-variant-marker',
      lifecycleStatus: 'inactive_variant', retiredAt: '2026-01-01T00:00:00.000Z' };
    await x.h.context.__rawMaintenance.saveWorldline(x.scope.scopeKey, { ...await x.h.api._test.loadTurnWorldline(x.scope.scopeKey),
      nodes: [{ turnNodeId: before.turnNodeId, logicalTurnId: before.logicalTurnId, variantId: before.variantId,
        pairIndex: 1, status: 'inactive_variant', createdAt: 1, updatedAt: 2 }], retiredRecords: [before] });
    assert.equal((await x.h.api._test.loadTurnWorldline(x.scope.scopeKey)).retiredRecords.length, 1);
    x.h.host.nativeFetch = async () => { throw Error('synthetic provider unavailable'); };
    await x.call('rebuild');
    const retained = (await x.h.api._test.loadTurnWorldline(x.scope.scopeKey)).retiredRecords;
    assert(retained.some(record => record.text === before.text && record.sourceHash === before.sourceHash), 'old raw variant survives rebuilding');
    assert((await x.read()).some(record => record.text.includes(REPLY)));
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    const restored = await second.h.api._test.loadTurnWorldline(x.scope.scopeKey);
    assert.deepEqual(clone(restored.retiredRecords.find(record => record.id === before.id)), clone(before));
    assert.equal(restored.nodes.find(node => node.turnNodeId === before.turnNodeId)?.variantId, before.variantId);
    const physical = await physicalScope(second);
    assert.deepEqual(physical.worldline.retiredRecords.find(record => record.id === before.id), clone(before));
    assert.equal(physical.worldline.nodes.find(node => node.turnNodeId === before.turnNodeId)?.logicalTurnId, before.logicalTurnId);
    console.log(JSON.stringify({ evidence: 'retired_raw_worldline_restart', key: physical.worldlineKey,
      text: before.text, sourceHash: before.sourceHash, turnNodeId: before.turnNodeId, logicalTurnId: before.logicalTurnId, variantId: before.variantId }));
    assert((await second.read()).some(record => record.text.includes(REPLY)));
    assert.equal(second.h.networkCalls.length, 0);
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('rebuild keeps an existing legacy vector for the same raw source until replacement succeeds', async () => {
  const x = await setup(); let second;
  try {
    const before = await seedLegacy(x);
    x.h.host.nativeFetch = async () => { throw Error('synthetic provider unavailable'); };
    const result = await x.call('rebuild');
    const [after] = await x.read();
    assert.equal(after.text, before.text); assert.equal(after.sourceHash, before.sourceHash);
    assert.deepEqual(clone(after.vector), before.vector); assert.equal(after.model, before.model);
    assert.equal(after.embeddingWork.schema, 'flashback.embedding_retained_work.v1');
    assert.equal(result.embeddingComplete, false); assert.equal(result.embeddedVectors, 0); assert.equal(result.embeddingPending, 1);
    assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    const [reloaded] = await second.read();
    assert.deepEqual(clone(reloaded.vector), before.vector); assert.equal(reloaded.model, before.model);
    const physical = await physicalScope(second);
    assert.deepEqual(physical.records[0].vector, before.vector); assert.equal(physical.records[0].model, before.model);
    assert.equal(physical.records[0].sourceHash, before.sourceHash); assert.equal(physical.records[0].text, before.text);
    console.log(JSON.stringify({ evidence: 'legacy_vector_restart', key: physical.shardKeys[0], vector: before.vector,
      model: before.model, sourceHash: before.sourceHash, text: before.text }));
    let calls = 0; second.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const retry = await second.call('rebuild');
    assert.equal(calls, 0); assert.equal(retry.embeddingComplete, false);
    assert.equal((await second.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('rebuild refuses worldline capacity loss and preserves the stored identifiers before any provider submission', async () => {
  const x = await setup();
  try {
    const nodes = Array.from({ length: 2048 }, (_, index) => ({ turnNodeId: `retired-capacity-node-${index}`,
      logicalTurnId: `retired-capacity-logical-${index}`, variantId: `retired-capacity-variant-${index}`,
      originalOrdinal: index + 1, pairIndex: index + 1, status: 'inactive_variant', createdAt: index + 1, updatedAt: index + 1 }));
    await x.h.context.__rawMaintenance.saveWorldline(x.scope.scopeKey, { ...await x.h.api._test.loadTurnWorldline(x.scope.scopeKey), nodes });
    const key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    const before = await x.h.pluginStorage.getItem(key);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await assert.rejects(() => x.call('rebuild'), error => error.code === 'FLASHBACK_WORLDLINE_PRESERVATION_CAPACITY');
    assert.equal(calls, 0); assert.equal(await x.h.pluginStorage.getItem(key), before);
    const retained = await x.h.api._test.loadTurnWorldline(x.scope.scopeKey);
    assert.deepEqual(clone(retained.nodes.map(node => node.turnNodeId)), nodes.map(node => node.turnNodeId));
    assert((await x.read()).some(record => record.text.includes(REPLY)), 'new raw publication survives the deferred lineage reconciliation');
  } finally { await x.h.cleanup(); }
});

test('retired raw capacity refuses an additional variant without silently truncating any stored original', async () => {
  const x = await setup();
  try {
    const sources = Array.from({ length: 2049 }, (_, index) => ({ ...x.sources[0], sourceId: `retired-capacity-source-${index}`,
      sourceHash: `retired-capacity-hash-${index}`,
      text: `User:\n${USER}\n\n---\n\nAssistant:\nRetired observatory ledger marker ${index} is stored under the distinct cedar cabinet.` }));
    const retired = (await x.h.api._test.buildRecordsFromSources(sources, x.cfg, x.scope, { deferEmbedding: true }))
      .map(record => ({ ...record, lifecycleStatus: 'inactive_variant', retiredAt: '2026-01-01T00:00:00.000Z' }));
    const worldline = { ...await x.h.api._test.loadTurnWorldline(x.scope.scopeKey), retiredRecords: retired.slice(0, 2048) };
    await x.h.context.__rawMaintenance.saveWorldline(x.scope.scopeKey, worldline);
    const key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    const before = await x.h.pluginStorage.getItem(key);
    await assert.rejects(() => x.h.context.__rawMaintenance.saveWorldline(x.scope.scopeKey, { ...worldline, retiredRecords: retired }),
      error => error.code === 'FLASHBACK_WORLDLINE_PRESERVATION_CAPACITY');
    assert.equal(await x.h.pluginStorage.getItem(key), before);
    const physical = JSON.parse(await x.h.pluginStorage.getItem(key));
    assert.deepEqual(physical.retiredRecords.map(record => [record.id, record.sourceHash, record.text]),
      clone(retired.slice(0, 2048).map(record => [record.id, record.sourceHash, record.text])));
    assert.equal(x.h.networkCalls.length, 0);
  } finally { await x.h.cleanup(); }
});

test('retirement capacity is checked before a reconciliation removes the active raw record', async () => {
  const x = await setup();
  try {
    await x.call('rebuild', { deferEmbedding: true });
    const oldSources = Array.from({ length: 2048 }, (_, index) => ({ ...x.sources[0], sourceId: `old-retirement-source-${index}`,
      sourceHash: `old-retirement-hash-${index}`,
      text: `User:\n${USER}\n\n---\n\nAssistant:\nOld retired ledger marker ${index} remains inside the closed cedar cabinet.` }));
    const retired = (await x.h.api._test.buildRecordsFromSources(oldSources, x.cfg, x.scope, { deferEmbedding: true }))
      .map(record => ({ ...record, lifecycleStatus: 'inactive_variant', retiredAt: '2026-01-01T00:00:00.000Z' }));
    const [tail] = await x.h.api._test.buildRecordsFromSources([{ ...x.sources[0], sourceId: 'removed-tail-source', sourceHash: 'removed-tail-hash',
      pairIndex: 2, turnIndex: 2, userMessagePosition: 3, assistantMessagePosition: 4,
      text: 'User:\nWhere is the retired appendix?\n\n---\n\nAssistant:\nThe removed tail raw marker remains inside a separate bronze cabinet.' }], x.cfg, x.scope, { deferEmbedding: true });
    Object.assign(tail, { turnNodeId: 'removed-tail-node', logicalTurnId: 'removed-tail-logical', variantId: 'removed-tail-variant', lifecycleStatus: 'active' });
    await x.h.api._test.saveAllRecords([...(await x.read()), tail], x.cfg, x.scope);
    const worldline = await x.h.api._test.loadTurnWorldline(x.scope.scopeKey);
    await x.h.context.__rawMaintenance.saveWorldline(x.scope.scopeKey, { ...worldline, retiredRecords: retired,
      nodes: [...worldline.nodes, { turnNodeId: tail.turnNodeId, logicalTurnId: tail.logicalTurnId, variantId: tail.variantId,
        pairIndex: 2, originalOrdinal: 2, status: 'orphaned', createdAt: 1, updatedAt: 2 }] });
    const before = await physicalScope(x);
    const chat = await x.h.host.getCurrentChat(), character = await x.h.host.getCharacter();
    const live = x.h.context.__rawMaintenance.liveState({ character, chat, characterIndex: 0, chatIndex: 0 });
    await assert.rejects(() => x.h.context.__rawMaintenance.synchronize(x.scope, live, x.cfg, { forceReconcile: true }),
      error => error.code === 'FLASHBACK_WORLDLINE_PRESERVATION_CAPACITY');
    const after = await physicalScope(x);
    assert.equal(after.manifest.commitId, before.manifest.commitId, 'capacity refusal must happen before publishing a corpus without the retiring raw source');
    assert.deepEqual(after.records, before.records); assert.deepEqual(after.worldline, before.worldline);
    assert.equal(after.records.find(record => record.sourceHash === tail.sourceHash)?.text, tail.text);
    assert.equal(x.h.networkCalls.length, 0);
  } finally { await x.h.cleanup(); }
});

test('rebuild preserves precise legacy sidecar values during raw publication and replaces them only after success', async () => {
  const x = await setup(); let second;
  try {
    const before = await seedLegacy(x, [Math.fround(0.123456789), Math.fround(0.765432109), Math.fround(0.654321987)]);
    assert(before.vectorRef, 'the fixture actually persists a sidecar');
    let calls = 0, submitted;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; const [record] = await x.read();
      submitted = { record: clone(record), registry: clone((await x.manifest()).embeddingAttemptRegistry) };
      return success(init);
    };
    const result = await x.call('rebuild');
    assert.deepEqual(submitted.record.vector, before.vector);
    assert.equal(submitted.record.model, before.model);
    assert.equal(submitted.record.embeddingWork.schema, 'flashback.embedding_retained_work.v1');
    assert.equal(submitted.registry.entries[submitted.record.embeddingWork.attempt.id].state, 'submitted');
    assert.equal(calls, 1); assert.equal(result.embeddingComplete, true); assert.equal(result.embeddedVectors, 1);
    const [ready] = await x.read();
    assert.equal(ready.text, before.text); assert.equal(ready.sourceHash, before.sourceHash);
    assert.deepEqual(clone(ready.vector), [0, 1, 0]); assert.equal(ready.model, x.cfg.embeddingModel);
    assert.equal(ready.embeddingWork, undefined); assert.equal(ready.embeddingReceipt.status, 'ready');
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    assert.deepEqual(clone((await second.read())[0].vector), [0, 1, 0]);
    let repeats = 0; second.h.host.nativeFetch = async (_url, init) => { repeats++; return success(init); };
    assert.equal((await second.call('rebuild')).embeddingComplete, true); assert.equal(repeats, 0);
    assert.equal((await second.read())[0].embeddingReceipt.attemptId, ready.embeddingReceipt.attemptId);
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('raw-only rebuild keeps a legacy vector without counting it as configured-model readiness', async () => {
  const x = await setup();
  try {
    const before = await seedLegacy(x);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.call('rebuild', { deferEmbedding: true });
    const [after] = await x.read();
    assert.equal(calls, 0); assert.deepEqual(clone(after.vector), before.vector);
    assert.equal(after.sourceId, before.sourceId); assert.equal(after.sourceHash, before.sourceHash); assert.equal(after.text, before.text);
    assert.equal(result.embeddingComplete, false); assert.equal(result.embeddingPending, 1);
    assert.equal(result.reusedVectors, 0); assert.equal(result.embeddedVectors, 0);
    assert.notEqual((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'ready');
  } finally { await x.h.cleanup(); }
});

test('a refused durable replacement after provider success leaves the legacy vector intact', async () => {
  const x = await setup(); let second, original;
  try {
    const before = await seedLegacy(x);
    original = x.h.pluginStorage.setItem.bind(x.h.pluginStorage);
    let calls = 0, refused = 0;
    x.h.pluginStorage.setItem = async (key, value) => {
      if (String(key).includes(':records:commit:')) {
        const shard = typeof value === 'string' ? JSON.parse(value) : value;
        if (shard.records?.some(record => record.embeddingReceipt?.status === 'ready' && record.model === x.cfg.embeddingModel)) {
          refused++; return false;
        }
      }
      return original(key, value);
    };
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.call('rebuild');
    assert.equal(calls, 1); assert(refused > 0); assert.equal(result.embeddingComplete, false);
    const [after] = await x.read();
    assert.deepEqual(clone(after.vector), before.vector); assert.equal(after.model, before.model);
    assert.equal(after.text, before.text); assert.equal(after.sourceHash, before.sourceHash);
    assert.notEqual(after.embeddingReceipt?.status, 'ready');
    x.h.pluginStorage.setItem = original;
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    assert.deepEqual(clone((await second.read())[0].vector), before.vector);
    let repeats = 0; second.h.host.nativeFetch = async (_url, init) => { repeats++; return success(init); };
    assert.equal((await second.call('rebuild')).embeddingComplete, false); assert.equal(repeats, 0);
  } finally { if (original) x.h.pluginStorage.setItem = original; await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('rebuilding a trusted copy does not relabel its unknown original source as a new native job', async () => {
  const x = await setup(); let second;
  try {
    await x.call('ingest', { deferEmbedding: true });
    x.h.host.nativeFetch = async () => { throw Error('synthetic unknown original'); };
    await x.h.api.processPendingEmbeddingWork({ sourceHash: x.sources[0].sourceHash });
    const before = clone((await x.read())[0]), history = clone((await x.manifest()).embeddingAttemptRegistry);
    const originalChat = await x.h.host.getCurrentChat(), character = await x.h.host.getCharacter();
    const targetChat = { ...clone(originalChat), id: 'trusted-rebuild-copy', chatId: 'trusted-rebuild-copy', name: 'Trusted copy' };
    character.chats.push(targetChat); character.chatPage = 1;
    x.h.host.getCurrentChatIndex = async () => 1; x.h.host.getChat = x.h.host.getCurrentChat = async () => targetChat;
    x.h.host.getChatFromIndex = async (_char, index) => character.chats[index];
    // Resolving the selected copied chat performs normal trusted adoption itself.
    // A second low-level clone would correctly refuse this now-populated target.
    const { scope: target, storageReady } = await x.h.context.__rawMaintenance.resolveBundle(false);
    assert.equal(storageReady.adopted, true);
    assert.equal(storageReady.cloned.ok, true);
    const copied = (await x.h.api._test.loadScopeRecords(target.scopeKey)).records;
    assert.equal(copied[0].sourceHash, before.sourceHash);
    assert.equal(copied[0].embeddingOriginScopeKey, x.scope.scopeKey);
    assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
    const copiedHistory = clone((await x.h.api._test.loadScopeManifest(target.scopeKey)).embeddingAttemptRegistry);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await x.call('rebuild');
    assert.equal(calls, 0, 'a chat-derived source ID change is not a fresh request authorization for a trusted copied source');
    const records = (await x.h.api._test.loadScopeRecords(target.scopeKey)).records;
    assert.equal(records[0].sourceHash, before.sourceHash);
    assert.equal(records[0].sourceId, before.sourceId); assert.equal(records[0].text, before.text);
    assert.equal(records[0].embeddingOriginScopeKey, x.scope.scopeKey);
    assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
    assert.deepEqual(clone((await x.h.api._test.loadScopeManifest(target.scopeKey)).embeddingAttemptRegistry), copiedHistory);
    assert.deepEqual(clone((await x.manifest()).embeddingAttemptRegistry), history);
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    const restartedCharacter = await second.h.host.getCharacter();
    restartedCharacter.chats.push(clone(targetChat)); restartedCharacter.chatPage = 1;
    second.h.host.getCurrentChatIndex = async () => 1;
    second.h.host.getChat = second.h.host.getCurrentChat = async () => restartedCharacter.chats[1];
    second.h.host.getChatFromIndex = async (_char, index) => restartedCharacter.chats[index];
    let repeats = 0; second.h.host.nativeFetch = async (_url, init) => { repeats++; return success(init); };
    const restarted = await second.call('rebuild');
    assert.equal(repeats, 0); assert.equal(restarted.embeddingComplete, false);
    const [reloaded] = (await second.h.api._test.loadScopeRecords(target.scopeKey)).records;
    assert.equal(reloaded.sourceId, before.sourceId); assert.equal(reloaded.sourceHash, before.sourceHash); assert.equal(reloaded.text, before.text);
    assert.equal(reloaded.embeddingOriginScopeKey, x.scope.scopeKey);
    assert.equal((await second.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
    assert.deepEqual(clone((await second.h.api._test.loadScopeManifest(target.scopeKey)).embeddingAttemptRegistry), copiedHistory);
    const physical = await physicalScope(second, target);
    assert.equal(physical.records[0].embeddingOriginScopeKey, x.scope.scopeKey);
    assert.equal(physical.records[0].sourceHash, before.sourceHash); assert.equal(physical.records[0].sourceId, before.sourceId);
    assert.equal(physical.records[0].text, before.text); assert.deepEqual(physical.manifest.embeddingAttemptRegistry, copiedHistory);
    console.log(JSON.stringify({ evidence: 'trusted_origin_restart', key: physical.shardKeys[0],
      originScopeKey: physical.records[0].embeddingOriginScopeKey, sourceId: before.sourceId, sourceHash: before.sourceHash,
      attemptIds: Object.keys(copiedHistory.entries), text: before.text }));
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

const RECHUNK_CODE = 'FLASHBACK_REBUILD_RECHUNK_PRESERVATION_REQUIRED';
const WORLDLINE_INTEGRITY_CODE = 'FLASHBACK_WORLDLINE_PRESERVATION_INTEGRITY';
for (const [name, ids] of [
  ['colliding long turn IDs', ['a'.repeat(96) + 'X', 'a'.repeat(96) + 'Y']],
  ['an unstable long turn ID', ['a'.repeat(96) + 'X']]
]) test(`rebuild refuses ${name} before normalizing away an existing history identity`, async () => {
  const x = await setup(); let second;
  try {
    await seedLegacy(x);
    const key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    const worldline = clone(await x.h.api._test.loadTurnWorldline(x.scope.scopeKey));
    worldline.nodes = ids.map((turnNodeId, index) => ({ turnNodeId, variantId: 'original-variant-' + index,
      status: 'inactive_variant', pairIndex: index + 1 }));
    const stored = JSON.stringify(worldline);
    await x.h.pluginStorage.setItem(key, stored);
    const bytes = await scopeBytes(x);
    let calls = 0, rejected;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await x.call('rebuild', { deferEmbedding: true }).catch(error => { rejected = error; });
    const preserved = await x.h.pluginStorage.getItem(key) === stored;
    console.log(JSON.stringify({ evidence: 'worldline_node_identity_refusal', name, inputIds: ids,
      calls, error: rejected?.code || null, storedBytesPreserved: preserved }));
    assert(preserved, 'the exact stored node identities and variants remain recoverable');
    assert.equal(rejected?.code, WORLDLINE_INTEGRITY_CODE);
    assert.equal(calls, 0); assert.deepEqual(await scopeBytes(x), bytes, 'no replacement raw/vector generation was published');
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    await assert.rejects(second.h.api._test.loadTurnWorldline(x.scope.scopeKey), error => error.code === WORLDLINE_INTEGRITY_CODE);
    assert.deepEqual(await scopeBytes(second), bytes);
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});
test('rebuild retains distinct full-width 96-character turn IDs without treating valid history as a collision', async () => {
  const x = await setup();
  try {
    await seedLegacy(x);
    const key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    const ids = ['a'.repeat(95) + 'X', 'a'.repeat(95) + 'Y'];
    const worldline = clone(await x.h.api._test.loadTurnWorldline(x.scope.scopeKey));
    worldline.nodes = ids.map((turnNodeId, index) => ({ turnNodeId, variantId: 'valid-variant-' + index,
      status: 'inactive_variant', pairIndex: index + 1 }));
    await x.h.pluginStorage.setItem(key, JSON.stringify(worldline));
    assert.deepEqual(clone((await x.h.api._test.loadTurnWorldline(x.scope.scopeKey)).nodes.map(node => node.turnNodeId)), ids);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await x.call('rebuild', { deferEmbedding: true });
    const physical = JSON.parse(await x.h.pluginStorage.getItem(key));
    for (let index = 0; index < ids.length; index++) {
      assert.equal(physical.nodes.find(node => node.turnNodeId === ids[index])?.variantId, 'valid-variant-' + index);
    }
    assert.equal(calls, 0);
  } finally { await x.h.cleanup(); }
});
test('rebuild refuses corrupt persisted worldline bytes before replacing any raw or vector generation', async () => {
  const x = await setup();
  try {
    const before = await seedLegacy(x);
    const [retired] = await x.h.api._test.buildRecordsFromSources([{ ...x.sources[0], sourceHash: 'corrupt-retired-marker',
      text: `User:\n${USER}\n\n---\n\nAssistant:\nThe original retired raw marker remains recoverable.` }], x.cfg, x.scope, { deferEmbedding: true });
    const key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    await x.h.context.__rawMaintenance.saveWorldline(x.scope.scopeKey, {
      ...await x.h.api._test.loadTurnWorldline(x.scope.scopeKey), retiredRecords: [retired]
    });
    const stored = await x.h.pluginStorage.getItem(key);
    const corrupt = stored.slice(0, -1);
    await x.h.pluginStorage.setItem(key, corrupt);
    const bytes = await scopeBytes(x);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    let rejected;
    await x.call('rebuild').catch(error => { rejected = error; });
    console.log(JSON.stringify({ evidence: 'corrupt_worldline_refusal', calls,
      error: rejected?.code || null, storedBytesPreserved: await x.h.pluginStorage.getItem(key) === corrupt }));
    assert.equal(await x.h.pluginStorage.getItem(key), corrupt, 'existing corrupt worldline bytes are recoverable history');
    assert.equal(rejected?.code, WORLDLINE_INTEGRITY_CODE);
    assert.equal(calls, 0);
    assert.deepEqual(await scopeBytes(x), bytes, 'corrupt history cannot authorize replacement or cleanup of an existing generation');
    const [after] = await x.read();
    assert.equal(after.sourceHash, before.sourceHash); assert.deepEqual(clone(after.vector), before.vector);
  } finally { await x.h.cleanup(); }
});
const malformedWorldlines = [
  ['empty stored bytes', () => ''],
  ['parsed null', () => 'null'],
  ['array root', () => '[]'],
  ['missing history arrays', value => JSON.stringify({ version: value.version, scopeKey: value.scopeKey })],
  ['foreign scope', value => JSON.stringify({ ...value, scopeKey: 'foreign-worldline-owner' })],
  ['unknown version', value => JSON.stringify({ ...value, version: 'future-worldline-schema' })],
  ['invalid node', value => JSON.stringify({ ...value, nodes: [{ variantId: 'recoverable-invalid-node' }] })],
  ['duplicate node', value => JSON.stringify({ ...value, nodes: [
    { turnNodeId: 'duplicate-node', variantId: 'first-variant' }, { turnNodeId: 'duplicate-node', variantId: 'second-variant' }
  ] })],
  ['invalid retired vector', value => JSON.stringify({ ...value,
    retiredRecords: [{ id: 'recoverable-raw', sourceType: 'response', text: 'retired raw with unreadable derived dependency', vector: null }] })]
];
for (const [name, corrupt] of malformedWorldlines) test(`rebuild preserves ${name} worldline evidence and refuses before publication`, async () => {
  const x = await setup(); let second;
  try {
    await seedLegacy(x);
    const key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    const worldline = await x.h.api._test.loadTurnWorldline(x.scope.scopeKey);
    await x.h.pluginStorage.setItem(key, corrupt(clone(worldline)));
    const bytes = await scopeBytes(x);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await assert.rejects(x.call('rebuild'), error => error.code === WORLDLINE_INTEGRITY_CODE);
    assert.equal(calls, 0); assert.deepEqual(await scopeBytes(x), bytes);
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    await assert.rejects(second.h.api._test.loadTurnWorldline(x.scope.scopeKey), error => error.code === WORLDLINE_INTEGRITY_CODE);
    assert.deepEqual(await scopeBytes(second), bytes, 'fresh-runtime loading preserves exact corrupt evidence');
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});
test('unavailable worldline read refuses rebuild before raw/vector publication and preserves persisted history', async () => {
  const x = await setup();
  try {
    await seedLegacy(x);
    const bytes = await scopeBytes(x), key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    const get = x.h.pluginStorage.getItem;
    let reads = 0, calls = 0;
    x.h.pluginStorage.getItem = async name => {
      if (name === key) { reads++; throw Error('synthetic worldline unavailable'); }
      return get(name);
    };
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    try { await assert.rejects(x.call('rebuild'), /synthetic worldline unavailable/); }
    finally { x.h.pluginStorage.getItem = get; }
    assert(reads > 0); assert.equal(calls, 0); assert.deepEqual(await scopeBytes(x), bytes);
  } finally { await x.h.cleanup(); }
});
test('worldline corruption after rebuild preparation still refuses before publishing a replacement', async () => {
  const x = await setup();
  try {
    await seedLegacy(x);
    const key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    const corrupt = JSON.stringify({ ...clone(await x.h.api._test.loadTurnWorldline(x.scope.scopeKey)),
      retiredRecords: [{ id: 'late-retired-evidence', sourceType: 'response', text: 'late retained raw evidence', vector: null }] });
    let bytes, calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await assert.rejects(x.call('rebuild', { maintenanceSourceValidate: async () => {
      if (bytes) return;
      await x.h.pluginStorage.setItem(key, corrupt);
      bytes = await scopeBytes(x);
    } }), error => error.code === WORLDLINE_INTEGRITY_CODE);
    assert(bytes, 'the corruption hook runs after the initial integrity check');
    assert.equal(calls, 0); assert.deepEqual(await scopeBytes(x), bytes);
  } finally { await x.h.cleanup(); }
});
test('an absent worldline is a valid first raw publication rather than corrupt persisted evidence', async () => {
  const x = await setup();
  try {
    const key = x.h.context.__rawMaintenance.keys.worldline(x.scope.scopeKey);
    assert.equal(await x.h.pluginStorage.getItem(key), null);
    assert.equal((await x.h.api._test.loadTurnWorldline(x.scope.scopeKey)).retiredRecords.length, 0);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await x.call('rebuild', { deferEmbedding: true });
    assert.equal(calls, 0);
    assert.equal((await x.read())[0].text, x.sources[0].text);
    assert((await x.h.api._test.loadTurnWorldline(x.scope.scopeKey)).nodes.length > 0);
  } finally { await x.h.cleanup(); }
});
const rechunkOptions = { reply: `${REPLY} `.repeat(30), settings: { chunkChars: 12000, chunkOverlap: 0 } };
async function scopeBytes(x, scope = x.scope) {
  const prefix = x.h.context.__rawMaintenance.keys.manifest(scope.scopeKey).split(':manifest:')[0] + ':';
  const vectorPrefix = x.h.context.__rawMaintenance.keys.localVectorShard(scope.scopeKey, 'rechunk-byte-marker', 0)
    .split(':rechunk-byte-marker:')[0] + ':';
  const rows = [];
  for (const [name, storage] of [['pluginStorage', x.h.pluginStorage], ['safeLocalStorage', x.h.safeLocalStorage]]) {
    for (const key of (await storage.keys()).filter(key => key.startsWith(prefix) || key.startsWith(vectorPrefix)).sort()) {
      const value = await storage.getItem(key); rows.push([`${name}/${key}`, typeof value === 'string' ? value : JSON.stringify(value)]);
    }
  }
  return rows;
}
async function physicalLegacyVector(x, before) {
  const physical = await physicalScope(x), record = physical.records.find(row => row.id === before.id);
  assert.equal(record.sourceId, before.sourceId); assert.equal(record.sourceHash, before.sourceHash); assert.equal(record.text, before.text);
  assert.deepEqual(record.vectorRef, before.vectorRef);
  const raw = await x.h.safeLocalStorage.getItem(record.vectorRef.storageKey), payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assert(payload, 'the vector is read from its actual persisted local sidecar');
  const item = payload.items.find(row => row.recordId === before.id), data = Buffer.from(payload.data, 'base64');
  const values = Array.from({ length: item.length }, (_, index) => data.readFloatLE((item.offset + index) * 4));
  assert.deepEqual(values, before.vector);
  return { key: record.vectorRef.storageKey, values };
}
async function changeChunkSettings(x) {
  Object.assign(x.cfg, { chunkChars: 240, chunkOverlap: 0 });
  await x.h.api.saveSettings(x.cfg);
}
for (const transport of ['failure', 'success']) test(`unchanged-source rechunk refuses before ${transport} transport and preserves exact legacy storage on restart`, async () => {
  const x = await setup(rechunkOptions); let second;
  try {
    const before = await seedLegacy(x, [Math.fround(0.123456789), Math.fround(0.765432109), Math.fround(0.654321987)]);
    assert.equal(before.chunkCount, 1); assert(before.vectorRef);
    const hostMessages = clone((await x.h.host.getCurrentChat()).message);
    await x.h.context.__rawMaintenance.saveWorldline(x.scope.scopeKey, { ...await x.h.api._test.loadTurnWorldline(x.scope.scopeKey),
      nodes: [{ turnNodeId: 'rechunk-retired-node', logicalTurnId: 'rechunk-retired-logical', variantId: 'rechunk-retired-variant',
        pairIndex: 2, originalOrdinal: 2, status: 'inactive_variant', createdAt: 1, updatedAt: 2 }],
      retiredRecords: [{ ...before, id: 'rechunk-retired-raw', sourceHash: 'rechunk-retired-hash', turnNodeId: 'rechunk-retired-node',
        logicalTurnId: 'rechunk-retired-logical', variantId: 'rechunk-retired-variant', lifecycleStatus: 'inactive_variant',
        retiredAt: '2026-01-01T00:00:00.000Z' }] });
    await changeChunkSettings(x);
    const candidate = await x.h.api._test.buildRecordsFromSources(x.sources, x.cfg, x.scope, { deferEmbedding: true });
    assert(candidate.length > 1, 'the requested settings would actually create a different raw chunk generation');
    const stored = await scopeBytes(x); let calls = 0;
    assert(stored.some(([key]) => key === `safeLocalStorage/${before.vectorRef.storageKey}`), 'byte snapshots include the actual precise sidecar payload');
    x.h.host.nativeFetch = async (_url, init) => { calls++; if (transport === 'failure') throw Error('synthetic failure'); return success(init); };
    await assert.rejects(() => x.call('rebuild'), error => error.code === RECHUNK_CODE);
    assert.equal(calls, 0); assert.deepEqual(await scopeBytes(x), stored);
    assert.deepEqual(clone(await x.read()), [before]);
    assert.deepEqual(clone((await x.h.host.getCurrentChat()).message), hostMessages);
    await physicalLegacyVector(x, before);
    await x.h.cleanup();
    second = await setup({ ...rechunkOptions, settings: x.cfg, pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    assert.deepEqual(await scopeBytes(second), stored); assert.deepEqual(clone(await second.read()), [before]);
    assert.deepEqual(clone((await second.h.host.getCurrentChat()).message), hostMessages);
    const sidecar = await physicalLegacyVector(second, before);
    let repeats = 0; second.h.host.nativeFetch = async (_url, init) => { repeats++; return success(init); };
    await assert.rejects(() => second.call('rebuild'), error => error.code === RECHUNK_CODE);
    assert.equal(repeats, 0); assert.deepEqual(await scopeBytes(second), stored);
    console.log(JSON.stringify({ evidence: 'rechunk_refusal_legacy_restart', transport, sourceId: before.sourceId,
      sourceHash: before.sourceHash, vector: before.vector, sourceText: before.text, oldChunks: 1, requestedChunks: candidate.length,
      storeKeys: stored.map(([key]) => key), sidecar, sameHostMessages: true, calls, repeats, error: RECHUNK_CODE }));
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('trusted-copy rechunk refuses with the original unknown attempt, origin and physical stores intact on restart', async () => {
  const x = await setup(rechunkOptions); let second;
  try {
    await x.call('ingest', { deferEmbedding: true });
    x.h.host.nativeFetch = async () => { throw Error('synthetic unknown original'); };
    await x.h.api.processPendingEmbeddingWork({ sourceHash: x.sources[0].sourceHash });
    const original = clone(await x.read()), originalBytes = await scopeBytes(x);
    const chat = await x.h.host.getCurrentChat(), character = await x.h.host.getCharacter();
    const hostMessages = clone(chat.message);
    const targetChat = { ...clone(chat), id: 'trusted-rechunk-copy', chatId: 'trusted-rechunk-copy' };
    character.chats.push(targetChat); character.chatPage = 1;
    x.h.host.getCurrentChatIndex = async () => 1; x.h.host.getChat = x.h.host.getCurrentChat = async () => targetChat;
    x.h.host.getChatFromIndex = async (_char, index) => character.chats[index];
    const { scope: target, storageReady } = await x.h.context.__rawMaintenance.resolveBundle(false);
    assert.equal(storageReady.adopted, true); assert.equal(storageReady.cloned.ok, true);
    const copied = clone((await x.h.api._test.loadScopeRecords(target.scopeKey)).records), copiedBytes = await scopeBytes(x, target);
    assert.equal(copied[0].embeddingOriginScopeKey, x.scope.scopeKey);
    assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
    await changeChunkSettings(x); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await assert.rejects(() => x.call('rebuild'), error => error.code === RECHUNK_CODE);
    assert.equal(calls, 0); assert.deepEqual(await scopeBytes(x, target), copiedBytes); assert.deepEqual(await scopeBytes(x), originalBytes);
    assert.deepEqual(clone((await x.h.api._test.loadScopeRecords(target.scopeKey)).records), copied);
    await x.h.cleanup();
    second = await setup({ ...rechunkOptions, settings: x.cfg, pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    const restartedCharacter = await second.h.host.getCharacter(); restartedCharacter.chats.push(clone(targetChat)); restartedCharacter.chatPage = 1;
    second.h.host.getCurrentChatIndex = async () => 1;
    second.h.host.getChat = second.h.host.getCurrentChat = async () => restartedCharacter.chats[1];
    second.h.host.getChatFromIndex = async (_char, index) => restartedCharacter.chats[index];
    let repeats = 0; second.h.host.nativeFetch = async (_url, init) => { repeats++; return success(init); };
    await assert.rejects(() => second.call('rebuild'), error => error.code === RECHUNK_CODE);
    assert.equal(repeats, 0); assert.deepEqual(await scopeBytes(second, target), copiedBytes); assert.deepEqual(await scopeBytes(second), originalBytes);
    assert.deepEqual(clone((await second.h.api._test.loadScopeRecords(target.scopeKey)).records), copied);
    assert.deepEqual(clone(await second.read()), original);
    assert.equal((await second.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
    const physical = await physicalScope(second, target);
    assert.equal(physical.records[0].embeddingOriginScopeKey, x.scope.scopeKey);
    assert.equal(physical.records[0].sourceId, original[0].sourceId); assert.equal(physical.records[0].sourceHash, original[0].sourceHash);
    assert.equal(physical.records[0].text, original[0].text);
    assert.deepEqual(clone((await second.h.host.getCurrentChat()).message), hostMessages);
    console.log(JSON.stringify({ evidence: 'trusted_rechunk_refusal_restart', origin: copied[0].embeddingOriginScopeKey,
      sourceId: copied[0].sourceId, sourceHash: copied[0].sourceHash, registry: physical.manifest.embeddingAttemptRegistry,
      calls, repeats, error: RECHUNK_CODE }));
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

class RechunkUiNode {
  constructor(doc, tag = 'div', id = '') {
    Object.assign(this, { doc, tagName: tag, id, children: [], dataset: {}, style: {}, listeners: new Map(), disabled: false,
      isConnected: true, className: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} } });
  }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.isConnected = false; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] || ''; }
  focus() { this.doc.activeElement = this; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  async click() { assert(this.listeners.has('click')); return this.listeners.get('click')({ target: this, preventDefault() {}, stopPropagation() {} }); }
}
test('the registered rebuild GUI surfaces rechunk refusal instead of completion before any provider probe', async () => {
  const x = await setup(rechunkOptions);
  try {
    await seedLegacy(x); await changeChunkSettings(x); const stored = await scopeBytes(x);
    const doc = { createElement(tag) { return new RechunkUiNode(doc, tag); }, addEventListener() {}, removeEventListener() {} };
    doc.body = new RechunkUiNode(doc, 'body'); doc.head = new RechunkUiNode(doc, 'head'); doc.activeElement = doc.body;
    doc.all = () => { const out = []; const walk = node => { out.push(node); node.children.forEach(walk); }; walk(doc.body); walk(doc.head); return out; };
    doc.getElementById = id => doc.all().find(node => node.id === id) || null;
    const root = new RechunkUiNode(doc, 'div', 'root'); root.nodes = new Map();
    for (const id of ['maintenanceRunBtn', 'maintenanceMode']) root.nodes.set(id, new RechunkUiNode(doc, id.endsWith('Btn') ? 'button' : 'select', id));
    root.nodes.get('maintenanceMode').value = 'rebuild';
    root.querySelector = selector => selector.startsWith('#') ? root.nodes.get(selector.slice(1)) || null : null;
    root.querySelectorAll = selector => selector === 'button' ? [root.nodes.get('maintenanceRunBtn')] : [];
    doc.body.appendChild(root); x.h.context.document = doc; x.h.context.__rawMaintenance.mount(root);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    let done = false, handlerError;
    const run = root.nodes.get('maintenanceRunBtn').click().then(() => { done = true; }, error => { done = true; handlerError = error; });
    const messages = [], seen = new Set();
    for (let index = 0; index < 1000 && !done; index++) {
      const button = dialogElements(doc).ok;
      if (button && !seen.has(button)) {
        seen.add(button); messages.push(dialogElements(doc).message?.textContent || ''); await button.click();
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(done, 'the actual registered GUI handler settles'); await run; if (handlerError) throw handlerError;
    assert.equal(calls, 0); assert.deepEqual(await scopeBytes(x), stored);
    assert.equal(messages.length, 2, 'confirmation is followed by the surfaced error, without a completion dialog');
    assert(messages[1].includes(RECHUNK_CODE), messages.join(' | '));
    const journal = x.h.audit.Runtime.maintenanceJournal;
    assert.equal(journal.status, 'failed'); assert.equal(journal.result, null); assert(journal.error.includes(RECHUNK_CODE));
    console.log(JSON.stringify({ evidence: 'rechunk_gui_error', messages, calls, journalStatus: journal.status, error: RECHUNK_CODE }));
  } finally { await x.h.cleanup(); }
});
