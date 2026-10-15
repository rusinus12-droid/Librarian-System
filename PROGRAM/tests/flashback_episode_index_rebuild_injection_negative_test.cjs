'use strict';
// C.3: public derived-index rebuild, canonical preservation, and stale-derived negative control.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { settings: modelSettings, syntheticFetch, configure } = require('./helpers/unload_recall_contract_fixture.cjs');
const { seedLegacyMirrorFixture } = require('./helpers/legacy_mirror_fixture.cjs');

const FACT = 'The beacon glows crimson at night.';
const STALE = 'The beacon glows violet at night.';
const QUERY = 'What color does the beacon glow at night?';
const SOURCE_TIME = '2026-09-25T00:00:00.000Z';
const SETTINGS = {
  ...modelSettings('configured'),
  episodeIndexEnabled: true, episodeHierarchyEnabled: false, episodeMinRecords: 1,
  captureAfterRequest: true, hookRecallTimeoutMs: 5000, maxInjectionChars: 6000
};
const stableSource = record => ({ id: record.id, text: record.text, vector: record.vector,
  sourceHash: record.sourceHash, sourceMessageIds: record.sourceMessageIds,
  rawDigest: record.metadata?.sourceRawDigest });
const MODES = ['plugin_only', 'mirror', 'server_only'];
const plain = value => JSON.parse(JSON.stringify(value));
// Preserve raw source identity separately from the fields that legitimate model work changes.
const rawSource = record => ({ id: record.id, hash: record.hash, scopeKey: record.scopeKey,
  sourceType: record.sourceType, sourceId: record.sourceId, sourceHash: record.sourceHash,
  sourceMessageIds: record.sourceMessageIds, text: record.text, title: record.title,
  origin: record.origin, role: record.role, pairIndex: record.pairIndex, turnIndex: record.turnIndex,
  userMessagePosition: record.userMessagePosition, assistantMessagePosition: record.assistantMessagePosition,
  chunkIndex: record.chunkIndex, chunkCount: record.chunkCount, sourceChars: record.sourceChars,
  chunkSourceStart: record.chunkSourceStart, chunkSourceEnd: record.chunkSourceEnd,
  chunkNovelStart: record.chunkNovelStart, chunkSchemaVersion: record.chunkSchemaVersion,
  chunkBoundaryType: record.chunkBoundaryType, chunkHardSplit: record.chunkHardSplit,
  chunkOversizeAtomic: record.chunkOversizeAtomic, chunkOverlapUnitCount: record.chunkOverlapUnitCount,
  chunkRole: record.chunkRole, schema: record.schema, tags: record.tags, metadata: record.metadata,
  createdAt: record.createdAt, updatedAt: record.updatedAt });
const assertComplete = (loaded, label) => {
  assert.equal(Number(loaded.manifest.missingShards || 0), 0, `${label}: no missing shards`);
  assert.equal(Number(loaded.manifest.corruptShards || 0), 0, `${label}: no corrupt shards`);
  assert.notEqual(loaded.manifest.recordCountMismatch, true, `${label}: complete canonical readback`);
};
const assertCompletedQuery = (recall, scope, label) => {
  assert.equal(recall.scopeKey, scope.scopeKey, `${label}: current query scope`);
  assert.equal(recall.queryDim, 3, `${label}: configured query completed`);
  assert.notEqual(recall.skipped, true, `${label}: hook did not skip or time out`);
  assert.equal(recall.fallbackWarning || '', '', `${label}: no query failure fallback`);
  assert.equal(Number(recall.storageMissingShards || 0), 0, `${label}: no missing query shards`);
  assert.equal(Number(recall.storageCorruptShards || 0), 0, `${label}: no corrupt query shards`);
  assert.notEqual(recall.storageManifestCorrupt, true, `${label}: readable query manifest`);
  assert.notEqual(recall.storageRecordCountMismatch, true, `${label}: complete query storage`);
};


async function checkMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flashback-episode-c3-${mode}-`));
  let app = null;
  let fixture = null;
  const networkCalls = []; // Physical storage transport only.
  const modelCalls = []; // In-process synthetic protocol responses, never physical model transport.
  const reservations = new Map();
  let sources = [], scope, settings;
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    fixture = await createFixture({
      exposeStorageBridge: true,
      arguments: { memory_suite_server_mode: mode, memory_suite_server_url: serverUrl },
      nativeFetch: async (url, options) => {
        const target = new URL(String(url));
        if (target.href === 'https://unload-fixture.invalid/v1/embeddings') {
          assert.equal(String(options?.method || '').toUpperCase(), 'POST', 'synthetic model uses the configured protocol');
          const body = JSON.parse(options.body);
          assert.equal(body.model, SETTINGS.embeddingModel, 'synthetic model selection is exact');
          assert.ok(Array.isArray(body.input) && body.input.length > 0 && body.input.length <= 8, 'finite synthetic input batch');
          const document = body.input.every(value => sources.some(source => source.text === value));
          assert.ok(document || body.input.every(value => String(value).includes(QUERY)
            || String(value).includes('UNRELATED_FIXTURE_QUERY')), 'only this fixed corpus and its query controls reach the fake endpoint');
          modelCalls.push({ kind: document ? 'document' : 'query', input: body.input.slice() });
          assert.ok(modelCalls.length <= 64, 'each storage mode has a finite synthetic-provider call ceiling');
          if (document) {
            const loaded = await fixture.api._test.loadScopeRecords(scope.scopeKey);
            assertComplete(loaded, 'provider-entry reservation');
            for (const input of body.input) {
              const row = loaded.records.find(record => record.text === input && record.sourceType === 'response');
              assert.ok(row, 'provider input belongs to an actual durable canonical row');
              assert.equal(row.embeddingWork?.status, 'running', 'model submission follows a real durable reservation');
              assert.ok(row.embeddingWork.attempt?.id && row.embeddingWork.attempt?.runtimeId, 'reservation has a real attempt owner');
              assert.equal(reservations.has(row.id), false, 'each source submits one finite document attempt');
              reservations.set(row.id, plain(row.embeddingWork));
            }
          }
          return syntheticFetch(url, options);
        }
        assert.equal(target.origin, serverUrl, 'physical transport is confined to this exact disposable storage server');
        assert.equal(target.username + target.password, '', 'storage URL has no credentials');
        return syntheticFetch(url, options, async (storageUrl, storageOptions) => {
          networkCalls.push({ url: String(storageUrl), method: String(storageOptions?.method || 'GET') });
          return fetch(storageUrl, storageOptions);
        });
      }
    });
    const api = fixture.api;
    const t = api._test;
    const bridge = fixture.context.__fixtureStorageBridge;
    // Historical mirror ownership is exercised through the supported persisted-upgrade fixture.
    if (mode === 'mirror') await seedLegacyMirrorFixture(bridge, fixture.pluginStorage);
    else if (mode !== 'plugin_only') await bridge.setMode(mode);
    assert.equal(await bridge.getMode(), mode, `${mode}: scope storage mode is selected`);
    await configure(fixture, 'configured');
    await api.saveSettings({ ...await api.loadSettings(), ...SETTINGS });
    scope = await api.resolveCurrentScope();
    settings = await api.loadSettings();
    for (let turn = 1; turn <= 8; turn += 1) {
      const response = turn === 1
        ? 'A brass key rests in the lower alcove.'
        : `The crew returns to the cavern after observation ${turn}.`;
      const userObservation = turn === 1 ? `I record this: ${FACT}` : 'I inspect the beacon in the cavern and check its glass lens.';
      const body = `User:\n${userObservation}\n\n---\n\nAssistant:\n${response}`;
      sources.push({ sourceType: 'response', sourceId: `episode-c3-chat:turn:${turn}`,
        text: body, title: `Observation ${turn}`, pairIndex: turn, turnIndex: turn,
        sourceHash: `episode-c3-source-${turn}`, tags: [], sourceMessageIds: [] });
    }
    const records = await t.buildRecordsFromSources(sources, settings, scope, { deferEmbedding: true });
    assert.equal(records.length, 8, 'the eight original response sources each produce one canonical row');
    assert.equal(new Set(records.map(record => record.id)).size, 8, 'builder-returned canonical IDs are unique');
    for (let turn = 1; turn <= 8; turn += 1) {
      const source = sources[turn - 1];
      const cleaned = records.find(record => record.sourceId === source.sourceId);
      assert.ok(cleaned, `response ${turn} is accepted as a canonical record`);
      assert.equal(cleaned.text, source.text, `response ${turn} retains the exact original U/A source bytes`);
      assert.equal(cleaned.sourceHash, source.sourceHash);
      assert.equal(cleaned.pairIndex, turn);
      assert.equal(cleaned.turnIndex, turn);
      assert.equal(cleaned.chunkIndex, 0);
      assert.equal(cleaned.chunkCount, 1);
    }
    assert.equal(modelCalls.length, 0, 'deferred building does not submit model work');
    await t.saveAllRecords(records, settings, scope);
    // Join the real owner migration before query/readiness snapshots; no timer or private Runtime exposure.
    const retirement = await api.retireExternalSources(scope);
    assert.equal(retirement.removed, 0, 'all eight response sources survive the current owner migration');
    assert.equal(retirement.kept, 8);
    const rawLoaded = await t.loadScopeRecords(scope.scopeKey);
    assertComplete(rawLoaded, 'pending canonical fixture');
    const pendingRows = rawLoaded.records;
    assert.deepEqual(pendingRows.map(record => record.id).sort(), records.map(record => record.id).sort(), 'durable rows retain actual builder IDs');
    assert.ok(pendingRows.every(record => record.vector.length === 0 && record.embeddingWork?.status === 'pending'
      && record.embeddingReceipt == null), 'deferred canonical source is pending, not recall-ready');
    const rawSourceBytes = JSON.stringify(pendingRows.map(rawSource));
    const pendingBytes = JSON.stringify(pendingRows);
    const negativeHook = async (label, configured = true) => {
      t.invalidateQueryEmbeddingCache();
      const beforeCalls = modelCalls.length;
      const output = await api._selectionTest.beforeRequest([{ role: 'user', chatId: `c3-${label}`, content: QUERY }], 'model');
      const last = (await api.debugState()).lastRecall;
      if (configured) {
        assert.ok(modelCalls.slice(beforeCalls).some(call => call.kind === 'query'), `${label}: the fake provider actually handles the query`);
        assertCompletedQuery(last, scope, label);
      } else {
        assert.equal(modelCalls.length, beforeCalls, 'unconfigured recall submits no provider query');
        assert.equal(last.modelReadiness?.status, 'unconfigured');
        assert.equal(last.queryDim, 0);
        assert.notEqual(last.skipped, true, 'unconfigured control reaches recall rather than skipping the hook');
      }
      assert.ok(!JSON.stringify(output ?? null).includes(FACT), `${label}: ineligible source cannot inject`);
      return last;
    };
    await negativeHook('pending');
    assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records), pendingBytes,
      'pending-query filtering preserves the complete durable raw rows');

    // Persist explicit legacy data, with no work/receipt copied from a ready model row.
    // This fixed vector is historical test data, not a replacement hash kernel.
    const legacyRows = sources.map((source, index) => t.cleanRecordForMemory({ ...source,
      id: `episode-c3-legacy-${index + 1}`, scopeKey: scope.scopeKey, vector: [1, 0, 0], dim: 3,
      provider: 'hash', model: 'hash-3', embeddingProvider: 'hash', embeddingModel: 'hash-3',
      embeddingDimensions: 3, lifecycleStatus: 'active', createdAt: SOURCE_TIME, updatedAt: SOURCE_TIME
    }, scope, { authoritativeSource: true }).record);
    assert.ok(legacyRows.every(Boolean), 'explicit legacy source fixture is accepted');
    await t.saveAllRecords(legacyRows, settings, scope);
    const legacyLoaded = await t.loadScopeRecords(scope.scopeKey);
    assertComplete(legacyLoaded, 'legacy canonical fixture');
    assert.equal(legacyLoaded.records.length, 8);
    assert.ok(legacyLoaded.records.every(record => record.provider === 'hash' && record.vector.length === 3
      && record.embeddingReceipt == null && record.embeddingWork == null), 'legacy vectors are durable but carry no fabricated model readiness');
    const legacyBytes = JSON.stringify(legacyLoaded.records);
    await negativeHook('legacy');
    assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records), legacyBytes,
      'legacy-query filtering preserves the complete historical source rows');
    await t.saveAllRecords(pendingRows, settings, scope);

    const boundary = await api.inspectEmbeddingWork();
    assert.equal(boundary.configured, true);
    assert.equal(boundary.automatic, false, 'only the explicit finite queue may prepare the fixture');
    assert.equal(boundary.scopeKey, scope.scopeKey);
    assert.equal(boundary.provider, SETTINGS.embeddingProvider);
    assert.equal(boundary.model, SETTINGS.embeddingModel);
    assert.ok(boundary.profile && boundary.storageBinding, 'public inspection supplies the current profile and storage binding');
    const beforeBudgetControls = await t.loadScopeRecords(scope.scopeKey);
    assertComplete(beforeBudgetControls, 'pending queue-budget controls');
    assert.equal(beforeBudgetControls.records.length, 8, 'both queue negatives start with the original eight pending rows');
    assert.equal(JSON.stringify(beforeBudgetControls.records), pendingBytes, 'queue negatives use the exact original durable pending corpus');
    const callsBeforeBudgetControls = modelCalls.length;
    const reservationsBeforeBudgetControls = JSON.stringify([...reservations]);
    assert.equal(modelCalls.filter(call => call.kind === 'document').length, 0, 'no document callback precedes the budget controls');
    assert.equal(reservations.size, 0, 'no source reservation precedes the budget controls');

    // The existing ledger checks an already-expired absolute deadline before inventory/model work.
    const expiredQueue = await api.processPendingEmbeddingQueue({ scopeKey: scope.scopeKey,
      expectedProfile: boundary.profile, expectedStorageBinding: boundary.storageBinding, expectedGeneration: boundary.generation,
      maxSources: 8, maxRequests: 8, maxRecords: 8, maxChars: sources.reduce((sum, source) => sum + source.text.length, 0),
      deadlineAt: Date.now() - 1 });
    assert.equal(expiredQueue.ok, false);
    assert.equal(expiredQueue.reason, 'TIMEOUT', `expired queue stops at the real deadline: ${JSON.stringify(expiredQueue)}`);
    assert.equal(expiredQueue.scopeKey, scope.scopeKey);
    assert.equal(expiredQueue.ready, 0);
    assert.equal(expiredQueue.failed, 0);
    assert.equal(expiredQueue.physicalRequests, 0);
    assert.equal(expiredQueue.processedSources, 0);
    assert.equal(expiredQueue.processedRecords, 0);
    assert.equal(expiredQueue.processedChars, 0);
    assert.equal(expiredQueue.uncertain, false);
    assert.equal(expiredQueue.uncertainRecords, 0);
    assert.equal(expiredQueue.pendingSources, 0, 'early timeout has no discovered inventory; this is not an empty-corpus claim');
    assert.equal(modelCalls.length, callsBeforeBudgetControls, 'expired deadline submits no synthetic provider callback');
    assert.equal(JSON.stringify([...reservations]), reservationsBeforeBudgetControls, 'expired deadline creates no document reservation');
    const afterExpiredQueue = await t.loadScopeRecords(scope.scopeKey);
    assertComplete(afterExpiredQueue, 'expired queue readback');
    assert.equal(afterExpiredQueue.records.length, 8, 'all eight pending rows still exist despite the undiscovered pendingSources diagnostic');
    assert.equal(JSON.stringify(afterExpiredQueue.records), pendingBytes, 'expired queue preserves exact pending-row bytes');

    // The existing zero-budget result explicitly has no inventory-read authority.
    const disabledQueue = await api.processPendingEmbeddingQueue({ scopeKey: scope.scopeKey,
      expectedProfile: boundary.profile, expectedStorageBinding: boundary.storageBinding, expectedGeneration: boundary.generation,
      maxSources: 8, maxRequests: 0, maxRecords: 8, maxChars: sources.reduce((sum, source) => sum + source.text.length, 0) });
    assert.equal(disabledQueue.ok, false);
    assert.equal(disabledQueue.reason, 'budget_disabled', `zero request budget stays disabled: ${JSON.stringify(disabledQueue)}`);
    assert.equal(disabledQueue.inventoryKnown, false);
    assert.equal(disabledQueue.scopeKey, scope.scopeKey);
    assert.equal(disabledQueue.ready, 0);
    assert.equal(disabledQueue.failed, 0);
    assert.equal(disabledQueue.physicalRequests, 0);
    assert.equal(disabledQueue.processedSources, 0);
    assert.equal(disabledQueue.pendingSources, 0, 'disabled inventory is unread, not empty');
    assert.equal(modelCalls.length, callsBeforeBudgetControls, 'disabled budget submits no synthetic provider callback');
    assert.equal(JSON.stringify([...reservations]), reservationsBeforeBudgetControls, 'disabled budget creates no document reservation');
    const afterDisabledQueue = await t.loadScopeRecords(scope.scopeKey);
    assertComplete(afterDisabledQueue, 'disabled queue readback');
    assert.equal(afterDisabledQueue.records.length, 8);
    assert.equal(JSON.stringify(afterDisabledQueue.records), pendingBytes, 'disabled queue preserves all eight exact pending rows');

    // Read the supported effective default; do not write a replacement timeout or retry a partial pass.
    const effectiveEmbeddingTimeoutMs = (await api.loadSettings(true)).embeddingTimeoutMs;
    assert.equal(effectiveEmbeddingTimeoutMs, 30000, 'positive queue uses the fixed current bounded default');
    const queue = await api.processPendingEmbeddingQueue({ scopeKey: scope.scopeKey,
      expectedProfile: boundary.profile, expectedStorageBinding: boundary.storageBinding, expectedGeneration: boundary.generation,
      maxSources: 8, maxRequests: 8, maxRecords: 8, maxChars: sources.reduce((sum, source) => sum + source.text.length, 0) });
    assert.equal(queue.ok, true, `finite source work completes: ${JSON.stringify(queue)}`);
    assert.equal(queue.ready, 8);
    assert.equal(queue.failed, 0);
    assert.equal(queue.pendingSources, 0, 'the single positive pass completes every original pending source');
    assert.equal(queue.uncertain, false);
    assert.equal(queue.uncertainRecords, 0);
    assert.equal(queue.processedSources, 8);
    assert.equal(queue.processedRecords, 8);
    assert.equal(queue.physicalRequests, 8, 'one real provider-adapter request per original source');
    assert.equal(reservations.size, 8, 'all ready rows followed observed durable reservations');
    const readyLoaded = await t.loadScopeRecords(scope.scopeKey);
    assertComplete(readyLoaded, 'ready canonical fixture');
    const canonicalFirst = readyLoaded.records.filter(record => record.sourceType !== 'episode_index');
    assert.equal(canonicalFirst.length, 8);
    assert.equal(readyLoaded.records.length, 8, 'readiness setup does not build the derived episode fixture early');
    assert.equal(JSON.stringify(canonicalFirst.map(rawSource)), rawSourceBytes, 'legitimate model work preserves exact raw/source identities');
    const readyBoundary = await api.inspectEmbeddingWork();
    assert.equal(readyBoundary.profile, boundary.profile);
    assert.equal(readyBoundary.storageBinding, boundary.storageBinding);
    for (const row of canonicalFirst) {
      const prior = pendingRows.find(record => record.id === row.id);
      const reservation = reservations.get(row.id);
      assert.ok(prior && reservation, 'ready receipt belongs to an actual returned and reserved canonical ID');
      assert.deepEqual(plain(row.vector), [1, 0, 0]);
      assert.equal(row.dim, 3);
      assert.equal(row.embeddingDimensions, 3);
      assert.equal(row.provider, SETTINGS.embeddingProvider);
      assert.equal(row.embeddingProvider, SETTINGS.embeddingProvider);
      assert.equal(row.model, SETTINGS.embeddingModel);
      assert.equal(row.embeddingModel, SETTINGS.embeddingModel);
      assert.equal(row.embeddingProfileId, t.embeddingProfileId(settings, 3));
      assert.equal(row.scopeKey, scope.scopeKey);
      assert.equal(row.embeddingWork == null, true);
      assert.equal(row.embeddingReceipt?.schema, 'flashback.embedding_work_receipt.v1');
      assert.equal(row.embeddingReceipt.status, 'ready');
      assert.equal(row.embeddingReceipt.sourceRevision, prior.embeddingWork.sourceRevision);
      assert.equal(row.embeddingReceipt.jobId, prior.embeddingWork.jobId);
      assert.equal(row.embeddingReceipt.originScopeKey, scope.scopeKey);
      assert.deepEqual(plain(row.embeddingReceipt.targetProfile), plain(prior.embeddingWork.targetProfile));
      assert.equal(row.embeddingReceipt.targetProfile.profileFingerprint, boundary.profile);
      assert.equal(row.embeddingReceipt.attemptId, reservation.attempt.id);
      assert.equal(row.embeddingReceipt.runtimeId, reservation.attempt.runtimeId);
      assert.equal(row.embeddingReceipt.storageBinding, boundary.storageBinding);
      assert.equal(row.embeddingReceipt.storageBinding, reservation.attempt.storageBinding);
      assert.equal(row.embeddingReceipt.sourceRevision, reservation.sourceRevision);
      assert.equal(reservation.scopeKey, scope.scopeKey);
      assert.equal(reservation.originScopeKey, scope.scopeKey);
      assert.equal(reservation.jobId, prior.embeddingWork.jobId);
      assert.deepEqual(plain(reservation.targetProfile), plain(prior.embeddingWork.targetProfile));
      assert.ok(Number.isFinite(row.embeddingReceipt.completedAt), 'completion has a real finite timestamp');
      assert.equal(readyBoundary.jobs.find(job => job.recordId === row.id)?.status, 'ready');
    }
    // Freeze after actual durable model completion; retain the original source/vector byte projection exactly.
    const baselineSourceBytes = JSON.stringify(canonicalFirst.map(stableSource));
    const recallWitness = async (query, label) => {
      t.invalidateQueryEmbeddingCache();
      const beforeCalls = modelCalls.length;
      const recall = await api._selectionTest.prepareFlashbackRecall(query, settings, scope, { currentUser: query });
      assert.ok(modelCalls.slice(beforeCalls).some(call => call.kind === 'query'), `${label}: configured provider query was submitted`);
      assertCompletedQuery(recall, scope, label);
      if (query === QUERY) assert.equal(recall.contextualRecall.mode, 'semantic_embedding');
      assert.equal(recall.contextualRecall.lexicalFallbackCandidates, 0);
      // Hybrid recall keeps keyword arms beside dense; the hash recovery arm stays retired.
      assert.equal(recall.candidateArms.hashRecovery, 0);
      return api._selectionTest.selectFlashbackEvidencePlan(recall, settings, SETTINGS.maxInjectionChars);
    };
    const readyPositive = await recallWitness(QUERY, 'model-ready positive');
    assert.ok(readyPositive.text.includes(FACT), 'actual model-ready evidence supplies the canonical fact');
    assert.equal((await recallWitness('UNRELATED_FIXTURE_QUERY', 'orthogonal negative')).items.length, 0,
      'a successful orthogonal model query cannot inject unrelated canonical evidence');
    assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records.map(stableSource)), baselineSourceBytes,
      'prerequisite recall witnesses preserve the frozen canonical source/vector bytes');
    // Disable configuration only after the same canonical rows have supplied a positive.
    const readyBytes = JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records);
    await api.saveSettings({ ...settings, embeddingProvider: '', embeddingModel: '' });
    await negativeHook('unconfigured', false);
    assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records), readyBytes,
      'unconfigured recall preserves every byte of the previously ready canonical rows');
    await api.saveSettings(settings);

    // The public owner entry point must rebuild a deliberately absent derived index from canonical rows.
    const beforeFirstRebuild = await t.loadScopeRecords(scope.scopeKey);
    assertComplete(beforeFirstRebuild, 'immediately before the first public rebuild');
    assert.equal(beforeFirstRebuild.records.some(record => record.autoEpisode || record.sourceType === 'episode_index'), false,
      'the first public rebuild starts with a deliberately absent derived index');
    assert.equal(JSON.stringify(beforeFirstRebuild.records.map(stableSource)), baselineSourceBytes,
      'all prerequisites preserve canonical source/vector bytes before the first public rebuild');
    assert.equal(JSON.stringify(beforeFirstRebuild.records.map(record => record.embeddingReceipt)),
      JSON.stringify(canonicalFirst.map(record => record.embeddingReceipt)), 'all prerequisites preserve real readiness receipts');
    const firstRebuild = await api.rebuildEpisodeIndex(scope);
    assert.equal(firstRebuild.rebuilt, true, `public rebuild executes: ${JSON.stringify(firstRebuild)}`);
    const afterFirstRebuild = await t.loadScopeRecords(scope.scopeKey);
    const firstEpisodes = afterFirstRebuild.records.filter(record => record.autoEpisode || record.sourceType === 'episode_index');
    assert.ok(firstEpisodes.length > 0, 'episode rows survive durable readback after public rebuild');
    assert.ok(firstEpisodes.some(record => String(record.text || '').includes(FACT)), `derived episode records summarize the canonical source text: ${JSON.stringify(firstEpisodes.map(record => record.text))}`);
    assert.equal(JSON.stringify(afterFirstRebuild.records.filter(record => record.sourceType !== 'episode_index').map(stableSource)), baselineSourceBytes,
      'episode rebuild preserves canonical response text, vector, source hash and source identity bytes');

    // Remove only the episode rows, verify canonical bytes, then invoke the public rebuild again.
    await t.saveAllRecords(canonicalFirst, settings, scope);
    const afterRemoval = await t.loadScopeRecords(scope.scopeKey);
    assert.equal(afterRemoval.records.some(record => record.autoEpisode || record.sourceType === 'episode_index'), false,
      'derived episode rows can be removed while canonical responses remain');
    assert.equal(JSON.stringify(afterRemoval.records.map(stableSource)), baselineSourceBytes,
      'removing derived rows leaves canonical response bytes intact');
    assert.equal((await t.loadScopeRecords(scope.scopeKey)).records.some(record => record.autoEpisode || record.sourceType === 'episode_index'), false,
      'derived episode rows are absent immediately before the removal-path request');
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-without-index-warm', content: QUERY }], 'model');
    const withoutIndex = await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-without-index', content: QUERY }], 'model');
    const withoutIndexText = JSON.stringify(withoutIndex ?? null);
    const afterRemovalRequest = await t.loadScopeRecords(scope.scopeKey);
    const indexAbsentDuringRecall = !afterRemovalRequest.records.some(record => record.autoEpisode || record.sourceType === 'episode_index');
    assert.ok(withoutIndexText.includes(FACT), 'the first request after index removal injects the canonical fact');
    const secondRebuild = await api.rebuildEpisodeIndex(scope);
    assert.equal(secondRebuild.rebuilt, true, `public rebuild restores removed rows: ${JSON.stringify(secondRebuild)}`);
    const afterSecondRebuild = await t.loadScopeRecords(scope.scopeKey);
    const rebuiltEpisodes = afterSecondRebuild.records.filter(record => record.autoEpisode || record.sourceType === 'episode_index');
    assert.ok(rebuiltEpisodes.length > 0, 'rebuilt rows are durable after readback');

    // Exercise the final host request hook after index removal and after reconstruction.
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-after-rebuild-warm', content: QUERY }], 'model');
    const afterRebuild = await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-after-rebuild', content: QUERY }], 'model');
    const afterRebuildText = JSON.stringify(afterRebuild ?? null);
    assert.ok(afterRebuildText.includes(FACT), 'a final beforeRequest injects the same canonical fact after index reconstruction');

    const serverRowsWithCanonical = app.repositories.flashback.list('plugin', '').records || [];
    const localValuesWithCanonical = [...fixture.pluginStorage.values.values()].map(value => JSON.stringify(value));
    const localHasCanonical = localValuesWithCanonical.some(value => value.includes(canonicalFirst.find(record => record.sourceHash === sources[0].sourceHash).id) || value.includes(FACT));
    const localCanonicalKeys = [...fixture.pluginStorage.values.keys()].map(String)
      .filter(key => /:records:commit:|:records:shard:/.test(key));
    if (mode === 'plugin_only') {
      assert.equal(networkCalls.length, 0, 'plugin_only episode rebuild and recall make zero server calls');
      assert.equal(serverRowsWithCanonical.length, 0, 'plugin_only stores no derived or canonical server rows');
      assert.ok(localHasCanonical, 'plugin_only keeps canonical rows locally');
    } else if (mode === 'mirror') {
      assert.ok(serverRowsWithCanonical.length > 0, 'mirror projects canonical and episode rows to the server');
      assert.ok(localHasCanonical, 'mirror retains canonical rows locally');
    } else {
      assert.ok(serverRowsWithCanonical.length > 0, 'server_only stores canonical and episode rows on the server');
      assert.equal(localHasCanonical, false, 'server_only does not retain canonical response text locally');
      assert.equal(localCanonicalKeys.length, 0, 'server_only has no local canonical shard keys');
    }

    // Missing-canonical negative control: preserve the original valid derived rows and key payload
    // fields, but remove every response record. This isolates canonical absence from derived corruption.
    fixture.currentChat.message = [];
    fixture.currentChat.messages = [];
    const validEpisodeFields = JSON.stringify(rebuiltEpisodes.map(record => ({ id: record.id, text: record.text,
      vector: record.vector, hash: record.hash, sourceHash: record.sourceHash, childIds: record.childIds })));
    assert.ok(rebuiltEpisodes.some(record => String(record.text || '').includes(FACT)), 'valid derived episode contains the source fact');
    await t.saveAllRecords(rebuiltEpisodes, settings, scope);
    const missingCanonical = await t.loadScopeRecords(scope.scopeKey);
    assert.equal(missingCanonical.records.some(record => record.sourceType !== 'episode_index' && !record.autoEpisode), false,
      'negative control has no canonical response rows');
    const validEpisodesAfterRemoval = missingCanonical.records.filter(record => record.autoEpisode || record.sourceType === 'episode_index');
    assert.equal(JSON.stringify(validEpisodesAfterRemoval.map(record => ({ id: record.id, text: record.text,
      vector: record.vector, hash: record.hash, sourceHash: record.sourceHash, childIds: record.childIds }))), validEpisodeFields,
    'valid episode key fields are preserved while the canonical response is absent');
    t.invalidateQueryEmbeddingCache();
    const missingQueryCalls = modelCalls.length;
    const missingCanonicalRequest = await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-missing-canonical', content: QUERY }], 'model');
    const missingCanonicalInjection = JSON.stringify(missingCanonicalRequest ?? null);
    assert.ok(modelCalls.slice(missingQueryCalls).some(call => call.kind === 'query'), 'missing-canonical negative follows an actual configured query');
    assertCompletedQuery((await api.debugState()).lastRecall, scope, 'missing-canonical negative');
    assert.ok(!missingCanonicalInjection.includes(FACT),
      'first expected missing-canonical negative assertion: valid derived episode text is not injected as canonical evidence');

    // Separate corruption control: preserve valid canonical rows while altering only a derived episode
    // body. The final hook must inject the canonical fact and exclude stale text, isolating corruption.
    const corruptedEpisodes = validEpisodesAfterRemoval.map(record => ({ ...record, text: STALE }));
    await t.saveAllRecords([...canonicalFirst, ...corruptedEpisodes], settings, scope);
    const corruptOnly = await t.loadScopeRecords(scope.scopeKey);
    assert.ok(corruptOnly.records.some(record => record.sourceType === 'episode_index' && String(record.text || '').includes(STALE)),
      'corruption control contains deliberately stale derived text');
    assert.ok(corruptOnly.records.some(record => record.sourceType !== 'episode_index' && !record.autoEpisode && String(record.text || '').includes(FACT)),
      'corruption control retains the valid canonical response');
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-corrupt-derived-warm', content: QUERY }], 'model');
    t.invalidateQueryEmbeddingCache();
    const corruptionQueryCalls = modelCalls.length;
    const corruptionRequest = await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-corrupted-derived', content: QUERY }], 'model');
    const corruptionInjection = JSON.stringify(corruptionRequest ?? null);
    assert.ok(modelCalls.slice(corruptionQueryCalls).some(call => call.kind === 'query'), 'corruption control follows an actual configured query');
    assertCompletedQuery((await api.debugState()).lastRecall, scope, 'corruption control');
    assert.equal(JSON.stringify(corruptOnly.records.filter(record => record.sourceType !== 'episode_index').map(stableSource)), baselineSourceBytes,
      'corruption changes only derived data and preserves the complete original canonical byte projection');
    assert.ok(corruptionInjection.includes(FACT) && !corruptionInjection.includes(STALE),
      'separate corruption-control assertion: canonical fact injects while stale text in the damaged derived body does not');
    return {
      mode, networkCalls: networkCalls.length, syntheticModelCalls: modelCalls.length,
      documentModelCalls: modelCalls.filter(call => call.kind === 'document').length,
      readiness: { canonicalReady: canonicalFirst.length, reservations: reservations.size, queue,
        effectiveEmbeddingTimeoutMs, budgetControls: { expiredQueue, disabledQueue }, rawIdentityStable: true, orthogonalQueryItems: 0 },
      serverRowsWithCanonical: serverRowsWithCanonical.length,
      localHasCanonical, localCanonicalShardCount: localCanonicalKeys.length,
      canonicalSourceCount: canonicalFirst.length,
      firstRebuild: { episodes: firstEpisodes.length, digest: firstRebuild.digest },
      secondRebuild: { episodes: rebuiltEpisodes.length, digest: secondRebuild.digest },
      sourceBytesStable: true, indexAbsentDuringRecall, beforeRebuildInjection: withoutIndexText.includes(FACT),
      afterRebuildInjection: afterRebuildText.includes(FACT),
      missingCanonical: { validDerivedTextPresent: true, injected: missingCanonicalInjection.includes(FACT) },
      damagedDerived: { staleTextPresent: true, injected: corruptionInjection.includes(STALE) },
      boundary: 'public owner rebuild API + actual beforeRequest; synthetic provider protocol; zero external model requests'
    };
  } finally {
    await fixture?.dispose?.();
    await app?.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) results.push(await checkMode(mode));
  assert.deepEqual(results.map(row => `${row.beforeRebuildInjection}|${row.afterRebuildInjection}`), ['true|true', 'true|true', 'true|true'],
    'all storage modes inject the same canonical fact while the episode index is absent and after reconstruction');
  process.stdout.write(JSON.stringify({ test: 'flashback_episode_index_rebuild_injection_negative', results }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
