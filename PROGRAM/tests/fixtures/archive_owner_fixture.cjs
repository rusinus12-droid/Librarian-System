'use strict';

// Offline product fixture. Private exports seed/read durable data only: every
// archive preview and execution in the tests uses the registered public API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFlashback } = require('./embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '../..');
const clone = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
const parse = value => typeof value === 'string' ? JSON.parse(value) : plain(value);
const copyMap = map => new Map(Array.from(map, ([key, value]) => [key, clone(value)]));
const bodyFor = init => JSON.parse(String(init.body || '{}'));
const syntheticResponse = init => {
  const body = bodyFor(init), dimensions = Number(body.dimensions || 3);
  const input = Array.isArray(body.input) ? body.input : [body.input];
  const vector = Array.from({ length: dimensions }, (_, i) => Number(i === (dimensions === 3 ? 0 : 1)));
  return { ok: true, status: 200, async json() {
    return { data: input.map((_, index) => ({ index, embedding: vector.slice() })) };
  } };
};

// This list is intentionally narrower than "remove anything that changed".
// Timestamps, origin, source positions, history, visibility and lineage remain.
const VECTOR_OUTPUT_FIELDS = new Set([
  'vector', 'vectorRef', 'vectorStorageMode', 'vectorPayloadLocal', 'vectorPayloadMissing',
  'dim', 'provider', 'model', 'embeddingProvider', 'embeddingModel', 'embeddingDimensions',
  'embeddingProfileId', 'embeddingDescriptor', 'embeddingProvenance', 'embeddingReceipt',
  'tokenEstimate'
]);
const PHYSICAL_REPRESENTATION_FIELDS = new Set([
  'id', 'scopeKey', 'archiveReferenceOnly', 'archiveId', 'archiveSourceScopeKey', 'logicalScopeKey'
]);
const canonicalNonVector = record => Object.fromEntries(Object.entries(plain(record))
  .filter(([key]) => !VECTOR_OUTPUT_FIELDS.has(key) && !PHYSICAL_REPRESENTATION_FIELDS.has(key)));
const canonicalIdentity = record => record.permanentHistoryId || record.archiveCanonicalId;
const assertSubsetUnchanged = (before, after, label) => {
  for (const [key, value] of before) {
    assert(after.has(key), `${label}: missing ${key}`);
    assert.equal(typeof after.get(key), typeof value, `${label}: storage-value type ${key}`);
    assert.equal(JSON.stringify(after.get(key)), JSON.stringify(value), `${label}: exact serialized value ${key}`);
  }
};

const waitFor = async (predicate, label = 'fixture condition', timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

// Consumer scripts are evaluated exactly as built: no source replacement and
// no injected private test or audit exports. Existing stores/host scope persist.
const createConsumerRuntime = async (scriptPath, previousHost) => {
  const timeouts = new Set(), intervals = new Set(), unload = [];
  const host = { ...previousHost, async onUnload(handler) { unload.push(handler); return true; } };
  const context = vm.createContext({
    risuai: host, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout(fn, ms, ...args) { const id = setTimeout(() => { timeouts.delete(id); fn(...args); }, ms); timeouts.add(id); return id; },
    clearTimeout(id) { timeouts.delete(id); clearTimeout(id); },
    setInterval(fn, ms, ...args) { const id = setInterval(fn, ms, ...args); intervals.add(id); return id; },
    clearInterval(id) { intervals.delete(id); clearInterval(id); },
    queueMicrotask, AbortController, AbortSignal, DOMException, URL, URLSearchParams,
    TextEncoder, TextDecoder, crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
    performance: globalThis.performance, Headers, Request, Response, FormData, Blob,
    atob: globalThis.atob, btoa: globalThis.btoa,
    fetch: async () => { throw new Error('External network is disabled in consumer archive fixture.'); },
    confirm: () => false, alert() {}, prompt: () => null
  });
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath });
  const api = await waitFor(() => context.__FlashbackMemory, 'actual consumer public API');
  await waitFor(() => api.uiStatus().registered.after, 'consumer initialization');
  return { api, host, context, audit: undefined, clearPreexistingTimers() {
    for (const id of Array.from(timeouts)) { clearTimeout(id); timeouts.delete(id); }
    for (const id of Array.from(intervals)) { clearInterval(id); intervals.delete(id); }
  }, async cleanup() {
    for (const handler of unload.slice().reverse()) try { await handler(); } catch (_) {}
    for (const id of timeouts) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
  } };
};

async function createArchiveOwnerFixture(options = {}) {
  const exposeFixtureUtilities = source => {
    source = source.replace('abortEmbeddingJobs, buildRecordsFromSources, hydrateFlashbackVectorRecords,',
      'abortEmbeddingJobs, buildRecordsFromSources, hydrateFlashbackVectorRecords, loadScopeRecordsRaw, archiveRepairOffers, clearScheduledTimers, sharedScopeWriteLocks, retireExternalRecordsAcrossKnownScopes, storageShardChecksum, rawEmbeddingSourceRevision, embeddingPhysicalJobId, nextEmbeddingWorkForRecord, isValidatedEmbeddingWorkRecord, recordEmbeddingCompatibility, embeddingProfileId, prepareEmbeddingInput,');
    if (process.env.ARCHIVE_FIXTURE_TRACE) source = source.replace(
      'const saveScopeManifest = async (manifest, scope = {}, saveOptions = {}) => {',
      'const saveScopeManifest = async (manifest, scope = {}, saveOptions = {}) => { (globalThis.__ArchiveFixtureManifestOrigins ||= []).push({scopeKey:manifest?.scopeKey||scope?.scopeKey,externalRetirementVersion:manifest?.externalRetirementVersion,physical:!!physicalContext(saveOptions),stack:new Error("manifest write origin").stack});');
    return source;
  };
  let h = await createFlashback(PROGRAM, { waitForLoaded: true, transformSource: source => options.transformSource ? options.transformSource(exposeFixtureUtilities(source)) : exposeFixtureUtilities(source) });
  // Isolate the explicitly invoked action from startup's 1800ms retirement
  // sweep. Complete legacy metadata upkeep before taking preservation baselines,
  // wait for issued ordinary work, then cancel only timers already scheduled at
  // this fixture boundary. New archive action deadlines/timers remain enabled.
  const quiesce = async ({ completeLegacyRetirement = false } = {}) => {
    assert.equal(h.api.archiveRecovery?.getState?.().busy || false, false,
      'fixture quiescence must never interrupt an active archive operation');
    if (completeLegacyRetirement) {
      assert(h.audit, 'legacy fixture setup is completed in the source VM only');
      await h.audit.retireExternalRecordsAcrossKnownScopes({ reason: 'archive_fixture_prebaseline' });
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    if (h.audit) {
      await Promise.all(Array.from(h.audit.Runtime.externalRetirementInFlight.values()));
      await waitFor(() => !h.audit.Runtime.nativeCopyObserver.inFlight && h.audit.sharedScopeWriteLocks.size === 0,
        'already-issued startup/retirement writers to settle');
      h.audit.clearScheduledTimers();
    } else h.clearPreexistingTimers();
  };
  const sharedPlugin = h.pluginStorage, sharedLocal = h.safeLocalStorage;
  let current = 0;
  const longAnswer = Array.from({ length: 20 }, (_, i) =>
    `The brass compass waits under blue sundial marker ${i + 1} beside observatory room ${i + 1}. `).join('');
  const transcript = [
    { role: 'user', data: 'Where is the brass compass?', chatId: 'archive-user-1' },
    { role: 'assistant', data: longAnswer, chatId: 'archive-assistant-1' },
    { role: 'user', data: 'What is the meeting phrase?', chatId: 'archive-user-2' },
    { role: 'assistant', data: 'Meet Rowan alone and whisper silver rain.', chatId: 'archive-assistant-2' }
  ];
  const chats = [
    { id: 'multilingual-probe-chat', name: 'Archive source', message: transcript },
    { id: 'archive-active-owner', name: 'Active archive owner', message: [] },
    { id: 'archive-sibling-owner', name: 'Shared archive sibling', message: [] },
    { id: 'archive-import-owner', name: 'Imported archive owner', message: [] }
  ].map(chat => ({ ...chat, chatId: chat.id, messages: chat.message, bindedPersona: '' }));
  const installHostScope = async () => {
    const character = await h.host.getCharacter();
    character.chats = chats;
    h.host.getCurrentChatIndex = async () => current;
    h.host.getChat = h.host.getCurrentChat = async () => chats[current];
    h.host.getChatFromIndex = async (_character, index) => chats[Number(index ?? current)];
  };
  await installHostScope();
  h.host.nativeFetch = async (url, init) => {
    assert.equal(String(url), 'https://archive-worker.invalid/v1/embeddings', 'fixture forbids external provider/server traffic');
    return syntheticResponse(init);
  };
  const baseSettings = h.api._test.normalizeSettings({
    ...await h.api.loadSettings(), embeddingProvider: 'openai_compat', embeddingModel: 'archive-fixture-model',
    embeddingDimensions: 3, embeddingUrl: 'https://archive-worker.invalid/v1', embeddingEnabled: true,
    embeddingAutoProcess: false, embeddingMaxRetries: 0, embeddingBatchSize: 32,
    chunkChars: 400, chunkOverlap: 0, episodeIndexEnabled: false, autoEpisodeIndex: false,
    episodeHierarchyEnabled: false
  });
  // Initial ingest uses the existing hash-only cold-start route. Ready retained
  // model vectors are then constructed with a synthetic provider before export.
  await h.api.ingestLiveChatColdStart({ scope: 'current', incremental: false,
    skipEpisodeRebuild: true, skipGuiRefresh: true, allowHashFallback: true });
  const sourceScope = await h.api.resolveCurrentScope(true);
  const sourceRaw = (await h.api._test.loadScopeRecords(sourceScope.scopeKey)).records;
  await h.api.saveSettings(baseSettings);
  const sources = [...new Map(sourceRaw.map(row => [row.sourceHash, row])).values()].map(row => ({
    sourceType: 'response', sourceId: row.sourceId, sourceHash: row.sourceHash,
    text: row.text, turnIndex: row.turnIndex, pairIndex: row.pairIndex, sanitizeMemory: false
  }));
  let readyRows = await h.api._test.buildRecordsFromSources(sources, baseSettings, sourceScope);
  if (options.timestamp) readyRows = readyRows.map(row => ({ ...row,
    createdAt: options.timestamp, updatedAt: options.timestamp }));
  await h.api._test.saveAllRecords(readyRows, baseSettings, sourceScope);
  if (options.includeEpisode) {
    await h.api.saveSettings({ ...baseSettings, episodeIndexEnabled: true, episodeMinRecords: 2 });
    const rebuilt = await h.api.rebuildEpisodeIndex(sourceScope);
    assert.equal(rebuilt.rebuilt, true, 'public episode rebuild creates an actual aggregate fixture');
    const episodes = (await h.api._test.loadScopeRecords(sourceScope.scopeKey)).records.filter(row => row.autoEpisode);
    assert.equal(episodes.length, 1);
    await h.api.saveSettings(baseSettings);
  }
  const exported = await h.context.__FlashbackPortableMemoryBackup.exportCurrentScope();
  current = 1;
  const restored = await h.context.__FlashbackPortableMemoryBackup.restoreCurrentScope(exported,
    { mode: 'chat_migration_archive' });
  assert.equal(restored.ok, true, 'public portable restore creates the archive');
  let scope = await h.api.resolveCurrentScope(true);
  await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
  const ownerManifest = await h.api._test.loadScopeManifest(scope.scopeKey);
  const originalRef = plain(ownerManifest.archiveRef);
  assert.equal(ownerManifest.count, 0, 'initial target owns an archive without active local rows');
  const chain = await h.api._test.loadFlashbackArchiveChain(originalRef);
  assert.equal(chain.verified, true);
  const beforeRows = plain(chain.recordsList);
  const firstSourceHash = beforeRows.find(row => row.turnIndex === 1 || row.pairIndex === 1)?.sourceHash;
  const selectedBefore = beforeRows.filter(row => row.sourceHash === firstSourceHash);
  assert(selectedBefore.length > 1, 'fixture contains a complete multi-chunk response group');
  assert.equal(selectedBefore.length, selectedBefore[0].chunkCount);
  assert.equal(new Set(selectedBefore.map(row => h.audit.prepareEmbeddingInput(row.text, 'document', baseSettings))).size,
    selectedBefore.length, 'distinct chunks keep exact wire membership independent of existing input deduplication');
  if (options.timestamp) for (const row of selectedBefore) {
    assert.equal(row.createdAt, options.timestamp, 'fixture retains the requested source creation time');
    assert.equal(row.updatedAt, options.timestamp, 'fixture retains the requested predecessor timestamp');
  }
  assert(beforeRows.some(row => row.sourceHash !== firstSourceHash), 'fixture has an unselected source group');
  for (const row of beforeRows) assert(canonicalIdentity(row), 'portable archive has stable canonical member IDs');

  // A second active owner references the same immutable physical chain.
  current = 2;
  const siblingScope = await h.api.resolveCurrentScope(true);
  const siblingManifest = await h.api._test.loadScopeManifest(siblingScope.scopeKey);
  await h.api._test.saveScopeManifest({ ...siblingManifest, archiveRef: originalRef }, siblingScope);
  current = 1;
  scope = await h.api.resolveCurrentScope(true);
  const targetSettings = h.api._test.normalizeSettings({ ...baseSettings, embeddingDimensions: 4 });
  await h.api.saveSettings(options.compatible ? baseSettings : targetSettings);
  await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
  await quiesce({ completeLegacyRetirement: true });

  const manifestKeyFor = scopeKey => [...sharedPlugin.values].find(([key, value]) => {
    if (!key.endsWith(':manifest:v2')) return false;
    try { return parse(value).scopeKey === scopeKey; } catch { return false; }
  })?.[0];
  const physicalManifest = scopeKey => {
    const key = manifestKeyFor(scopeKey); assert(key, `physical manifest for ${scopeKey}`);
    return parse(sharedPlugin.values.get(key));
  };
  const protectedHashes = [sourceScope, siblingScope].map(s => physicalManifest(s.scopeKey).storageHash)
    .concat(chain.layers.map(layer => layer.manifest.storageHash));
  const protectedKeys = ([key]) => protectedHashes.some(hash => key.includes(`:${hash}:`));
  const protectedPlugin = copyMap(new Map([...sharedPlugin.values].filter(protectedKeys)));
  const protectedLocal = copyMap(new Map([...sharedLocal.values].filter(protectedKeys)));
  let observation, providerHook = null, restorers = [];
  const startObservation = () => {
    for (const restore of restorers.splice(0)) restore();
    observation = { reads: [], writes: [], removals: [], enumerations: [], argumentWrites: [], requests: [] };
    for (const [name, store] of [['plugin', sharedPlugin], ['local', sharedLocal]]) {
      for (const [method, bucket] of [['getItem', 'reads'], ['setItem', 'writes'], ['removeItem', 'removals'], ['keys', 'enumerations']]) {
        const original = store[method].bind(store);
        store[method] = async (...args) => {
          const event = { store: name, key: String(args[0] ?? ''), value: clone(args[1]) };
          if (process.env.ARCHIVE_FIXTURE_TRACE && ['writes', 'removals'].includes(bucket)) {
            event.stack = new Error('fixture physical effect origin').stack;
            console.error('ARCHIVE_FIXTURE_EFFECT', JSON.stringify({ owner: scope.scopeKey, method, store: name, key: event.key, stack: event.stack,
              manifestOrigins: h.context.__ArchiveFixtureManifestOrigins?.slice(-3) }));
          }
          observation[bucket].push(event); return original(...args);
        };
        restorers.push(() => { store[method] = original; });
      }
    }
    const setArgument = h.host.setArgument.bind(h.host);
    h.host.setArgument = async (...args) => { observation.argumentWrites.push(args); return setArgument(...args); };
    restorers.push(() => { h.host.setArgument = setArgument; });
    h.host.nativeFetch = async (url, init) => {
      assert.equal(String(url), 'https://archive-worker.invalid/v1/embeddings', 'no external transport');
      const entry = { url: String(url), body: bodyFor(init), owner: physicalManifest(scope.scopeKey) };
      observation.requests.push(entry);
      if (providerHook) return providerHook(entry, init);
      return syntheticResponse(init);
    };
    return observation;
  };
  const clearObservation = () => { for (const restore of restorers.splice(0)) restore(); };
  const archive = () => {
    assert.equal(typeof h.api.archiveRecovery?.preview, 'function', 'registered public archiveRecovery.preview is required');
    assert.equal(typeof h.api.archiveRecovery?.repair, 'function');
    assert.equal(typeof h.api.archiveRecovery?.clear, 'function');
    assert.equal(typeof h.api.archiveRecovery?.getState, 'function');
    return h.api.archiveRecovery;
  };
  const readChain = async () => h.api._test.loadFlashbackArchiveChain(physicalManifest(scope.scopeKey).archiveRef);
  const readLocal = async () => (await h.audit.loadScopeRecordsRaw(scope.scopeKey)).records;
  const restart = async scriptPath => {
    clearObservation(); const previousHost = h.host; await h.cleanup();
    h = scriptPath ? await createConsumerRuntime(scriptPath, previousHost)
      : await createFlashback(PROGRAM, { pluginStorage: sharedPlugin, safeLocalStorage: sharedLocal,
        waitForLoaded: true, transformSource: source => options.transformSource ? options.transformSource(exposeFixtureUtilities(source)) : exposeFixtureUtilities(source) });
    await installHostScope();
    scope = await h.api.resolveCurrentScope(true);
    await quiesce();
    startObservation();
    return h.api;
  };
  const injectRegistry = (scopeKey, raw) => {
    const key = manifestKeyFor(scopeKey), manifest = physicalManifest(scopeKey);
    sharedPlugin.values.set(key, JSON.stringify({ ...manifest, embeddingAttemptRegistry: raw }));
  };
  const mutateArchiveRows = async transform => {
    const manifest = physicalManifest(originalRef.archiveScopeKey);
    const prefix = `vector_rag_memory:scope:${manifest.storageHash}:records:commit:${manifest.commitId}:shard:`;
    let changed = 0;
    for (const [key, value] of sharedPlugin.values) {
      if (!key.startsWith(prefix)) continue;
      const decoded = await h.api._test.decodeFlashbackShardEnvelope(value);
      const payload = plain(decoded.parsed);
      assert(Array.isArray(payload.records));
      payload.records = transform(payload.records, manifest);
      payload.checksum = h.audit.storageShardChecksum(payload.records);
      sharedPlugin.values.set(key, JSON.stringify(payload));
      changed++;
    }
    assert(changed, 'fixture modified a real declared physical archive shard');
  };
  const removeRegistry = scopeKey => {
    const key = manifestKeyFor(scopeKey), manifest = physicalManifest(scopeKey);
    delete manifest.embeddingAttemptRegistry; delete manifest.embeddingAttemptRegistryBlocked;
    sharedPlugin.values.set(key, JSON.stringify(manifest));
  };
  const seedLegacyMarker = async status => {
    const canonical = selectedBefore[0];
    await mutateArchiveRows(rows => rows.map(row => {
      if (canonicalIdentity(row) !== canonicalIdentity(canonical)) return row;
      const legacy = { ...plain(canonical), vectorRef: null, vectorPayloadLocal: false,
        vectorPayloadMissing: false, vectorStorageMode: '' };
      delete legacy.vectorRef; delete legacy.embeddingOriginScopeKey;
      const work = plain(h.audit.nextEmbeddingWorkForRecord(legacy, targetSettings));
      delete work.originScopeKey;
      work.jobId = h.audit.embeddingPhysicalJobId(legacy.scopeKey, work.sourceRevision, work.targetProfile);
      work.status = status;
      work.attempt = { id: `legacy-${status}-attempt`, runtimeId: 'legacy-runtime', startedAt: 1,
        sourceRevision: work.sourceRevision, profileFingerprint: work.targetProfile.profileFingerprint,
        storageBinding: 'legacy-plugin-binding', sourceSet: 'legacy-source-set' };
      legacy.embeddingWork = work;
      assert.equal(h.audit.isValidatedEmbeddingWorkRecord(legacy), true, 'legacy marker is a valid pre-origin retained work record');
      return legacy;
    }));
    removeRegistry(scope.scopeKey); removeRegistry(originalRef.archiveScopeKey);
  };
  const unknownRegistry = (scopeKey, settings = targetSettings) => {
    const hash = value => h.audit.MemorySuiteExecutionContract.hash(value);
    const row = selectedBefore[0], originScopeKey = row.embeddingOriginScopeKey || row.embeddingReceipt?.originScopeKey
      || row.inheritedFromScopeKey || row.clonedFromScopeKey || row.archiveSourceScopeKey || row.scopeKey;
    const sourceRevision = hash({ sourceId: row.sourceId || '', sourceHash: row.sourceHash || '',
      chunkIndex: Number(row.chunkIndex || 0), chunkCount: Number(row.chunkCount || 0), textDigest: hash(row.text || '') });
    const targetProfile = { provider: settings.embeddingProvider, model: settings.embeddingModel,
      profileFingerprint: h.audit.embeddingProfileSettingsFingerprint(settings) };
    const attemptId = 'prior-unresolved-archive-attempt';
    const job = { originScopeKey, sourceRevision, targetProfile,
      jobId: `fb_embed_${hash({ scopeKey, sourceRevision, targetProfile, originScopeKey })}`,
      logicalJobId: `fb_logical_${hash({ originScopeKey, sourceRevision, targetProfile })}` };
    const body = { schema: 'flashback.embedding_attempt_registry.v1', scopeKey, entries: {
      [attemptId]: { attemptId, runtimeId: 'prior-runtime', sourceHash: row.sourceHash,
        sourceSet: 'prior-source-set', startedAt: 1, state: 'uncertain', jobs: [job] }
    } };
    return { ...body, digest: hash(body) };
  };
  const seedLocal = async () => {
    const settings = await h.api.loadSettings();
    const rows = await h.api._test.buildRecordsFromSources([{ sourceType: 'response', sourceId: 'active-local-source',
      sourceHash: 'active-local-source-hash', origin: 'live_chat', role: 'turn_pair', turnIndex: 1, pairIndex: 1,
      text: 'User:\nWhere is the parcel?\n\n---\n\nAssistant:\nThe parcel remains inside the cedar cabinet.' }], settings, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(rows, settings, scope);
    await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
    return plain(await readLocal());
  };
  const copyToNewOwner = async () => {
    clearObservation();
    const backup = await h.context.__FlashbackPortableMemoryBackup.exportCurrentScope();
    current = 3;
    const result = await h.context.__FlashbackPortableMemoryBackup.restoreCurrentScope(backup, { mode: 'chat_migration_archive' });
    assert.equal(result.ok, true);
    scope = await h.api.resolveCurrentScope(true);
    await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
    startObservation();
    return scope;
  };
  startObservation();
  return {
    get api() { return h.api; }, get host() { return h.host; }, get audit() { return h.audit; },
    get context() { return h.context; }, get scope() { return scope; }, get observation() { return observation; },
    get ownerKey() { return manifestKeyFor(scope.scopeKey); },
    get archiveManifest() { return physicalManifest(originalRef.archiveScopeKey); },
    get ref() { return originalRef; }, get requests() { return observation.requests.length; },
    selectedRows: selectedBefore,
    pluginStorage: sharedPlugin, safeLocalStorage: sharedLocal, sourceScope, siblingScope,
    baseSettings, targetSettings, originalRef, beforeRows, selectedBefore, firstSourceHash,
    protectedPlugin, protectedLocal, archive, readChain, readLocal, physicalManifest, manifestKeyFor,
    injectRegistry, unknownRegistry, seedLocal, restart, copyToNewOwner, startObservation,
    mutateArchiveRows, removeRegistry, seedLegacyMarker,
    waitFor, quiesce,
    setProviderHook(fn) { providerHook = fn; },
    assertProtectedUnchanged() {
      assertSubsetUnchanged(protectedPlugin, sharedPlugin.values, 'predecessor/source/sibling plugin bytes');
      assertSubsetUnchanged(protectedLocal, sharedLocal.values, 'predecessor/source/sibling local bytes');
    },
    snapshot() { return { plugin: copyMap(sharedPlugin.values), local: copyMap(sharedLocal.values) }; },
    async dispose() { clearObservation(); await h.cleanup(); }
  };
}

module.exports = { createArchiveOwnerFixture, canonicalNonVector, canonicalIdentity,
  syntheticResponse, plain, parse, assertSubsetUnchanged };
