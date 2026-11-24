'use strict';

const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

(async () => {
  const f = await createFixture();
  try {
    const t = f.api._test;

    f.currentChat.message = [
      { role: 'user', chatId: 'u1-id', data: 'Turn 1 user prompt' },
      { role: 'char', chatId: 'a1-id', data: 'Turn 1 original response body.' }
    ];

    const [source] = t.collectLiveChatSourcesFromSnapshot({ character: f.character, chat: f.currentChat, db: {} });
    assert.ok(source?.metadata?.sourceRawDigest, 'sourceRawDigest should be populated');

    const storedRecord = {
      id: 'rec_1',
      hash: 'hash_1',
      scopeKey: 'char:test|chat:test',
      sourceType: 'response',
      role: 'assistant',
      turnIndex: 1,
      pairIndex: 1,
      userMessagePosition: source.userMessagePosition,
      assistantMessagePosition: source.assistantMessagePosition,
      sourceMessageIds: [
        'request:abc123',
        'u1-id',
        'a1-id',
        'char-uuid-1',
        'live:1:assistant:oldhash',
        'assistant:oldbodyhash'
      ],
      chunkIndex: 0,
      chunkCount: 1,
      text: 'User:\nTurn 1 user prompt\n\n---\n\nAssistant:\nTurn 1 original response body.\n\n<older_tag>extra</older_tag>',
      vector: [1, 0, 0, 0, 0, 0, 0, 0],
      dim: 8,
      lifecycleStatus: 'active',
      metadata: {
        sourceRawDigest: source.metadata.sourceRawDigest,
        captureAuthority: {
          source: 'finalized_live_chat',
          provisional: false,
          liveConfirmed: true
        }
      }
    };

    // 1. Same raw digest + native message IDs contained in stored capture IDs => unchanged
    const sameDiff = t.diffLiveChatSourcesAgainstRecords([source], [storedRecord]);
    assert.equal(sameDiff.unchanged.length, 1, 'captured turn with extra metadata IDs must stay unchanged');
    assert.equal(sameDiff.changed.length, 0);
    assert.equal(sameDiff.missing.length, 0);

    // 2. Reroll (assistant message ID changed) => changed
    const rerolledSource = {
      ...source,
      sourceMessageIds: source.sourceMessageIds.map(id => (id === 'a1-id' ? 'a1-rerolled' : id))
    };
    const rerollDiff = t.diffLiveChatSourcesAgainstRecords([rerolledSource], [storedRecord]);
    assert.equal(rerollDiff.changed.length, 1, 'rerolled assistant message ID must be detected as changed');
    assert.equal(rerollDiff.unchanged.length, 0);

    // 3. Real edit (raw digest changed) => changed
    const editedSource = {
      ...source,
      metadata: { ...source.metadata, sourceRawDigest: 'edited-raw-digest' }
    };
    const editDiff = t.diffLiveChatSourcesAgainstRecords([editedSource], [storedRecord]);
    assert.equal(editDiff.changed.length, 1, 'edited raw digest must be detected as changed');
    assert.equal(editDiff.unchanged.length, 0);

    console.log(JSON.stringify({ test: 'flashback_source_rules_preserve_captured_turn', passed: 7 }));
  } finally {
    await f.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
