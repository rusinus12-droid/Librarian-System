'use strict';
// Ordinal 672 only: finish the real scoped producer before observing the hook.
// Exactly two committed memories (T1 and T6) bound one public queue invocation.
// This is not a general idle detector or a replacement embedding implementation.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { countCalls } = require('./libra_provider_call_kinds.cjs');
const { durableWitness } = require('./libra_actual_canonical_delivery.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const pending = status => status === 'pending' || status === 'retry_pending';
const memoryIdentity = memory => ({ memoryId: memory.memoryId, revision: memory.revision,
  scopeKey: memory.scopeKey, sourceDigest: memory.sourceDigest,
  artifactDigest: memory.artifactDigest, artifactSchema: memory.artifactSchema,
  status: memory.status, turnRange: memory.turnRange });

// Only preparation permits the four documented derived memory fields to change.
// The separately imported hook witness retains its entire original raw equality.
function canonicalMemory(memory) {
  const value = copy(memory);
  for (const field of ['embedding', 'sections', 'anchors', 'retrieval']) delete value[field];
  return value;
}
function canonicalManifest(manifest) {
  const value = copy(manifest);
  for (const ref of Object.values(value.memories)) {
    for (const field of ['embeddingStatus', 'retrievalVersion', 'vectorCount', 'updatedAt']) delete ref[field];
  }
  return value;
}

function capture(snapshot, expectedMemories) {
  const scopeKey = expectedMemories[0].scopeKey;
  const prefix = `libra:v1:scope:${scopeKey}:`;
  const expected = new Map(expectedMemories.map(memory => [
    prefix + `memory:${memory.turnRange.start}:r${memory.revision}`, memory
  ]));
  const rows = durableWitness(snapshot).rows;
  const manifests = [], memories = [], heads = [], transactions = [];
  const pendingIds = new Set();
  const protectedRows = [];
  for (const row of rows) {
    assert.ok(row.key.startsWith(prefix), '672 preparation: no unexpected durable scope');
    if (row.key.includes(':unified-vector-tx:')) {
      const tx = row.value, memory = expected.get(tx?.memoryKey);
      assert.ok(memory, '672 preparation: transaction belongs to an exact initial memory');
      assert.equal(tx.schema, 'libra.unified_server_vector_tx.v1');
      assert.equal(tx.scopeKey, scopeKey);
      assert.equal(tx.artifactDigest, memory.artifactDigest);
      transactions.push(row);
      continue;
    }
    if (row.key.endsWith(':manifest')) {
      const manifest = row.value;
      assert.equal(manifest?.scopeKey, scopeKey, '672 preparation: manifest scope');
      assert.equal(manifest.characterId, snapshot.f.character.id);
      assert.equal(manifest.chatId, snapshot.f.chat.chatId);
      assert.deepEqual(Object.keys(manifest.memories).sort(), ['1', '6'],
        '672 preparation: exact two-memory fixture, never a global until-idle loop');
      for (const ref of Object.values(manifest.memories)) {
        const memory = expected.get(ref.key);
        assert.ok(memory, '672 preparation: no new canonical ref identity');
        const identity = { ...memoryIdentity(memory) }; delete identity.scopeKey;
        const actual = Object.fromEntries(Object.keys(identity).map(field => [field, ref[field]]));
        assert.equal(hash(actual), hash(identity), '672 preparation: canonical ref identity is pinned');
        assert.ok(pending(ref.embeddingStatus) || ref.embeddingStatus === 'disabled',
          '672 preparation: expected missing-key fixture ref status');
        if (pending(ref.embeddingStatus)) pendingIds.add(ref.memoryId);
      }
      manifests.push(row);
      protectedRows.push({ owner: row.owner, key: row.key, canonical: hash(canonicalManifest(manifest)) });
      continue;
    }
    if (/:memory:\d+:r\d+$/.test(row.key)) {
      const expectedMemory = expected.get(row.key), memory = row.value;
      assert.ok(expectedMemory, '672 preparation: no new canonical memory identity');
      assert.equal(hash(memoryIdentity(memory)), hash(memoryIdentity(expectedMemory)),
        '672 preparation: canonical memory identity is pinned');
      assert.equal(hash(canonicalMemory(memory)), hash(canonicalMemory(expectedMemory)),
        '672 preparation: canonical artifact and non-derived memory bytes are pinned');
      assert.ok(pending(memory.embedding?.status) || memory.embedding?.status === 'disabled',
        '672 preparation: expected missing-key fixture memory status');
      if (pending(memory.embedding?.status)) pendingIds.add(memory.memoryId);
      memories.push(row);
      protectedRows.push({ owner: row.owner, key: row.key, canonical: hash(canonicalMemory(memory)),
        artifact: hash(memory.canonicalArtifact) });
      continue;
    }
    if (row.key.endsWith(':continuity-state')) {
      assert.equal(row.value?.scopeKey, scopeKey);
      assert.equal(row.value?.status, 'ready', '672 preparation: restored Head is ready');
      assert.equal(row.value?.throughTurn, 10, '672 preparation: restored Head is through T10');
      const projection = snapshot.f.r.api.getUnifiedStateReadProjection(row.value);
      assert.equal(projection?.status, 'ready');
      assert.equal(projection?.throughTurn, 10);
      heads.push({ owner: row.owner, key: row.key, projection: hash(projection) });
    }
    // Head, registry, canonical transactions and all other witnessed authority
    // retain exact owner/key/raw/physical revision equality even in preparation.
    const { value, ...rawRow } = row;
    protectedRows.push(rawRow);
  }
  assert.equal(manifests.filter(row => row.owner === 'server').length, 1,
    '672 preparation: authoritative server manifest exists');
  assert.equal(heads.filter(row => row.owner === 'server').length, 1,
    '672 preparation: authoritative server Head exists');
  for (const key of expected.keys()) {
    assert.equal(memories.filter(row => row.owner === 'server' && row.key === key).length, 1,
      '672 preparation: each exact initial memory is durable on the server');
  }
  for (const manifest of manifests) {
    for (const key of expected.keys()) assert.equal(memories.filter(row => row.owner === manifest.owner && row.key === key).length, 1,
      '672 preparation: each observed manifest resolves in its own physical owner');
  }
  return { manifests, memories, transactions, pendingIds: [...pendingIds].sort(),
    authority: hash(protectedRows), currentness: hash(heads),
    source: hash({ chat: snapshot.f.chat, characterId: snapshot.f.character.id,
      characterAlias: snapshot.f.character.chaId, chatPage: snapshot.f.character.chatPage }) };
}

const externalRequests = snapshot => {
  assert.ok(Array.isArray(snapshot.requests), '672 preparation: fixture records actual native requests');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(snapshot.url), '672 preparation: synthetic local server only');
  return snapshot.requests.filter(request => !String(request.url).startsWith(snapshot.url + '/'));
};

async function prepare672DerivedQueue(snapshot, { expectedMemories }) {
  assert.equal(expectedMemories?.length, 2, '672 preparation: exactly two initial fixture memories');
  assert.deepEqual(expectedMemories.map(memory => memory.turnRange?.start).sort((a, b) => a - b), [1, 6]);
  for (const memory of expectedMemories) {
    assert.ok(memory.memoryId && memory.scopeKey && memory.sourceDigest && memory.artifactDigest);
    assert.equal(memory.scopeKey, expectedMemories[0].scopeKey);
    assert.equal(memory.status, 'committed');
    assert.equal(memory.artifactSchema, 'libra.canonical_artifact.v5');
    assert.ok(memory.canonicalArtifact, '672 preparation: canonical artifact exists');
  }
  assert.equal(new Set(expectedMemories.map(memory => memory.memoryId)).size, 2);
  const api = snapshot.f.r.api;
  for (const name of ['retryPendingUnifiedVectors', 'getEmbeddingSettings', 'getUnifiedStateReadProjection']) {
    assert.equal(typeof api[name], 'function', `672 preparation: existing public ${name} is available`);
  }
  // Capture before the first await. Any timer winning that await is still inside
  // this preparation interval and must preserve the same canonical authority.
  const providerBefore = countCalls(snapshot.f.control);
  const externalBefore = hash(externalRequests(snapshot));
  const before = capture(snapshot, expectedMemories);
  const settingsBefore = copy(await api.getEmbeddingSettings());
  assert.equal(settingsBefore.enabled, true, '672 preparation: unchanged enabled embedding default');
  assert.equal(settingsBefore.key, '', '672 preparation: synthetic embedding configuration has no key');

  // A flush selects at most two refs. The exact-two-memory precondition above
  // makes ONE real invocation sufficient. Never retry failure or wait until green.
  const result = await api.retryPendingUnifiedVectors();
  const settingsAfter = copy(await api.getEmbeddingSettings());
  const after = capture(snapshot, expectedMemories);
  assert.equal(result?.ok, true, '672 preparation: actual queue result must succeed');
  assert.notEqual(result.staleDiscarded, true, '672 preparation: stale queue result is rejected');
  assert.ok(!result.reason && !result.error, '672 preparation: failed/stale queue reason is rejected');
  assert.ok(Number.isInteger(result.attempted) && result.attempted >= 0 && result.attempted <= 2,
    '672 preparation: attempted count is bounded by exact fixture identities');
  assert.equal(result.completed, result.attempted, '672 preparation: every attempted ref completed');
  assert.ok(Array.isArray(result.results));
  assert.equal(result.results.length, result.attempted);
  const returnedIds = new Set();
  for (const row of result.results) {
    assert.ok(before.pendingIds.includes(row.memoryId), '672 preparation: returned identity was initially pending');
    assert.ok(!returnedIds.has(row.memoryId), '672 preparation: queue returns no duplicate identity');
    returnedIds.add(row.memoryId);
    assert.equal(row.status, 'disabled', '672 preparation: missing-key result is disabled');
    assert.equal(row.diagnostic == null, true, '672 preparation: no failed/stale result diagnostic');
  }
  assert.equal(after.source, before.source, '672 preparation: source and chat identity remain unchanged');
  assert.equal(after.authority, before.authority, '672 preparation: canonical/manifest/Head authority remains unchanged');
  assert.equal(after.currentness, before.currentness, '672 preparation: structured Head currentness remains unchanged');
  assert.equal(hash(settingsAfter), hash(settingsBefore), '672 preparation: embedding configuration remains unchanged');
  assert.deepEqual(countCalls(snapshot.f.control), providerBefore,
    '672 preparation: no canonical, Micro, other, or total provider calls');
  assert.equal(hash(externalRequests(snapshot)), externalBefore,
    '672 preparation: no embedding or other external provider requests');
  assert.equal(after.pendingIds.length, 0, '672 preparation: no pending/retry_pending memory or ref remains');
  assert.equal(after.transactions.length, 0, '672 preparation: no vector transaction remains, including orphan transactions');
  if (before.pendingIds.length) assert.ok(after.pendingIds.length < before.pendingIds.length,
    '672 preparation: strict durable progress for the finite initial pending set');
  for (const { value: memory } of after.memories) {
    assert.equal(memory.embedding.status, 'disabled');
    assert.equal(memory.embedding.reason, 'API Key', '672 preparation: exact missing-key reason');
    assert.equal(memory.embedding.vectorCount, 0, '672 preparation: no synthetic vectors');
  }
  for (const { value: manifest } of after.manifests) {
    for (const ref of Object.values(manifest.memories)) {
      assert.equal(ref.embeddingStatus, 'disabled');
      assert.equal(ref.vectorCount, 0);
    }
  }
  // Any zero-delay timer queued later now sees zero eligible refs. No canonical
  // work is started between this return and the untouched consumer hook witness.
  return { queueInvocations: 1, attempted: result.attempted, completed: result.completed,
    initialMemoryCount: 2, pendingBefore: before.pendingIds.length,
    pendingAfter: after.pendingIds.length, transactionsAfter: after.transactions.length,
    canonicalAuthoritySha256: after.authority, headCurrentnessSha256: after.currentness,
    sourceSha256: after.source, providerCallsAdded: 0, externalRequestsAdded: 0 };
}

module.exports = { prepare672DerivedQueue };
