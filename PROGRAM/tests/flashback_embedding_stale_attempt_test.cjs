'use strict';
// Attempts left in reserved/submitted by a previous runtime keep their records `running`, and the
// queue skips every group that still holds a running record - so those turns could never be retried
// (measured: 8 records pinned by two attempts from 21:02, still stuck at 21:12). Settlement must be
// possible without another provider call.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

(async () => {
  const f = await createFixture({ chat: { id: 'settle-chat', name: 'Settle', message: [] } });
  const results = [];
  try {
    const t = f.api._test;
    const scope = await f.api.resolveCurrentScope();
    const cfg = t.normalizeSettings({ embeddingProvider: 'voyageai', embeddingModel: 'voyage-4-large', embeddingDimensions: 1024, shardSize: 50 });
    const now = Date.now();
    const entry = (id, state, startedAt, runtimeId = 'runtime_previous_session') => ({
      attemptId: id, runtimeId, sourceHash: 'src1', sourceSet: 'ss', startedAt, state,
      jobs: [{ jobId: `job_${id}`, logicalJobId: `logical_${id}`, originScopeKey: scope.scopeKey, sourceRevision: 'rev1',
        targetProfile: { provider: 'voyageai', model: 'voyage-4-large', profileFingerprint: 'fp' } }]
    });

    // 1. Stale attempts from another runtime are selected; a fresh one is not.
    const registry = { entries: {
      attempt_stale_reserved: entry('attempt_stale_reserved', 'reserved', now - 20 * 60 * 1000),
      attempt_stale_submitted: entry('attempt_stale_submitted', 'submitted', now - 11 * 60 * 1000),
      attempt_fresh: entry('attempt_fresh', 'reserved', now - 5000),
      attempt_settled_state: entry('attempt_settled_state', 'committed', now - 60 * 60 * 1000)
    } };
    const stale = t.staleEmbeddingAttemptEntries(registry, { staleMs: 10 * 60 * 1000, runtimeId: 'runtime_current', activeAttemptIds: new Set() });
    assert.equal(stale.map(item => item.attemptId).sort().join(','), 'attempt_stale_reserved,attempt_stale_submitted');
    results.push('only stale, still-open attempts are selected');

    // 2. An attempt this runtime still owns is never settled, however old.
    const owned = t.staleEmbeddingAttemptEntries(
      { entries: { attempt_owned: entry('attempt_owned', 'submitted', now - 60 * 60 * 1000, 'runtime_current') } },
      { staleMs: 10 * 60 * 1000, runtimeId: 'runtime_current', activeAttemptIds: new Set(['attempt_owned']) });
    assert.equal(owned.length, 0, 'an attempt held by this runtime is left alone');
    results.push('an attempt still owned by this runtime is skipped');

    // 3. Record transform: an unverified target returns to pending, keeping its attempt count.
    const boundary = { configured: true, settings: cfg, profile: 'probe-profile' };
    const pendingRecord = { id: 'raw-1', scopeKey: scope.scopeKey, sourceType: 'response', sourceId: 'turn:1', sourceHash: 'src1',
      text: 'a', pairIndex: 1, turnIndex: 1, chunkIndex: 0, chunkCount: 1, vector: [],
      embeddingWork: { schema: 'flashback.embedding_work.v1', status: 'running', scopeKey: scope.scopeKey,
        originScopeKey: scope.scopeKey, sourceRevision: 'rev1',
        targetProfile: { provider: 'voyageai', model: 'voyage-4-large', profileFingerprint: 'probe-profile' },
        jobId: 'job_1', attemptCount: 3, attempt: { id: 'attempt_stale_reserved', runtimeId: 'runtime_previous_session', startedAt: now - 9e5 } } };
    const reset = t.settleRecordForStaleAttempt(pendingRecord, boundary);
    assert.ok(reset.embeddingWork, 'an unverified target keeps work');
    assert.equal(reset.embeddingWork.status, 'pending', 'an unverified target becomes retryable');
    assert.equal(reset.embeddingWork.attempt, undefined, 'the dead attempt marker is cleared');
    assert.equal(reset.embeddingWork.attemptCount, 3, 'the attempt count is preserved');
    results.push('an unverified target returns to pending with its attempt count');

    // 4. A record that already holds a verified receipt is committed, not re-embedded.
    const committedRecord = { ...pendingRecord, vector: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
      dim: 1024, embeddingDimensions: 1024, provider: 'voyageai', model: 'voyage-4-large',
      embeddingProvider: 'voyageai', embeddingModel: 'voyage-4-large',
      embeddingReceipt: { schema: 'flashback.embedding_work_receipt.v1', status: 'ready', jobId: 'job_1',
        sourceRevision: t.rawEmbeddingSourceRevision(pendingRecord), originScopeKey: scope.scopeKey,
        attemptId: 'attempt_stale_reserved', runtimeId: 'runtime_previous_session',
        targetProfile: { provider: 'voyageai', model: 'voyage-4-large', profileFingerprint: 'probe-profile' },
        storageBinding: 'x', completedAt: now } };
    const settled = t.settleRecordForStaleAttempt(committedRecord, boundary);
    assert.equal(settled.embeddingWork, undefined, 'a verified target drops its stale work marker instead of re-embedding');
    results.push('a verified target is settled as committed');

    // 5. Nothing to settle on a clean scope, and the outcome is always recorded for the export.
    const clean = await t.reconcileStaleEmbeddingAttempts({ scope });
    assert.equal(clean.settled, 0);
    assert.equal(clean.reason, 'no_stale_attempts');
    const recorded = t.debugReconcileState();
    assert.ok(recorded, 'the reconciliation outcome is recorded');
    assert.equal(recorded.ok, true);
    assert.equal(recorded.attempt, 1, 'the first attempt is recorded');
    assert.equal(recorded.reason, 'no_stale_attempts');
    results.push('a clean scope reports no stale attempts and the outcome is recorded');

    console.log(JSON.stringify({ test: 'flashback_embedding_stale_attempt', passed: results.length, results,
      boundary: 'full plugin in native runtime fixture; live RisuAI server mirror untested' }));
  } finally {
    await f.close?.();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
