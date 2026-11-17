'use strict';
// When RisuAI duplicates a chat (채팅 복사), the copy gets a new chatId and new message
// chatIds while its U+A text is unchanged. Both HAYAKU and Flashback must detect the copy
// and bind the copied memories to the target chat's worldline nodes immediately, matching
// the updated-bot JSON restore behavior so no copied turns appear as missing (누락).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createFixture: createFlashbackFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { clone, parent } = require('./fixtures/native_branch_fixture.cjs');

test('HAYAKU binds inline packets with meta.lineage on a duplicated chat with regenerated message chatIds', async () => {
  const p1 = createValidPacket({ turn: 1, summary: 'Alice entered the archive.' });
  p1.meta.lineage = {
    schema: 'hayaku_turn_lineage_v1',
    parent_turn_node_id: '',
    logical_turn_id: 'v1-logical-1',
    request_nonce: 'v1-nonce-1'
  };
  const p2 = createValidPacket({ turn: 2, summary: 'Alice opened the ledger.' });
  p2.meta.lineage = {
    schema: 'hayaku_turn_lineage_v1',
    parent_turn_node_id: 'v1-parent-node-1',
    logical_turn_id: 'v1-logical-2',
    request_nonce: 'v1-nonce-2'
  };
  const messages = [
    { role: 'user', data: 'I enter the archive.', chatId: 'v1-u1' },
    { role: 'char', data: hiddenPacketMessage('Alice entered the archive.', p1), chatId: 'v1-a1' },
    { role: 'user', data: 'I open the ledger.', chatId: 'v1-u2' },
    { role: 'char', data: hiddenPacketMessage('Alice opened the ledger.', p2), chatId: 'v1-a2' }
  ];
  const f = await createHayakuRuntime({ autoRepair: false, messages, chatId: 'hayaku-parent', chatName: 'Story', loadRetrace: true });
  try {
    const t = f.hayaku._test;
    const scope = await t.currentChatScope();
    await t.reconcileObservedChatTopology(scope, t.authoritativeChatSnapshot(scope.chatMessages, scope), 'parent_init');

    const orig = clone(f.chat);
    const copy = clone(orig);
    copy.id = copy.chatId = 'hayaku-copy';
    copy.name = 'Story (Copy)';
    copy.message = copy.message.map((m, idx) => ({ ...m, chatId: `copy-msg-${idx}` }));
    Object.assign(f.chat, copy);
    f.chat.messages = f.chat.message;
    f.character.chats = [f.chat, orig];

    const target = await t.currentChatScope();
    assert.equal(target.copiedFromChatId, 'hayaku-parent');
    assert.equal(target.copiedChatDetectionReason, 'risu_native_chat_copy');
    const snapshot = t.authoritativeChatSnapshot(target.chatMessages, target);
    await t.reconcileObservedChatTopology(target, snapshot, 'copy_init');

    const ledger = await f.hayaku.ledger.inspect({ includeRecords: true });
    const cov = t.exactHayakuTurnCoverage(snapshot, ledger, target.key);
    assert.deepEqual(Array.from(cov.coveredTurns), [1, 2]);
    assert.deepEqual(Array.from(cov.missingTurns), []);
  } finally {
    await f.dispose();
  }
});

test('HAYAKU rebinds storage-backed packets on a duplicated chat even without inline packet comments', async () => {
  const p1 = createValidPacket({ turn: 1, summary: 'Alice entered the archive.' });
  const p2 = createValidPacket({ turn: 2, summary: 'Alice opened the ledger.' });
  const messages = [
    { role: 'user', data: 'I enter the archive.', chatId: 'v1-u1' },
    { role: 'char', data: hiddenPacketMessage('Alice entered the archive.', p1), chatId: 'v1-a1' },
    { role: 'user', data: 'I open the ledger.', chatId: 'v1-u2' },
    { role: 'char', data: hiddenPacketMessage('Alice opened the ledger.', p2), chatId: 'v1-a2' }
  ];
  const f = await createHayakuRuntime({ autoRepair: false, messages, chatId: 'hayaku-storage-parent', chatName: 'Archive', loadRetrace: true });
  try {
    const t = f.hayaku._test;
    const scope = await t.currentChatScope();
    await t.reconcileObservedChatTopology(scope, t.authoritativeChatSnapshot(scope.chatMessages, scope), 'parent_init');

    const orig = clone(f.chat);
    const copy = clone(orig);
    copy.id = copy.chatId = 'hayaku-storage-copy';
    copy.name = 'Archive (Copy)';
    copy.copiedFromChatId = 'hayaku-storage-parent';
    // Strip inline packet comments from the copied chat's visible messages to verify storage rebind.
    copy.message = [
      { role: 'user', data: 'I enter the archive.', chatId: 'copy-u1' },
      { role: 'char', data: 'Alice entered the archive.', chatId: 'copy-a1' },
      { role: 'user', data: 'I open the ledger.', chatId: 'copy-u2' },
      { role: 'char', data: 'Alice opened the ledger.', chatId: 'copy-a2' }
    ];
    Object.assign(f.chat, copy);
    f.chat.messages = f.chat.message;
    f.character.chats = [f.chat, orig];

    const target = await t.currentChatScope();
    assert.equal(target.copiedFromChatId, 'hayaku-storage-parent');
    const snapshot = t.authoritativeChatSnapshot(target.chatMessages, target);
    await t.reconcileObservedChatTopology(target, snapshot, 'copy_init');

    const ledger = await f.hayaku.ledger.inspect({ includeRecords: true });
    const cov = t.exactHayakuTurnCoverage(snapshot, ledger, target.key);
    assert.deepEqual(Array.from(cov.coveredTurns), [1, 2]);
    assert.deepEqual(Array.from(cov.missingTurns), []);
  } finally {
    await f.dispose();
  }
});

test('Flashback reconciles target turnWorldline and binds turnNodeId/logicalTurnId on native chat copy', async () => {
  const f = await createFlashbackFixture();
  try {
    const t = f.api._test;
    const p = parent('fb-parent', 5);
    Object.assign(f.currentChat, p);
    f.character.chats = [f.currentChat];
    const snapshot = chat => ({
      character: clone(f.character),
      chat: clone(chat),
      db: { personas: [], selectedPersona: '' },
      chatInfo: { characterIndex: 0, chatIndex: 0 }
    });
    const from = t.resolveScopeFromSnapshot(snapshot(f.currentChat));
    const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });
    const records = [];
    for (let i = 1; i <= 5; i += 1) {
      const r = t.cleanRecordForMemory({
        id: 'record-' + i, sourceType: 'response', sourceId: `${p.id}:turn:${i}`,
        text: `User:\nUser ${i}\n\n---\n\nAssistant:\nAssistant ${i}`, title: 'Turn ' + i,
        scopeKey: from.scopeKey, pairIndex: i, turnIndex: i, tags: [], tokenCount: 8, tokens: 8,
        vector: [1, 0, 0, 0, 0, 0, 0, 0], dim: 8, provider: 'hash', model: 'hash-8',
        embeddingProvider: 'hash', embeddingModel: 'hash-8', embeddingDimensions: 8,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        lifecycleStatus: 'active', sourceHash: 'turn-' + i
      }, from, { authoritativeSource: true }).record;
      records.push(r);
    }
    await t.saveAllRecords(records, cfg, from);

    const copy = clone(f.currentChat);
    copy.id = copy.chatId = 'fb-copy';
    copy.name = p.name + ' (Copy)';
    copy.message = copy.message.map((m, idx) => ({ ...m, chatId: 'copy-msg-' + idx }));
    Object.assign(f.currentChat, copy);
    f.character.chats = [f.currentChat, clone(p)];

    const to = t.resolveScopeFromSnapshot(snapshot(f.currentChat));
    const copied = await t.cloneScopeStorage(from, to, cfg, { mode: 'chat_copy_live', reason: 'copy_test' });
    assert.equal(copied.ok, true);

    const wl = await t.loadTurnWorldline(to.scopeKey);
    assert.equal(wl.nodes.length, 5);
    const loaded = await t.loadScopeRecords(to);
    assert.equal(loaded.records.length, 5);
    for (const rec of loaded.records) {
      assert.ok(rec.turnNodeId, 'copied record has turnNodeId bound');
      assert.ok(rec.logicalTurnId, 'copied record has logicalTurnId bound');
      const node = wl.nodes.find(n => n.turnNodeId === rec.turnNodeId);
      assert.ok(node, 'record turnNodeId exists in target worldline');
      assert.equal(node.logicalTurnId, rec.logicalTurnId);
    }
    const manifest = await t.loadScopeManifest(to);
    assert.ok(manifest.turnWorldlineLiveHash, 'manifest records turnWorldlineLiveHash');
    assert.ok(manifest.turnWorldlineRevision >= 1, 'manifest records turnWorldlineRevision');
  } finally {
    await f.dispose();
  }
});
