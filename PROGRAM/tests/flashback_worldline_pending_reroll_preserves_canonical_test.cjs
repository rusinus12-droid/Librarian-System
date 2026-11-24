'use strict';

const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

function stableHash(value) {
  const source = String(value ?? '');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

(async () => {
  const f = await createFixture();
  try {
    const t = f.api._test;
    const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8 });

    // 1. Seed 2 completed turns with stable chatIds.
    f.currentChat.message = [
      { role: 'user', chatId: 'u1-id', data: 'Turn 1 user prompt' },
      { role: 'char', chatId: 'a1-id', data: 'Turn 1 original response body.\n\n◈CG\nTIME|2027.04.25|20:00\n◈' },
      { role: 'user', chatId: 'u2-id', data: 'Turn 2 user prompt' },
      { role: 'char', chatId: 'a2-id', data: 'Turn 2 original response body.' }
    ];

    const scope = t.resolveScopeFromSnapshot({ character: f.character, chat: f.currentChat, db: {} });
    const sources = t.collectLiveChatSourcesFromSnapshot({ character: f.character, chat: f.currentChat, db: {} });
    assert.equal(sources.length, 2, 'should collect 2 turn pairs');

    const storedRecords = sources.map((source, index) => ({
      id: `rec_${index + 1}`,
      hash: stableHash(`rec_${index + 1}|${source.text}`),
      scopeKey: scope.scopeKey,
      sourceType: 'response',
      role: 'assistant',
      turnIndex: index + 1,
      pairIndex: index + 1,
      userMessagePosition: source.userMessagePosition,
      assistantMessagePosition: source.assistantMessagePosition,
      sourceMessageIds: source.sourceMessageIds,
      chunkIndex: 0,
      chunkCount: 1,
      text: source.text,
      vector: [1, 0, 0, 0, 0, 0, 0, 0],
      dim: 8,
      lifecycleStatus: 'active',
      metadata: {
        captureAuthority: {
          source: 'finalized_live_chat',
          provisional: false,
          liveConfirmed: true
        }
      }
    }));

    await t.saveAllRecords(storedRecords, cfg, scope);

    const initialNormalized = t.normalizeStoredChatMessages(f.currentChat, scope.scopeKey);
    const initialLive = t.liveChatStateFromNormalized(initialNormalized);
    await t.synchronizeFlashbackTurnWorldline(scope, initialLive, cfg, { allowRetirement: true });

    // 2. Simulate a sourceRules projection change on Turn 1 (same UUIDs, stripped ◈CG block)
    //    while Turn 2 is actively rerolling (assistant message removed, protectedPending active).
    f.currentChat.message = [
      { role: 'user', chatId: 'u1-id', data: 'Turn 1 user prompt' },
      { role: 'char', chatId: 'a1-id', data: 'Turn 1 original response body.' },
      { role: 'user', chatId: 'u2-id', data: 'Turn 2 user prompt' }
    ];

    const rerollNormalized = t.normalizeStoredChatMessages(f.currentChat, scope.scopeKey);
    const rerollLive = t.liveChatStateFromNormalized(rerollNormalized);
    const result = await t.synchronizeFlashbackTurnWorldline(scope, rerollLive, cfg, {
      allowRetirement: true,
      protectedPending: {
        pendingId: 'pending-reroll-t2',
        scope: { scopeKey: scope.scopeKey },
        pairIndex: 2,
        latestUser: 'Turn 2 user prompt',
        requestUserMessageIdHash: stableHash('u2-id'),
        userMessagePosition: 3,
        expectedAssistantPosition: 4
      }
    });

    assert.equal(result.generationTargetProtected, true, 'Turn 2 reroll target should be protected');
    assert.equal(result.protectedPairIndex, 2, 'protectedPairIndex should be 2');
    assert.equal(result.changed, false, 'worldline should remain unchanged when Turn 1 is preserved and Turn 2 is protected');
    assert.equal(result.newlyRetiredRecords || 0, 0, 'Turn 1 must not be retired during Turn 2 reroll');

    const loadedAfter = await t.loadScopeRecords(scope.scopeKey);
    const activeTurnIndexes = loadedAfter.records
      .filter(r => r.sourceType === 'response' && r.lifecycleStatus === 'active')
      .map(r => Number(r.pairIndex))
      .sort((a, b) => a - b);
    assert.equal(JSON.stringify(activeTurnIndexes), JSON.stringify([1, 2]), 'Both Turn 1 and Turn 2 must remain active');

    const wlAfter = await t.loadTurnWorldline(scope.scopeKey);
    assert.equal((wlAfter.retiredRecords || []).length, 0, 'retiredRecords must remain empty');
    const t1Inactive = (wlAfter.nodes || []).filter(n => n.pairIndex === 1 && n.status !== 'active');
    assert.equal(t1Inactive.length, 0, 'Turn 1 must have no inactive_variant nodes');

    console.log(JSON.stringify({ test: 'flashback_worldline_pending_reroll_preserves_canonical', passed: 6 }));
  } finally {
    await f.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
