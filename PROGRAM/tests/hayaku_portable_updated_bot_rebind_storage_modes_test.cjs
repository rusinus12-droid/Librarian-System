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
const sourceMessages = () => [
  { role: 'user', data: 'I enter the archive.', chatId: 'v1-u1' },
  {
    role: 'assistant',
    data: hiddenPacketMessage('Alice entered the archive.', createValidPacket({ turn: 1, summary: 'Alice entered the archive.' })),
    chatId: 'v1-a1'
  }
];
const movedMessages = () => sourceMessages().map((message, index) => ({ ...message, chatId: `v2-moved-${index}` }));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-updated-bot-'));
const pluginFile = path.join(root, 'HAYAKU-host-test.js');
const marker = '        updateRecoveryJournalBackgroundDecision,';
const source = fs.readFileSync(path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
assert.ok(source.includes(marker), 'test hook anchor exists');
fs.writeFileSync(pluginFile, source.replace(marker, `        storageBridgeForHostTest:MemorySuiteStorageBridge,\n${marker}`));

const runtimeFor = async ({ mode, url, store, characterId, chatId, characterName, messages }) => {
  const runtime = await createHayakuRuntime({
    autoRepair: false, pluginSourceFile: pluginFile, pluginStorage: store,
    characterId, chatId, characterName, messages,
    arguments: { memory_suite_server_mode: mode, memory_suite_server_url: url },
    nativeFetch: async (target, init) => await fetch(target, init)
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
    const original = await runtimeFor({ mode, url, store, characterId: 'bot-v1', characterName: 'Archive Bot', chatId: 'bot-v1-chat', messages: sourceMessages() });
    let envelope; let sourceKey;
    try {
      const scope = await original.hayaku._test.currentChatScope();
      const snapshot = original.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
      assert.equal((await original.hayaku._test.reconcileObservedChatTopology(scope, snapshot, 'updated_bot_fixture')).durable, true);
      const portable = await waitFor(() => original.context.__HAYAKUPortableMemoryBackup, 'source portable API');
      envelope = await portable.exportCurrentScope();
      assert.equal(envelope.formatVersion, 3);
      sourceKey = `hayaku.v2.ledger.${scope.key}`;
    } finally { await original.dispose(); }
    const authoritative = () => mode === 'plugin_only'
      ? [...store.values.entries()].map(([key, value]) => ({ key, value }))
      : serverRows();
    const sourceBefore = JSON.stringify(authoritative().find(row => row.key === sourceKey)?.value ?? null);
    assert.notEqual(sourceBefore, 'null', `${mode}: the original bot ledger is stored`);

    const updated = await runtimeFor({ mode, url, store, characterId: 'bot-v2', characterName: 'Archive Bot v2', chatId: 'bot-v2-chat', messages: movedMessages() });
    try {
      const portable = await waitFor(() => updated.context.__HAYAKUPortableMemoryBackup, 'updated-bot portable API');
      await assert.rejects(portable.analyzeImport(envelope, 'copied_chat_recovery'), /portable_cross_character_import_blocked/,
        `${mode}: same-character copy recovery stays closed for another bot`);
      await assert.rejects(portable.analyzeImport(envelope, 'new_chat_migration'), /portable_cross_character_import_blocked/,
        `${mode}: same-character migration stays closed for another bot`);
      await assert.rejects(portable.restoreCurrentScope(envelope), /scope/,
        `${mode}: same-chat replacement stays closed for another bot`);

      const analysis = await portable.analyzeImport(envelope, 'updated_bot_rebind');
      assert.equal(analysis.matchedPairs, 1, `${mode}: the moved transcript matches by text`);
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
        const imported = ledger.records.filter(record => record.captureSource === 'portable_chat_copy_recovery');
        assert.equal(imported.length, 1, `${mode}: ${label} holds the adopted packet`);
        assert.equal(imported[0].recordState, 'active');
        assert.ok(imported[0].ownerTurnNodeId, `${mode}: ${label} packet is bound to the new worldline`);
        assert.equal(ledger.portableImport?.mode, 'updated_bot_rebind');
        assert.equal(ledger.portableImport?.targetScopeKey, targetScope.key);
        assert.equal(ledger.portableImport?.verified, true);
      };
      if (mode !== 'plugin_only') checkLedger(serverRows().find(row => row.key === targetKey)?.value, 'server');
      if (mode !== 'server_only') checkLedger(await store.getItem(targetKey), 'pluginStorage');
      if (mode === 'server_only') {
        assert.equal(await store.getItem(targetKey), null, 'server_only: the ledger is not written into pluginStorage');
      }
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
