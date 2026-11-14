'use strict';
// A RisuAI bot update is installed as a NEW character. A user who moves the same session into
// it gets a chat whose characterId, chatId and message IDs all differ from the backup, while the
// U+A text is identical. The portable restore must:
//   - keep every existing same-scope gate closed for that backup (no scope rule is widened),
//   - offer `rebind_updated_bot` only when the conversation text matches,
//   - write the adopted memories under the CURRENT chat's own scope, in the store the current
//     storage mode names (pluginStorage for plugin_only, the server for server_only, both for mirror),
//   - leave the original bot's scope untouched.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const parse = value => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
};
const portableApi = async snapshot => {
  const context = snapshot.f.r.context;
  for (let i = 0; i < 500; i += 1) {
    if (context.__LIBRAPortableMemoryBackup) return context.__LIBRAPortableMemoryBackup;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA portable API did not appear');
};
const idle = async (operation, label, attempts = 40) => {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return await operation(); } catch (error) {
      if (!/BUSY/.test(String(error?.code || ''))) throw error;
      last = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`LIBRA stayed busy for ${label}: ${last?.code || last}`);
};
const localRows = snapshot => [...snapshot.local.entries()].map(([key, raw]) => ({ key, value: parse(raw) }));
const manifestFor = (rows, chatId) => rows.find(row => /:manifest$/.test(row.key)
  && row.value?.schema === 'libra.manifest.v1' && row.value?.chatId === chatId) || null;

async function run(mode) {
  const snapshot = await serverFixture({ mode });
  try {
    const { f } = snapshot;
    await f.r.api.runManualColdStart({});
    const portable = await portableApi(snapshot);
    const envelope = await idle(() => portable.exportCurrentScope(), `${mode}: backup`);
    const sourceScopeKey = String(envelope.source.scopeKey);
    assert.ok(sourceScopeKey, `${mode}: backup carries its source scope`);
    assert.ok(envelope.lineage.batches.length >= 1, `${mode}: backup carries U+A lineage`);

    const authoritativeRows = () => mode === 'plugin_only' ? localRows(snapshot) : snapshot.storedRows();
    const sourceRowsBefore = new Map(authoritativeRows()
      .filter(row => row.key.includes(`:scope:${sourceScopeKey}:`))
      .map(row => [row.key, JSON.stringify(row.value)]));
    assert.ok(sourceRowsBefore.size > 0, `${mode}: the original bot has stored memory`);

    // The same session, moved into the updated bot: new character, new chat, new message IDs.
    const originalCharacter = { id: f.character.id, chaId: f.character.chaId, name: f.character.name };
    f.character.id = 'unified-char-v2';
    f.character.chaId = 'unified-char-v2';
    f.character.name = '민아 (업데이트)';
    f.chat.id = 'unified-chat-moved';
    f.chat.chatId = 'unified-chat-moved';
    f.chat.name = 'Moved session';
    f.chat.message.forEach((message, index) => { message.chatId = `moved-${index}`; });

    // A diverged transcript is never rebound.
    const originalText = f.chat.message[1].data;
    f.chat.message[1].data = `${originalText} (changed in the new bot)`;
    const diverged = await idle(() => portable.previewImport(envelope), `${mode}: diverged preview`);
    assert.equal(diverged.modes.rebind_updated_bot.available, false, `${mode}: changed text blocks the rebind`);
    assert.equal(diverged.modes.rebind_updated_bot.reason, 'no_contiguous_match');
    f.chat.message[1].data = originalText;

    const preview = await idle(() => portable.previewImport(envelope), `${mode}: preview`);
    assert.notEqual(String(preview.target.scopeKey), sourceScopeKey, `${mode}: the moved chat has its own scope`);
    assert.equal(preview.modes.restore_same_scope.available, false, `${mode}: same-scope replace stays closed`);
    assert.equal(preview.modes.reconstruct_native_copy.available, false, `${mode}: same-character copy stays closed`);
    assert.equal(preview.modes.reconstruct_native_copy.reason, 'character_mismatch');
    assert.equal(preview.modes.import_as_predecessor_archive.available, false, `${mode}: same-character migration stays closed`);
    assert.equal(preview.modes.rebind_updated_bot.available, true, `${mode}: matching text opens the updated-bot rebind`);
    assert.deepEqual(Array.from(preview.matchedStarts), Array.from(envelope.lineage.batches, batch => batch.startTurn));
    await assert.rejects(portable.reconstructCopiedChat(envelope), /portable_chat_copy_blocked:character_mismatch/,
      `${mode}: the existing copy path still refuses another character`);

    if (mode === 'plugin_only') {
      const targetPrefix = `libra:v1:scope:${preview.target.scopeKey}:`;
      const setItem = snapshot.backend.setItem;
      let droppedMemory = '';
      snapshot.backend.setItem = async (storageKey, value) => {
        const saved = await setItem(storageKey, value);
        const manifest = storageKey === `${targetPrefix}manifest` ? parse(value) : null;
        if (!droppedMemory && manifest?.portableImports?.some(receipt => receipt.updatedBotRebind && receipt.durable)) {
          droppedMemory = manifest.memories[String(preview.matchedStarts[0])].key;
          snapshot.local.delete(droppedMemory);
        }
        return saved;
      };
      try {
        await assert.rejects(idle(() => portable.rebindToUpdatedBot(envelope), 'rebind with missing record'),
          /portable_chat_copy_completion_readback_failed/);
      } finally {
        snapshot.backend.setItem = setItem;
      }
      assert.ok(droppedMemory, 'a restored record was removed before the final verification');
      assert.ok([...snapshot.local.keys()].every(key => !key.startsWith(`${targetPrefix}portable-import-journal:`)),
        'a failed final verification rolls back and clears its journal');
    }

    const sourceStart = Number(preview.matchedStarts[0]);
    const occupiedKey = `libra:v1:scope:${preview.target.scopeKey}:memory:${sourceStart}:r1`;
    const occupiedBody = {schema:'libra.canonical_memory.v1',scopeKey:preview.target.scopeKey,
      memoryId:`mem_${String(sourceStart).padStart(6,'0')}`,revision:1,status:'committed',
      turnRange:{start:sourceStart,end:sourceStart+4},sourceDigest:'earlier-branch',text:'keep this previous revision'};
    if(mode!=='plugin_only')await snapshot.mutate(occupiedKey,occupiedBody);
    if(mode!=='server_only')snapshot.local.set(occupiedKey,JSON.stringify(occupiedBody));
    const beforeRebindRequests = snapshot.requests.length;
    const result = await idle(() => portable.rebindToUpdatedBot(envelope), `${mode}: rebind`);
    assert.equal(result.ok, true, `${mode}: rebind succeeds`);
    assert.equal(result.receipt.updatedBotRebind, true);
    assert.equal(result.receipt.sourceCharacterId, originalCharacter.chaId);
    assert.equal(result.receipt.targetCharacterId, 'unified-char-v2');
    assert.equal(result.receipt.targetScopeKey, String(preview.target.scopeKey));
    assert.deepEqual(Array.from(result.copiedStarts), Array.from(preview.matchedStarts));
    assert.equal(result.receipt.reboundRevisions[sourceStart].targetRevision,2);

    const targetScopeKey = String(preview.target.scopeKey);
    const checkStore = (rows, label) => {
      const manifest = manifestFor(rows, 'unified-chat-moved');
      assert.ok(manifest, `${mode}: ${label} holds the moved chat's manifest`);
      assert.equal(manifest.value.scopeKey, targetScopeKey);
      assert.ok(manifest.key.startsWith(`libra:v1:scope:${targetScopeKey}:`), `${mode}: ${label} manifest key uses the new scope`);
      assert.equal(manifest.value.memories[String(sourceStart)].revision,2);
      assert.ok(manifest.value.memories[String(sourceStart)].history.some(ref=>ref.key===occupiedKey));
      assert.deepEqual(rows.find(row=>row.key===occupiedKey)?.value,occupiedBody);
      for (const start of preview.matchedStarts) {
        const ref = manifest.value.memories[String(start)];
        assert.equal(ref?.status, 'committed', `${mode}: ${label} T${start} is committed`);
        const memory = rows.find(row => row.key === ref.key)?.value;
        assert.ok(memory, `${mode}: ${label} T${start} memory body exists`);
        assert.equal(memory.scopeKey, targetScopeKey, `${mode}: ${label} T${start} memory carries the new scope`);
        assert.equal(memory.nativeCopiedFromScopeKey, sourceScopeKey);
        assert.deepEqual(memory.sourcePairs.map(pair => pair.userChatId).filter(Boolean).every(id => id.startsWith('moved-')), true,
          `${mode}: ${label} T${start} is bound to the moved chat's message IDs`);
      }
    };
    if (mode !== 'plugin_only') checkStore(snapshot.storedRows(), 'server');
    if (mode !== 'plugin_only') {
      const requestLog = snapshot.requests.slice(beforeRebindRequests);
      assert.ok(requestLog.some(request => request.url.endsWith('/v1/kv/set')),
        `${mode}: the restore exercised the server write route`);
      assert.ok(requestLog.some(request => /\/v1\/kv\/get\?/.test(request.url)
        && decodeURIComponent(request.url).includes(':portable-import-journal:')
        && /:entry:\d{8}(?:&|$)/.test(decodeURIComponent(request.url))),
        `${mode}: undo cleanup exercised the server route`);
      // Deletes have their own readback. Before cleanup starts, the server's
      // durable write receipt is sufficient to advance past each undo entry.
      const cleanupStart = requestLog.findIndex(request => request.url.endsWith('/v1/kv/remove'));
      assert.ok(cleanupStart > 0, `${mode}: undo cleanup ran`);
      assert.equal(requestLog.slice(0, cleanupStart).some(request => /\/v1\/kv\/get\?/.test(request.url)
        && /:portable-import-journal:[^:]+:entry:\d{8}(?:&|$)/.test(decodeURIComponent(request.url))), false,
        `${mode}: no per-entry server readback before journal cleanup`);
    }
    if (mode !== 'server_only') checkStore(localRows(snapshot), 'pluginStorage');
    if (mode === 'server_only') {
      assert.equal(manifestFor(localRows(snapshot), 'unified-chat-moved'), null,
        'server_only: the rebind does not write the manifest into pluginStorage');
    }

    const sourceRowsAfter = new Map(authoritativeRows()
      .filter(row => row.key.includes(`:scope:${sourceScopeKey}:`))
      .map(row => [row.key, JSON.stringify(row.value)]));
    assert.deepEqual([...sourceRowsAfter.keys()].sort(), [...sourceRowsBefore.keys()].sort(), `${mode}: original bot key set unchanged`);
    for (const [key, value] of sourceRowsBefore) assert.equal(sourceRowsAfter.get(key), value, `${mode}: original bot record unchanged: ${key}`);

    const again = await idle(() => portable.rebindToUpdatedBot(envelope), `${mode}: repeat`);
    assert.equal(again.skipped, true, `${mode}: a repeated rebind is recognized as already complete`);
    return { mode, copiedStarts: Array.from(result.copiedStarts), targetScopeKey, storage: await portable.storageTarget() };
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) {
    console.log(`RUN ${mode}`);
    results.push(await run(mode));
  }
  console.log(JSON.stringify(results, null, 1));
  assert.match(results[0].storage, /플러그인 스토리지/);
  assert.match(results[1].storage, /미러/);
  assert.match(results[2].storage, /서버 저장소/);
  for (const result of results.slice(1)) assert.deepEqual(result.copiedStarts, results[0].copiedStarts);
  process.stdout.write('libra_portable_updated_bot_rebind_3mode_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
