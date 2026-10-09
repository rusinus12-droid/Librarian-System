'use strict';

// Startup recall regression: source-edit observation needs every stored U+A
// record for identity comparison, but it must not hydrate dense-vector sidecars
// before the real recall stage. A blocked/large sidecar previously consumed the
// whole beforeRequest preparation budget and made an optional consent observer
// suppress recall injection.

const assert = require('node:assert/strict');
const path = require('node:path');
const PROGRAM = path.resolve(__dirname, '..');
const { createFixture } = require(path.join(PROGRAM, 'tests', 'fixtures', 'flashback_native_runtime_fixture.cjs'));

const USER = 'Where is the brass key?';
const MEMORY = 'The brass key is under the blue lamp.';
const USER_TWO = 'Who guards the map?';
const MEMORY_TWO = 'Mira guards the map beside the blue lamp.';

const countVectorReads = store => {
  const original = store.getItem.bind(store);
  let reads = 0;
  store.getItem = async key => {
    if (String(key).includes(':local-vector-shard:v1:')) reads += 1;
    return await original(key);
  };
  return { reads: () => reads };
};

const commitShardKey = (store, commitId, shardIndex) => Array.from(store.values.keys())
  .find(key => String(key).includes(`:commit:${commitId}:shard:${String(shardIndex).padStart(4, '0')}`));

(async () => {
  let fixture = await createFixture({
    chat: { id: 'source-rawtext-chat', chatId: 'source-rawtext-chat', message: [
      { role: 'user', chatId: 'u1', data: USER },
      { role: 'assistant', chatId: 'a1', data: MEMORY },
      { role: 'user', chatId: 'u2', data: USER_TWO },
      { role: 'assistant', chatId: 'a2', data: MEMORY_TWO }
    ] }
  });
  const pluginStorage = fixture.pluginStorage;
  const safeLocalStorage = fixture.host.safeLocalStorage;
  let chat;
  let character;
  let scope;
  let commitId;
  try {
    const api = fixture.api;
    const t = api._test;
    scope = await api.resolveCurrentScope();
    await t.saveAllRecords([{
      id: 'source-observation-record-1', hash: 'source-observation-record-1', type: 'response', sourceType: 'response',
      text: MEMORY, userText: USER, responseTurnIndex: 1, pairIndex: 1, dim: 4, vector: [1, 0, 0, 0]
    }, {
      id: 'source-observation-record-2', hash: 'source-observation-record-2', type: 'response', sourceType: 'response',
      text: MEMORY_TWO, userText: USER_TWO, responseTurnIndex: 2, pairIndex: 2, dim: 4, vector: [0, 1, 0, 0]
    }], { shardSize: 1 }, scope);
    const manifest = await t.loadScopeManifest(scope.scopeKey);
    assert.equal(manifest.shardCount, 2, 'fixture must persist two canonical shards');
    assert.equal(manifest.vectorSidecarCount, 2, 'fixture must persist one vector sidecar per shard');
    commitId = manifest.commitId;
    chat = structuredClone(fixture.currentChat);
    character = structuredClone(fixture.character);
  } finally {
    await fixture.dispose();
  }

  fixture = await createFixture({ pluginStorage, safeLocalStorage, chat, character });
  try {
    const api = fixture.api;
    const t = api._test;
    const reads = countVectorReads(safeLocalStorage);

    const snapshot = await t.flashbackSourceEditSnapshot();
    assert.equal(snapshot.units.length, 2, 'source observation retains U+A identities from every shard');
    assert.equal(reads.reads(), 0, 'source observation must not read vector sidecars');

    const recalled = await t.loadScopeRecords(scope.scopeKey);
    assert.equal(recalled.records.length, 2, 'normal loader retains every canonical shard');
    assert.ok(recalled.records.every(record => record.vector.length > 0), 'normal recall loader still hydrates vectors');
    assert.ok(reads.reads() > 0, 'normal recall must retain vector-sidecar hydration');
  } finally {
    await fixture.dispose();
  }

  fixture = await createFixture({ pluginStorage, safeLocalStorage, chat, character });
  try {
    const key = commitShardKey(pluginStorage, commitId, 1);
    assert.ok(key, 'second fixture commit shard exists');
    pluginStorage.values.set(key, '{broken');
    await assert.rejects(
      () => fixture.api._test.flashbackSourceEditSnapshot(),
      error => ['FLASHBACK_STORAGE_SHARDS_MISSING', 'FLASHBACK_STORAGE_RECORD_COUNT_MISMATCH'].includes(error?.code),
      'source observation must reject a corrupt canonical shard rather than treating it as an empty store'
    );
  } finally {
    await fixture.dispose();
  }

  console.log('flashback_source_edit_rawtext_recall_test: PASS');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
