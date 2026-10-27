'use strict';
// A retained vector keeps a pending re-embedding record "comparable", so health
// used to report it as normal. Inspection must surface open embedding jobs and
// automatic recovery must finish them through the ordinary pending queue.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const SOURCE = { sourceType: 'response', sourceId: 'retained-source', sourceHash: 'retained-source-hash', origin: 'live_chat',
  role: 'turn_pair', turnIndex: 1, pairIndex: 1,
  text: 'User:\nWhere is the atlas?\n\n---\n\nAssistant:\nThe worn atlas remains beside a copper lamp on the eastern shelf.' };
const success = init => ({ ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [0, 1, 0] })) }; } });

async function pendingFixture() {
  const h = await createFlashback(PROGRAM);
  const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai_compat', embeddingModel: 'retained-model-b', embeddingDimensions: 3,
    embeddingUrl: 'https://provider.invalid/v1', embeddingEnabled: true, embeddingAutoProcess: false, embeddingMaxRetries: 0, autoEpisodeIndex: false });
  await h.api.saveSettings(cfg); const scope = await h.api.resolveCurrentScope(false);
  const [draft] = await h.api._test.buildRecordsFromSources([SOURCE], cfg, scope, { deferEmbedding: true });
  const legacy = { ...draft, vector: [0.123457, 0.765431, 0.654329], dim: 3,
    provider: 'hash', model: 'hash-3', embeddingProvider: 'hash', embeddingModel: 'hash-3',
    embeddingDimensions: 3, embeddingProfileId: 'legacy-hash-profile', embeddingProvenance: { legacyFixture: true } };
  delete legacy.embeddingWork;
  await h.api._test.saveAllRecords([legacy], cfg, scope);
  await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
  const prepared = await h.api.preparePendingEmbeddingMigration();
  assert.equal(prepared.prepared, 1);
  const [pending] = (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
  assert.equal(pending.embeddingWork.status, 'pending');
  return { h, scope };
}

test('inspection reports pending re-embedding instead of a healthy verdict', async () => {
  const { h } = await pendingFixture();
  try {
    const plan = await h.api.inspectMemoryMaintenance();
    assert.equal(plan.embeddingWorkPendingRecords, 1);
    assert.equal(plan.embeddingWorkIncompleteRecords, 1);
    assert.equal(plan.healthy, false, 'open embedding work is not a healthy store');
    assert.equal(h.networkCalls.length, 0, 'inspection stays read-only');
  } finally { await h.cleanup(); }
});

test('open embedding work alone selects the queue; other damage and uncertain jobs do not', async () => {
  const h = await createFlashback(PROGRAM);
  try {
    const pick = plan => h.api._test.automaticMaintenanceStrategyForPlan({ liveTurns: 3, ...plan });
    assert.equal(JSON.stringify(pick({ embeddingWorkPendingRecords: 197, embeddingWorkIncompleteRecords: 197 })), JSON.stringify({ strategy: 'embedding_queue', stages: ['embedding_queue'] }));
    assert.equal(pick({ embeddingWorkFailedRecords: 2, embeddingWorkIncompleteRecords: 2 }).strategy, 'embedding_queue');
    assert.equal(pick({ embeddingWorkPendingRecords: 5, missingTurns: 1 }).strategy, 'targeted_repair', 'turn repair takes precedence');
    assert.equal(pick({ embeddingWorkUncertainRecords: 7, embeddingWorkIncompleteRecords: 7 }).strategy, 'no_action', 'uncertain jobs are never resent automatically');
    assert.equal(pick({ embeddingWorkPendingRecords: 5, embeddingCredentialMissing: true }).strategy, 'credential_required');
  } finally { await h.cleanup(); }
});

test('the embedding queue recovery path finishes pending work and re-inspects', async () => {
  const { h, scope } = await pendingFixture();
  try {
    const plan = await h.api.inspectMemoryMaintenance();
    // The fixture record is not a live-chat turn, so this plan also asks for sync;
    // drive only the queue path that a turn-consistent store would select.
    plan.automatic = { strategy: 'embedding_queue', stages: ['embedding_queue'] };
    h.host.nativeFetch = async (_url, init) => success(init);
    const result = await h.api.runMemoryMaintenance('auto', { preflight: plan });
    assert.equal(result.operation.strategy, 'embedding_queue');
    assert.equal(result.operation.queue.ready, 1, JSON.stringify(result.operation.queue));
    assert.equal(result.after.embeddingWorkIncompleteRecords, 0);
    const [done] = (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
    assert.equal(done.embeddingWork, undefined);
  } finally { await h.cleanup(); }
});
