'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const SOURCE = { sourceType: 'response', sourceId: 'retained-source', sourceHash: 'retained-source-hash', origin: 'live_chat',
  role: 'turn_pair', turnIndex: 1, pairIndex: 1,
  text: 'User:\nWhere is the atlas?\n\n---\n\nAssistant:\nThe worn atlas remains beside a copper lamp on the eastern shelf.' };
const clone = value => JSON.parse(JSON.stringify(value));
const success = init => ({ ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [0, 1, 0] })) }; } });
async function setup({ inline = false } = {}) {
  const h = await createFlashback(PROGRAM, { transformSource: source => source.replace('  globalThis.__FlashbackMemory = publicApi;',
    '  globalThis.__RetainedFixtureStore = saveScopeRecords; globalThis.__RetainedFixtureChecksum = storageShardChecksum;\n  globalThis.__FlashbackMemory = publicApi;') });
  const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai_compat', embeddingModel: 'retained-model-b', embeddingDimensions: 3,
    embeddingUrl: 'https://provider.invalid/v1', embeddingEnabled: true, embeddingAutoProcess: false, embeddingMaxRetries: 0, autoEpisodeIndex: false });
  await h.api.saveSettings(cfg); const scope = await h.api.resolveCurrentScope(false);
  if (inline) h.safeLocalStorage.setItem = async () => false;
  const [draft] = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
  const legacy = { ...draft, vector: [0.123457, 0.765431, 0.654329], dim: 3,
    provider: 'hash', model: 'hash-3', embeddingProvider: 'hash', embeddingModel: 'hash-3',
    embeddingDimensions: 3, embeddingProfileId: 'legacy-hash-profile', embeddingProvenance: { legacyFixture: true } };
  delete legacy.embeddingWork;
  await h.api._test.saveAllRecords([legacy], cfg, scope);
  await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
  const read = async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
  const prepare = options => { assert.equal(typeof h.api.preparePendingEmbeddingMigration, 'function'); return h.api.preparePendingEmbeddingMigration(options); };
  return { h, cfg, scope, read, prepare };
}
const preserved = record => ({ text: record.text, sourceHash: record.sourceHash, sourceId: record.sourceId,
  vector: clone(record.vector), provider: record.provider, model: record.model, embeddingProfileId: record.embeddingProfileId,
  embeddingProvenance: clone(record.embeddingProvenance), embeddingReceipt: record.embeddingReceipt ? clone(record.embeddingReceipt) : null });

for (const inline of [false, true]) test(`preparing ${inline ? 'inline' : 'sidecar'} legacy work retains exact vector values and source through reload`, async () => {
  const x = await setup({ inline }); let second;
  try {
    const before = preserved((await x.read())[0]);
    const result = await x.prepare();
    assert.equal(result.prepared, 1); assert.equal(x.h.networkCalls.length, 0);
    const [pending] = await x.read();
    assert.deepEqual(preserved(pending), before);
    assert.equal(pending.embeddingWork.schema, 'flashback.embedding_retained_work.v1');
    assert.equal(pending.embeddingWork.status, 'pending');
    assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'pending');
    assert.equal(pending.vectorRef, null, 'retained values use a self-contained existing shard representation');
    await x.h.cleanup();
    second = await createFlashback(PROGRAM, { pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    assert.deepEqual(preserved((await second.api._test.loadScopeRecords(x.scope.scopeKey)).records[0]), before);
    assert.equal(second.networkCalls.length, 0);
  } finally { await x.h.cleanup(); if (second) await second.cleanup(); }
});

test('the actual background queue migrates a legacy record only after durable reservation', async () => {
  const x = await setup();
  try {
    const before = preserved((await x.read())[0]); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; const [running] = await x.read();
      assert.deepEqual(preserved(running), before);
      assert.equal(running.embeddingWork.status, 'running');
      const manifest = await x.h.api._test.loadScopeManifest(x.scope.scopeKey);
      assert.equal(manifest.embeddingAttemptRegistry.entries[running.embeddingWork.attempt.id].state, 'submitted');
      return success(init);
    };
    const result = await x.h.api.processPendingEmbeddingQueue();
    assert.equal(result.ready, 1); assert.equal(calls, 1);
    const [ready] = await x.read();
    assert.deepEqual(clone(ready.vector), [0, 1, 0]); assert.equal(ready.text, before.text);
    assert.equal(ready.embeddingReceipt.status, 'ready'); assert.equal(ready.embeddingWork, undefined);
  } finally { await x.h.cleanup(); }
});

test('a definite provider failure preserves retained values and waits for explicit failed retry', async () => {
  const x = await setup();
  try {
    const before = preserved((await x.read())[0]); let calls = 0;
    x.h.host.nativeFetch = async () => { calls++; return { ok: false, status: 400, async text() { return '{"error":"synthetic invalid input"}'; } }; };
    assert.equal((await x.h.api.processPendingEmbeddingQueue()).failed, 1);
    assert.deepEqual(preserved((await x.read())[0]), before);
    assert.equal((await x.read())[0].embeddingWork.status, 'failed');
    await x.h.api.processPendingEmbeddingQueue(); assert.equal(calls, 1);
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.equal((await x.h.api.processPendingEmbeddingQueue({ retryFailed: true, onlyFailed: true })).ready, 1);
    assert.equal(calls, 2);
  } finally { await x.h.cleanup(); }
});

test('a changed retained vector cannot be blessed by rebinding work ownership', async () => {
  const x = await setup();
  try {
    await x.prepare(); const [pending] = await x.read(), tampered = clone(pending);
    tampered.vector[0] += 0.1;
    assert.throws(() => x.h.api._test.rebindRecordForSameChatPersonaRecovery(tampered, x.scope.scopeKey + '|copy'),
      error => error.code === 'FLASHBACK_RETAINED_EMBEDDING_BINDING_INVALID');
    await assert.rejects(() => x.h.api._test.saveAllRecords([tampered], x.cfg, x.scope),
      error => error.code === 'FLASHBACK_RETAINED_EMBEDDING_BINDING_INVALID');
    assert.deepEqual(clone((await x.read())[0].vector), clone(pending.vector));
    assert.equal(x.h.networkCalls.length, 0);
  } finally { await x.h.cleanup(); }
});

for (const budget of ['maxInlineBytes', 'maxInlineShardBytes']) test(`${budget} exhaustion defers migration with original commit unchanged`, async () => {
  const x = await setup();
  try {
    const before = preserved((await x.read())[0]), manifest = await x.h.api._test.loadScopeManifest(x.scope.scopeKey);
    const result = await x.prepare({ [budget]: 1 });
    assert.equal(result.prepared, 0); assert.equal(result.deferred, 1); assert.equal(result.reason, 'migration_deferred');
    assert.equal((await x.h.api._test.loadScopeManifest(x.scope.scopeKey)).commitId, manifest.commitId);
    assert.deepEqual(preserved((await x.read())[0]), before); assert.equal(x.h.networkCalls.length, 0);
  } finally { await x.h.cleanup(); }
});

test('candidate shard write refusal leaves the original committed vector and text readable', async () => {
  const x = await setup(); const original = x.h.pluginStorage.setItem.bind(x.h.pluginStorage);
  try {
    const before = preserved((await x.read())[0]), manifest = await x.h.api._test.loadScopeManifest(x.scope.scopeKey);
    let rejected = 0;
    x.h.pluginStorage.setItem = async (key, value) => {
      if (String(key).includes(':records:commit:')) { rejected++; return false; }
      return original(key, value);
    };
    const result = await x.prepare();
    assert(rejected); assert.equal(result.prepared, 0); assert.equal(result.reason, 'migration_deferred');
    assert.equal((await x.h.api._test.loadScopeManifest(x.scope.scopeKey)).commitId, manifest.commitId);
    assert.deepEqual(preserved((await x.read())[0]), before); assert.equal(x.h.networkCalls.length, 0);
  } finally { x.h.pluginStorage.setItem = original; await x.h.cleanup(); }
});

test('migrating one source does not round an unselected legacy vector', async () => {
  const x = await setup();
  try {
    const [row] = await x.read();
    const other = { ...clone(row), id: 'other-retained-id', hash: 'other-retained-id', sourceId: 'other-source', sourceHash: 'other-hash',
      text: SOURCE.text + ' A second original observation.', turnIndex: 2, pairIndex: 2,
      vector: [Math.fround(0.123456789), Math.fround(0.765432109), Math.fround(0.654321987)] };
    // A valid pre-existing Float32 sidecar need not have been six-decimal rounded.
    await x.h.context.__RetainedFixtureStore(x.scope, [row, other], x.cfg, x.scope, { metadataOnly: true });
    const before = new Map((await x.read()).map(record => [record.sourceHash, preserved(record)]));
    x.h.host.nativeFetch = async (_url, init) => success(init);
    const result = await x.h.api.processPendingEmbeddingQueue({ maxSources: 1, maxRequests: 1 });
    assert.equal(result.ready, 1);
    const after = await x.read(), untouched = after.find(record => !record.embeddingReceipt);
    assert(untouched); assert.deepEqual(preserved(untouched), before.get(untouched.sourceHash));
  } finally { await x.h.cleanup(); }
});

async function selectChat(h, id) {
  const character = await h.host.getCharacter(), chat = { id, chatId: id, name: id, message: [], messages: [] };
  character.chats.push(chat); const index = character.chats.length - 1; character.chatPage = index;
  h.host.getCurrentChatIndex = async () => index; h.host.getChat = h.host.getCurrentChat = async () => chat;
  h.host.getChatFromIndex = async (_char, n) => character.chats[n];
  return h.api.resolveCurrentScope(false);
}
for (const route of ['copy', 'portable']) test(`retained work survives ${route} with exact values and rebound physical ownership`, async () => {
  const x = await setup();
  try {
    await x.prepare(); const [before] = await x.read(), portable = x.h.context.__FlashbackPortableMemoryBackup;
    const backup = route === 'portable' ? await portable.exportCurrentScope() : null;
    const target = await selectChat(x.h, `retained-${route}-target`);
    const result = route === 'copy' ? await x.h.api._test.cloneScopeStorage(x.scope, target, x.cfg)
      : await portable.restoreCurrentScope(backup, { mode: portable.restoreModes.CHAT_MIGRATION });
    assert.equal(result.ok, true);
    const [after] = (await x.h.api._test.loadScopeRecords(target.scopeKey)).records;
    assert.deepEqual(preserved(after), preserved(before));
    assert.equal(after.embeddingWork.retained.digest, before.embeddingWork.retained.digest);
    assert.equal(after.embeddingWork.scopeKey, after.scopeKey); assert.notEqual(after.embeddingWork.jobId, before.embeddingWork.jobId);
    assert.equal(after.embeddingOriginScopeKey, x.scope.scopeKey); assert.equal(x.h.networkCalls.length, 0);
  } finally { await x.h.cleanup(); }
});

test('returning to the retained completed model reuses its vector while preserving another model unknown history', async () => {
  const x = await setup();
  try {
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.equal((await x.h.api.processPendingEmbeddingQueue()).ready, 1);
    const before = preserved((await x.read())[0]);
    const next = { ...x.cfg, embeddingModel: 'retained-model-c' }; await x.h.api.saveSettings(next);
    x.h.host.nativeFetch = async () => { calls++; throw Error('synthetic unknown C outcome'); };
    await x.h.api.processPendingEmbeddingQueue(); assert.equal(calls, 2);
    const unknown = (await x.read())[0].embeddingWork.attempt.id;
    await x.h.api.saveSettings(x.cfg);
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await x.h.api.processPendingEmbeddingQueue();
    assert.equal(calls, 2, 'matching completed model data is reused without submitting it again');
    assert.deepEqual(preserved((await x.read())[0]), before);
    assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'ready');
    assert((await x.h.api._test.loadScopeManifest(x.scope.scopeKey)).embeddingAttemptRegistry.entries[unknown]);
  } finally { await x.h.cleanup(); }
});

test('a model change during retained work keeps original values and refuses stale adoption', async () => {
  const x = await setup();
  try {
    const before = preserved((await x.read())[0]); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; await x.h.api.saveSettings({ ...x.cfg, embeddingModel: 'changed-model' }); return success(init); };
    const result = await x.h.api.processPendingEmbeddingQueue();
    assert.equal(result.ready, 0); assert.equal(calls, 1);
    assert.deepEqual(preserved((await x.read())[0]), before);
    assert.equal((await x.read())[0].embeddingWork.status, 'running');
  } finally { await x.h.cleanup(); }
});

test('returning to a compatible legacy inline model preserves its exact pre-existing vector without a replacement receipt', async () => {
  const x = await setup();
  const localSet = x.h.safeLocalStorage.setItem.bind(x.h.safeLocalStorage);
  try {
    x.h.host.nativeFetch = async (_url, init) => ({ ok: true, status: 200, async json() {
      return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [0.123457, 0.765431, 0.654329] })) };
    } });
    const legacy = await x.h.api._test.buildRecordsFromSources([SOURCE], x.cfg, x.scope);
    assert(legacy.length, 'the actual model producer supplies a valid legacy fixture');
    x.h.safeLocalStorage.setItem = async () => false;
    await x.h.api._test.saveAllRecords(legacy, x.cfg, x.scope);
    x.h.safeLocalStorage.setItem = localSet;
    const before = preserved((await x.read())[0]); assert.equal(before.embeddingReceipt, null);
    await x.h.api.saveSettings({ ...x.cfg, embeddingModel: 'legacy-inline-other-model' });
    await x.prepare();
    await x.h.api.saveSettings(x.cfg);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await x.h.api.processPendingEmbeddingQueue();
    assert.equal(calls, 0); assert.deepEqual(preserved((await x.read())[0]), before);
    assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'ready');
  } finally { await x.h.cleanup(); }
});

test('deferred retained profile migration cannot bypass its budget through the queue worker', async () => {
  const x = await setup();
  try {
    await x.prepare(); const before = clone((await x.read())[0]);
    await x.h.api.saveSettings({ ...x.cfg, embeddingModel: 'deferred-new-profile' });
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.processPendingEmbeddingQueue({ maxInlineBytes: 1 });
    assert.equal(result.ready, 0); assert.equal(calls, 0); assert.equal(result.reason, 'migration_deferred');
    assert.deepEqual(clone((await x.read())[0]), before);
  } finally { await x.h.cleanup(); }
});

test('more than one failed legacy migration batch cannot starve a valid tail', async () => {
  const x = await setup();
  try {
    const [exemplar] = await x.read();
    const records = Array.from({ length: 19 }, (_, index) => ({ ...clone(exemplar), id: `migration-${index}`, hash: `migration-${index}`,
      sourceId: `legacy-source-${index}`, sourceHash: `legacy-hash-${index}`, turnIndex: index + 1, pairIndex: index + 1,
      text: `${SOURCE.text} Original migration marker ${index}.` }));
    await x.h.api._test.saveAllRecords(records, x.cfg, x.scope);
    let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; return String(JSON.parse(init.body).input[0]).endsWith('marker 18.') ? success(init)
        : { ok: false, status: 400, async text() { return '{"error":"synthetic rejected source"}'; } };
    };
    for (let pass = 0; pass < 3; pass++) {
      const before = calls, result = await x.h.api.processPendingEmbeddingQueue({ maxSources: 8, maxRequests: 8 });
      assert(calls - before <= 8); assert.equal(result.physicalRequests, calls - before);
    }
    const after = await x.read();
    assert.equal(after.find(record => record.sourceHash === 'legacy-hash-18').embeddingReceipt.status, 'ready');
    assert.equal(after.filter(record => record.embeddingWork?.status === 'failed').length, 18);
    assert.equal(calls, 19); assert(after.filter(record => record.embeddingWork).every(record => record.vector.length === 3));
  } finally { await x.h.cleanup(); }
});

test('failed-only retry does not prepare unrelated legacy migration', async () => {
  const x = await setup();
  try {
    const [legacy] = await x.read();
    const other = { ...clone(legacy), id: 'failed-other', hash: 'failed-other', sourceId: 'failed-other', sourceHash: 'failed-other' };
    await x.h.api._test.saveAllRecords([other, legacy], x.cfg, x.scope);
    x.h.host.nativeFetch = async () => ({ ok: false, status: 400, async text() { return '{"error":"synthetic rejection"}'; } });
    await x.h.api.processPendingEmbeddingQueue({ maxSources: 1, maxRequests: 1 });
    const before = (await x.read()).find(record => !record.embeddingWork); assert(before);
    x.h.host.nativeFetch = async (_url, init) => success(init);
    assert.equal((await x.h.api.processPendingEmbeddingQueue({ onlyFailed: true, retryFailed: true })).ready, 1);
    const after = (await x.read()).find(record => record.id === before.id);
    assert.deepEqual(preserved(after), preserved(before));
    assert.equal(after.embeddingWork, undefined, 'the unrelated legacy source receives no migration marker');
  } finally { await x.h.cleanup(); }
});

test('the real migration flow retains an unknown earlier profile across B to C to B', async () => {
  const x = await setup();
  try {
    let bCalls = 0, cCalls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      if (JSON.parse(init.body).model === x.cfg.embeddingModel) { bCalls++; throw Error('synthetic unknown B result'); }
      cCalls++; return success(init);
    };
    await x.h.api.processPendingEmbeddingQueue(); const unknown = (await x.read())[0].embeddingWork.attempt.id;
    await x.h.api.saveSettings({ ...x.cfg, embeddingModel: 'known-model-c' });
    assert.equal((await x.h.api.processPendingEmbeddingQueue()).ready, 1);
    const completedC = preserved((await x.read())[0]);
    await x.h.api.saveSettings(x.cfg);
    const result = await x.h.api.processPendingEmbeddingQueue();
    assert.equal(result.ready, 0); assert.equal(result.uncertainSources, 1); assert.equal(bCalls, 1); assert.equal(cCalls, 1);
    assert.deepEqual(preserved((await x.read())[0]), completedC);
    assert((await x.h.api._test.loadScopeManifest(x.scope.scopeKey)).embeddingAttemptRegistry.entries[unknown]);
  } finally { await x.h.cleanup(); }
});

test('loss of a retained derived vector cannot block the next finalized raw capture', async () => {
  const x = await setup();
  try {
    await x.prepare(); const [before] = await x.read();
    const manifest = await x.h.api._test.loadScopeManifest(x.scope.scopeKey);
    const key = [...x.h.pluginStorage.values.keys()].find(key => key.includes(`:records:commit:${manifest.commitId}:shard:`));
    const shard = JSON.parse(await x.h.pluginStorage.getItem(key));
    assert(Array.isArray(shard.records)); shard.records[0].vector = [];
    shard.checksum = x.h.context.__RetainedFixtureChecksum(shard.records);
    await x.h.pluginStorage.setItem(key, JSON.stringify(shard));
    x.h.api._test.invalidateRecallShardCache(x.scope.scopeKey);
    assert.equal((await x.read())[0].vectorPayloadMissing, true, 'fixture proves the derived payload is missing');
    await x.h.api.saveSettings({ ...x.cfg, embeddingEnabled: false });
    const chat = await x.h.host.getCurrentChat(), character = await x.h.host.getCharacter();
    chat.message = [{ role: 'user', chatId: 'old-u', data: 'Where is the atlas?' },
      { role: 'assistant', chatId: 'old-a', data: 'The worn atlas remains beside a copper lamp on the eastern shelf.' }];
    chat.messages = chat.message;
    const nextUser = 'I inspect the copper lamp.', nextReply = 'A small star is engraved under its handle.';
    await x.h.api._test.beforeRequest([{ role: 'user', chatId: 'new-u', content: nextUser }], 'model');
    chat.message.push({ role: 'user', chatId: 'new-u', data: nextUser }, { role: 'assistant', chatId: 'new-a', data: nextReply });
    await x.h.api._test.processRisuChatOutputEvent({ char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: 3 });
    const after = await x.read();
    assert(after.some(record => record.text.includes(nextReply)));
    const original = after.find(record => record.sourceHash === before.sourceHash); assert(original);
    assert.equal(original.text, before.text); assert.equal(original.embeddingWork.status, 'repair_needed');
    const evidence = JSON.parse(original.embeddingWork.repair.originalMetadata);
    assert.deepEqual(evidence.embeddingWork, clone(before.embeddingWork));
    assert.deepEqual(evidence.embeddingProvenance, clone(before.embeddingProvenance));
    assert.equal(x.h.networkCalls.length, 0);
  } finally { await x.h.cleanup(); }
});
