'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const { createFlashback: createManualPortableFixture } = require('./fixtures/raw_pending_portable_fixture.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const USER = 'I check the old brass key.';
const REPLY = 'The brass key opens the north library cabinet. A blue ribbon remains tied to its handle.';
const SOURCE = {
  sourceType: 'response', sourceId: 'raw-pending-source-1', sourceHash: 'raw-pending-source-hash-1',
  title: 'Captured turn', origin: 'live_chat', role: 'turn_pair', turnIndex: 1, pairIndex: 1,
  userMessagePosition: 0, assistantMessagePosition: 1, sourceMessageIds: ['raw-u1', 'raw-a1'],
  text: `User:\n${USER}\n\n---\n\nAssistant:\n${REPLY}`
};
const clone = value => JSON.parse(JSON.stringify(value));

async function withRuntime(run, options = {}) {
  const h = await (options.manualPortableFixture ? createManualPortableFixture : createFlashback)(PROGRAM, options);
  try {
    const scope = await h.api.resolveCurrentScope(false);
    const cfg = h.api._test.normalizeSettings({ embeddingEnabled: false, enableGui: false });
    await run(h, scope, cfg);
  } finally { await h.cleanup(); }
}

function assertRawPending(record, status) {
  assert.equal(record.text, SOURCE.text, 'source text is preserved exactly');
  assert.equal(record.sourceHash, SOURCE.sourceHash);
  assert.equal(record.vector.length, 0, 'a raw save must not manufacture a substitute vector');
  assert.equal(record.vectorRef == null, true);
  assert.equal(record.dim, 0);
  assert.equal(record.embeddingDimensions, 0);
  assert.equal(record.embeddingWork?.schema, 'flashback.embedding_work.v1');
  assert.equal(record.embeddingWork?.status, status);
  assert(record.embeddingWork.sourceRevision, 'raw source identity is durably bound');
  assert(record.embeddingWork.jobId, 'pending work has a durable identity');
}

test('raw-only construction with no configured model preserves text and creates no vector', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const records = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
    assert.equal(records.length, 1);
    assertRawPending(records[0], 'unconfigured');
    assert.equal(h.networkCalls.length, 0);
  });
});

test('raw-only construction does not submit to a configured unavailable provider', async () => {
  await withRuntime(async (h, scope, base) => {
    let submitted = 0;
    h.host.nativeFetch = async () => { submitted++; throw Error('synthetic_provider_unavailable'); };
    const cfg = h.api._test.normalizeSettings({ ...base, embeddingEnabled: true,
      embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small',
      embeddingUrl: 'https://provider.invalid/v1/embeddings', embeddingMaxRetries: 0,
      fallbackHashEmbedding: false });
    let records;
    await assert.doesNotReject(async () => {
      records = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
    }, 'saving raw source must not depend on an embedding response');
    assertRawPending(records[0], 'pending');
    assert.equal(submitted, 0);
    assert.equal(records[0].embeddingWork.targetProfile.provider, 'openai');
    assert.equal(records[0].embeddingWork.targetProfile.model, 'text-embedding-3-small');
  });
});

test('the completed-output capture path durably saves raw pending text without a model call', async () => {
  await withRuntime(async (h, scope, cfg) => {
    await h.api.saveSettings({ ...cfg, captureAfterRequest: true });
    const chat = await h.host.getCurrentChat();
    const character = await h.host.getCharacter();
    await h.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'raw-u1', content: USER }], 'model');
    chat.message = [{ role: 'user', chatId: 'raw-u1', data: USER },
      { role: 'assistant', chatId: 'raw-a1', data: REPLY }];
    chat.messages = chat.message;
    const capture = await h.api._test.processRisuChatOutputEvent({ char: character, chat,
      characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    assert(capture, 'actual output capture entrypoint must accept the completed turn');
    const loaded = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert(loaded.records.length > 0, 'capture is durably readable');
    for (const record of loaded.records) {
      assert(record.text.includes(REPLY));
      assert.equal(record.vector.length, 0);
      assert.equal(record.embeddingWork?.status, 'unconfigured');
    }
    assert.equal(h.networkCalls.length, 0);
  });
});

async function contractFixtureRecord(h, scope, cfg) {
  const [record] = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope);
  const hash = h.audit.MemorySuiteExecutionContract.hash;
  const sourceRevision = hash({ sourceId: record.sourceId, sourceHash: record.sourceHash,
    chunkIndex: record.chunkIndex, chunkCount: record.chunkCount, textDigest: hash(record.text) });
  const targetProfile = null;
  return { ...record, vector: [], vectorRef: null, dim: 0, embeddingDimensions: 0,
    provider: '', model: '', embeddingProvider: '', embeddingModel: '', embeddingProfileId: '',
    embeddingDescriptor: null, embeddingProvenance: null,
    embeddingWork: { schema: 'flashback.embedding_work.v1', status: 'unconfigured',
      scopeKey: scope.scopeKey, sourceRevision, targetProfile,
      jobId: `fb_embed_${hash({ scopeKey: scope.scopeKey, sourceRevision, targetProfile })}` } };
}

test('verified shard commit accepts an intentional source-bound raw-only record', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const record = await contractFixtureRecord(h, scope, cfg);
    await assert.doesNotReject(() => h.api._test.saveAllRecords([record], cfg, scope));
    const loaded = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(loaded.records.length, 1);
    assertRawPending(loaded.records[0], 'unconfigured');
    assert.deepEqual(clone(loaded.records[0].embeddingWork), clone(record.embeddingWork));
  });
});

test('unmarked vector loss and a pending marker over changed source remain corruption', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const record = await contractFixtureRecord(h, scope, cfg);
    const unmarked = clone(record); delete unmarked.embeddingWork;
    await assert.rejects(() => h.api._test.saveAllRecords([unmarked], cfg, scope), error => error.code === 'FLASHBACK_REBUILD_COMMIT_READBACK_FAILED');
    const changed = { ...record, text: `${record.text} Changed.` };
    await assert.rejects(() => h.api._test.saveAllRecords([changed], cfg, scope), error => error.code === 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID');
    const claimedSidecar = { ...record, vectorRef: { schema: 'flashback.vector_ref.v1', storageKey: 'missing-vector', recordId: record.id, offset: 0, length: 3, digest: 'missing' } };
    await assert.rejects(() => h.api._test.saveAllRecords([claimedSidecar], cfg, scope), error => error.code === 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID');
  });
});


test('metadata audit distinguishes intentional pending from a missing derived vector', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const record = await contractFixtureRecord(h, scope, cfg);
    assert.equal((await h.api._test.inspectFlashbackVectorPayloadMetadata([record], { scopeKey: scope.scopeKey })).verified, true);
    const broken = clone(record); delete broken.embeddingWork;
    assert.equal((await h.api._test.inspectFlashbackVectorPayloadMetadata([broken], { scopeKey: scope.scopeKey })).verified, false);
  });
});

test('portable predecessor import preserves pending raw source and its source binding', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const record = await contractFixtureRecord(h, scope, cfg);
    await h.api._test.saveAllRecords([record], cfg, scope);
    const portable = h.context.__FlashbackPortableMemoryBackup;
    const backup = await portable.exportCurrentScope();
    const character = await h.host.getCharacter();
    const target = { id: 'raw-target', chatId: 'raw-target', name: 'Target', message: [], messages: [] };
    character.chats.push(target); character.chatPage = 1;
    h.host.getCurrentChatIndex = async () => 1;
    h.host.getCurrentChat = h.host.getChat = async () => target;
    h.host.getChatFromIndex = async (_char, index) => character.chats[index];
    const result = await portable.restoreCurrentScope(backup, { mode: portable.restoreModes.CHAT_MIGRATION });
    assert.equal(result.ok, true);
    const targetScope = await h.api.resolveCurrentScope(false);
    const restored = await h.api._test.loadScopeRecords(targetScope.scopeKey);
    assert.equal(restored.records.length, 1);
    assertRawPending(restored.records[0], 'unconfigured');
    assert.equal(restored.records[0].embeddingWork.sourceRevision, record.embeddingWork.sourceRevision);
    assert.equal(restored.records[0].embeddingWork.scopeKey, restored.records[0].scopeKey);
    assert.notEqual(restored.records[0].embeddingWork.jobId, record.embeddingWork.jobId);
    assert.equal(h.networkCalls.length, 0);
  });
});

test('immutable handoff archive preserves a raw-pending record', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const record = await contractFixtureRecord(h, scope, cfg);
    await h.api._test.saveAllRecords([record], cfg, scope);
    const archived = await h.api._test.createImmutableFlashbackHandoffArchive(scope.scopeKey, 1, cfg);
    assert.equal(archived.recordCount, 1);
    const reread = await h.api._test.loadFlashbackArchiveChain(archived.archiveRef);
    assert.equal(reread.verified, true);
    assertRawPending(reread.recordsList[0], 'unconfigured');
    assert.equal(reread.recordsList[0].embeddingWork.scopeKey, reread.recordsList[0].scopeKey);
    assert.notEqual(reread.recordsList[0].embeddingWork.jobId, record.embeddingWork.jobId);
  });
});

test('a fresh runtime rereads exact raw source and pending identity without a provider call', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const [record] = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords([record], cfg, scope);
    const second = await createFlashback(PROGRAM, { pluginStorage: h.pluginStorage, safeLocalStorage: h.safeLocalStorage });
    try {
      const loaded = await second.api._test.loadScopeRecords(scope.scopeKey);
      assert.equal(loaded.records.length, 1);
      assertRawPending(loaded.records[0], 'unconfigured');
      assert.deepEqual(clone(loaded.records[0].embeddingWork), clone(record.embeddingWork));
      assert.equal(second.networkCalls.length, 0);
    } finally { await second.cleanup(); }
  });
});

test('same-scope portable restore round trips pending source after an empty replacement', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const [record] = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords([record], cfg, scope);
    const portable = h.context.__FlashbackPortableMemoryBackup;
    const backup = await portable.exportCurrentScope();
    await h.api._test.saveAllRecords([], cfg, scope);
    assert.equal((await h.api._test.loadScopeRecords(scope.scopeKey)).records.length, 0);
    assert.equal((await portable.restoreCurrentScope(backup)).ok, true);
    const restored = await h.api._test.loadScopeRecords(scope.scopeKey);
    assertRawPending(restored.records[0], 'unconfigured');
    assert.deepEqual(clone(restored.records[0].embeddingWork), clone(record.embeddingWork));
    assert.equal(h.networkCalls.length, 0);
  });
});

test('copy-on-write commits use distinct candidate keys across isolated runtimes with equal clocks and Math.random', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const second = await createFlashback(PROGRAM, { pluginStorage: h.pluginStorage, safeLocalStorage: h.safeLocalStorage });
    const RealDate = Date;
    try {
      for (const runtime of [h, second]) {
        runtime.context.Date = class extends RealDate { static now() { return 1777777777777; } };
        runtime.context.Math = Object.assign(Object.create(Math), { random: () => 0.25 });
      }
      const [first] = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
      await h.api._test.saveAllRecords([first], cfg, scope);
      const before = await h.api._test.loadScopeManifest(scope);
      const source = { ...SOURCE, sourceId: 'distinct-source', sourceHash: 'distinct-source-hash', text: SOURCE.text + ' The lamp is lit.' };
      const [next] = await second.api._test.buildRecordsFromSources([source], cfg, scope, { deferEmbedding: true });
      await second.api._test.saveAllRecords([next], cfg, scope);
      const after = await second.api._test.loadScopeManifest(scope);
      assert.notEqual(after.commitId, before.commitId, 'candidate identity cannot collapse merely because clock/random/count match');
      const loaded = await h.api._test.loadScopeRecords(scope.scopeKey);
      assert.equal(loaded.records.length, 1, 'cleanup of old candidate cannot delete the newly active shard');
      assert.equal(loaded.records[0].text, next.text);
    } finally { await second.cleanup(); }
  });
});

test('a repeated strong candidate ID is refused before replacing existing shard bytes', async () => {
  await withRuntime(async (h, scope, cfg) => {
    h.context.crypto = { randomUUID: () => '11111111-1111-4111-8111-111111111111' };
    const [record] = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords([record], cfg, scope);
    const before = new Map([...h.pluginStorage.values].filter(([key]) => key.includes(':records:commit:') || key.endsWith(':manifest:v2')));
    await assert.rejects(() => h.api._test.saveAllRecords([record], cfg, scope), error => error.code === 'FLASHBACK_COMMIT_ID_COLLISION');
    for (const [key, value] of before) assert.equal(h.pluginStorage.values.get(key), value, 'refusal preserves existing candidate bytes');
  });
});

test('an older lost derived vector cannot prevent retaining a newly captured raw turn', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const chat = await h.host.getCurrentChat(), character = await h.host.getCharacter();
    chat.message = [{ role: 'user', chatId: 'old-u1', data: USER }, { role: 'assistant', chatId: 'old-a1', data: REPLY }];
    chat.messages = chat.message;
    const [old] = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope);
    // Explicit retained legacy vector fixture: current adapters no longer create hash vectors.
    delete old.embeddingWork;
    Object.assign(old, { vector: [1, 0, 0], dim: 3, embeddingDimensions: 3, provider: 'hash',
      embeddingProvider: 'hash', model: 'hash-3', embeddingModel: 'hash-3', embeddingProfileId: 'legacy-fixture-profile' });
    old.embeddingProvenance = { schema: 'test.original_embedding_provenance.v1', sourceDigest: 'original-evidence', grouping: 'independent.v1' };
    await h.api._test.saveAllRecords([old], cfg, scope);
    const payloadKeys = [...h.safeLocalStorage.values.keys()].filter(key => key.includes('local-vector-shard'));
    assert(payloadKeys.length > 0);
    for (const key of payloadKeys) h.safeLocalStorage.values.delete(key);
    h.audit.Runtime.localVectorShardCache.clear();
    h.api._test.invalidateRecallShardCache(scope.scopeKey);
    const oldRead = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(oldRead.records[0].vectorPayloadMissing, true, 'the old vector fault is real');
    const nextUser = 'I examine the brass latch.';
    const nextReply = 'The latch is closed and a silver seal rests beside it.';
    await h.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'new-u2', content: nextUser }], 'model');
    chat.message.push({ role: 'user', chatId: 'new-u2', data: nextUser }, { role: 'assistant', chatId: 'new-a2', data: nextReply });
    let result;
    await assert.doesNotReject(async () => { result = await h.api._test.processRisuChatOutputEvent({ char: character, chat,
      characterIndex: 0, chatIndex: 0, messageIndex: 3 }); }, 'an old derived-vector fault must not block new raw durability');
    const loaded = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert(loaded.records.some(record => record.text.includes(nextReply)), `new raw turn must be retained: ${JSON.stringify(result)}`);
    assert(loaded.records.some(record => record.text === old.text), 'valid old source remains preserved');
    const preserved = loaded.records.find(record => record.text === old.text);
    assert.equal(preserved.embeddingWork.status, 'repair_needed');
    assert.equal(preserved.sourceHash, old.sourceHash);
    assert(preserved.embeddingWork.repair.originalMetadata.includes('vectorRef'));
    assert.deepEqual(JSON.parse(preserved.embeddingWork.repair.originalMetadata).embeddingProvenance, clone(old.embeddingProvenance));
    const portable = h.context.__FlashbackPortableMemoryBackup;
    const backup = await portable.exportCurrentScope();
    await portable.restoreCurrentScope(backup);
    const restored = await h.api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(restored.records.find(record => record.text === old.text).embeddingWork.status, 'repair_needed');
    assert.equal(h.networkCalls.length, 0);
  });
});

test('raw-only records do not inflate completed-vector statistics', async () => {
  await withRuntime(async (h, scope, cfg) => {
    const records = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
    assert.equal(records.flashbackEmbeddingStats.totalVectors, 0);
    assert.equal(records.flashbackEmbeddingStats.embeddedVectors, 0);
    assert.equal(records.flashbackEmbeddingStats.attemptedVectors, 0);
  });
});

test('capture diagnostics distinguish durable source from incomplete embedding', async () => {
  await withRuntime(async (h, _scope, cfg) => {
    await h.api.saveSettings({ ...cfg, captureAfterRequest: true });
    await h.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'diagnostic-u1', content: USER }], 'model');
    const chat = await h.host.getCurrentChat(), character = await h.host.getCharacter();
    chat.message = [{ role: 'user', chatId: 'diagnostic-u1', data: USER }, { role: 'assistant', chatId: 'diagnostic-a1', data: REPLY }];
    chat.messages = chat.message;
    await h.api._test.processRisuChatOutputEvent({ char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    assert.equal(h.audit.Runtime.lastImport.embeddingComplete, false);
    assert(h.audit.Runtime.lastImport.embeddingPending > 0);
    assert.equal(h.audit.Runtime.lastCapture.captureVectorMode, 'raw_pending');
  });
});

test('raw-only construction reuses a matching model vector without a new submission', async () => {
  await withRuntime(async (h, scope, base) => {
    let calls = 0;
    h.host.nativeFetch = async (_url, init) => {
      calls++;
      const input = JSON.parse(init.body).input;
      return { ok: true, status: 200, async json() { return { data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } };
    };
    const cfg = h.api._test.normalizeSettings({ ...base, embeddingEnabled: true, embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small', embeddingDimensions: 3, embeddingUrl: 'https://provider.invalid/v1/embeddings',
      embeddingMaxRetries: 0, fallbackHashEmbedding: false });
    const modelRecords = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope);
    assert.equal(calls, 1);
    const reused = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true, reuseRecords: modelRecords });
    assert.deepEqual(clone(reused[0].vector), [1, 0, 0]);
    assert.equal(reused[0].provider, 'openai');
    assert.equal(reused[0].embeddingWork == null, true);
    assert.equal(calls, 1);
    const legacy = { ...modelRecords[0], provider: 'hash', model: 'hash-3', embeddingProvider: 'hash', embeddingModel: 'hash-3' };
    const pending = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true, reuseRecords: [legacy] });
    assertRawPending(pending[0], 'pending');
    assert.equal(calls, 1, 'same vector dimension does not authorize legacy hash reuse as a model result');
  });
});

for (const entry of ['captured', 'progressive', 'all']) {
  test(`legacy ${entry} re-embedding now enters the reserved path and never silently repeats an unknown request`, async () => {
    await withRuntime(async (h, scope, base) => {
      let submitted = 0;
      h.host.nativeFetch = async () => {
        submitted++;
        const current = await h.api._test.loadScopeRecords(scope.scopeKey);
        const row = current.records.find(record => record.sourceHash === SOURCE.sourceHash);
        assert.equal(row.embeddingWork.status, 'running');
        assert.equal(current.manifest.embeddingAttemptRegistry.entries[row.embeddingWork.attempt.id].state, 'submitted');
        throw Error('synthetic_provider_unavailable');
      };
      const cfg = h.api._test.normalizeSettings({ ...base, embeddingEnabled: true, embeddingProvider: 'openai',
        embeddingModel: 'text-embedding-3-small', embeddingUrl: 'https://provider.invalid/v1/embeddings',
        embeddingMaxRetries: 0, fallbackHashEmbedding: false });
      await h.api.saveSettings(cfg);
      const records = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
      await h.api._test.saveAllRecords(records, cfg, scope);
      const action = entry === 'captured' ? () => h.api._test.reembedCapturedTurnRecords(scope, SOURCE.sourceHash, 1, cfg)
        : entry === 'progressive' ? () => h.api.progressivelyReembedRecords(scope, cfg)
          : () => h.api.reembedAllRecords(scope, { settings: cfg });
      const result = await action().catch(error => ({ reason: error.code || error.message }));
      assert.equal(submitted, 1, 'pending work reaches the provider only after the observed durable reservation');
      assert.equal(result.reembedded, 0);
      assert.equal((await h.api._test.loadScopeRecords(scope.scopeKey)).records[0].embeddingWork.status, 'uncertain');
      await action();
      assert.equal(submitted, 1, 'the uncertain attempt still requires explicit recovery');
    });
  });
}

for (const changed of ['work', 'record']) {
  test(`a foreign ${changed} scope cannot pass raw-work validation or be silently rebound`, async () => {
    await withRuntime(async (h, scope, cfg) => {
      const record = await contractFixtureRecord(h, scope, cfg);
      if (changed === 'work') {
        const foreign = await contractFixtureRecord(h, { scopeKey: 'foreign-scope' }, cfg);
        record.embeddingWork = foreign.embeddingWork;
      } else record.scopeKey = 'foreign-scope';
      const audited = await h.api._test.inspectFlashbackVectorPayloadMetadata([record], { scopeKey: scope.scopeKey });
      assert.equal(audited.verified, false, 'pending work must belong to the physical record scope');
      await assert.rejects(() => h.api._test.saveAllRecords([record], cfg, scope), error => error.code === 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID');
    });
  });
}

test('portable chat copy rebinds pending work ownership and preserves the original source', async () => {
  await withRuntime(async (h, scope, cfg) => {
    await h.api.saveSettings({ ...cfg, captureAfterRequest: true });
    await h.api._selectionTest.beforeRequest([{ role: 'user', chatId: 'copy-u1', content: USER }], 'model');
    const chat = await h.host.getCurrentChat(), character = await h.host.getCharacter();
    chat.message = [{ role: 'user', chatId: 'copy-u1', data: USER }, { role: 'assistant', chatId: 'copy-a1', data: REPLY }];
    chat.messages = chat.message;
    await h.api._test.processRisuChatOutputEvent({ char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    const original = clone((await h.api._test.loadScopeRecords(scope.scopeKey)).records[0]);
    const portable = h.context.__FlashbackPortableMemoryBackup;
    const backup = await portable.exportCurrentScope();
    await h.closeNativeCopyObserver();
    const target = { id: 'raw-copy-target', chatId: 'raw-copy-target', name: 'Copy', message: clone(chat.message) };
    target.messages = target.message;
    character.chats.push(target); character.chatPage = 1;
    h.host.getCurrentChatIndex = async () => 1;
    h.host.getCurrentChat = h.host.getChat = async () => target;
    h.host.getChatFromIndex = async (_char, index) => character.chats[index];
    assert.equal((await portable.restoreCurrentScope(backup, { mode: portable.restoreModes.CHAT_COPY })).ok, true);
    const targetScope = await h.api.resolveCurrentScope(false);
    const restored = (await h.api._test.loadScopeRecords(targetScope.scopeKey)).records[0];
    assert.equal(restored.text, original.text);
    assert.equal(restored.sourceHash, original.sourceHash);
    assert.equal(restored.embeddingWork.sourceRevision, original.embeddingWork.sourceRevision);
    assert.equal(restored.embeddingWork.scopeKey, targetScope.scopeKey);
    assert.notEqual(restored.embeddingWork.jobId, original.embeddingWork.jobId);
    const sourceAgain = (await h.api._test.loadScopeRecords(scope.scopeKey)).records[0];
    assert.deepEqual(clone(sourceAgain.embeddingWork), original.embeddingWork);
    assert.equal(h.networkCalls.length, 0);
  }, { manualPortableFixture: true });
});

require('./fixtures/raw_pending_159_observer_control.cjs').registerObserverControls();
require('./fixtures/raw_pending_159_readiness_control.cjs').registerReadinessControl();
