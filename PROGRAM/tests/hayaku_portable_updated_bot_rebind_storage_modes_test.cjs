'use strict';
// A RisuAI bot update is installed as a NEW character, so the moved session has a new
// characterId, chatId and new message IDs while its U+A text is unchanged. HAYAKU's
// `updated_bot_rebind` must adopt the matching packets under the CURRENT chat's own scope,
// in the store the storage mode names, without opening any same-character path to another bot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {
  createStore,
  createValidPacket,
  hiddenPacketMessage,
  createHayakuRuntime,
  waitFor
} = require('./fixtures/hayaku_runtime_harness.cjs');

// HAYAKU's operating modes are plugin_only and server_only; mirror is a transition-only state
// (setScopeMode refuses it with memory_suite_mirror_is_transition_only), so it is not a restore target.
const MODES = ['plugin_only', 'server_only'];
const sourceMessages = () => {
  const p1 = createValidPacket({ turn: 1, summary: 'Alice entered the archive.' });
  p1.meta.lineage = {
    schema: 'hayaku_turn_lineage_v1',
    parent_turn_node_id: '',
    logical_turn_id: 'v1-logical-1',
    request_nonce: 'v1-nonce-1'
  };
  return [
    { role: 'user', data: 'I enter the archive.', chatId: 'v1-u1' },
    {
      role: 'assistant',
      data: hiddenPacketMessage('Alice entered the archive.', p1),
      chatId: 'v1-a1'
    }
  ];
};
const movedMessages = () => sourceMessages().map((message, index) => ({ ...message, chatId: `v2-moved-${index}` }));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-updated-bot-'));
const pluginFile = path.join(root, 'HAYAKU-host-test.js');
const marker = '        updateRecoveryJournalBackgroundDecision,';
const source = fs.readFileSync(path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
assert.ok(source.includes(marker), 'test hook anchor exists');
fs.writeFileSync(pluginFile, source.replace(marker, `        storageBridgeForHostTest:MemorySuiteStorageBridge,\n${marker}`));

const runtimeFor = async ({ mode, url, store, characterId, chatId, characterName, messages, requests = [] }) => {
  const runtime = await createHayakuRuntime({
    autoRepair: false, pluginSourceFile: pluginFile, pluginStorage: store,
    characterId, chatId, characterName, messages,
    arguments: { memory_suite_server_mode: mode, memory_suite_server_url: url },
    nativeFetch: async (target, init) => {
      requests.push(String(target));
      return await fetch(target, init);
    }
  });
  if (mode !== 'plugin_only') {
    const bridge = runtime.hayaku._test.storageBridgeForHostTest;
    const connection = await bridge.getConnectionSettings({ force: true });
    await bridge.setScopeMode(connection.scope, mode);
    assert.equal((await bridge.getConnectionSettings({ scope: connection.scope, force: true })).mode, mode);
  }
  return runtime;
};

async function run(mode) {
  const dataDir = path.join(root, `DATA-${mode}`);
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const store = createStore();
  const serverRows = () => app.repositories.hayaku.database
    .prepare('SELECT key,value_json FROM kv WHERE deleted=0').all()
    .map(row => { let value = JSON.parse(row.value_json); try { value = JSON.parse(value); } catch (_) {} return { key: row.key, value }; });
  try {
    const requests = [];
    const originalMessages = sourceMessages();
    const original = await runtimeFor({ mode, url, store, requests, characterId: 'bot-v1', characterName: 'Archive Bot', chatId: 'bot-v1-chat', messages: originalMessages });
    let envelope; let sourceKey;
    try {
      const scope1 = await original.hayaku._test.currentChatScope();
      const snap1 = original.hayaku._test.authoritativeChatSnapshot(scope1.chatMessages, scope1);
      const rec1 = await original.hayaku._test.reconcileObservedChatTopology(scope1, snap1, 'updated_bot_fixture_t1');
      assert.equal(rec1.durable, true);
      const t1Row = mode === 'plugin_only'
        ? await store.getItem(`hayaku.v2.ledger.${scope1.key}`)
        : serverRows().find(row => row.key === `hayaku.v2.ledger.${scope1.key}`)?.value;
      const t1NodeId = original.hayaku._test.normalizeStorageLedger(t1Row, scope1).worldline.nodes[0].turnNodeId;
      const p2 = createValidPacket({ turn: 2, summary: 'Alice opened the vault.' });
      p2.meta.lineage = {
        schema: 'hayaku_turn_lineage_v1',
        parent_turn_node_id: t1NodeId,
        logical_turn_id: 'v1-logical-2',
        request_nonce: 'v1-nonce-2'
      };
      originalMessages.push(
        { role: 'user', data: 'I open the vault.', chatId: 'v1-u2' },
        { role: 'assistant', data: hiddenPacketMessage('Alice opened the vault.', p2), chatId: 'v1-a2' }
      );
      const scope = await original.hayaku._test.currentChatScope();
      const snapshot = original.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
      assert.equal((await original.hayaku._test.reconcileObservedChatTopology(scope, snapshot, 'updated_bot_fixture')).durable, true);
      const portable = await waitFor(() => original.context.__HAYAKUPortableMemoryBackup, 'source portable API');
      const beforeBackup = requests.length;
      envelope = await portable.exportCurrentScope();
      if (mode === 'server_only') {
        assert.ok(requests.slice(beforeBackup).some(url => url.endsWith('/v1/kv/get-many')));
      }
      assert.equal(envelope.formatVersion, 3);
      sourceKey = `hayaku.v2.ledger.${scope.key}`;
    } finally { await original.dispose(); }
    const authoritative = () => mode === 'plugin_only'
      ? [...store.values.entries()].map(([key, value]) => ({ key, value }))
      : serverRows();
    const sourceBefore = JSON.stringify(authoritative().find(row => row.key === sourceKey)?.value ?? null);
    assert.notEqual(sourceBefore, 'null', `${mode}: the original bot ledger is stored`);

    const updated = await runtimeFor({
      mode, url, store,
      characterId: 'bot-v2', characterName: 'Archive Bot v2', chatId: 'bot-v2-chat',
      messages: originalMessages.map((message, index) => ({ ...message, chatId: `v2-moved-${index}` }))
    });
    try {
      const targetScopeBefore = await updated.hayaku._test.currentChatScope();
      const targetSnapBefore = updated.hayaku._test.authoritativeChatSnapshot(targetScopeBefore.chatMessages, targetScopeBefore);
      const preRebind = await updated.hayaku._test.reconcileObservedChatTopology(targetScopeBefore, targetSnapBefore, 'updated_bot_pre_rebind');
      assert.equal(preRebind.durable, true);
      const preRebindRow = mode === 'plugin_only'
        ? await store.getItem(`hayaku.v2.ledger.${targetScopeBefore.key}`)
        : serverRows().find(row => row.key === `hayaku.v2.ledger.${targetScopeBefore.key}`)?.value;
      assert.equal(updated.hayaku._test.normalizeStorageLedger(preRebindRow, targetScopeBefore).worldline.nodes[1].packetLineageReason, 'declared_parent_mismatch',
        `${mode}: pre-rebind chat import quarantines turn 2 with declared_parent_mismatch`);

      const portable = await waitFor(() => updated.context.__HAYAKUPortableMemoryBackup, 'updated-bot portable API');
      await assert.rejects(portable.analyzeImport(envelope, 'copied_chat_recovery'), /portable_cross_character_import_blocked/,
        `${mode}: same-character copy recovery stays closed for another bot`);
      await assert.rejects(portable.analyzeImport(envelope, 'new_chat_migration'), /portable_cross_character_import_blocked/,
        `${mode}: same-character migration stays closed for another bot`);
      await assert.rejects(portable.restoreCurrentScope(envelope), /scope/,
        `${mode}: same-chat replacement stays closed for another bot`);

      const analysis = await portable.analyzeImport(envelope, 'updated_bot_rebind');
      assert.equal(analysis.matchedPairs, 2, `${mode}: the moved transcript matches by text`);
      const result = await portable.rebindToUpdatedBot(envelope);
      assert.equal(result.ok, true);
      assert.equal(result.updatedBotRebind, true);
      assert.equal(result.sourceCharacterId, 'bot-v1');
      assert.equal(result.targetCharacterId, 'bot-v2');

      const targetScope = await updated.hayaku._test.currentChatScope();
      assert.notEqual(targetScope.key, sourceKey.replace('hayaku.v2.ledger.', ''), `${mode}: the updated bot has its own scope`);
      const targetKey = `hayaku.v2.ledger.${targetScope.key}`;
      const checkLedger = (raw, label) => {
        const ledger = updated.hayaku._test.normalizeStorageLedger(raw, targetScope);
        const active = ledger.records.filter(record => record.recordState === 'active');
        assert.equal(active.length, 2, `${mode}: ${label} binds both rebased turns as active`);
        assert.equal(ledger.records.filter(record => record.recordState === 'quarantined').length, 0,
          `${mode}: ${label} has no quarantined records after rebind`);
        assert.ok(active.every(record => Boolean(record.ownerTurnNodeId)), `${mode}: ${label} packets are bound to the new worldline`);
        assert.equal(ledger.portableImport?.mode, 'updated_bot_rebind');
        assert.equal(ledger.portableImport?.targetScopeKey, targetScope.key);
        assert.equal(ledger.portableImport?.verified, true);
      };
      if (mode !== 'plugin_only') checkLedger(serverRows().find(row => row.key === targetKey)?.value, 'server');
      if (mode !== 'server_only') checkLedger(await store.getItem(targetKey), 'pluginStorage');
      if (mode === 'server_only') {
        assert.equal(await store.getItem(targetKey), null, 'server_only: the ledger is not written into pluginStorage');
      }
      const postRebind = await updated.hayaku._test.reconcileObservedChatTopology(
        targetScope,
        updated.hayaku._test.authoritativeChatSnapshot(targetScope.chatMessages, targetScope),
        'updated_bot_post_rebind',
        { verifyBindings: true }
      );
      assert.equal(postRebind.durable, true);
      const postRebindRow = mode === 'plugin_only'
        ? await store.getItem(targetKey)
        : serverRows().find(row => row.key === targetKey)?.value;
      const postWorldline = updated.hayaku._test.normalizeStorageLedger(postRebindRow, targetScope).worldline;
      assert.equal(postWorldline.nodes.filter(node => node.status === 'active').length, 2,
        `${mode}: subsequent topology reconciliation keeps both turns active`);
      assert.equal(postWorldline.nodes[1].packetLineageReason, 'verified_portable_copy_scope_rebase',
        `${mode}: turn 2 keeps verified_portable_copy_scope_rebase`);
      assert.equal(JSON.stringify(authoritative().find(row => row.key === sourceKey)?.value ?? null), sourceBefore,
        `${mode}: the original bot ledger is unchanged`);
      return { mode, storage: await portable.storageTarget() };
    } finally { await updated.dispose(); }
  } finally {
    await app.close();
  }
}

(async () => {
  const results = [];
  try {
    for (const mode of MODES) { console.log(`RUN ${mode}`); results.push(await run(mode)); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log(JSON.stringify(results));
  assert.match(results[0].storage, /플러그인 스토리지/);
  assert.match(results[1].storage, /서버 저장소/);
  console.log('PASS hayaku_portable_updated_bot_rebind_storage_modes_test');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
