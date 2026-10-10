'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');
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
  { role: 'assistant', data: 'At moonrise, Mira meets Rowan alone and whispers silver rain.', chatId: 'source-assistant-2' }
];

const pluginStorage = createStore();
const safeLocalStorage = createStore();
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

(async () => {
  vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });
  const flashback = await waitFor(() => context.__FlashbackMemory, 'Flashback API');
  const portable = await waitFor(() => context.__FlashbackPortableMemoryBackup, 'portable API');
  assert.equal(flashback.version, source.match(/^[\/][\/]@version\s+(\S+)/m)[1]);

  const ingested = await flashback.ingestLiveChatColdStart({
    scope: 'current',
    incremental: false,
    skipEpisodeRebuild: true,
    skipGuiRefresh: true,
    allowHashFallback: true
  });
  assert.equal(ingested.liveChatTurns, 2, 'source transcript creates two canonical U+A turns');
  const sourceScope = await flashback.resolveCurrentScope(true);
  const sourceLoaded = await flashback._test.loadScopeRecords(sourceScope.scopeKey);
  assert.ok(sourceLoaded.records.length >= 2, 'source records are durable before export');
  // First preserve the rejected fixture as an explicit negative contract.
  const sourceBeforeInvalid = JSON.stringify(sourceLoaded.records);
  await assert.rejects(() => flashback._test.saveAllRecords(sourceLoaded.records.map((record, index) =>
    index ? record : { ...record, text: record.text + ' stale work binding' })),
    error => error.code === 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID');
  assert.equal(JSON.stringify((await flashback._test.loadScopeRecords(sourceScope.scopeKey)).records), sourceBeforeInvalid);
  console.log('PASS invalid retained source/work binding rejected without changing source');

  const fixtureSettings = flashback._test.normalizeSettings({
    ...await flashback.loadSettings(), embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small',
    embeddingUrl: 'https://portable-fixture.invalid/v1/embeddings', embeddingEnabled: true,
    embeddingDimensions: 4, embeddingAutoProcess: false, embeddingMaxRetries: 0,
    episodeIndexEnabled: false, autoEpisodeIndex: false, episodeMinRecords: 2, episodeHierarchyEnabled: false
  });
  await flashback.saveSettings(fixtureSettings);
  const sourceRows = await flashback._test.buildRecordsFromSources(sourceLoaded.records.map(record => ({
    sourceType: 'response', sourceId: record.sourceId, sourceHash: record.sourceHash,
    text: record.text, turnIndex: record.turnIndex, pairIndex: record.pairIndex, sanitizeMemory: false
  })), fixtureSettings, sourceScope);
  assert.ok(sourceRows.every(record => record.vector.length === 4));
  await flashback._test.saveAllRecords(sourceRows, fixtureSettings, sourceScope);
  await flashback.saveSettings({ ...fixtureSettings, episodeIndexEnabled: true });
  const rebuiltEpisode = await flashback.rebuildEpisodeIndex(sourceScope);
  assert.equal(rebuiltEpisode.rebuilt, true, 'public episode rebuild reaches the production builder and durable commit');
  const episodes = (await flashback._test.loadScopeRecords(sourceScope.scopeKey)).records.filter(record => record.autoEpisode);
  assert.equal(episodes.length, 1, 'public episode rebuild creates the archived episode fixture');
  assert.deepEqual(Array.from(episodes, record => [record.turnRange.start, record.turnRange.end]), [[1, 2]]);
  assert.ok(episodes.every(record => !record.turnIndex && !record.pairIndex), 'real episodes span turns rather than impersonating a response row');
  await flashback.saveSettings(fixtureSettings);
  console.log('PASS public episode rebuild durably creates aggregate episode spanning turns 1-2');
  const bulkArchiveSources = Array.from({ length: 640 }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    return { sourceType: 'response', sourceId: `bulk-archive-probe-${suffix}`,
      text: `Bulk archive route probe ${suffix} preserves cobalt compass token ${suffix}.`,
      turnIndex: index + 10, pairIndex: index + 10, sanitizeMemory: false };
  });
  const sourceWithEpisode = await flashback._test.loadScopeRecords(sourceScope.scopeKey);
  const activeVectorRef = sourceWithEpisode.records.find(record => record.vectorRef?.storageKey)?.vectorRef;
  assert.ok(activeVectorRef?.storageKey, 'source uses a durable Float32 sidecar before export');
  const staleShardKey = `vector_rag_memory:scope:${sourceScope.storageHash}:records:commit:stale-portable-export:shard:0000`;
  const staleVectorKey = `vector_rag_memory:local-vector-shard:v1:${sourceScope.storageHash}:stale-portable-export:0000`;
  await pluginStorage.setItem(staleShardKey, {
    scopeKey: sourceScope.scopeKey,
    commitId: 'stale-portable-export',
    shardIndex: 0,
    records: [{
      ...sourceWithEpisode.records[0],
      vector: [],
      vectorRef: { ...activeVectorRef, storageKey: staleVectorKey }
    }]
  });
  const envelope = await portable.exportCurrentScope();
  assert.ok(!envelope.records.some(record => record.key === staleShardKey), 'portable export excludes retired commit shards and their missing sidecars');
  assert.equal(envelope.formatVersion, 2);
  assert.equal(envelope.policy.restore, 'portable_restore_modes_v2');
  assert.equal(envelope.source.chatId, 'portable-source-chat');
  assert.equal(envelope.source.chatMessageCount, 4);
  assert.ok(envelope.source.chatFingerprint, 'export binds the source transcript fingerprint');
  console.log('PASS portable export excludes retired shards and includes durable vector sidecars');
  const sourcePhysicalPrefix = `vector_rag_memory:scope:${sourceScope.storageHash}:`;
  const sourcePhysicalBefore = cloneMap(new Map(Array.from(pluginStorage.values).filter(([key]) => String(key).startsWith(sourcePhysicalPrefix) && String(key) !== staleShardKey)));
  const sourceVectorsBefore = cloneMap(new Map(Array.from(safeLocalStorage.values).filter(([key]) => String(key).includes(`:${sourceScope.storageHash}:`))));

  currentChatIndex = 1;
  const migrationInspection = await portable.inspectRestoreOptions(envelope);
  assert.equal(migrationInspection.modes.same_chat_replace.allowed, false);
  assert.equal(migrationInspection.modes.chat_migration_archive.allowed, true);
  assert.equal(migrationInspection.modes.chat_copy_rebind.allowed, false);
  const migrated = await portable.restoreCurrentScope(envelope, { mode: 'chat_migration_archive' });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.mode, 'chat_migration_archive');
  assert.ok(migrated.archiveRecords >= 2, 'all imported logical memories are linked as an archive');
  const migrationScope = migrationInspection.target.scope;
  const migrationManifest = await flashback._test.loadScopeManifest(migrationScope.scopeKey);
  assert.equal(migrationManifest.count, 0, 'migration keeps the target active layer empty');
  assert.equal(migrationManifest.copyAdoptionMode, 'shared_archive');
  assert.equal(migrationManifest.portableRestoreMode, 'chat_migration_archive');
  const migrationArchive = await flashback._test.loadFlashbackArchiveManifestSummary(migrationManifest.archiveRef);
  assert.equal(migrationArchive.verified, true, 'migration archive survives durable manifest-chain verification');
  assert.equal(migrationArchive.records, migrated.archiveRecords);
  const migrationReenteredScope = await flashback.resolveCurrentScope(true);
  assert.equal(migrationReenteredScope.scopeKey, migrationScope.scopeKey);
  const migrationReenteredManifest = await flashback._test.loadScopeManifest(migrationScope.scopeKey);
  assert.equal(migrationReenteredManifest.copyAdoptionMode, 'shared_archive', 'normal scope initialization preserves archive-migration semantics');
  assert.equal(migrationReenteredManifest.count, 0, 'normal scope initialization does not promote inherited archive rows into the active layer');

  console.log('PASS empty-target archive migration and scope reentry');
  // Keep this branch focused on the manual fallback. The plugin's background
  // native-copy watcher would otherwise adopt the identical transcript before
  // the portable restore inspector can evaluate an empty target.
  for (const timer of activeTimeouts) clearTimeout(timer);
  activeTimeouts.clear();
  for (const timer of activeIntervals) clearInterval(timer);
  activeIntervals.clear();
  chats[2].message = transcript();
  chats[2].messages = chats[2].message;
  currentChatIndex = 2;
  const copyInspection = await portable.inspectRestoreOptions(envelope);
  assert.equal(copyInspection.modes.same_chat_replace.allowed, false);
  assert.equal(copyInspection.modes.chat_migration_archive.allowed, true);
  assert.equal(copyInspection.modes.chat_copy_rebind.allowed, true);
  assert.equal(copyInspection.transcriptMatches, true);
  const copied = await portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' });
  assert.equal(copied.ok, true);
  assert.equal(copied.mode, 'chat_copy_rebind');
  assert.equal(copied.activeTurns, 2, 'copied transcript reconstructs two active worldline turns');
  const copyScope = copyInspection.target.scope;
  const copyLoaded = await flashback._test.loadScopeRecords(copyScope.scopeKey);
  const copyManifest = copyLoaded.manifest;
  assert.equal(copyManifest.copyAdoptionMode, 'chat_copy_live');
  assert.equal(copyManifest.portableRestoreMode, 'chat_copy_rebind');
  assert.equal(copyManifest.count, copyLoaded.records.length);
  assert.ok(copyLoaded.records.every(record => record.scopeKey === copyScope.scopeKey), 'every copied record is rebound to the target scope');
  assert.ok(copyLoaded.records.every(record => record.copiedFromLiveScopeKey === sourceScope.scopeKey), 'source scope provenance is retained');
  const copyWorldline = await flashback._test.loadTurnWorldline(copyScope.scopeKey);
  assert.equal(copyWorldline.nodes.filter(node => node.status === 'active').length, 2);
  assert.equal(copyWorldline.liveHash, copyManifest.turnWorldlineLiveHash);
  const copyReenteredScope = await flashback.resolveCurrentScope(true);
  assert.equal(copyReenteredScope.scopeKey, copyScope.scopeKey);
  const copyReenteredManifest = await flashback._test.loadScopeManifest(copyScope.scopeKey);
  assert.equal(copyReenteredManifest.copyAdoptionMode, 'chat_copy_live', 'normal scope initialization preserves copied-chat semantics');
  assert.equal(copyReenteredManifest.portableImportId, copied.importId);

  console.log('PASS matching transcript copy rebind and worldline reconstruction');
  currentChatIndex = 1;
  assert.equal((await flashback.resolveCurrentScope(true)).scopeKey, migrationScope.scopeKey);

  const archiveFixtureSettings = await flashback.loadSettings(true);
  const bulkArchiveRecords = await flashback._test.buildRecordsFromSources(bulkArchiveSources, archiveFixtureSettings, migrationScope);
  // Stable archive identity is assigned before persistence; source and vector bindings remain builder-generated.
  for (const record of bulkArchiveRecords) record.permanentHistoryId = record.sourceId;
  await flashback._test.saveAllRecords(bulkArchiveRecords, archiveFixtureSettings, migrationScope);
  const migrationWithBulk = await flashback._test.loadScopeRecords(migrationScope.scopeKey);
  const expandedArchive = await flashback._test.createImmutableFlashbackHandoffArchive(
    migrationScope.scopeKey,
    migrationWithBulk.records.length,
    archiveFixtureSettings
  );
  const emptiedMigration = await flashback._test.saveAllRecords([], archiveFixtureSettings, migrationScope);
  await flashback._test.saveScopeManifest({
    ...emptiedMigration.manifest,
    archiveRef: expandedArchive.archiveRef,
    archiveLinkedAt: new Date().toISOString(),
    copyAdoptedComplete: true,
    copyAdoptionMode: 'shared_archive'
  }, migrationScope);
  const migrationExpandedManifest = await flashback._test.loadScopeManifest(migrationScope.scopeKey);
  assert.equal(migrationExpandedManifest.count, 0, 'large routed-recall fixture is attached as archive history, not active local memory');
  assert.equal(migrationExpandedManifest.archiveRef.recordCount, migrationArchive.records + bulkArchiveRecords.length);

  const originalArchiveRef = migrationExpandedManifest.archiveRef;
  const originalArchiveManifest = await flashback._test.loadScopeManifest(originalArchiveRef.archiveScopeKey);
  const originalArchivePrefix = `vector_rag_memory:scope:${originalArchiveManifest.storageHash}:`;
  const originalArchivePhysicalBefore = cloneMap(new Map(Array.from(pluginStorage.values).filter(([key]) => String(key).startsWith(originalArchivePrefix))));
  const baseSettings = await flashback.loadSettings(true);
  const settings96 = flashback._test.normalizeSettings({
    ...baseSettings,
    embeddingEnabled: true,
    embeddingProvider: 'openai',
    embeddingDimensions: 96,
    episodeIndexEnabled: false
  });
  const plan96 = await flashback.inspectMemoryMaintenance({ settings: settings96, scope: migrationScope, ensureStorage: false });
  assert.equal(plan96.localRecordsNeedingEmbedding, 0, 'archive-only migration has no local vectors to repair');
  assert.ok(plan96.archiveRecordsNeedingEmbedding >= 2, 'maintenance inspection includes archive vector profile mismatches');
  const fullReembed = await flashback.reembedAllRecords({ settings: settings96, scope: migrationScope });
  if (!(fullReembed.archiveReembedded >= 2)) console.error('ARCHIVE_REEMBED_RESULT', JSON.stringify(fullReembed));
  assert.equal(fullReembed.localReembedded, 0, 'full archive re-embedding does not materialize active local rows');
  assert.ok(fullReembed.archiveReembedded >= 2, 'full re-embedding durably updates archive memories');
  assert.equal(fullReembed.reembedded, fullReembed.archiveReembedded, 'success count reflects durable archive writes');
  assert.equal(fullReembed.archiveRefUpdated, true);
  const afterFullManifest = await flashback._test.loadScopeManifest(migrationScope.scopeKey);
  assert.equal(afterFullManifest.count, 0, 'archive re-embedding keeps the active target layer empty');
  assert.notEqual(afterFullManifest.archiveRef.archiveId, originalArchiveRef.archiveId, 'current chat swaps to a new immutable archive snapshot');
  assert.equal(afterFullManifest.copyAdoptionMode, 'shared_archive', 'target migration semantics survive archive reference replacement');
  assert.equal(afterFullManifest.archiveRef.depth, originalArchiveRef.depth + 1, 'full archive re-embedding appends an immutable vector overlay generation');
  const afterFullLayerManifest = await flashback._test.loadScopeManifest(afterFullManifest.archiveRef.archiveScopeKey);
  assert.equal(afterFullLayerManifest.archiveVectorOverlay, true);
  assert.equal(afterFullLayerManifest.archiveDeltaCount, fullReembed.archiveReembedded);
  const afterFullArchive = await flashback._test.loadFlashbackArchiveChain(afterFullManifest.archiveRef);
  assert.equal(afterFullArchive.verified, true);
  const afterFullResponses = afterFullArchive.recordsList.filter(record => record.sourceType === 'response' && !record.autoEpisode);
  const afterFullEmbeddingRecords = afterFullArchive.recordsList.filter(record => record.sourceType === 'response' || record.sourceType === 'episode_index');
  assert.ok(afterFullResponses.length >= 2);
  assert.ok(afterFullEmbeddingRecords.length >= 3, 'archive includes response memories and an episode index');
  assert.ok(afterFullEmbeddingRecords.every(record => record.vector.length === 96 && record.embeddingProvider === 'openai'));
  assertMapSubsetUnchanged(originalArchivePhysicalBefore, pluginStorage.values, 'shared source archive remains immutable after full re-embedding');

  console.log('PASS full archive reembedding preserves immutable source');
  const fullArchiveManifest = await flashback._test.loadScopeManifest(afterFullManifest.archiveRef.archiveScopeKey);
  const fullArchivePrefix = `vector_rag_memory:scope:${fullArchiveManifest.storageHash}:`;
  const fullArchivePhysicalBefore = cloneMap(new Map(Array.from(pluginStorage.values).filter(([key]) => String(key).startsWith(fullArchivePrefix))));
  const settings64 = flashback._test.normalizeSettings({ ...settings96, embeddingDimensions: 64 });
  const progressive = await flashback.progressivelyReembedRecords(migrationScope, settings64, {
    maxRecords: 1,
    maxChars: 500000,
    maxRequests: 1,
    retryOnConcurrent: false
  });
  assert.equal(progressive.localReembedded, 0);
  assert.equal(progressive.archiveReembedded, 1, 'progressive archive success count is durably committed');
  assert.equal(progressive.reembedded, 1);
  assert.equal(progressive.archiveRefUpdated, true);
  const afterProgressiveManifest = await flashback._test.loadScopeManifest(migrationScope.scopeKey);
  assert.notEqual(afterProgressiveManifest.archiveRef.archiveId, afterFullManifest.archiveRef.archiveId);
  assert.equal(afterProgressiveManifest.archiveRef.depth, afterFullManifest.archiveRef.depth + 1);
  const afterProgressiveLayerManifest = await flashback._test.loadScopeManifest(afterProgressiveManifest.archiveRef.archiveScopeKey);
  assert.equal(afterProgressiveLayerManifest.archiveVectorOverlay, true);
  assert.equal(afterProgressiveLayerManifest.count, 1, 'progressive re-embedding stores only the changed archive row in the new layer');
  assert.equal(afterProgressiveLayerManifest.archiveDeltaCount, 1);
  const afterProgressiveArchive = await flashback._test.loadFlashbackArchiveChain(afterProgressiveManifest.archiveRef);
  const afterProgressiveResponses = afterProgressiveArchive.recordsList.filter(record => record.sourceType === 'response' && !record.autoEpisode);
  const afterProgressiveEmbeddingRecords = afterProgressiveArchive.recordsList.filter(record => record.sourceType === 'response' || record.sourceType === 'episode_index');
  assert.equal(afterProgressiveEmbeddingRecords.filter(record => record.vector.length === 64).length, 1, 'one progressive archive vector is persisted in the replacement snapshot');
  assert.equal(afterProgressiveEmbeddingRecords.filter(record => record.vector.length === 96).length, afterProgressiveEmbeddingRecords.length - 1, 'unselected archive vectors are preserved');
  const afterProgressiveSummary = await flashback._test.loadFlashbackArchiveManifestSummary(afterProgressiveManifest.archiveRef);
  assert.equal(afterProgressiveSummary.verified, true);
  assert.equal(afterProgressiveSummary.records, afterProgressiveArchive.recordsList.length, 'vector overlays do not double-count archive statistics');
  assertMapSubsetUnchanged(fullArchivePhysicalBefore, pluginStorage.values, 'previous re-embedded archive remains immutable after progressive replacement');

  console.log('PASS progressive archive reembedding preserves unselected vectors');
  const plan64 = await flashback.inspectMemoryMaintenance({ settings: settings64, scope: migrationScope, ensureStorage: false });
  assert.equal(plan64.archiveEpisodeRecords, 1, 'maintenance inventory includes archived episode indexes');
  assert.equal(plan64.archiveRecordsNeedingEmbedding, afterProgressiveEmbeddingRecords.length - 1, 'maintenance reports only the remaining archive vector mismatches');
  const automatic = await flashback.runMemoryMaintenance('auto', { preflight: plan64 });
  assert.equal(automatic.healthy, true, 'automatic maintenance completes the remaining archive vector repair');
  assert.equal(automatic.operation.archive.archiveRefUpdated, true);
  const afterAutomaticManifest = await flashback._test.loadScopeManifest(migrationScope.scopeKey);
  const afterAutomaticArchive = await flashback._test.loadFlashbackArchiveChain(afterAutomaticManifest.archiveRef);
  const afterAutomaticResponses = afterAutomaticArchive.recordsList.filter(record => record.sourceType === 'response' && !record.autoEpisode);
  const afterAutomaticEmbeddingRecords = afterAutomaticArchive.recordsList.filter(record => record.sourceType === 'response' || record.sourceType === 'episode_index');
  assert.ok(afterAutomaticEmbeddingRecords.every(record => record.vector.length === 64 && record.embeddingProvider === 'openai'));
  assert.equal(afterAutomaticEmbeddingRecords.find(record => record.sourceType === 'episode_index')?.vector.length, 64, 'automatic maintenance re-embeds archived episode indexes');
  assert.equal(afterAutomaticManifest.count, 0, 'automatic archive repair never copies archive rows into active storage');

  console.log('PASS automatic archive vector repair keeps active layer empty');
  const routedQuery = 'bulk archive route probe 0350 cobalt compass token 0350';
  const routedTargetId = 'bulk-archive-probe-0350';
  const routedTarget = afterAutomaticEmbeddingRecords.find(record => flashback._test.flashbackArchiveRecordIdentity(record) === routedTargetId);
  assert.ok(routedTarget, 'large archive fixture contains the routed overlay target');
  const routedHeadManifest = await flashback._test.loadScopeManifest(afterAutomaticManifest.archiveRef.archiveScopeKey);
  assert.ok(routedHeadManifest.shardCount > 8, 'automatic partial overlay is large enough to use routed shard selection');
  let routedTargetShard = -1;
  for (let index = 0; index < routedHeadManifest.shardCount; index += 1) {
    const shardKey = `vector_rag_memory:scope:${routedHeadManifest.storageHash}:records:commit:${routedHeadManifest.commitId}:shard:${String(index).padStart(4, '0')}`;
    const shard = parseStoredValue(await pluginStorage.getItem(shardKey));
    if ((shard?.records || []).some(record => flashback._test.flashbackArchiveRecordIdentity(record) === routedTargetId)) {
      routedTargetShard = index;
      break;
    }
  }
  assert.ok(routedTargetShard > 0 && routedTargetShard < routedHeadManifest.shardCount - 1, 'routed target is in a non-protected middle shard');
  const decoyShard = routedTargetShard === 0 ? 1 : 0;
  const routedSettings = flashback._test.normalizeSettings({
    ...settings64,
    recallFullScanThreshold: 1,
    recallShardLimit: 2
  });
  const [routedVector] = await flashback._test.embedTexts([routedQuery], settings64);
  const decoyManifest = {
    ...routedHeadManifest,
    shardSummaries: routedHeadManifest.shardSummaries.map((summary, index) => ({
      ...summary,
      terms: index === decoyShard ? routedQuery.split(/\s+/) : [],
      termStats: index === decoyShard ? routedQuery.split(/\s+/).map(term => ({ term, tf: 12 })) : [],
      phrases: index === decoyShard ? [routedQuery] : [],
      anchors: index === decoyShard ? [routedQuery] : [],
      properties: [],
      sparse: { version: 1, topCanonical: [], topIdentity: [], topRelation: [], topState: [], topEvent: [], topTemporal: [], documentCount: Number(summary?.recordCount || 0) },
      centroids: []
    }))
  };
  const forcedHeadSelection = flashback._test.selectRecallShardIndexes(
    decoyManifest,
    routedQuery,
    routedVector,
    'openai',
    'fact',
    routedSettings,
    'text-embedding-3-small'
  );
  assert.ok(!forcedHeadSelection.indexes.includes(routedTargetShard), 'fixture forces the newest overlay router away from the replacement shard');
  const routedHeadManifestKey = `vector_rag_memory:scope:${routedHeadManifest.storageHash}:manifest:v2`;
  const routedHeadManifestRaw = await pluginStorage.getItem(routedHeadManifestKey);
  await pluginStorage.setItem(
    routedHeadManifestKey,
    typeof routedHeadManifestRaw === 'string' ? JSON.stringify(decoyManifest) : decoyManifest
  );

  const routedRecall = await flashback._test.loadScopeRecordsForRecall(migrationScope.scopeKey, null, {
    archiveQuery: {
      queryText: routedQuery,
      queryVector: routedVector,
      queryProvider: 'openai',
      queryType: 'fact',
      settings: routedSettings,
      queryModel: 'text-embedding-3-small'
    }
  });
  const routedRecallTargets = routedRecall.records.filter(record => flashback._test.flashbackArchiveRecordIdentity(record) === routedTargetId);
  assert.equal(routedRecallTargets.length, 1, 'routed recall recovers one newest overlay replacement when parent and overlay shard selections diverge');
  assert.equal(routedRecallTargets[0].vector.length, 64, 'routed repair never falls back to the superseded parent vector');
  assert.ok(routedRecall.performance.archiveOverlayRepairReads > 0, 'routed recall records the bounded overlay repair read');

  console.log('PASS routed overlay recall recovers newest replacement');
  const recallAfterAutomatic = await flashback._test.loadScopeRecordsForRecall(migrationScope.scopeKey);
  const recallArchiveEmbeddingRecords = recallAfterAutomatic.records.filter(record => (
    record.archiveReferenceOnly === true
    && (record.sourceType === 'response' || record.sourceType === 'episode_index')
  ));
  assert.equal(recallArchiveEmbeddingRecords.length, afterAutomaticEmbeddingRecords.length, 'recall exposes every logical archive memory once');
  assert.ok(recallArchiveEmbeddingRecords.every(record => record.vector.length === 64), 'recall uses the newest archive overlay vectors');

  const overlayEnvelope = await portable.exportCurrentScope();
  assert.equal(overlayEnvelope.source.scopeKey, migrationScope.scopeKey, 'portable export remains bound to the migrated target scope');
  const exportedKeys = new Set(overlayEnvelope.records.map(record => String(record.key)));
  let exportedArchiveRef = afterAutomaticManifest.archiveRef;
  let exportedArchiveLayers = 0;
  while (exportedArchiveRef?.archiveScopeKey) {
    const layerManifest = await flashback._test.loadScopeManifest(exportedArchiveRef.archiveScopeKey);
    const layerPrefix = `vector_rag_memory:scope:${layerManifest.storageHash}:`;
    const exportedLayerKeys = [...exportedKeys].filter(key => key.startsWith(layerPrefix));
    assert.ok(exportedLayerKeys.some(key => /manifest(?::v\d+)?$/i.test(key)), `portable backup includes archive manifest ${exportedArchiveRef.archiveId}`);
    assert.ok(exportedLayerKeys.some(key => /:records:(?:commit:[^:]+:)?shard:/i.test(key)), `portable backup includes active archive shards ${exportedArchiveRef.archiveId}`);
    exportedArchiveLayers += 1;
    exportedArchiveRef = layerManifest.parentArchiveRef || null;
  }
  assert.equal(exportedArchiveLayers, afterAutomaticManifest.archiveRef.depth, 'portable backup follows every retained archive generation after bounded-depth compaction');
  const overlayInspection = await portable.inspectRestoreOptions(overlayEnvelope);
  assert.equal(overlayInspection.modes.same_chat_replace.allowed, true, 'portable validation accepts the immutable archive overlay chain');

  console.log('PASS portable archive chain export and validation');
  chats[3].message = [{ role: 'user', data: 'Existing target activity', chatId: 'occupied-user' }];
  chats[3].messages = chats[3].message;
  currentChatIndex = 3;
  const occupiedScope = await flashback.resolveCurrentScope(true);
  const occupiedRows = await flashback._test.buildRecordsFromSources([{
    sourceId: 'occupied-record', sourceType: 'response', text: 'Existing target memory', turnIndex: 1, pairIndex: 1
  }], fixtureSettings, occupiedScope);
  await flashback._test.saveAllRecords(occupiedRows, fixtureSettings, occupiedScope);
  const collisionInspection = await portable.inspectRestoreOptions(envelope);
  assert.equal(collisionInspection.modes.chat_migration_archive.allowed, false);
  assert.equal(collisionInspection.modes.chat_migration_archive.reason, 'target_not_empty');
  assert.equal(collisionInspection.modes.chat_copy_rebind.allowed, false);
  await assert.rejects(
    () => portable.restoreCurrentScope(envelope, { mode: 'chat_migration_archive' }),
    error => error?.code === 'FLASHBACK_PORTABLE_MIGRATION_BLOCKED'
  );

  console.log('PASS occupied-target migration blocked');
  assertMapSubsetUnchanged(sourcePhysicalBefore, pluginStorage.values, 'source pluginStorage remains immutable');
  assertMapSubsetUnchanged(sourceVectorsBefore, safeLocalStorage.values, 'source vector sidecars remain immutable');

  for (const handler of unloadHandlers) await handler().catch(() => {});
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  console.log('flashback_portable_cross_chat_restore_test: PASS');
})().catch(error => {
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  console.error(error);
  process.exitCode = 1;
});
