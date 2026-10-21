'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const { awaitScopeRetirement } = require('./fixtures/flashback_retirement_lifecycle.cjs');
const { checkComputeRetired } = require('./fixtures/current_ui_compute_contracts.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const SOURCE = { sourceType: 'response', sourceId: 'model-only-source', sourceHash: 'model-only-hash',
  origin: 'live_chat', role: 'turn_pair', turnIndex: 1, pairIndex: 1,
  text: 'User:\nWhere is the brass key?\n\n---\n\nAssistant:\nThe brass key is inside the north library cabinet, tied with a blue ribbon.' };
const QUERY = 'Tell me where the brass key is kept in the north library cabinet.';
const clone = value => JSON.parse(JSON.stringify(value));
async function setup(run, { settleRetirement = true } = {}) {
  const h = await createFlashback(PROGRAM, { waitForLoaded: true, transformSource: source => source.replace('  globalThis.__FlashbackMemory = publicApi;',
    '  globalThis.__modelOnlyAudit = { restoredLegacyCompactionRecord, buildProviderTab, embeddingProfileId };\n  globalThis.__FlashbackMemory = publicApi;').replace(
      "        const currentManifest = await withinHookDeadline(loadScopeManifest(scope.scopeKey),'recall binding');",
      "        globalThis.__modelOnlyAtFinalManifestRead = true;\n        const currentManifest = await withinHookDeadline(loadScopeManifest(scope.scopeKey),'recall binding');") });
  try {
    const cfg = h.api._test.normalizeSettings({ embeddingEnabled: true, embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small', embeddingDimensions: 3, embeddingUrl: 'https://provider.invalid/v1/embeddings',
      embeddingMaxRetries: 0, fallbackHashEmbedding: true, embeddingFallbackProvider: 'hash',
      autoEpisodeIndex: false, heuristicRecall: true, contextualRecall: false, currentSceneTailEnabled: false, minScore: 0 });
    await h.api.saveSettings(cfg);
    const scope = await h.api.resolveCurrentScope(false);
    let calls = 0;
    h.host.nativeFetch = async (_url, init) => { calls++; const input = JSON.parse(init.body).input;
      return { ok: true, status: 200, async json() { return { data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } }; };
    const raw = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(raw, cfg, scope);
    if (settleRetirement) {
      await h.api._test.loadScopeRecords(scope.scopeKey);
      await awaitScopeRetirement(h.audit.Runtime, scope.scopeKey);
    }
    await run({ h, cfg, scope, raw, calls: () => calls, read: async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records });
  } finally { await h.cleanup(); }
}

test('default configuration is explicitly unconfigured and legacy fallback settings cannot activate substitutes', async () => {
  await setup(async ({ h }) => {
    const defaults = h.api._test.normalizeSettings({});
    assert.equal(defaults.embeddingProvider, '');
    assert.equal(defaults.embeddingModel, '');
    const old = h.api._test.normalizeSettings({ embeddingProvider: 'hash', fallbackHashEmbedding: true, embeddingFallbackProvider: 'hash' });
    assert.equal(old.embeddingProvider, 'hash', 'legacy identity remains readable');
    assert.equal(old.fallbackHashEmbedding, false);
    assert.equal(old.embeddingFallbackProvider, '');
  });
});
for (const mode of ['unconfigured', 'disabled', 'legacy_hash']) test(`${mode} adapter refuses to manufacture document vectors`, async () => {
  await setup(async ({ h, cfg, scope, calls }) => {
    const settings = mode === 'disabled' ? { ...cfg, embeddingEnabled: false }
      : mode === 'legacy_hash' ? { ...cfg, embeddingProvider: 'hash' } : h.api._test.normalizeSettings({});
    await assert.rejects(h.api._test.embedTexts([SOURCE.text], settings, { scope }), error => error.code === 'EMBEDDING_UNCONFIGURED');
    assert.equal(calls(), 0);
  });
});
test('provider failure propagates even with old fallback flags and preserves durable raw source', async () => {
  await setup(async ({ h, cfg, scope, read }) => {
    const before = clone(await read());
    h.host.nativeFetch = async () => ({ ok: false, status: 503, async json() { return { error: { message: 'synthetic provider unavailable' } }; } });
    await assert.rejects(h.api._test.embedTexts([SOURCE.text], { ...cfg, fallbackHashEmbedding: true }, { scope, allowHashFallback: true }));
    assert.equal(h.api._test.inspectLastEmbedFallback(), false);
    assert.deepEqual(clone(await read()), before);
  });
});
test('durably reserved model vectors flow through actual recall and evidence rendering', async () => {
  await setup(async ({ h, cfg, scope, calls }) => {
    assert.equal((await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).ready, 1);
    const result = await h.api.recallRecords(QUERY, cfg, scope, { currentPairIndex: 10 });
    assert(result.records.some(item => item.record.sourceHash === SOURCE.sourceHash));
    const rendered = h.api._selectionTest.selectFlashbackEvidencePlan(result, cfg, 8000);
    assert(rendered.text.includes('blue ribbon'));
    assert(calls() >= 2, 'document reservation and configured query each submit to the synthetic provider');
    assert.equal(result.queryDim, 3);
    assert.equal(result.fallbackWarning, '');
  });
});
for (const mode of ['pending', 'legacy_hash', 'wrong_profile', 'changed_source']) test(`${mode} rows cannot enter any recall arm or structured-state output`, async () => {
  await setup(async ({ h, cfg, scope, raw, read }) => {
    let row = raw[0];
    if (mode !== 'pending') {
      assert.equal((await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash })).ready, 1);
      row = clone((await read())[0]);
      if (mode === 'legacy_hash') { row.provider = row.embeddingProvider = 'hash'; row.model = row.embeddingModel = 'hash-3'; delete row.embeddingReceipt; }
      if (mode === 'wrong_profile') row.embeddingProfileId = 'emb_foreign';
      if (mode === 'changed_source') row.text += ' The source was edited after embedding.';
    }
    row.structuredStateFacts = [{ entity: 'brass key', property: 'location', value: 'north library cabinet' }];
    await h.api._test.saveAllRecords([row], cfg, scope);
    const before = clone(await read());
    const result = await h.api.recallRecords(QUERY, cfg, scope, { currentPairIndex: 10 });
    assert.equal(result.records.length, 0);
    assert.equal(result.currentStateFacts?.length || 0, 0);
    assert.equal(result.candidateArms?.hashRecovery || 0, 0);
    const arms = await h.api._test.generateRecallCandidateArms({ records: [row], queryText: QUERY, queryVector: [1, 0, 0], settings: cfg,
      context: { scopeKey: scope.scopeKey, queryProvider: 'openai', queryModel: cfg.embeddingModel, queryProfileId: h.context.__modelOnlyAudit.embeddingProfileId(cfg, 3) } });
    assert(Object.values(arms).every(rows => rows.length === 0), 'all candidate channels honor model readiness');
    assert.deepEqual(clone(await read()), before, 'query filtering never deletes legacy or raw source bytes');
  });
});
test('query provider failure falls back to keyword retrieval over admitted records only', async () => {
  await setup(async ({ h, cfg, scope, read }) => {
    await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    const before = clone(await read());
    h.host.nativeFetch = async () => { throw Error('synthetic query outage'); };
    const result = await h.api.recallRecords(QUERY, { ...cfg, fallbackHashEmbedding: true }, scope, { currentPairIndex: 10 });
    assert.equal(result.modelReadiness.status, 'lexical_fallback');
    assert.equal(result.modelReadiness.reason, 'query_failed');
    assert.equal(result.modelReadiness.ready, false, 'a keyword fallback is never reported as semantic readiness');
    assert.equal(result.queryDim, 0, 'no hash or substitute query vector is manufactured');
    assert.match(result.fallbackWarning, /키워드 검색/);
    assert.ok(h.api._selectionTest.selectFlashbackEvidencePlan(result, cfg, 8000).text.includes('blue ribbon'), 'the admitted model-ready record is found by keywords');
    assert.deepEqual(clone(await read()), before, 'fallback recall writes nothing');
  });
});
test('legacy/default recall is unavailable with zero provider calls and no alternate hash output', async () => {
  await setup(async ({ h, cfg, scope, calls }) => {
    const result = await h.api.recallRecords(QUERY, { ...cfg, embeddingProvider: 'hash' }, scope, { currentPairIndex: 10 });
    assert.equal(result.records.length, 0);
    assert.equal(result.modelReadiness.status, 'unconfigured');
    assert.equal(calls(), 0);
  });
});
test('legacy compaction restore preserves raw pending text without synthesizing a vector', async () => {
  await setup(async ({ h, cfg, scope, raw }) => {
    const restored = h.context.__modelOnlyAudit.restoredLegacyCompactionRecord(raw[0], scope.scopeKey, cfg);
    assert.equal(restored.text, SOURCE.text);
    assert.equal(restored.sourceHash, SOURCE.sourceHash);
    assert.equal(restored.vector.length, 0);
    assert.equal(restored.embeddingWork.sourceRevision, raw[0].embeddingWork.sourceRevision);
    await h.api._test.saveAllRecords([restored], cfg, scope);
    assert.equal((await h.api._test.loadScopeRecords(scope.scopeKey)).records[0].vector.length, 0);
  });
});
test('provider UI represents unconfigured and legacy state without offering local fallback', async () => {
  await setup(async ({ h }) => {
    const defaults = h.api._test.normalizeSettings({});
    const html = h.context.__modelOnlyAudit.buildProviderTab(defaults);
    assert.match(html, /<option value="" selected>/);
    assert.doesNotMatch(html, /id="embeddingFallbackProvider"/);
    assert.match(html, /원문/);
    const legacy = h.context.__modelOnlyAudit.buildProviderTab(h.api._test.normalizeSettings({ embeddingProvider: 'hash' }));
    assert.match(legacy, /<option value="hash" selected[^>]*>[^<]*이전/);
  });
});
test('a compatible tail record remains recallable after more than 128 pending front records', async () => {
  await setup(async ({ h, cfg, scope, read }) => {
    await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    const ready = (await read())[0];
    const sources = Array.from({ length: 137 }, (_, i) => ({ ...SOURCE, sourceId: `front-${i}`, sourceHash: `front-hash-${i}`,
      turnIndex: i + 2, pairIndex: i + 2, text: `User:\nFront question ${i}.\n\n---\n\nAssistant:\nUnrelated paper records from front group ${i}.` }));
    const pending = await h.api._test.buildRecordsFromSources(sources, cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords([...pending, ready], cfg, scope);
    const result = await h.api.recallRecords(QUERY, cfg, scope, { currentPairIndex: 200 });
    assert(result.records.some(item => item.record.sourceHash === SOURCE.sourceHash));
    assert(result.records.every(item => item.record.sourceHash === SOURCE.sourceHash));
  });
});
test('the shipped plugin exposes no local hash-vector generation capability', async () => {
  await setup(async ({ h }) => {
    assert.equal(h.api._test.hashEmbedding, undefined);
    assert.equal(h.api._test.hashEmbeddingBatch, undefined);
    assert.equal(h.api._test.hashEmbeddingBatchLocal, undefined);
    // The Compute SDK is retired from the plugin: no compute adapter (hash-only or
    // otherwise) can be registered, exposed or created by the shipped source.
    assert.equal(h.api._test.memorySuiteComputeStatus, undefined, 'no compute adapter status surface remains');
    assert.equal(h.api._test.memorySuiteComputeWhenIdle, undefined, 'no compute adapter lifecycle surface remains');
    checkComputeRetired(require('node:fs').readFileSync(path.join(PROGRAM, 'plugins', 'Flashback_Memory.js'), 'utf8'));
  });
});
test('the former emergency sparse entry cannot return source text without a completed model query', async () => {
  await setup(async ({ h, cfg, scope }) => {
    const result = typeof h.api._test.emergencySparseRecall === 'function'
      ? await h.api._test.emergencySparseRecall(QUERY, cfg, scope, { currentPairIndex: 10 }) : null;
    assert.equal(result, null);
  });
});
for (const change of ['profile', 'scope']) test(`a query cannot publish recall after a ${change} change during provider await`, async () => {
  await setup(async ({ h, cfg, scope }) => {
    await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    h.host.nativeFetch = async (_url, init) => {
      if (change === 'profile') await h.api.saveSettings({ ...cfg, embeddingModel: 'other-model' });
      else {
        const character = await h.host.getCharacter();
        const chat = { id: 'other-model-only-chat', chatId: 'other-model-only-chat', message: [], messages: [] };
        character.chats.push(chat); character.chatPage = 1;
        h.host.getCurrentChatIndex = async () => 1;
        h.host.getCurrentChat = h.host.getChat = async () => chat;
        h.host.getChatFromIndex = async (_c, index) => character.chats[index];
      }
      return { ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } };
    };
    const result = await h.api.recallRecords(QUERY, cfg, scope, { currentPairIndex: 10 });
    assert.equal(result.records.length, 0);
    assert.equal(result.currentStateFacts?.length || 0, 0);
  });
});
test('the actual request hook does not inject raw memory after its model-query deadline', async () => {
  await setup(async ({ h, cfg, scope }) => {
    const settings = h.api._test.normalizeSettings({ ...cfg, hookRecallTimeoutMs: 1000 });
    await h.api.saveSettings(settings);
    const chat = await h.host.getCurrentChat();
    chat.message = [{ role: 'user', chatId: 'old-question', data: 'Where is the brass key?' },
      { role: 'assistant', chatId: 'old-answer', data: 'The brass key is inside the north library cabinet, tied with a blue ribbon.' }];
    chat.messages = chat.message;
    let calls = 0;
    h.host.nativeFetch = async (_url, init) => { calls++; return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }); };
    const output = await h.api._test.beforeRequest([{ role: 'user', content: QUERY }], 'model');
    assert.equal(calls, 1);
    assert(!JSON.stringify(output).includes('blue ribbon'), 'stored source must not leak through the timeout fallback');
    const last = (await h.api.debugState()).lastRecall;
    assert.equal(last.emergencyAttempted, false);
  });
});
test('profile changes during the last storage read invalidate the completed query result', async () => {
  await setup(async ({ h, cfg, scope }) => {
    await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    let queryFinished = false, changed = false;
    const provider = h.host.nativeFetch;
    h.host.nativeFetch = async (...args) => { const reply = await provider(...args); queryFinished = true; return reply; };
    const original = h.pluginStorage.getItem.bind(h.pluginStorage);
    h.api._test.invalidateRecallShardCache(scope.scopeKey);
    h.pluginStorage.getItem = async key => {
      const value = await original(key);
      if (queryFinished && !changed && String(key).includes(':shard:')) {
        changed = true;
        await h.api.saveSettings({ ...cfg, embeddingModel: 'other-after-query-model' });
      }
      return value;
    };
    const result = await h.api.recallRecords(QUERY, cfg, scope, { currentPairIndex: 10 });
    assert(changed, 'the model changes during real shard loading after query completion');
    assert.equal(result.records.length, 0);
    assert.ok(result.modelReadiness, 'the changed selected model retains an explicit readiness diagnostic');
    assert.equal(result.modelReadiness.status, 'changed');
    assert.equal(result.modelReadiness.ready, false);
    assert.equal(result.currentStateFacts?.length || 0, 0);
    assert.match(result.fallbackWarning, /원문은 보관/);
  });
});
test('the complete settings UI does not advertise a hash embedding compute route', async () => {
  await setup(async ({ h }) => {
    const html = await h.api._test.buildUiHtml();
    assert.doesNotMatch(html, /id="hashDimensions"|Hash 모델은 단어 기반 검색|hash embedding 연산 위치/);
  });
});
test('a stale caller profile cannot submit a query to the formerly selected model', async () => {
  await setup(async ({ h, cfg, scope, calls }) => {
    await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    const before = calls();
    await h.api.saveSettings({ ...cfg, embeddingModel: 'new-selected-model' });
    const result = await h.api.recallRecords(QUERY, cfg, scope, { currentPairIndex: 10 });
    assert.equal(calls(), before, 'only the currently configured model may receive queries');
    assert.equal(result.records.length, 0);
  });
});
test('legacy compaction preserves malformed derived vector bytes as repair evidence', async () => {
  await setup(async ({ h, cfg, scope, raw }) => {
    const old = { ...raw[0], vector: [1, 'damaged-component', 0], dim: 3, embeddingDimensions: 3,
      provider: 'openai', model: cfg.embeddingModel, embeddingProvenance: { source: 'original-group' }, vectorRef: { storageKey: 'lost' } };
    delete old.embeddingWork;
    const restored = h.context.__modelOnlyAudit.restoredLegacyCompactionRecord(old, scope.scopeKey, cfg);
    assert.equal(restored.text, old.text);
    assert.equal(restored.vector.length, 0);
    assert.equal(restored.embeddingWork.status, 'repair_needed');
    const evidence = JSON.parse(restored.embeddingWork.repair.originalMetadata);
    assert.deepEqual(evidence.vector, old.vector);
    assert.deepEqual(evidence.embeddingProvenance, old.embeddingProvenance);
  });
});
test('request-hook diagnostics and GUI report the keyword fallback after a query failure', async () => {
  await setup(async ({ h, cfg }) => {
    h.host.nativeFetch = async () => ({ ok: false, status: 503, async json() { return { error: { message: 'synthetic query failure' } }; } });
    await h.api._test.beforeRequest([{ role: 'user', content: QUERY }], 'model');
    const state = (await h.api.debugState()).lastRecall;
    assert.equal(state.modelReadiness.status, 'lexical_fallback');
    assert.equal(state.modelReadiness.reason, 'query_failed');
    assert.equal(state.modelReadiness.ready, false);
    assert(h.api._test.renderLastRecallPanel(state, state.scopeKey).includes('키워드 검색으로 대체'));
  });
});
for (const changed of ['', 'scope', 'credential']) test(`actual hook final manifest read ${changed ? 'rejects changed ' + changed : 'retains the current scope positive'}`, async () => {
  await setup(async ({ h, cfg, scope }) => {
    await h.api.processPendingEmbeddingWork({ sourceHash: SOURCE.sourceHash });
    let boundaryObserved = false;
    const get = h.pluginStorage.getItem.bind(h.pluginStorage);
    h.pluginStorage.getItem = async key => {
      const value = await get(key);
      if (!boundaryObserved && h.context.__modelOnlyAtFinalManifestRead && String(key).endsWith(':manifest:v2')) {
        boundaryObserved = true;
        if (changed === 'credential') await h.api.saveEmbeddingCredential('synthetic-changed-final-hook-key');
        if (changed === 'scope') {
          const character = await h.host.getCharacter();
          const chat = { id: 'other-final-hook-chat', chatId: 'other-final-hook-chat', message: [], messages: [] };
          character.chats.push(chat); character.chatPage = 1;
          h.host.getCurrentChatIndex = async () => 1;
          h.host.getCurrentChat = h.host.getChat = async () => chat;
          h.host.getChatFromIndex = async (_c, index) => character.chats[index];
        }
      }
      return value;
    };
    const output = await h.api._test.beforeRequest([{ role: 'user', content: QUERY }], 'model');
    assert(boundaryObserved, 'intercepted the actual final manifest read in the hook');
    assert.equal(JSON.stringify(output).includes('blue ribbon'), !changed);
  });
});

// A provider failure must not override an independently invalidated request.
test('retirement manifest cancellation remains expired when the provider also returns HTTP503', async () => {
  await setup(async ({ h, scope }) => {
    const manifestKey = [...h.pluginStorage.values.keys()].find(key => key.includes(':scope:') && key.endsWith(':manifest:v2'));
    const before = JSON.parse(JSON.stringify((await h.api._test.loadScopeRecords(scope.scopeKey)).records));
    await awaitScopeRetirement(h.audit.Runtime, scope.scopeKey);
    const stored = h.pluginStorage.values.get(manifestKey);
    const manifest = typeof stored === 'string' ? JSON.parse(stored) : structuredClone(stored);
    manifest.externalRetirementVersion = 0;
    h.pluginStorage.values.set(manifestKey, typeof stored === 'string' ? JSON.stringify(manifest) : manifest);
    let releaseWrite, enteredWrite, releaseProvider, enteredProvider;
    const writing = new Promise(resolve => { enteredWrite = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const submitted = new Promise(resolve => { enteredProvider = resolve; });
    const providerGate = new Promise(resolve => { releaseProvider = resolve; });
    const set = h.pluginStorage.setItem.bind(h.pluginStorage);
    let blocked = false, calls = 0, pending;
    const within = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('overlap seam not reached')), 5000); })]); } finally { clearTimeout(timer); } };
    h.pluginStorage.setItem = async (key, value) => {
      const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
      if (!blocked && key === manifestKey && parsed?.externalRetirementVersion > 0) { blocked = true; enteredWrite(); await writeGate; }
      return set(key, value);
    };
    h.host.nativeFetch = async () => { calls++; enteredProvider(); await providerGate; return { ok: false, status: 503, async json() { return { error: { message: 'synthetic overlap failure' } }; } }; };
    try {
      pending = h.api._test.beforeRequest([{ role: 'user', content: QUERY }], 'model');
      await within(Promise.all([writing, submitted]));
      releaseWrite();
      await awaitScopeRetirement(h.audit.Runtime, scope.scopeKey);
      releaseProvider();
      const output = await within(pending);
      assert.equal(calls, 1);
      assert(!JSON.stringify(output).includes('blue ribbon'));
      const state = (await h.api.debugState()).lastRecall;
      assert.equal(state.reason, 'FLASHBACK_RECALL_EXPIRED');
      assert.equal(state.skipped, true);
      assert.deepEqual(JSON.parse(JSON.stringify((await h.api._test.loadScopeRecords(scope.scopeKey)).records)), before);
    } finally {
      releaseWrite(); releaseProvider();
      if (pending) await pending.catch(() => {});
      await awaitScopeRetirement(h.audit.Runtime, scope.scopeKey);
    }
  });
});

test('unchanged configured model with no stored rows is not reported as a changed profile', async () => {
  await setup(async ({h,cfg,scope}) => {
    await h.api._test.saveAllRecords([],cfg,scope);
    await h.api._test.loadScopeRecords(scope.scopeKey);
    await awaitScopeRetirement(h.audit.Runtime,scope.scopeKey);
    const result=await h.api.recallRecords(QUERY,cfg,scope,{currentPairIndex:10});
    assert.equal(result.records.length,0);
    assert.notEqual(result.modelReadiness?.status,'changed');
    assert.equal(result.storageMissingShards||0,0);
    assert.equal(result.storageCorruptShards||0,0);
  });
});

test('missing physical shard with unchanged model remains a storage diagnostic', async () => {
  await setup(async ({h,cfg,scope}) => {
    await h.api.processPendingEmbeddingWork({sourceHash:SOURCE.sourceHash});
    await h.api._test.loadScopeRecords(scope.scopeKey);
    await awaitScopeRetirement(h.audit.Runtime,scope.scopeKey);
    const keys=[...h.pluginStorage.values.keys()].filter(key=>key.includes(':records:')&&key.includes(':shard:'));
    assert(keys.length>0,'fixture reaches a real physical shard');
    for(const key of keys)h.pluginStorage.values.delete(key);
    h.api._test.invalidateRecallShardCache(scope.scopeKey);
    const result=await h.api.recallRecords(QUERY,cfg,scope,{currentPairIndex:10});
    assert.equal(result.records.length,0);
    assert.notEqual(result.modelReadiness?.status,'changed');
    assert(result.storageMissingShards>0,'missing physical bytes retain the storage failure classification');
  });
});
