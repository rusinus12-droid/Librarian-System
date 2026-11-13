'use strict';
// A RisuAI bot update is installed as a NEW character, so the moved session has a new
// characterId, chatId and new message IDs while its U+A text is unchanged. Flashback's
// `updated_bot_rebind` must re-key the backed-up memories to the CURRENT chat's own scope,
// in the store the storage mode names, keep every same-actor path closed for another bot,
// and leave the original bot's scope untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const transcript = prefix => [
  { role: 'user', data: 'The observatory key is hidden beneath the blue sundial.', chatId: `${prefix}-u1` },
  { role: 'assistant', data: 'Mira pockets the brass key and promises to return at moonrise.', chatId: `${prefix}-a1` },
  { role: 'user', data: 'She should meet Rowan alone and use the phrase silver rain.', chatId: `${prefix}-u2` },
  { role: 'assistant', data: 'At moonrise, Mira meets Rowan alone and whispers silver rain.', chatId: `${prefix}-a2` }
];
const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

// A portable operation is refused while an owner writer is still draining (mirror pushes after
// ingest). Retry the way a user presses the button again a moment later.
const idle = async (operation, label, attempts = 60) => {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return await operation(); } catch (error) {
      if (!/BUSY/.test(String(error?.code || error?.message || ''))) throw error;
      last = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Flashback stayed busy for ${label}: ${last?.code || last}`);
};

async function run(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flashback-updated-bot-${mode}-`));
  let app = null;
  let fixture = null;
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const url = `http://127.0.0.1:${address.port}`;
    const messages = transcript('v1');
    fixture = await createFixture({
      exposeStorageBridge: true,
      characterId: 'mira-bot-v1',
      chat: { id: 'mira-v1-chat', chatId: 'mira-v1-chat', name: 'Original session', message: messages, messages },
      arguments: { memory_suite_server_mode: mode, memory_suite_server_url: url },
      nativeFetch: fetch
    });
    const { api, context, pluginStorage } = fixture;
    const bridge = context.__fixtureStorageBridge;
    if (mode === 'server_only') await bridge.setMode(mode);
    assert.equal(await bridge.getMode(), mode, `${mode}: the bridge runs in the requested mode`);
    const portable = await waitFor(() => context.__FlashbackPortableMemoryBackup, 'portable API');
    const serverRows = () => app.repositories.flashback.database
      .prepare('SELECT key,value_json FROM kv WHERE deleted=0').all()
      .map(row => ({ key: String(row.key), value: String(row.value_json) }));
    const serverKeys = () => serverRows().map(row => row.key);
    // The physical rows of one scope in the store the mode makes authoritative.
    const physicalScopeRows = async storageHash => {
      const prefix = `vector_rag_memory:scope:${storageHash}:`;
      const rows = mode === 'plugin_only'
        ? await Promise.all((await pluginStorage.keys()).filter(key => key.startsWith(prefix))
          .map(async key => ({ key, value: JSON.stringify(await pluginStorage.getItem(key)) })))
        : serverRows().filter(row => row.key.startsWith(prefix));
      return JSON.stringify(rows.sort((left, right) => left.key.localeCompare(right.key)));
    };

    const ingested = await api.ingestLiveChatColdStart({
      scope: 'current', incremental: false, skipEpisodeRebuild: true, skipGuiRefresh: true, allowHashFallback: true
    });
    assert.equal(ingested.liveChatTurns, 2, `${mode}: the original session has two memory turns`);
    const sourceScope = await api.resolveCurrentScope(true);
    const envelope = await idle(() => portable.exportCurrentScope(), `${mode}: backup`);
    assert.equal(envelope.source.scopeKey, sourceScope.scopeKey);

    // The same session, moved into the updated bot.
    fixture.character.id = 'mira-bot-v2';
    fixture.character.chaId = 'mira-bot-v2';
    fixture.character.name = 'Mira (updated)';
    Object.assign(fixture.currentChat, { id: 'mira-v2-chat', chatId: 'mira-v2-chat', name: 'Moved session' });
    const moved = transcript('v2-moved');
    fixture.currentChat.message = moved;
    fixture.currentChat.messages = moved;
    const targetScope = await api.resolveCurrentScope(true);
    assert.notEqual(targetScope.scopeKey, sourceScope.scopeKey, `${mode}: the updated bot has its own scope`);
    // Storage mode is per chat scope; the user's server mode applies to the new bot's chat too.
    if (mode === 'server_only') await bridge.setMode(mode);
    assert.equal(await bridge.getMode(), mode, `${mode}: the updated bot's chat runs in the requested mode`);

    const originalText = moved[3].data;
    moved[3].data = 'At moonrise, Mira waits alone and nobody comes.';
    const diverged = await portable.inspectRestoreOptions(envelope);
    assert.equal(diverged.modes.updated_bot_rebind.allowed, false, `${mode}: changed text blocks the rebind`);
    assert.equal(diverged.modes.updated_bot_rebind.reason, 'updated_bot_transcript_mismatch');
    moved[3].data = originalText;

    const inspection = await portable.inspectRestoreOptions(envelope);
    assert.equal(inspection.modes.same_chat_replace.allowed, false, `${mode}: same-chat replace stays closed`);
    assert.equal(inspection.modes.chat_copy_rebind.allowed, false, `${mode}: same-actor copy stays closed`);
    assert.equal(inspection.modes.chat_copy_rebind.reason, 'source_actor_mismatch');
    assert.equal(inspection.modes.chat_migration_archive.allowed, false, `${mode}: same-actor migration stays closed`);
    assert.equal(inspection.modes.updated_bot_rebind.allowed, true, `${mode}: matching text opens the rebind`);
    await assert.rejects(idle(() => portable.restoreCurrentScope(envelope, { mode: 'chat_copy_rebind' }), `${mode}: copy refusal`), /채팅 복사 복구를 실행할 수 없습니다/,
      `${mode}: the existing copy path still refuses another bot`);

    // Background indexing of the original chat may still settle after ingest; the baseline is the
    // original bot's physical rows immediately before the rebind.
    const sourcePhysicalBefore = await physicalScopeRows(sourceScope.storageHash);
    assert.notEqual(sourcePhysicalBefore, '[]', `${mode}: the original bot's memories are stored`);
    const result = await idle(() => portable.rebindToUpdatedBot(envelope), `${mode}: rebind`);
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'updated_bot_rebind');
    assert.equal(result.updatedBotRebind, true);
    assert.equal(result.sourceCharacterId, 'mira-bot-v1');
    assert.equal(result.targetCharacterId, 'mira-bot-v2');
    assert.equal(result.scopeKey, targetScope.scopeKey);
    assert.equal(result.activeTurns, 2, `${mode}: both turns are rebound to the new worldline`);

    const targetLoaded = await api._test.loadScopeRecords(targetScope.scopeKey);
    assert.ok(targetLoaded.records.length >= 2, `${mode}: the updated bot reads the restored memories`);
    assert.ok(targetLoaded.records.every(record => record.scopeKey === targetScope.scopeKey),
      `${mode}: every restored memory carries the new scope`);
    assert.equal(await physicalScopeRows(sourceScope.storageHash), sourcePhysicalBefore,
      `${mode}: the original bot's stored memories are byte-for-byte unchanged`);

    // Flashback keys a scope by its storage hash: vector_rag_memory:scope:<storageHash>:...
    assert.ok(targetScope.storageHash, `${mode}: the target scope has a storage hash`);
    const ownsTarget = key => key.startsWith(`vector_rag_memory:scope:${targetScope.storageHash}:`);
    const localTargetKeys = (await pluginStorage.keys()).filter(ownsTarget);
    const remoteTargetKeys = serverKeys().filter(ownsTarget);
    if (mode === 'plugin_only') {
      assert.ok(localTargetKeys.length > 0, 'plugin_only: the restore lands in pluginStorage');
      assert.equal(remoteTargetKeys.length, 0, 'plugin_only: nothing is written to the server');
    } else {
      assert.ok(remoteTargetKeys.length > 0, `${mode}: the restore lands on the server`);
    }
    if (mode === 'server_only') {
      assert.ok(localTargetKeys.length < remoteTargetKeys.length,
        `server_only: the restored scope lives on the server (local ${localTargetKeys.length}, server ${remoteTargetKeys.length})`);
    }
    return { mode, localTargetKeys: localTargetKeys.length, remoteTargetKeys: remoteTargetKeys.length,
      storage: await portable.storageTarget() };
  } finally {
    await fixture?.dispose();
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) { console.log(`RUN ${mode}`); results.push(await run(mode)); }
  console.log(JSON.stringify(results));
  assert.match(results[0].storage, /플러그인 스토리지/);
  assert.match(results[1].storage, /미러/);
  assert.match(results[2].storage, /서버 저장소/);
  console.log('PASS flashback_portable_updated_bot_rebind_3mode_test');
  process.exit(0);
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
