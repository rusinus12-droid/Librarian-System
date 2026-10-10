'use strict';
// P01 — LIBRA embedding commit failure must not be reported as success.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §3 P01
// ("LIBRA Embedding commit 실패가 성공처럼 보일 수 있음"). Its required regression:
//
//   forced commit failure / completed 증가 0 / retry_pending /
//   retry 후 정상 / canonical preserved / mirror·server_only 동일
//
// MEASURED DEFECT (probe, before any fix):
//
// The unified retry writes the MEMORY ROW first and the MANIFEST second. When the commit
// fails after the row write, durable storage DIVERGES:
//
//     memory row   -> embedding.status 'ready'      (the vector was written)
//     manifest ref -> embeddingStatus  'pending'    (the ref never learned about it)
//
// `ref.embeddingStatus` SELECTS work for the next flush, while the flush derived completion
// from the RETURNED object's status:
//
//     retryUnifiedEmbedding:      `if(!force && !['pending','retry_pending'].includes(
//                                   memory.embedding?.status))return memory;`
//     flushUnifiedDerivedVectors: `if(!['pending','retry_pending'].includes(
//                                   memory?.embedding?.status))completed++;`
//
// So the flush returned the already-'ready' row unchanged, counted it COMPLETED, and
// reported ok — while the durable ref still said 'pending' and nothing had been committed.
// Because the ref was never repaired it stayed selected forever: an unbounded no-progress
// retry loop that reported success on every pass. Probe:
//
//     reported_completed: 1, reported_ok: true, reported_status: "ready",
//     durable_manifestRefStatus: "pending", newVectorCommitted: false
//
// THE INVARIANT THIS TEST ASSERTS: the flush's report must MATCH DURABLE STATE.
//
//   * if the durable ref still requires a commit, the flush may not report it settled,
//   * `completed` must equal the number of refs that are durably settled,
//   * `ok:true` requires every attempted ref to be durably settled.
//
// Two legitimate outcomes satisfy this, and both are accepted:
//
//   (a) the ref is repaired from the embedded row and published (when the publish succeeds
//       the durable ref really is settled, so reporting it settled is truthful);
//   (b) the ref stays outstanding and is reported retryable (when the publish fails).
//
// The pre-fix code satisfied neither: it reported (a) while leaving the durable state at (b).
//
// The divergent state is injected rather than raced: the probe showed it arises from a real
// interrupted commit, and injecting it keeps this test deterministic.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const DIMENSIONS = 256;
const EMBED_CONFIG = {
  enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
  model: 'text-embedding-3-small', key: 'synthetic-not-a-real-key',
  dimensions: DIMENSIONS, maxRetries: 0
};
const RETRYABLE = new Set(['pending', 'retry_pending']);
const isRetryable = status => RETRYABLE.has(String(status || ''));

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

const localEntry = (snapshot, re) => {
  const key = [...snapshot.local.keys()].find(k => re.test(k));
  return key ? { key, value: parse(snapshot.local.get(key)) } : null;
};

// Owner records of whichever side owns them for this mode.
const readRef = (snapshot, mode) => (mode === 'plugin_only'
  ? localEntry(snapshot, /:manifest$/)?.value?.memories?.['1']
  : snapshot.getManifest()?.memories?.['1']) || null;
const readMemory = (snapshot, mode) => (mode === 'plugin_only'
  ? localEntry(snapshot, /:memory:1:r1$/)?.value
  : snapshot.getMemory(1)) || null;

// The durable state an interrupted commit leaves behind: the row is embedded, but the
// manifest ref still says the commit is outstanding.
async function injectOutstandingRef(snapshot, mode) {
  if (mode === 'plugin_only') {
    const entry = localEntry(snapshot, /:manifest$/);
    assert.ok(entry, 'plugin_only: local manifest must exist');
    entry.value.memories['1'].embeddingStatus = 'pending';
    await snapshot.backend.setItem(entry.key, JSON.stringify(entry.value));
    return;
  }
  const row = snapshot.storedRows().find(r => r.key.endsWith(':manifest'));
  assert.ok(row, `${mode}: server manifest row must exist`);
  row.value.memories['1'].embeddingStatus = 'pending';
  await snapshot.mutate(row.key, row.value);
}

// Block the MANIFEST commit so this isolates "the commit failed" from "storage is broken";
// every other write still succeeds. Reports whether the block actually intercepted a write,
// so the test can say which modes had the outage genuinely enforced.
//
// MEASURED: the manifest write does NOT travel as a batch in the server modes. `saveManifest`
// publishes through the single-key route — `/v1/kv/set` in server_only, and `/v1/kv/set` AFTER
// the local mirror write in mirror. Watching only `/v1/kv/batch` (what this helper did first)
// therefore intercepted NOTHING in mirror/server_only, blockIntercepted stayed 0, and the
// "outage" those modes were tested under was not an outage at all. Both routes are watched now,
// and the assertions below require interception in every mode.
function blockManifestCommit(snapshot, mode) {
  const backend = snapshot.backend;
  const state = { armed: true, intercepted: 0 };
  if (mode === 'plugin_only') {
    const rawSet = backend.setItem.bind(backend);
    backend.setItem = async (k, v) => {
      if (state.armed && String(k).endsWith(':manifest')) { state.intercepted += 1; throw new Error('P01_FORCED_COMMIT_FAILURE'); }
      return rawSet(k, v);
    };
    state.release = () => { backend.setItem = rawSet; };
  } else {
    const manifestKeysIn = (url, init) => {
      let body = null;
      try { body = init?.body ? JSON.parse(init.body) : null; } catch (_) { return []; }
      if (!body) return [];
      const target = String(url);
      if (target.endsWith('/v1/kv/set') || target.endsWith('/v1/kv/remove')) {
        return String(body.key || '').endsWith(':manifest') ? [body.key] : [];
      }
      if (target.endsWith('/v1/kv/batch')) {
        return (body.mutations || []).map(m => String(m.key)).filter(k => k.endsWith(':manifest'));
      }
      return [];
    };
    snapshot.hooks.beforeServerRequest = (url, init) => {
      if (!state.armed) return;
      const keys = manifestKeysIn(url, init);
      if (keys.length) {
        state.intercepted += keys.length;
        throw new Error('P01_FORCED_COMMIT_FAILURE');
      }
    };
    state.release = () => { snapshot.hooks.beforeServerRequest = null; };
  }
  return state;
}

async function commitFailurePropagation(mode) {
  const snapshot = await serverFixture({ mode });
  const result = { mode };
  try {
    await snapshot.f.r.api.saveEmbeddingSettings(EMBED_CONFIG);
    snapshot.hooks.externalFetch = async (_url, init) => embeddingResponse(init);
    await snapshot.f.run();

    // A healthy commit first, so the later divergence is caused only by the forced failure.
    await snapshot.f.r.api.retryPendingUnifiedVectors();
    result.warm = {
      refStatus: String(readRef(snapshot, mode)?.embeddingStatus || ''),
      rowStatus: String(readMemory(snapshot, mode)?.embedding?.status || '')
    };
    const canonicalBefore = String(readMemory(snapshot, mode)?.artifactDigest || '');
    result.hasCanonical = canonicalBefore.length > 0;

    // Interrupt the commit: the row stays embedded, the ref goes back to outstanding.
    await injectOutstandingRef(snapshot, mode);
    result.diverged = {
      refStatus: String(readRef(snapshot, mode)?.embeddingStatus || ''),
      rowStatus: String(readMemory(snapshot, mode)?.embedding?.status || '')
    };

    // Flush while the manifest commit is blocked. Whether the ref is repaired or left
    // outstanding, the REPORT must reflect the durable outcome.
    const block = blockManifestCommit(snapshot, mode);
    const during = await snapshot.f.r.api.retryPendingUnifiedVectors();
    const durableRef = String(readRef(snapshot, mode)?.embeddingStatus || '');
    result.duringOutage = {
      reportedOk: during?.ok === true,
      reportedCompleted: Number(during?.completed || 0),
      reportedAttempted: Number(during?.attempted || 0),
      reportedStatus: String(during?.results?.[0]?.status || ''),
      reportedDiagnosticOk: during?.results?.[0]?.diagnostic?.ok ?? null,
      durableRefStatus: durableRef,
      durableRowStatus: String(readMemory(snapshot, mode)?.embedding?.status || ''),
      blockIntercepted: block.intercepted
    };

    // Release: the retry must leave the system consistent and settled.
    block.release();
    const recovered = await snapshot.f.r.api.retryPendingUnifiedVectors();
    result.recovered = {
      ok: recovered?.ok === true,
      completed: Number(recovered?.completed || 0),
      attempted: Number(recovered?.attempted || 0),
      refStatus: String(readRef(snapshot, mode)?.embeddingStatus || ''),
      rowStatus: String(readMemory(snapshot, mode)?.embedding?.status || '')
    };
    result.canonicalPreserved = String(readMemory(snapshot, mode)?.artifactDigest || '') === canonicalBefore;
    return result;
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const rows = [];
  for (const mode of MODES) rows.push(await commitFailurePropagation(mode));
  console.log(JSON.stringify({ rows }, null, 1));

  for (const r of rows) {
    // The fixture must reach the state under test, or the test proves nothing.
    assert.equal(r.hasCanonical, true, `${r.mode}: canonical memory must exist`);
    assert.equal(r.warm.rowStatus, 'ready', `${r.mode}: the warm commit must embed the row`);
    assert.equal(r.diverged.refStatus, 'pending',
      `${r.mode}: the interrupted commit must leave the ref outstanding`);
    assert.equal(r.diverged.rowStatus, 'ready',
      `${r.mode}: the interrupted commit must leave the embedded row in place`);

    // The flush must actually have attempted the outstanding ref.
    assert.ok(r.duringOutage.reportedAttempted >= 1,
      `${r.mode}: the flush must attempt the outstanding ref `
      + `(attempted ${r.duringOutage.reportedAttempted})`);

    // INVARIANT 1 — the report may not claim a ref settled while it is durably outstanding.
    // This is the exact line the pre-fix code crossed: it reported 'ready' while the durable
    // manifest ref was still 'pending'.
    if (isRetryable(r.duringOutage.durableRefStatus)) {
      assert.ok(isRetryable(r.duringOutage.reportedStatus),
        `${r.mode}: flush reported '${r.duringOutage.reportedStatus}' while the durable `
        + `manifest ref is still '${r.duringOutage.durableRefStatus}' — a failed commit was `
        + 'reported as a success');
      assert.equal(r.duringOutage.reportedCompleted, 0,
        `${r.mode}: a ref that is still durably outstanding must not be counted as completed`);
      assert.equal(r.duringOutage.reportedOk, false,
        `${r.mode}: the flush must not report ok while a ref remains outstanding`);
      assert.equal(r.duringOutage.reportedDiagnosticOk, false,
        `${r.mode}: the failure diagnostic must be surfaced to the caller`);
    } else {
      // The ref was repaired and published: that report must be truthful, i.e. completion is
      // counted only because the durable ref really did settle.
      assert.equal(r.duringOutage.reportedStatus, r.duringOutage.durableRefStatus,
        `${r.mode}: the reported status must equal the durable ref status`);
      assert.equal(r.duringOutage.reportedCompleted, 1,
        `${r.mode}: a durably settled ref must be counted as completed`);
    }

    // INVARIANT 2 — the canonical memory survives the failure untouched.
    assert.equal(r.canonicalPreserved, true,
      `${r.mode}: a failed vector commit must not alter the canonical memory`);

    // INVARIANT 3 — after the commit is possible again, no retryable ref may remain, so the
    // retry loop terminates instead of reporting success forever without progress.
    assert.equal(r.recovered.refStatus, 'ready',
      `${r.mode}: the ref must be settled once the commit can succeed `
      + `(got '${r.recovered.refStatus}')`);
    assert.equal(r.recovered.rowStatus, 'ready', `${r.mode}: the row must be ready after recovery`);
    assert.equal(r.recovered.ok, true, `${r.mode}: the recovered flush must report ok`);
  }

  // EVERY mode must have had the outage genuinely enforced. This assertion is why the batch-only
  // watcher was caught: it held for plugin_only and silently did not hold for the server modes.
  for (const r of rows) {
    assert.ok(r.duringOutage.blockIntercepted >= 1,
      `${r.mode}: the forced manifest-write failure must actually fire `
      + `(intercepted ${r.duringOutage.blockIntercepted})`);
  }

  // Each mode must show the strict outcome: a commit that cannot be published leaves the ref
  // outstanding and reports it. The one legitimate exception is a mode whose local mirror
  // already carries the settled ref, in which case the report must match THAT durable state —
  // never a status the durable store does not hold.
  for (const r of rows) {
    if (isRetryable(r.duringOutage.durableRefStatus)) {
      assert.equal(r.duringOutage.reportedCompleted, 0,
        `${r.mode}: an uncommittable commit must report completed 0`);
      assert.equal(r.duringOutage.reportedOk, false,
        `${r.mode}: an uncommittable commit must report ok:false`);
    } else {
      assert.equal(r.duringOutage.reportedStatus, r.duringOutage.durableRefStatus,
        `${r.mode}: the report must equal the durable ref status`);
      assert.equal(r.duringOutage.reportedOk, true,
        `${r.mode}: a durably settled ref may be reported ok`);
    }
  }

  process.stdout.write('libra_embedding_commit_failure_propagation_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
