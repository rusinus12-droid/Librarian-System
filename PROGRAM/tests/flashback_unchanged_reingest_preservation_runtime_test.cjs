'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const USER = 'Where is the observatory ledger?';
const REPLY = 'The observatory ledger is inside the oak drawer beneath a folded silver map.';
const VECTOR = [Math.fround(0.123456789), Math.fround(0.765432109), Math.fround(-0.333333333)];
const canonicalFields = ['scopeKey', 'sourceType', 'sourceId', 'sourceHash', 'text', 'sourceMessageIds', 'turnIndex', 'pairIndex', 'chunkIndex', 'chunkCount'];
const canonical = record => clone(Object.fromEntries(canonicalFields.map(key => [key, record[key] ?? null]).concat([['sourceRawDigest', record.metadata?.sourceRawDigest ?? null]])));
async function setup(options = {}) {
  const h = await createFlashback(PROGRAM, { ...options, transformSource: source =>
    (process.env.FLASHBACK_REINGEST_PRODUCT_FILE ? fs.readFileSync(process.env.FLASHBACK_REINGEST_PRODUCT_FILE, 'utf8') : source)
      .replace('  globalThis.__FlashbackMemory = publicApi;',
    '  globalThis.__reingestStore = { ingest: (...args) => ingestSources(...args), upsert: (...args) => upsertRecords(...args), save: (...args) => saveScopeRecords(...args), checksum: storageShardChecksum, keys: scopeKeys };\n  globalThis.__FlashbackMemory = publicApi;') });
  const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai_compat', embeddingModel: 'reingest-model', embeddingDimensions: 3,
    embeddingUrl: 'https://provider.invalid/v1', embeddingEnabled: true, embeddingAutoProcess: false, embeddingMaxRetries: 0,
    autoColdStart: false, autoEpisodeIndex: false, episodeIndexEnabled: false });
  await h.api.saveSettings(cfg);
  const chat = await h.host.getCurrentChat(), character = await h.host.getCharacter();
  chat.message = [{ role: 'user', chatId: 'raw-maintenance-u', data: USER }, { role: 'assistant', chatId: 'raw-maintenance-a', data: REPLY }];
  chat.messages = chat.message;
  const scope = await h.api.resolveCurrentScope(false);
  const sources = h.api._test.collectLiveChatSourcesFromSnapshot({ character, chat, characterIndex: 0, chatIndex: 0 });
  assert.equal(sources.length, 1);
  const read = async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
  const call = entry => entry === 'ingest'
    ? h.context.__reingestStore.ingest(sources, cfg, scope, { deferEmbedding: true })
    : entry === 'coldstart'
      ? h.api.ingestLiveChatColdStart({ scope: 'current', settings: cfg, historyLimit: 0, incremental: false, deferEmbedding: true })
      : h.api.rebuildCurrentChatMemory({ settings: cfg, deferEmbedding: true });
  return { h, cfg, chat, character, scope, sources, read, call };
}
async function seedLegacy(x) {
  const [draft] = await x.h.api._test.buildRecordsFromSources(x.sources, x.cfg, x.scope, { deferEmbedding: true });
  const old = { ...draft, vector: VECTOR, dim: 3, embeddingDimensions: 3, provider: 'hash', model: 'hash-3',
    embeddingProvider: 'hash', embeddingModel: 'hash-3', embeddingProfileId: 'original-legacy-marker',
    embeddingProvenance: { marker: 'original-precise-float32-sidecar' } };
  delete old.embeddingWork;
  await x.h.api._test.saveAllRecords([old], x.cfg, x.scope);
  await x.h.api._test.retireExternalRecordsForScope(x.scope.scopeKey);
  const [stored] = await x.read();
  await x.h.context.__reingestStore.save(x.scope, [{ ...stored, vector: VECTOR }], x.cfg, x.scope, { metadataOnly: true });
  const [before] = await x.read();
  assert.deepEqual(clone(before.vector), VECTOR);
  assert.equal(before.provider, 'hash');
  assert.equal(before.model, 'hash-3');
  assert(before.vectorRef?.storageKey, 'fixture starts with a physically persisted sidecar');
  return before;
}
async function physical(x) {
  const keys = x.h.context.__reingestStore.keys;
  const manifestKey = keys.manifest(x.scope.scopeKey);
  const manifestRaw = await x.h.pluginStorage.getItem(manifestKey);
  assert.equal(typeof manifestRaw, 'string');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.scopeKey, x.scope.scopeKey);
  assert.notEqual(manifest.rawPageLayout, 'flashback.raw_pages.v1', 'fixture has an actual one-page full-writer head');
  const records = [], rawOwners = [];
  for (let index = 0; index < manifest.shardCount; index++) {
    const key = keys.commitShard(x.scope.scopeKey, manifest.commitId, index);
    const raw = await x.h.pluginStorage.getItem(key);
    assert.equal(typeof raw, 'string');
    const payload = JSON.parse(raw);
    assert.equal(payload.scopeKey, x.scope.scopeKey);
    records.push(...payload.records);
    rawOwners.push({ key, raw, bytes: Buffer.byteLength(raw), sha256: sha(raw) });
  }
  assert.equal(records.length, manifest.count);
  const decoded = [], vectorOwners = [];
  for (const record of records) {
    let vector = clone(record.vector || []);
    if (record.vectorRef?.storageKey) {
      const key = record.vectorRef.storageKey, raw = await x.h.safeLocalStorage.getItem(key);
      assert(raw !== null && raw !== undefined, 'actual referenced Float32 owner is available');
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      assert(payload && typeof payload === 'object', 'actual vector owner has the persisted object shape');
      const member = payload.items.find(item => item.recordId === record.id);
      assert(member, 'actual vector owner contains the referenced record');
      const bytes = Buffer.from(payload.data, 'base64');
      vector = Array.from({ length: member.length }, (_, i) => bytes.readFloatLE((member.offset + i) * 4));
      vectorOwners.push({ key, raw, valueType: typeof raw, serializedBytes: Buffer.byteLength(typeof raw === 'string' ? raw : JSON.stringify(raw)), serializedSha256: sha(raw), vector });
    }
    decoded.push({ id: record.id, canonical: canonical(record), canonicalSha256: sha(canonical(record)), vector,
      provider: record.provider, model: record.model, embeddingProfileId: record.embeddingProfileId,
      embeddingOriginScopeKey: record.embeddingOriginScopeKey || record.embeddingWork?.originScopeKey || record.scopeKey,
      embeddingWork: record.embeddingWork || null, vectorRef: record.vectorRef || null });
  }
  const worldlineRaw = await x.h.pluginStorage.getItem(keys.worldline(x.scope.scopeKey));
  const allVectorOwners = [];
  for (const key of (await x.h.safeLocalStorage.keys()).filter(key => key.includes('local-vector-shard')).sort()) {
    const raw = await x.h.safeLocalStorage.getItem(key);
    allVectorOwners.push({ key, raw, sha256: sha(raw) });
  }
  return { manifestKey, manifestRaw, manifestSha256: sha(manifestRaw), manifest, rawOwners, vectorOwners, allVectorOwners, worldlineRaw, decoded };
}
function persist(name, value) {
  const dir = process.env.FLASHBACK_REINGEST_EVIDENCE;
  assert(dir, 'external evidence directory supplied');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.json');
  assert(!fs.existsSync(file), 'evidence is never overwritten');
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
async function exercise(entry, uncertain = false) {
  const x = await setup(); let fresh;
  try {
    const initial = await seedLegacy(x), seed = await physical(x);
    assert.deepEqual(seed.decoded[0].vector, VECTOR);
    assert.deepEqual(seed.decoded[0].canonical, canonical(initial));
    let initialMockRequests = 0;
    if (uncertain) {
      x.h.host.nativeFetch = async () => { initialMockRequests++; throw Error('synthetic lost acknowledgement'); };
      await x.h.api.preparePendingEmbeddingMigration();
      const prepared = await physical(x);
      assert.deepEqual(prepared.decoded[0].vector, VECTOR);
      await x.h.api.processPendingEmbeddingQueue();
      assert.equal(initialMockRequests, 1);
      assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
    }
    const before = await physical(x), hostBefore = JSON.stringify(x.chat.message);
    assert.deepEqual(before.decoded[0].vector, VECTOR);
    const oldAttemptId = before.decoded[0].embeddingWork?.attempt?.id || null;
    if (uncertain) assert(oldAttemptId, 'unknown history is created by the actual public queue');
    let newMockRequests = 0;
    x.h.host.nativeFetch = async () => { newMockRequests++; throw Error('unexpected automatic mock submission'); };
    let result, operationError;
    try { result = await x.call(entry); } catch (error) { operationError = { code: error.code, message: error.message }; }
    const after = await physical(x), [runtimeAfter] = await x.read();
    await x.h.cleanup();
    fresh = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    const freshPhysical = await physical(fresh), [freshRecord] = await fresh.read();
    const inspection = await fresh.h.api.inspectEmbeddingWork();
    const issues = [];
    if (JSON.stringify(after.decoded[0].vector) !== JSON.stringify(VECTOR)) issues.push('active physical vector replaced before any successful replacement');
    if (JSON.stringify(runtimeAfter.vector) !== JSON.stringify(VECTOR)) issues.push('actual runtime reader loses original vector');
    if (JSON.stringify(freshRecord.vector) !== JSON.stringify(VECTOR)) issues.push('fresh runtime reader loses original vector');
    if (after.decoded[0].model !== before.decoded[0].model) issues.push('original model provenance replaced');
    if (after.decoded[0].embeddingOriginScopeKey !== before.decoded[0].embeddingOriginScopeKey) issues.push('logical source origin changed');
    if (uncertain && after.decoded[0].embeddingWork?.attempt?.id !== oldAttemptId) issues.push('original unknown attempt marker replaced');
    if (uncertain && JSON.stringify(after.manifest.embeddingAttemptRegistry.entries[oldAttemptId]) !== JSON.stringify(before.manifest.embeddingAttemptRegistry.entries[oldAttemptId])) issues.push('original unknown registry entry changed');
    // Preconditions are strict and independent of the preservation assertion.
    assert.deepEqual(after.decoded[0].canonical, before.decoded[0].canonical, 'raw body/hash/canonical scope remain exactly equal');
    assert.deepEqual(freshPhysical.decoded[0].canonical, before.decoded[0].canonical);
    assert.equal(JSON.stringify(x.chat.message), hostBefore);
    assert.equal(JSON.stringify(fresh.chat.message), hostBefore);
    assert.equal(newMockRequests, 0, 'raw-only entry cannot submit or bypass unknown history');
    persist(`${entry}-${uncertain ? 'uncertain' : 'legacy'}`, { entry, uncertain, initialMockRequests, newMockRequests,
      actualModelCalls: 0, actualEmbeddingCalls: 0, seed, before, after, freshPhysical, inspection, oldAttemptId, result,
      hostBeforeSha256: sha(hostBefore), hostAfterSha256: sha(JSON.stringify(x.chat.message)), operationError, issues });
    if (!uncertain && entry !== 'rebuild') {
      assert.equal(operationError?.code, 'FLASHBACK_RAW_EMBEDDING_BINDING_INVALID', 'existing legacy-only binding refusal remains a separate boundary');
      if (entry === 'ingest') {
        assert.equal(after.manifestRaw, before.manifestRaw);
        assert.deepEqual(after.rawOwners, before.rawOwners);
        assert.deepEqual(after.allVectorOwners, before.allVectorOwners);
      } else {
        // Coldstart first publishes the real worldline binding. Its full writer
        // can replace the active commit before the separate legacy refusal.
        const worldline = JSON.parse(after.worldlineRaw);
        assert.equal(worldline.scopeKey, x.scope.scopeKey);
        assert.equal(worldline.nodes.length, 1); assert.equal(worldline.nodes[0].status, 'active');
        assert.deepEqual(worldline.retiredRecords, []);
        assert.equal(after.manifest.count, before.manifest.count);
        assert.equal(after.decoded[0].id, before.decoded[0].id);
        assert.equal(after.decoded[0].provider, before.decoded[0].provider);
        assert.equal(after.decoded[0].embeddingProfileId, before.decoded[0].embeddingProfileId);
        assert.equal(after.decoded[0].embeddingWork, before.decoded[0].embeddingWork);
      }
    } else assert.equal(operationError, undefined, 'admitted retained work republishes without inventing a new attempt');
    assert.deepEqual(issues, [], 'all original vector/provenance/origin/attempt obligations survive unchanged-source raw publication');
  } finally { await x.h.cleanup(); if (fresh) await fresh.h.cleanup(); }
}
test('known unchanged-source rebuild control retains exact legacy vector through raw-only publication', () => exercise('rebuild'));
for (const entry of ['ingest', 'coldstart']) {
  if (entry === 'ingest') test(`${entry} legacy-only refusal preserves exact active source and vector and remains outside the retained-work fix`, () => exercise(entry));
  test(`${entry} unchanged-source raw-only publication preserves public-queue unknown attempt and retained vector`, () => exercise(entry, true));
}
async function unknown(x) {
  await seedLegacy(x);
  await x.h.api.preparePendingEmbeddingMigration();
  let calls = 0;
  x.h.host.nativeFetch = async () => { calls++; throw Error('synthetic unknown acknowledgement'); };
  await x.h.api.processPendingEmbeddingQueue();
  assert.equal(calls, 1);
  assert.equal((await x.h.api.inspectEmbeddingWork()).jobs[0].status, 'uncertain');
  const before = await physical(x);
  assert.deepEqual(before.decoded[0].vector, VECTOR);
  return before;
}
for (const entry of ['ingest', 'coldstart']) test(`${entry} keeps publicly prepared pending retained work without inventing a submission`, async () => {
  const x = await setup(); let fresh;
  try {
    await seedLegacy(x); await x.h.api.preparePendingEmbeddingMigration();
    const before = await physical(x);
    assert.equal(before.decoded[0].embeddingWork.schema, 'flashback.embedding_retained_work.v1');
    assert.equal(before.decoded[0].embeddingWork.status, 'pending');
    assert.equal(before.decoded[0].embeddingWork.attempt, undefined);
    let calls = 0; x.h.host.nativeFetch = async () => { calls++; throw Error('unexpected pending submission'); };
    await x.call(entry);
    const after = await physical(x);
    await x.h.cleanup();
    fresh = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    const freshPhysical = await physical(fresh);
    persist(`${entry}-pending`, { before, after, freshPhysical, mockRequests: calls, actualModelCalls: 0, actualEmbeddingCalls: 0 });
    assert.deepEqual(after.decoded[0].canonical, before.decoded[0].canonical);
    assert.deepEqual(after.decoded[0].vector, VECTOR);
    assert.deepEqual(after.decoded[0].embeddingWork, before.decoded[0].embeddingWork);
    assert.deepEqual(freshPhysical.decoded[0], after.decoded[0]);
    assert.equal(calls, 0);
  } finally { await x.h.cleanup(); if (fresh) await fresh.h.cleanup(); }
});
for (const [change, field, value] of [
  ['model', 'embeddingModel', 'new-model-contract'],
  ['dimensions', 'embeddingDimensions', 4],
  ['preprocessing', 'embeddingDocumentPrefix', 'Different document prefix: '],
  ['endpoint', 'embeddingUrl', 'https://different-provider.invalid/v1'],
  ['revision', 'embeddingModelRevision', 'new-model-revision']
]) test(`changed ${change} cannot reuse the old target work or certify its retained vector as current`, async () => {
  const x = await setup();
  try {
    const before = await unknown(x), oldWork = before.decoded[0].embeddingWork, oldId = oldWork.attempt.id;
    const changed = x.h.api._test.normalizeSettings({ ...x.cfg, [field]: value });
    await x.h.api.saveSettings(changed); Object.assign(x.cfg, changed);
    let calls = 0; x.h.host.nativeFetch = async () => { calls++; throw Error('unexpected changed-contract request'); };
    await x.call('ingest');
    const after = await physical(x), work = after.decoded[0].embeddingWork;
    assert.deepEqual(after.decoded[0].canonical, before.decoded[0].canonical);
    assert.notEqual(work.targetProfile.profileFingerprint, oldWork.targetProfile.profileFingerprint);
    assert.notEqual(work.jobId, oldWork.jobId);
    assert.equal(work.status, 'pending'); assert.equal(work.attempt, undefined);
    assert.deepEqual(after.decoded[0].vector, [], 'old vector is not adopted into the new contract');
    assert.deepEqual(after.manifest.embeddingAttemptRegistry.entries[oldId], before.manifest.embeddingAttemptRegistry.entries[oldId]);
    assert.equal(calls, 0);
    persist(`changed-${change}`, { change, before, after, mockRequests: calls, actualModelCalls: 0, actualEmbeddingCalls: 0 });
  } finally { await x.h.cleanup(); }
});
test('changed body at the actual raw writer never attaches the prior source vector or attempt to its new canonical source', async () => {
  const x = await setup();
  try {
    const before = await unknown(x), oldId = before.decoded[0].embeddingWork.attempt.id;
    x.chat.message[1].data += ' A new confirmed source marker was added.';
    const sources = x.h.api._test.collectLiveChatSourcesFromSnapshot({ character: x.character, chat: x.chat, characterIndex: 0, chatIndex: 0 });
    const incoming = await x.h.api._test.buildRecordsFromSources(sources, x.cfg, x.scope, { deferEmbedding: true });
    assert.notEqual(incoming[0].sourceHash, before.decoded[0].canonical.sourceHash);
    assert.notEqual(incoming[0].text, before.decoded[0].canonical.text);
    let calls = 0; x.h.host.nativeFetch = async () => { calls++; throw Error('unexpected changed-body request'); };
    await x.h.context.__reingestStore.upsert(incoming, x.cfg, x.scope, { deferEmbedding: true });
    const after = await physical(x), candidate = after.decoded.find(record => record.canonical.sourceHash === incoming[0].sourceHash);
    assert(candidate, 'actual writer publishes the actual new raw source');
    assert.deepEqual(candidate.vector, []); assert.equal(candidate.embeddingWork.status, 'pending');
    assert.equal(candidate.embeddingWork.attempt, undefined);
    assert.deepEqual(after.manifest.embeddingAttemptRegistry.entries[oldId], before.manifest.embeddingAttemptRegistry.entries[oldId]);
    assert.equal(calls, 0);
    persist('changed-body-writer', { boundary: 'Actual upsert writer; this does not authorize outer source-edit consent', before, after, mockRequests: calls, actualModelCalls: 0, actualEmbeddingCalls: 0 });
  } finally { await x.h.cleanup(); }
});
test('a different raw writer scope cannot borrow the current owner retained vector or unresolved attempt', async () => {
  const x = await setup();
  try {
    const before = await unknown(x);
    const target = { ...x.scope, scopeKey: x.scope.scopeKey + '|reingest-scope-negative' };
    const incoming = await x.h.api._test.buildRecordsFromSources(x.sources, x.cfg, target, { deferEmbedding: true });
    let calls = 0; x.h.host.nativeFetch = async () => { calls++; throw Error('unexpected foreign-scope request'); };
    await x.h.context.__reingestStore.upsert(incoming, x.cfg, target, { deferEmbedding: true });
    const after = await physical(x);
    assert.equal(after.manifestRaw, before.manifestRaw);
    assert.deepEqual(after.rawOwners, before.rawOwners);
    const targetRead = await x.h.api._test.loadScopeRecords(target.scopeKey);
    assert.equal(targetRead.records.length, 1);
    assert.equal(targetRead.records[0].scopeKey, target.scopeKey);
    assert.deepEqual(clone(targetRead.records[0].vector), []);
    assert.equal(targetRead.records[0].embeddingWork.status, 'pending');
    assert.equal(targetRead.records[0].embeddingWork.attempt, undefined);
    assert.equal(calls, 0);
    persist('changed-scope-writer', { before, after, target, targetRead, mockRequests: calls, actualModelCalls: 0, actualEmbeddingCalls: 0 });
  } finally { await x.h.cleanup(); }
});
for (const entry of ['ingest', 'coldstart']) test(`${entry} keeps a definite failed retained attempt blocked without automatic retry`, async () => {
  const x = await setup();
  try {
    await seedLegacy(x); await x.h.api.preparePendingEmbeddingMigration();
    let calls = 0;
    x.h.host.nativeFetch = async () => { calls++; return { ok: false, status: 400, async text() { return '{"error":"synthetic invalid input"}'; } }; };
    await x.h.api.processPendingEmbeddingQueue();
    const before = await physical(x);
    assert.equal(before.decoded[0].embeddingWork.status, 'failed'); assert.equal(calls, 1);
    await x.call(entry);
    const after = await physical(x);
    persist(`${entry}-failed`, { before, after, totalMockRequests: calls, newMockRequests: 0, actualModelCalls: 0, actualEmbeddingCalls: 0 });
    assert.deepEqual(after.decoded[0].vector, VECTOR);
    assert.deepEqual(after.decoded[0].embeddingWork, before.decoded[0].embeddingWork);
    await x.h.api.processPendingEmbeddingQueue(); assert.equal(calls, 1);
  } finally { await x.h.cleanup(); }
});
for (const entry of ['ingest', 'coldstart']) test(`${entry} preserves the exact active running attempt during the actual provider await`, async () => {
  const x = await setup();
  try {
    await seedLegacy(x); await x.h.api.preparePendingEmbeddingMigration();
    let calls = 0, observed;
    x.h.host.nativeFetch = async () => {
      calls++;
      const before = await physical(x);
      let operationError;
      try { await x.call(entry); } catch (error) { operationError = { code: error.code, message: error.message }; }
      const after = await physical(x);
      observed = { before, after, operationError };
      return { ok: false, status: 400, async text() { return '{"error":"synthetic settled input failure"}'; } };
    };
    await x.h.api.processPendingEmbeddingQueue();
    assert(observed, 'actual submitted provider boundary was reached'); assert.equal(calls, 1);
    persist(`${entry}-running`, { ...observed, totalMockRequests: calls, actualModelCalls: 0, actualEmbeddingCalls: 0 });
    assert.equal(observed.before.decoded[0].embeddingWork.status, 'running');
    assert.equal(observed.operationError, undefined);
    assert.deepEqual(observed.after.decoded[0].vector, VECTOR);
    assert.deepEqual(observed.after.decoded[0].canonical, observed.before.decoded[0].canonical);
    assert.deepEqual(observed.after.decoded[0].embeddingWork, observed.before.decoded[0].embeddingWork);
    const id = observed.before.decoded[0].embeddingWork.attempt.id;
    assert.deepEqual(observed.after.manifest.embeddingAttemptRegistry.entries[id], observed.before.manifest.embeddingAttemptRegistry.entries[id]);
  } finally { await x.h.cleanup(); }
});
for (const [name, corrupt] of [
  ['retained digest', record => { record.embeddingWork.retained.digest = 'invalid-retained-digest'; }],
  ['missing attempt', record => { delete record.embeddingWork.attempt; }],
  ['attempt source revision', record => { record.embeddingWork.attempt.sourceRevision = 'wrong-source'; }]
]) test(`corrupt ${name} cannot be reused or bypass its existing unresolved registry authority`, async () => {
  const x = await setup(); let fresh;
  try {
    const before = await unknown(x), owner = before.rawOwners[0], payload = JSON.parse(owner.raw);
    corrupt(payload.records[0]); payload.checksum = x.h.context.__reingestStore.checksum(payload.records);
    const corruptedRaw = JSON.stringify(payload);
    await x.h.pluginStorage.setItem(owner.key, corruptedRaw);
    await x.h.cleanup();
    fresh = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    let calls = 0; fresh.h.host.nativeFetch = async () => { calls++; throw Error('unexpected corrupt-work request'); };
    const corruptPhysical = await physical(fresh);
    assert.equal(corruptPhysical.rawOwners[0].raw, corruptedRaw, 'actual fresh reader starts from the corrupted physical owner');
    await fresh.call('ingest');
    const after = await physical(fresh), oldId = before.decoded[0].embeddingWork.attempt.id;
    assert.deepEqual(after.decoded[0].canonical, before.decoded[0].canonical);
    assert.deepEqual(after.decoded[0].vector, [], 'unvalidated retained vector is never reused');
    assert.equal(after.decoded[0].embeddingWork.status, 'pending');
    assert.equal(after.decoded[0].embeddingWork.attempt, undefined);
    assert.deepEqual(after.manifest.embeddingAttemptRegistry.entries[oldId], before.manifest.embeddingAttemptRegistry.entries[oldId]);
    const queueResult = await fresh.h.api.processPendingEmbeddingQueue();
    const settled = await physical(fresh);
    assert.deepEqual(settled.decoded[0].vector, []);
    assert.notEqual(settled.decoded[0].embeddingWork.status, 'ready');
    assert.deepEqual(settled.manifest.embeddingAttemptRegistry.entries[oldId], before.manifest.embeddingAttemptRegistry.entries[oldId]);
    assert.deepEqual(settled.decoded[0].canonical, before.decoded[0].canonical);
    assert.equal(calls, 0);
    persist(`corrupt-${name.replaceAll(' ', '-')}`, { before, corruptPhysical, corruptedRaw, ownerKey: owner.key, after, settled, queueResult,
      retainedReuseRefused: true, mockRequests: calls, actualModelCalls: 0, actualEmbeddingCalls: 0 });
  } finally { await x.h.cleanup(); if (fresh) await fresh.h.cleanup(); }
});
