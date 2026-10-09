'use strict';
// Controlled protocol vectors, never a model-quality test or a hash/lexical fallback.
const assert = require('node:assert/strict');
const settings = mode => ({ embeddingProvider: mode === 'configured' ? 'openai_compat' : 'hash',
  embeddingModel: mode === 'configured' ? 'unload-synthetic-v1' : 'hash-v1',
  embeddingUrl: 'https://unload-fixture.invalid/v1', embeddingDimensions: 3,
  embeddingMaxRetries: 0, embeddingAutoProcess: false, embeddingEnabled: true,
  captureAfterRequest: true, episodeIndexEnabled: false, autoEpisodeIndex: false,
  hookRecallTimeoutMs: 5000, maxInjectionChars: 4000, currentSceneTailEnabled: false,
  minScore: 0.1, mmrEnabled: false });
const syntheticFetch = async (url, options, fallback) => {
  if (new URL(String(url)).hostname !== 'unload-fixture.invalid') {
    assert.equal(new URL(String(url)).hostname, '127.0.0.1', 'only the disposable loopback server is reachable');
    assert.equal(typeof fallback, 'function', 'unexpected transport');
    return fallback(url, options);
  }
  const body = JSON.parse(options.body);
  const input = Array.isArray(body.input) ? body.input : [body.input];
  return new Response(JSON.stringify({ data: input.map((value, index) => ({ index, embedding: String(value).includes('UNRELATED_FIXTURE_QUERY') ? [0, 1, 0] : [1, 0, 0] })) }), { status: 200 });
};
const configure = async (fixture, mode) => {
  if (mode === 'configured') await fixture.api._test.saveEmbeddingKeyLocal('synthetic-fixture-not-a-real-key');
  await fixture.api.saveSettings({ ...await fixture.api.loadSettings(), ...settings(mode) });
};
const readyForRecall = async (fixture, mode, fact) => {
  const api = fixture.api, scope = await api.resolveCurrentScope();
  const before = await api._test.loadScopeRecords(scope.scopeKey);
  assert.ok(before.records.some(record => record.text.includes(fact)), 'raw fact must exist before semantic work');
  assert.equal(Number(before.manifest.missingShards || 0), 0);
  assert.equal(Number(before.manifest.corruptShards || 0), 0);
  assert.notEqual(before.manifest.recordCountMismatch, true);
  const identity = rows => JSON.stringify(rows.map(row => [row.id, row.sourceId, row.sourceHash, row.text]));
  if (mode === 'configured') {
    // Official output is provisionally durable until exact live-chat confirmation.
    // Use the real cold-start reconciliation path; never mutate authority/work bindings.
    const confirmation = await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    const queueResult = await api.processPendingEmbeddingQueue({ maxSources: 8, maxRequests: 8 });
    const after = await api._test.loadScopeRecords(scope.scopeKey);
    assert.equal(identity(after.records), identity(before.records), 'embedding cannot change source identity or raw text');
    assert.ok(after.records.every(row => row.vector.length === 3 && row.embeddingReceipt?.status === 'ready'),
      `configured recall requires actual validated provider output and source-bound ready receipts: ${JSON.stringify({ confirmation, queueResult,
        sourceEditStatus: api.getSourceEditSyncStatus(), rows: after.records.map(row => ({ authority: row.metadata?.captureAuthority,
          work: row.embeddingWork, receipt: row.embeddingReceipt, vector: row.vector })) })}`);
    for (const row of after.records) {
      const prior = before.records.find(item => item.id === row.id);
      const priorBinding = prior.embeddingWork || prior.embeddingReceipt;
      assert.equal(row.embeddingReceipt.sourceRevision, priorBinding.sourceRevision, 'receipt binds the original raw revision');
      assert.equal(row.embeddingReceipt.jobId, priorBinding.jobId, 'receipt belongs to the original durable embedding job');
      assert.equal(row.embeddingReceipt.targetProfile.model, 'unload-synthetic-v1');
      assert.equal(row.embeddingReceipt.originScopeKey, scope.scopeKey);
      assert.ok(row.embeddingReceipt.attemptId && row.embeddingReceipt.storageBinding, 'a real validated attempt published the receipt');
    }
    const cfg = await api.loadSettings();
    const positiveQuery = 'What did the gauge show, and where is the spare valve?';
    const positive = await api._selectionTest.prepareFlashbackRecall(positiveQuery, cfg, scope, { currentUser: positiveQuery });
    assert.equal(positive.contextualRecall.mode, 'semantic_embedding', 'positive recall uses comparable model evidence');
    assert.equal(positive.queryDim, 3);
    assert.equal(positive.contextualRecall.lexicalFallbackCandidates, 0);
    for (const arm of ['hashRecovery', 'sparse', 'exact']) assert.equal(positive.candidateArms[arm], 0);
    assert.ok(api._selectionTest.selectFlashbackEvidencePlan(positive, cfg, 4000).text.includes(fact));
    const query = 'UNRELATED_FIXTURE_QUERY';
    const negative = await api._selectionTest.prepareFlashbackRecall(query, cfg, scope, { currentUser: query });
    assert.equal(negative.queryDim, 3, 'negative query still used the configured synthetic model');
    assert.equal(negative.contextualRecall.lexicalFallbackCandidates, 0, 'no fallback candidates');
    for (const arm of ['hashRecovery', 'sparse', 'exact']) assert.equal(negative.candidateArms[arm], 0);
    assert.equal(api._selectionTest.selectFlashbackEvidencePlan(negative, cfg, 4000).items.length, 0,
      'orthogonal synthetic query cannot inject arbitrary top-one evidence');
    assert.equal(identity((await api._test.loadScopeRecords(scope.scopeKey)).records), identity(before.records));
    return { rawCount: after.records.length, readyReceipts: after.records.length, sourceBindingsVerified: true, positiveRecallMode: positive.contextualRecall.mode, unrelatedQueryItems: 0 };

  } else {
    assert.ok(before.records.every(row => row.vector.length === 0), 'retired hash mode must not manufacture vectors');
    const cfg = await api.loadSettings();
    const recall = await api._selectionTest.prepareFlashbackRecall('Where is the spare valve?', cfg, scope, { currentUser: 'Where is the spare valve?' });
    assert.equal(recall.modelReadiness.status, 'unconfigured', 'raw durability is not semantic readiness');
    assert.equal(recall.records.length, 0, 'no lexical fallback on unconfigured storage');
    return { rawCount: before.records.length, readyReceipts: 0, modelReadiness: recall.modelReadiness.status, semanticItems: 0 };
  }
};
module.exports = { settings, syntheticFetch, configure, readyForRecall };
