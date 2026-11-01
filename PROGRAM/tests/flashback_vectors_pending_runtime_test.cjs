'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const { awaitScopeRetirement } = require('./fixtures/flashback_retirement_lifecycle.cjs');

const PROGRAM = path.resolve(__dirname, '..');

const clone = value => JSON.parse(JSON.stringify(value));

async function setupTest(run) {
  const h = await createFlashback(PROGRAM, { waitForLoaded: true });
  try {
    const cfg = h.api._test.normalizeSettings({
      embeddingEnabled: true,
      embeddingProvider: 'openai',
      embeddingModel: 'new-profile-model',
      embeddingDimensions: 3,
      embeddingUrl: 'https://provider.invalid/v1/embeddings',
      embeddingMaxRetries: 0,
      fallbackHashEmbedding: false,
      autoEpisodeIndex: false,
      heuristicRecall: true,
      contextualRecall: true,
      currentSceneTailEnabled: false,
      minScore: 0
    });
    await h.api.saveSettings(cfg);
    const scope = await h.api.resolveCurrentScope(false);
    await run({ h, cfg, scope });
  } finally {
    await h.cleanup();
  }
}

test('vectors_pending fallback allows keyword recall when all stored records await re-embedding', async () => {
  await setupTest(async ({ h, cfg, scope }) => {
    // Record with an older embedding profile
    const oldRecordSource = {
      sourceType: 'response',
      sourceId: 'old-profile-source-1',
      sourceHash: 'old-profile-hash-1',
      origin: 'live_chat',
      role: 'turn_pair',
      turnIndex: 1,
      pairIndex: 1,
      text: 'User:\n서랍에는 무엇이 있나요?\n\n---\n\nAssistant:\n황동 열쇠는 서랍 안에 있다.'
    };

    h.host.nativeFetch = async (_url, init) => {
      const input = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) };
        }
      };
    };

    const raw = await h.api._test.buildRecordsFromSources([oldRecordSource], cfg, scope, { deferEmbedding: true });
    assert.equal(raw.length, 1);
    const row = clone(raw[0]);
    delete row.embeddingWork;
    // Simulate stored record having an older/stale embedding profile
    row.provider = row.embeddingProvider = 'openai';
    row.model = row.embeddingModel = 'old-profile-model';
    row.embeddingProfileId = 'emb_old_profile_outdated';
    row.vector = [0.2, 0.4, 0.6];
    row.dim = 3;
    row.embeddingReceipt = {
      receiptVersion: 1,
      provider: 'openai',
      model: 'old-profile-model',
      profileId: 'emb_old_profile_outdated',
      dimensions: 3,
      sourceHash: row.sourceHash
    };

    await h.api._test.saveAllRecords([row], cfg, scope);
    await h.api._test.loadScopeRecords(scope.scopeKey);
    await awaitScopeRetirement(h.audit.Runtime, scope.scopeKey);

    // Query asking for the brass key
    const query = '황동 열쇠는 어디에 있는가?';
    const result = await h.api.recallRecords(query, cfg, scope, { currentPairIndex: 10 });

    // 1. Model readiness must reflect vectors_pending fallback
    assert.equal(result.modelReadiness?.status, 'lexical_fallback');
    assert.equal(result.modelReadiness?.reason, 'vectors_pending');
    assert.equal(result.modelReadiness?.ready, false);

    // 2. Dense candidates should be 0 because the stored record's vector is not comparable
    assert.equal(result.candidateArms?.dense || 0, 0);

    // 3. Keyword / exact arms should identify the candidate
    assert.ok(
      (result.candidateArms?.sparse || 0) > 0 || (result.candidateArms?.exact || 0) > 0,
      'keyword/exact candidate arms must populate'
    );

    // 4. Actual record must be recalled
    assert.equal(result.records.length, 1, 'record must be returned via keyword fallback');
    assert.ok(
      result.records[0].record.text.includes('황동 열쇠는 서랍 안에 있다'),
      'recalled record contains the expected memory text'
    );
    assert.equal(result.records[0].components?.lexicalFallback, true);
    assert.equal(result.records[0].components?.vectorComparable, false);
  });
});

test('mixed migration state: both current-profile and stale-profile records are searchable', async () => {
  await setupTest(async ({ h, cfg, scope }) => {
    const currentRecordSource = {
      sourceType: 'response',
      sourceId: 'new-profile-source-1',
      sourceHash: 'new-profile-hash-1',
      origin: 'live_chat',
      role: 'turn_pair',
      turnIndex: 1,
      pairIndex: 1,
      text: 'User:\n책장 위에는 무엇이 있나요?\n\n---\n\nAssistant:\n은빛 열쇠는 책장 위에 있다.'
    };

    const staleRecordSource = {
      sourceType: 'response',
      sourceId: 'old-profile-source-2',
      sourceHash: 'old-profile-hash-2',
      origin: 'live_chat',
      role: 'turn_pair',
      turnIndex: 2,
      pairIndex: 2,
      text: 'User:\n서랍 안에는 무엇이 있나요?\n\n---\n\nAssistant:\n황동 열쇠는 서랍 안에 있다.'
    };

    // Vector generation mock
    h.host.nativeFetch = async (_url, init) => {
      const input = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: input.map((textVal, index) => {
              // Differentiate query vectors for semantic testing
              if (typeof textVal === 'string' && textVal.includes('은빛')) {
                return { index, embedding: [1, 0, 0] };
              }
              return { index, embedding: [0, 1, 0] };
            })
          };
        }
      };
    };

    // Build and save records with deferEmbedding: true
    const raw = await h.api._test.buildRecordsFromSources([currentRecordSource, staleRecordSource], cfg, scope, { deferEmbedding: true });
    assert.equal(raw.length, 2);
    await h.api._test.saveAllRecords(raw, cfg, scope);
    await h.api._test.loadScopeRecords(scope.scopeKey);
    await awaitScopeRetirement(h.audit.Runtime, scope.scopeKey);

    // Process embedding work so both records get valid real receipts from nativeFetch mock
    await h.api.processPendingEmbeddingWork({ sourceHash: currentRecordSource.sourceHash });
    await h.api.processPendingEmbeddingWork({ sourceHash: staleRecordSource.sourceHash });

    const savedRecords = clone(await h.api._test.loadScopeRecords(scope.scopeKey)).records;
    const recordA = savedRecords.find(r => r.sourceId === 'new-profile-source-1');
    const recordB = savedRecords.find(r => r.sourceId === 'old-profile-source-2');

    // Simulate Record B being from a previous embedding profile before a model upgrade
    delete recordB.embeddingReceipt;
    recordB.provider = recordB.embeddingProvider = 'openai';
    recordB.model = recordB.embeddingModel = 'old-profile-model';
    recordB.embeddingProfileId = 'emb_old_profile_outdated';
    recordB.vector = [0.1, 0.2, 0.3];

    await h.api._test.saveAllRecords([recordA, recordB], cfg, scope);
    await h.api._test.loadScopeRecords(scope.scopeKey);
    await awaitScopeRetirement(h.audit.Runtime, scope.scopeKey);

    // Scenario 2A: Query for stale-profile Record B ("황동 열쇠")
    {
      const queryStale = '황동 열쇠는 어디에 있나요?';
      const resultStale = await h.api.recallRecords(queryStale, cfg, scope, { currentPairIndex: 10 });

      // Because query embedding succeeded and Record A is model-eligible, overall readiness is ready
      assert.equal(resultStale.modelReadiness?.ready, true);

      // Record B must still be recalled via keyword/exact arms despite incompatible vector
      const foundB = resultStale.records.find(item => item.record.sourceId === 'old-profile-source-2');
      assert.ok(foundB, 'stale-profile record B must be recalled in mixed migration state');
      assert.ok(foundB.record.text.includes('황동 열쇠는 서랍 안에 있다'));
      assert.equal(foundB.components?.vectorComparable, false);
      assert.equal(foundB.components?.lexicalFallback, true);
    }

    // Scenario 2B: Query for current-profile Record A ("은빛 열쇠")
    {
      const queryCurrent = '은빛 열쇠 위치가 어디였지?';
      const resultCurrent = await h.api.recallRecords(queryCurrent, cfg, scope, { currentPairIndex: 10 });

      assert.equal(resultCurrent.modelReadiness?.ready, true);

      // Record A must be recalled via dense semantic matching
      const foundA = resultCurrent.records.find(item => item.record.sourceId === 'new-profile-source-1');
      assert.ok(foundA, 'current-profile record A must be recalled');
      assert.ok(foundA.record.text.includes('은빛 열쇠는 책장 위에 있다'));
      assert.equal(foundA.components?.vectorComparable, true);
      assert.equal(foundA.components?.contextualSemantic, true);
    }
  });
});
