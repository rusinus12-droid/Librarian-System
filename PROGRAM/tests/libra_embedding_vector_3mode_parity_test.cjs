'use strict';
// Task 28 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
// LIBRA Embedding / vector lifecycle (D6) — storage parity across the three modes.
//
// The repro `libra_unified_server_vector_v1_test.cjs` drives `serverFixture()`, whose
// default mode is `server_only`, so the vector lifecycle was proven for server_only
// only; `plugin_only` and `mirror` were `unverified`. The risk the plan names: if
// vectors stay local in `server_only` or diverge in `mirror`, recall quality silently
// differs per mode.
//
// Measured shape of the lifecycle (all three modes, identical corpus and provider):
//
//   mode          owner vector (local)  server projection  manifest embeddingStatus
//   plugin_only   1                    0                  local: ready, count 4
//   mirror        1                    1                  local+server: ready, count 4
//   server_only   0                    1                  server: ready, count 4
//
// Step 1 asserts the lifecycle: embed, vector readback, canonical preserved, and a
// failed embed that recovers through an explicit failed-only retry without losing or
// regenerating the canonical memory.
// Step 2 asserts the storage rules: server_only keeps NO owner vector locally, and
// mirror's local and server records agree (no divergence).
//
// The local key `libra:v1:local-vector:<hash>` is a DERIVED read-through cache, not an
// owner record, so it is allowed in every mode; only the owner key
// `…:scope:<scope>:vector:<memoryId>:r<rev>:<profile>` counts as a vector row.
//
// The fixture's `getManifest`/`getMemory`/`getRecords` read SERVER rows only, so the
// local-side facts are read from `snapshot.local` (the pluginStorage backend the
// plugin actually writes to in plugin_only).
//
// The embedding provider is a synthetic in-test endpoint (no real key, no network).
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const PROJECTION_SCHEMA = 'libra.embedding_projection.v2';
const DIMENSIONS = 256;
const EMBED_CONFIG = {
  enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
  model: 'text-embedding-3-small', key: 'synthetic-not-a-real-key',
  dimensions: DIMENSIONS, maxRetries: 0
};
const OWNER_VECTOR_KEY = /:scope:[^:]+:vector:/;

const embeddingResponse = init => new Response(JSON.stringify({
  data: JSON.parse(init.body).input.map((_, index) => ({
    index, embedding: Array.from({ length: DIMENSIONS }, (_, k) => (k === 0 ? 1 : 0))
  })),
  usage: { total_tokens: 10 }
}), { status: 200 });

const parse = value => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
};

// The owner records as the plugin stored them LOCALLY (plugin_only's home).
const readLocalOwners = snapshot => {
  const localKeys = [...snapshot.local.keys()];
  const manifestKey = localKeys.find(k => /:manifest$/.test(k));
  const manifest = parse(snapshot.local.get(manifestKey));
  const ref = manifest?.memories?.['1'] || null;
  const memory = ref ? parse(snapshot.local.get(ref.key)) : null;
  return { manifest, ref, memory, ownerVectorRows: localKeys.filter(k => OWNER_VECTOR_KEY.test(k)).length };
};

// The owner records as the SERVER stored them (mirror / server_only's home).
const readServerOwners = snapshot => {
  const manifest = snapshot.getManifest();
  const ref = manifest?.memories?.['1'] || null;
  return { manifest, ref, memory: snapshot.getMemory(1), ownerVectorRows: snapshot.getRecords(PROJECTION_SCHEMA).length };
};

// Whichever side owns the records for this mode.
const readEffective = (snapshot, mode) => (mode === 'plugin_only'
  ? readLocalOwners(snapshot)
  : readServerOwners(snapshot));

async function waitFor(predicate, label, attempts = 1200) {
  for (let i = 0; i < attempts; i += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// Step 1 — the happy lifecycle plus the storage-rule facts.
async function embeddingLifecycle(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    await snapshot.f.r.api.saveEmbeddingSettings(EMBED_CONFIG);
    snapshot.hooks.externalFetch = async (_url, init) => embeddingResponse(init);
    await snapshot.f.run();

    const digestAfterCommit = String(readEffective(snapshot, mode).memory?.artifactDigest || '');

    // The unified vector flush is fire-and-forget after the commit; drive it
    // explicitly (the same call the GUI's "통합 임베딩 후처리 재시도" button makes).
    await snapshot.f.r.api.retryPendingUnifiedVectors();
    await waitFor(() => readEffective(snapshot, mode).memory?.embedding?.status === 'ready',
      `${mode}: embedding ready`);

    const effective = readEffective(snapshot, mode);
    const local = readLocalOwners(snapshot);
    const server = readServerOwners(snapshot);

    // Failed-only retry with nothing pending must be a no-op.
    const idleRetry = await snapshot.f.r.api.retryPendingUnifiedVectors();

    return {
      mode,
      status: String(effective.memory?.embedding?.status || ''),
      dimensions: Number(effective.memory?.embedding?.dimensions || 0),
      canonicalDigest: String(effective.memory?.artifactDigest || ''),
      digestAfterCommit,
      manifestEmbeddingStatus: String(effective.ref?.embeddingStatus || ''),
      manifestVectorCount: Number(effective.ref?.vectorCount || 0),
      localOwnerVectorRows: local.ownerVectorRows,
      localManifestEmbeddingStatus: String(local.ref?.embeddingStatus || ''),
      serverProjectionRows: server.ownerVectorRows,
      serverManifestEmbeddingStatus: String(server.ref?.embeddingStatus || ''),
      serverManifestVectorCount: Number(server.ref?.vectorCount || 0),
      serverEmbeddingStatus: String(server.memory?.embedding?.status || ''),
      serverEmbeddingDimensions: Number(server.memory?.embedding?.dimensions || 0),
      idleRetryCompleted: Number(idleRetry?.completed || 0)
    };
  } finally {
    await snapshot.cleanup();
  }
}

// Step 1 (continued) — a failed embed must not lose or regenerate the canonical, and
// an explicit failed-only retry must recover it.
async function embeddingFailureRecovery(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    await snapshot.f.r.api.saveEmbeddingSettings(EMBED_CONFIG);
    snapshot.hooks.externalFetch = async () => { throw new Error('controlled_embedding_failure'); };
    await snapshot.f.run();
    await snapshot.f.r.api.retryPendingUnifiedVectors();
    await waitFor(() => readEffective(snapshot, mode).memory?.embedding?.status === 'retry_pending',
      `${mode}: embedding retry_pending after provider failure`);

    const failed = readEffective(snapshot, mode);
    const digestOnFailure = String(failed.memory?.artifactDigest || '');

    snapshot.hooks.externalFetch = async (_url, init) => embeddingResponse(init);
    const retry = await snapshot.f.r.api.retryPendingUnifiedVectors();
    await waitFor(() => readEffective(snapshot, mode).memory?.embedding?.status === 'ready',
      `${mode}: embedding recovered`);

    const recovered = readEffective(snapshot, mode);
    return {
      mode,
      statusOnFailure: String(failed.memory?.embedding?.status || ''),
      digestOnFailure,
      statusAfterRetry: String(recovered.memory?.embedding?.status || ''),
      digestAfterRetry: String(recovered.memory?.artifactDigest || ''),
      retryCompleted: Number(retry?.completed || 0)
    };
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const lifecycles = [];
  const recoveries = [];
  for (const mode of MODES) {
    lifecycles.push(await embeddingLifecycle(mode));
    recoveries.push(await embeddingFailureRecovery(mode));
  }
  console.log(JSON.stringify({ lifecycles, recoveries }, null, 1));

  const pluginOnly = lifecycles.find(o => o.mode === 'plugin_only');
  const mirror = lifecycles.find(o => o.mode === 'mirror');
  const serverOnly = lifecycles.find(o => o.mode === 'server_only');

  // Step 1 — embed, readback, canonical preserved, in every mode.
  for (const o of lifecycles) {
    assert.equal(o.status, 'ready', `${o.mode}: embedding must reach 'ready' (got '${o.status}')`);
    assert.equal(o.dimensions, DIMENSIONS,
      `${o.mode}: the stored vector must have ${DIMENSIONS} dimensions (got ${o.dimensions})`);
    assert.equal(o.manifestEmbeddingStatus, 'ready',
      `${o.mode}: the manifest must record embeddingStatus 'ready'`);
    assert.ok(o.canonicalDigest.length > 0, `${o.mode}: the canonical memory must exist`);
    assert.equal(o.canonicalDigest, o.digestAfterCommit,
      `${o.mode}: adding vectors must not change the committed canonical memory`);
    assert.equal(o.idleRetryCompleted, 0,
      `${o.mode}: a failed-only retry with nothing pending must complete 0 vectors (got ${o.idleRetryCompleted})`);
  }

  // Step 1 — failed-only retry recovers without regenerating the canonical.
  for (const r of recoveries) {
    assert.equal(r.statusOnFailure, 'retry_pending',
      `${r.mode}: a failed embed must be recorded as retry_pending (got '${r.statusOnFailure}')`);
    assert.equal(r.statusAfterRetry, 'ready',
      `${r.mode}: the failed-only retry must complete the vector (got '${r.statusAfterRetry}')`);
    assert.ok(r.retryCompleted >= 1,
      `${r.mode}: the retry must report the completed vector (got ${r.retryCompleted})`);
    assert.equal(r.digestAfterRetry, r.digestOnFailure,
      `${r.mode}: recovering a vector must not regenerate the canonical memory`);
  }

  // Step 2a — server_only must leave NO owner vector locally.
  assert.equal(serverOnly.localOwnerVectorRows, 0,
    'server_only must not leave an owner vector row in local storage');

  // Step 2b — mirror must show no divergence between its local and server copies.
  assert.ok(mirror.localOwnerVectorRows >= 1, 'mirror must keep the owner vector row locally');
  assert.ok(mirror.serverProjectionRows >= 1, 'mirror must also commit the projection to the server');
  assert.equal(mirror.status, mirror.serverEmbeddingStatus,
    'mirror: local and server embedding status must agree');
  assert.equal(mirror.dimensions, mirror.serverEmbeddingDimensions,
    'mirror: local and server vector dimensionality must agree');
  assert.equal(mirror.manifestEmbeddingStatus, mirror.serverManifestEmbeddingStatus,
    'mirror: local and server manifest embedding status must agree');
  assert.equal(mirror.manifestVectorCount, mirror.serverManifestVectorCount,
    'mirror: local and server vector count must agree');

  // Storage home per mode.
  assert.ok(pluginOnly.localOwnerVectorRows >= 1, 'plugin_only must hold the owner vector locally');
  assert.equal(pluginOnly.serverProjectionRows, 0, 'plugin_only must not write the projection to the server');
  assert.ok(serverOnly.serverProjectionRows >= 1, 'server_only must hold the projection on the server');

  // Cross-mode: the committed vector metadata must not depend on the storage mode.
  assert.equal(mirror.serverManifestEmbeddingStatus, serverOnly.serverManifestEmbeddingStatus,
    'the committed manifest embedding status must not depend on the storage mode');
  assert.equal(mirror.serverManifestVectorCount, serverOnly.serverManifestVectorCount,
    'the committed vector count must not depend on the storage mode');
  assert.equal(pluginOnly.manifestVectorCount, mirror.serverManifestVectorCount,
    'plugin_only and mirror must commit the same vector count');

  process.stdout.write('libra_embedding_vector_3mode_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
