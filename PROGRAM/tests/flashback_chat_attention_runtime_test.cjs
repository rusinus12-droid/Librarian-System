'use strict';
// Zero-touch attention: FLASHBACK shows a chat button only while user attention
// is required (raw capture failure, embedding failure, storage error, cold start, etc.),
// prioritizes the most urgent cause, and disappears completely once healthy.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, content: data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, content: data, time: Date.now() });

(async () => {
  console.log('Starting flashback_chat_attention_runtime_test...');

  // 1. Pure decision tests across all issue states & priorities
  {
    const fixture = await createFixture({ pauseScheduledTimers: true });
    try {
      const { flashbackAttentionDecision } = fixture.api._test;

      // Case 1: capture_failed
      const decCapture = flashbackAttentionDecision({ captureFailed: true, embeddingFailed: 2 });
      assert.equal(decCapture.kind, 'capture_failed');
      assert.equal(decCapture.tab, 'import');
      assert.equal(decCapture.icon, '⚠️');
      assert.match(decCapture.name, /FLASHBACK · 원문 저장 실패/);

      // Case 2: storage_error
      const decStorage = flashbackAttentionDecision({ storageError: true, embeddingFailed: 1 });
      assert.equal(decStorage.kind, 'storage_error');
      assert.equal(decStorage.tab, 'import');
      assert.equal(decStorage.icon, '⚠️');
      assert.match(decStorage.name, /FLASHBACK · 저장소 오류 확인/);

      // Case 3: embedding_uncertain
      const decUncertain = flashbackAttentionDecision({ embeddingUncertain: 4, embeddingPending: 2 });
      assert.equal(decUncertain.kind, 'embedding_uncertain');
      assert.equal(decUncertain.count, 4);
      assert.equal(decUncertain.tab, 'provider');
      assert.equal(decUncertain.icon, '⚠️');
      assert.match(decUncertain.name, /FLASHBACK · 벡터 상태 확인 필요/);

      // Case 4: embedding_failed
      const decEmbedFailed = flashbackAttentionDecision({ embeddingFailed: 3, vectorRepair: 1 });
      assert.equal(decEmbedFailed.kind, 'embedding_failed');
      assert.equal(decEmbedFailed.count, 3);
      assert.equal(decEmbedFailed.tab, 'provider');
      assert.equal(decEmbedFailed.icon, '⚠️');
      assert.match(decEmbedFailed.name, /FLASHBACK · 응답 벡터화 실패/);

      // Case 5: vector_repair
      const decVectorRepair = flashbackAttentionDecision({ vectorRepair: 5, coldStart: 2 });
      assert.equal(decVectorRepair.kind, 'vector_repair');
      assert.equal(decVectorRepair.count, 5);
      assert.equal(decVectorRepair.tab, 'provider');
      assert.equal(decVectorRepair.icon, '⚠️');
      assert.match(decVectorRepair.name, /FLASHBACK · 벡터 복구 필요/);

      // Case 6: embedding_unconfigured
      const decUnconf = flashbackAttentionDecision({ embeddingUnconfigured: 2, coldStart: 5 });
      assert.equal(decUnconf.kind, 'embedding_unconfigured');
      assert.equal(decUnconf.count, 2);
      assert.equal(decUnconf.tab, 'provider');
      assert.equal(decUnconf.icon, '⚠️');
      assert.match(decUnconf.name, /FLASHBACK · 임베딩 제공자 설정 필요/);

      // Case 7: embedding_pending
      const decPending = flashbackAttentionDecision({ embeddingPending: 6, coldStart: 5 });
      assert.equal(decPending.kind, 'embedding_pending');
      assert.equal(decPending.count, 6);
      assert.equal(decPending.tab, 'provider');
      assert.equal(decPending.icon, '⚠️');
      assert.match(decPending.name, /FLASHBACK · 벡터 생성 대기 중/);

      // Case 8: cold_start
      const decCold = flashbackAttentionDecision({ coldStart: 12 });
      assert.equal(decCold.kind, 'cold_start');
      assert.equal(decCold.count, 12);
      assert.equal(decCold.tab, 'import');
      assert.equal(decCold.icon, '🕘');
      assert.match(decCold.name, /FLASHBACK · 지난 12턴 기억 만들기/);

      // Case 9: missing_turns
      const decMissing = flashbackAttentionDecision({ missingTurns: 7 });
      assert.equal(decMissing.kind, 'missing_turns');
      assert.equal(decMissing.count, 7);
      assert.equal(decMissing.tab, 'import');
      assert.equal(decMissing.icon, '🕘');
      assert.match(decMissing.name, /FLASHBACK · 기억 없는 턴 7개/);

      // Case 10: Healthy idle
      const decIdle = flashbackAttentionDecision({});
      assert.equal(decIdle.kind, '');
      assert.equal(decIdle.count, 0);

      // Priority ordering verification
      assert.equal(flashbackAttentionDecision({ captureFailed: true, storageError: true }).kind, 'capture_failed');
      assert.equal(flashbackAttentionDecision({ storageError: true, embeddingUncertain: 1 }).kind, 'storage_error');
      assert.equal(flashbackAttentionDecision({ embeddingUncertain: 1, embeddingFailed: 1 }).kind, 'embedding_uncertain');
      assert.equal(flashbackAttentionDecision({ embeddingFailed: 1, vectorRepair: 1 }).kind, 'embedding_failed');
      assert.equal(flashbackAttentionDecision({ vectorRepair: 1, embeddingUnconfigured: 1 }).kind, 'vector_repair');
      assert.equal(flashbackAttentionDecision({ embeddingUnconfigured: 1, embeddingPending: 1 }).kind, 'embedding_unconfigured');
      assert.equal(flashbackAttentionDecision({ embeddingPending: 1, coldStart: 1 }).kind, 'embedding_pending');
      assert.equal(flashbackAttentionDecision({ coldStart: 1, missingTurns: 1 }).kind, 'cold_start');
    } finally {
      await fixture.dispose();
    }
  }

  // 2. End-to-end runtime integration with real multi-turn chat
  {
    const fixture = await createFixture({
      pauseScheduledTimers: true,
      chat: {
        message: [
          user('u1', 'Where is the library located?'), assistant('a1', 'It is located in the northern quarter.'),
          user('u2', 'Who is the librarian?'), assistant('a2', 'The librarian is Astra.'),
          user('u3', 'What are the visiting hours?'), assistant('a3', 'The library is open from dusk until dawn.')
        ]
      }
    });

    try {
      const t = fixture.api._test;
      const registered = [];
      const removed = [];

      fixture.host.registerButton = async (spec, handler) => {
        registered.push({ spec, handler });
        return { id: spec.id };
      };
      fixture.host.unregisterUIPart = async (id) => {
        removed.push(id);
        return true;
      };

      t.startFlashbackAttention();
      assert.equal(t.FlashbackAttention.started, true, 'attention monitoring started');

      // Scenario A: Existing 3-turn chat with 0 memory records -> Cold Start detected automatically
      const stateCold = await t.refreshFlashbackAttention();
      assert.equal(stateCold.kind, 'cold_start', 'detected cold start for 3 existing turns');
      assert.equal(stateCold.count, 3);
      assert.equal(registered.length, 1, 'one chat button registered');

      const btnCold = registered.at(-1);
      assert.equal(btnCold.spec.location, 'chat');
      assert.equal(btnCold.spec.id, 'vector-rag-memory-attention');
      assert.match(btnCold.spec.name, /FLASHBACK · 지난 3턴 기억 만들기/);
      assert(btnCold.spec.icon.includes('data-memory-owner="flashback"'), 'icon has owner attribute');
      assert(btnCold.spec.icon.includes('>F<'), 'icon has F label');
      assert(btnCold.spec.icon.includes('aria-label="FLASHBACK · 기억 동기화 필요"'), 'icon has aria-label');

      // Clicking Cold Start button opens GUI to 'import' tab
      await btnCold.handler();
      assert.equal(t.Runtime.guiTab, 'import', 'opens import tab on cold start click');

      // Deduplication: refresh again with unchanged state does not create duplicate button
      await t.refreshFlashbackAttention();
      assert.equal(registered.length, 1, 'signature deduplication prevents multiple button registrations');

      // Scenario B: Raw response capture failure outranks cold start
      t.Runtime.lastCapture = {
        skipped: true,
        scopeKey: (await fixture.api.resolveCurrentScope()).scopeKey,
        pairIndex: 1,
        reason: 'finalized_capture_save_rejected',
        at: Date.now()
      };
      const stateCapture = await t.refreshFlashbackAttention();
      assert.equal(stateCapture.kind, 'capture_failed');
      const btnCapture = registered.at(-1);
      assert.match(btnCapture.spec.name, /FLASHBACK · 원문 저장 실패/);
      assert(btnCapture.spec.icon.includes('aria-label="FLASHBACK · 확인 필요"'));

      await btnCapture.handler();
      assert.equal(t.Runtime.guiTab, 'import', 'opens import tab for raw capture failure');

      // Scenario C: Historical queue diagnostics cannot invent missing durable failures
      t.Runtime.lastCapture = null;
      t.Runtime.lastEmbeddingQueue = {
        ok: false,
        failed: 2,
        failedSources: 2,
        reason: 'queue_failed',
        at: Date.now()
      };
      const stateEmbed = await t.refreshFlashbackAttention();
      assert.equal(stateEmbed.kind, 'cold_start');
      const btnEmbed = registered.at(-1);
      assert.match(btnEmbed.spec.name, /FLASHBACK · 지난 3턴 기억 만들기/);

      await btnEmbed.handler();
      assert.equal(t.Runtime.guiTab, 'import', 'historical failure does not redirect to provider settings');

      // Scenario D: Turns ingested without configured embedding provider -> alerts 'embedding_unconfigured'
      t.Runtime.lastEmbeddingQueue = null;
      t.Runtime.lastEmbedError = '';
      await fixture.api.ingestLiveChatColdStart({ scope: 'current' });

      const stateUnconf = await t.refreshFlashbackAttention();
      assert.equal(stateUnconf.kind, 'embedding_unconfigured', 'alerts provider setup when records are unvectorized');
      assert.equal(stateUnconf.count, 3);
      const btnUnconf = registered.at(-1);
      assert.match(btnUnconf.spec.name, /FLASHBACK · 임베딩 제공자 설정 필요/);
      assert(btnUnconf.spec.icon.includes('aria-label="FLASHBACK · 확인 필요"'));

      await btnUnconf.handler();
      assert.equal(t.Runtime.guiTab, 'provider', 'opens provider tab for unconfigured embedding');

      // Scenario E1: Memory healthy in lexical/raw mode (embeddingEnabled: false) -> zero-touch removal
      const settings = await fixture.api.loadSettings();
      settings.embeddingEnabled = false;
      await fixture.api.saveSettings(settings);

      const stateCleanLexical = await t.refreshFlashbackAttention();
      assert.equal(stateCleanLexical.kind, '', 'no attention needed when healthy in lexical mode');
      assert.equal(stateCleanLexical.count, 0);
      assert.equal(removed.includes('vector-rag-memory-attention'), true, 'button cleanly unregistered via unregisterUIPart');

      // Scenario E2: Memory healthy with vector embedding completed -> zero-touch removal persists
      settings.embeddingEnabled = true;
      await fixture.api.saveSettings(settings);
      const scope = await fixture.api.resolveCurrentScope();
      await t.saveAllRecords([
        { id: 'r1', hash: 'r1', sourceHash: 'r1', type: 'response', sourceType: 'response', text: 'It is located in the northern quarter.', userText: 'Where is the library located?', responseTurnIndex: 1, pairIndex: 1, dim: 4, vector: [1, 0, 0, 0] },
        { id: 'r2', hash: 'r2', sourceHash: 'r2', type: 'response', sourceType: 'response', text: 'The librarian is Astra.', userText: 'Who is the librarian?', responseTurnIndex: 2, pairIndex: 2, dim: 4, vector: [0, 1, 0, 0] },
        { id: 'r3', hash: 'r3', sourceHash: 'r3', type: 'response', sourceType: 'response', text: 'The library is open from dusk until dawn.', userText: 'What are the visiting hours?', responseTurnIndex: 3, pairIndex: 3, dim: 4, vector: [0, 0, 1, 0] }
      ], { shardSize: 1 }, scope);

      const stateCleanVector = await t.refreshFlashbackAttention();
      assert.equal(stateCleanVector.kind, '', 'no attention needed when fully vectorized and in sync');
      assert.equal(stateCleanVector.count, 0);

      // Scenario F: Plugin unload lifecycle cleanup
      await t.stopFlashbackAttention();
      assert.equal(t.FlashbackAttention.started, false);
      assert.equal(t.FlashbackAttention.buttonSignature, '');

      console.log('PASS: flashback chat attention runtime tests (decision hierarchy, real chat integration, UX routing, zero-touch cleanup)');
    } finally {
      await fixture.dispose();
    }
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
