'use strict';
// A: the existing dispatch/dispose ordering drains admitted official-output work.
// B: a separate call after full disposal is refused, then a fresh runtime recovers absent raw data.
// The official-listener-observed-but-worker-not-entered interleaving is NOT verified here.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const USER = 'I check the gauge and step back.';
const REPLY = 'The needle holds at the red mark and the spare valve hangs on the north wall hook.';
const FACT = 'needle holds at the red mark';
const QUERY = 'What did the gauge show, and where is the spare valve?';
const BODY = `User:\n${USER}\n\n---\n\nAssistant:\n${REPLY}`;
const { syntheticFetch, configure, readyForRecall } = require('./helpers/unload_recall_contract_fixture.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 7000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
};

// Independent fixed-input expectations, derived before execution from the pinned producer formulas.
// Native fixture defaults define A; supported characterId/chat inputs define B. No ignored character option.
const DRAIN = Object.freeze({ characterId: 'flashback-character', chatId: 'flashback-host-chat',
  scopeKey: 'char:lrahdw|chat:1bcs1l8', storageHash: '3ntqoh',
  sourceId: 'risu_chat_output_revision:176gsor', sourceHash: '933kjj', recordId: 'vrm_1hgznbg' });
const LATE = Object.freeze({ characterId: 'flashback-post-unload-character', chatId: 'flashback-post-unload-chat',
  scopeKey: 'char:1e0aw93|chat:h9ed4e', storageHash: '1gobs40',
  sourceId: 'live_chat:h9ed4e:0-1:dg4ufs', sourceHash: 'dg4ufs', recordId: 'vrm_r98y0q' });
const plain = value => JSON.parse(JSON.stringify(value));
const parseStored = value => typeof value === 'string' ? JSON.parse(value) : plain(value);
const scopePrefix = expected => `vector_rag_memory:scope:${expected.storageHash}:`;
const manifestKey = expected => `${scopePrefix(expected)}manifest:v2`;
const sourceIdentity = records => JSON.stringify(records.map(row =>
  [row.id, row.scopeKey, row.sourceId, row.sourceHash, row.text, row.sourceMessageIds, row.chunkIndex, row.chunkCount]));
const storeSnapshot = stores => JSON.stringify([stores.pluginStorage, stores.localStorage].map(store =>
  [...store.values.entries()].sort(([a], [b]) => a.localeCompare(b))));
const assertFixtureIdentity = async (fixture, expected) => {
  assert.equal(fixture.character.id, expected.characterId);
  assert.equal(fixture.character.chaId, expected.characterId);
  assert.equal(fixture.currentChat.id, expected.chatId);
  assert.equal(fixture.currentChat.chatId, expected.chatId);
  assert.equal(fixture.character.chats[0], fixture.currentChat);
  const scope = await fixture.api.resolveCurrentScope();
  for (const key of ['characterId', 'chatId', 'scopeKey', 'storageHash']) assert.equal(scope[key], expected[key]);
  assert.equal(scope.canonicalCharacterId, expected.characterId);
  assert.equal(scope.canonicalChatId, expected.chatId);
  assert.equal(scope.canonicalScopeId, expected.scopeKey);
  return scope;
};
const assertSource = (row, expected) => {
  assert.equal(row.scopeKey, expected.scopeKey);
  assert.equal(row.sourceType, 'response');
  assert.equal(row.sourceId, expected.sourceId);
  assert.equal(row.sourceHash, expected.sourceHash);
  assert.equal(row.text, BODY, 'the exact intended U+A source survives');
  assert.equal(row.role, 'turn_pair');
  assert.equal(row.pairIndex, 1);
  assert.equal(row.turnIndex, 1);
  assert.equal(row.userMessagePosition, 1);
  assert.equal(row.assistantMessagePosition, 2);
  assert.equal(row.chunkIndex, 0);
  assert.equal(row.chunkCount, 1);
  assert.equal(row.id, expected.recordId, 'the canonical record ID binds the independently specified source');
  assert.ok(row.sourceMessageIds.includes('u1') && row.sourceMessageIds.includes('a1'), 'both native message IDs bind the source');
};
const assertComplete = (loaded, expected) => {
  assert.equal(loaded.manifest.scopeKey, expected.scopeKey);
  assert.equal(loaded.manifest.missingShards, 0);
  assert.equal(loaded.manifest.corruptShards, 0);
  assert.equal(loaded.manifest.recordCountMismatch, false);
  assert.notEqual(loaded.manifest.manifestCorrupt, true);
  assert.equal(loaded.records.length, 1);
  assertSource(loaded.records[0], expected);
};
const readDurableSource = async (stores, expected) => {
  const manifestRaw = await stores.pluginStorage.getItem(manifestKey(expected));
  assert.ok(manifestRaw, 'the actual backing store contains a canonical manifest');
  const manifest = parseStored(manifestRaw);
  assert.equal(manifest.scopeKey, expected.scopeKey);
  assert.equal(manifest.characterId, expected.characterId);
  assert.equal(manifest.chatId, expected.chatId);
  assert.equal(manifest.canonicalCharacterId, expected.characterId);
  assert.equal(manifest.canonicalChatId, expected.chatId);
  assert.equal(manifest.storageHash, expected.storageHash);
  assert.equal(manifest.count, 1);
  assert.equal(manifest.shardCount, 1);
  assert.ok(typeof manifest.commitId === 'string' && manifest.commitId.length > 0);
  // A single short source cannot enter the full-page append/reuse branch.
  assert.equal(manifest.rawPageReferences, undefined);
  const shardKey = `${scopePrefix(expected)}records:commit:${manifest.commitId}:shard:0000`;
  const shardRaw = await stores.pluginStorage.getItem(shardKey);
  assert.ok(shardRaw, 'the manifest-selected physical shard exists');
  const shard = parseStored(shardRaw);
  assert.equal(shard.scopeKey, expected.scopeKey);
  assert.equal(shard.commitId, manifest.commitId);
  assert.equal(shard.shard, 0);
  assert.equal(shard.records.length, 1);
  assertSource(shard.records[0], expected);
  return { manifest, shardKey, shardRaw, records: shard.records };
};
const assertEmptyDurable = async (stores, expected) => {
  // In this isolated empty fixture, source text, vector/receipt rows and historical raw generations
  // have no legitimate producer. Check physical keys, not only a filtered current-record API.
  for (const store of [stores.pluginStorage, stores.localStorage]) {
    const keys = [...store.values.keys()];
    assert.deepEqual(keys.filter(key => key.startsWith('vector_rag_memory:scope:') && key.includes(':records:')), []);
    assert.deepEqual(keys.filter(key => key.startsWith('vector_rag_memory:local-vector-shard:v1:')), []);
    for (const key of keys.filter(key => key.startsWith('vector_rag_memory:scope:') && key.endsWith(':manifest:v2'))) {
      assert.equal(key, manifestKey(expected), 'no foreign canonical scope appears in the empty stores');
      const manifest = parseStored(await store.getItem(key));
      assert.equal(manifest.scopeKey, expected.scopeKey);
      assert.equal(manifest.count, 0);
      assert.equal(manifest.shardCount, 0);
      assert.equal(manifest.archiveRef == null, true, 'absence cannot conceal an archived source');
      assert.equal(Number(manifest.vectorSidecarCount || 0), 0);
      if (manifest.embeddingAttemptRegistry !== undefined) {
        const registry = parseStored(manifest.embeddingAttemptRegistry);
        assert.equal(registry.scopeKey, expected.scopeKey);
        assert.deepEqual(Object.keys(registry.entries), [], 'no reserved/submitted embedding attempt or recovery receipt');
      }
    }
  }
};

const runDrain = async mode => {
  let fixture = null;
  let fresh = null;
  try {
    fixture = await createFixture({ nativeFetch: syntheticFetch, arguments: { memory_suite_server_mode: 'plugin_only' } });
    const api = fixture.api;
    await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.registered && state.backend === 'chat_output_v3' ? state : null;
    }, 'registered official output listener');
    await configure(fixture, mode);
    await assertFixtureIdentity(fixture, DRAIN);
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
    await delay(50);
    fixture.currentChat.message = [
      { role: 'user', chatId: 'u1', data: USER },
      { role: 'assistant', chatId: 'a1', data: REPLY }
    ];
    fixture.currentChat.messages = fixture.currentChat.message;
    const pluginStorage = fixture.pluginStorage;
    const localStorage = fixture.host.safeLocalStorage;
    const stores = { pluginStorage, localStorage };
    const chat = structuredClone(fixture.currentChat);
    const baselineRuns = api.getCaptureBackendState().observedRuns;

    const dispatch = fixture.dispatchRisuChatEvent('output', {
      char: fixture.character, chat: fixture.currentChat, characterIndex: 0, chatIndex: 0, messageIndex: 1
    });
    assert.equal(api.getCaptureBackendState().observedRuns, baselineRuns + 1,
      'the official listener synchronously observes the host output event');
    // Preserve the original ordering: the later portable unload handler yields before core unload,
    // allowing the official output microtask to enter the queue which core unload then drains.
    const unload = fixture.dispose();
    const [listenerCount] = await Promise.all([dispatch, unload]);
    assert.equal(listenerCount, 1, 'exactly the registered official listener handled dispatch');
    fixture = null;
    const drained = await readDurableSource(stores, DRAIN);
    assert.equal(drained.records[0].vector.length, 0);
    assert.equal(drained.records[0].vectorRef == null, true);
    assert.equal(drained.records[0].embeddingReceipt == null, true, 'admitted raw capture does not fabricate readiness');

    fresh = await createFixture({ nativeFetch: syntheticFetch, pluginStorage, safeLocalStorage: localStorage, chat,
      arguments: { memory_suite_server_mode: 'plugin_only' } });
    assert.equal(fresh.pluginStorage, pluginStorage);
    assert.equal(fresh.host.safeLocalStorage, localStorage);
    const freshApi = fresh.api;
    await configure(fresh, mode);
    const scope = await assertFixtureIdentity(fresh, DRAIN);
    const beforeColdStart = await freshApi._test.loadScopeRecords(scope.scopeKey);
    assert.equal(beforeColdStart.records.some(record => String(record.text || '').includes(FACT)), true,
      'A: admitted official-output work persisted before fresh cold-start reconciliation');
    assertComplete(beforeColdStart, DRAIN);
    assert.equal(beforeColdStart.manifest.commitId, drained.manifest.commitId);
    assert.equal(await pluginStorage.getItem(drained.shardKey), drained.shardRaw, 'restart preserves the exact durable raw shard bytes');
    assert.equal(sourceIdentity(beforeColdStart.records), sourceIdentity(drained.records));
    const coldStart = await freshApi.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    assert.equal(coldStart.scopeKey, DRAIN.scopeKey);
    const restored = await waitFor(async () => {
      const readback = await freshApi._test.loadScopeRecords(scope.scopeKey);
      return readback.records.some(record => String(record.text || '').includes(FACT)) ? readback : null;
    }, 'cold-start confirmation of the admitted durable live-chat source');
    assertComplete(restored, DRAIN);
    assert.equal(sourceIdentity(restored.records), sourceIdentity(beforeColdStart.records), 'A confirmation preserves canonical/source identity and bytes');
    const recallProof = await readyForRecall(fresh, mode, FACT);
    const messages = await freshApi._selectionTest.beforeRequest([{ role: 'user', chatId: 'u8', content: QUERY }], 'model');
    assert.equal(JSON.stringify(messages ?? null).includes(FACT), mode === 'configured',
      'raw-only recovery stays unconfigured; configured recovery injects source-bound semantic evidence');
    const final = await freshApi._test.loadScopeRecords(scope.scopeKey);
    assertComplete(final, DRAIN);
    const durableFinal = await readDurableSource(stores, DRAIN);
    assert.equal(sourceIdentity(durableFinal.records), sourceIdentity(drained.records));
    assert.equal(final.manifest.commitId, durableFinal.manifest.commitId);
    process.stdout.write(JSON.stringify({
      test: 'flashback_chat_output_unload_microtask_recovery', scenario: 'A_admitted_dispatch_drain',
      listenerObserved: true, listenerCount, officialPreWorkerCancellationVerified: false,
      preColdStartCanonicalCount: beforeColdStart.records.length, recoveredCanonicalCount: restored.records.length,
      mode, recallProof, recoveredAndInjected: JSON.stringify(messages ?? null).includes(FACT)
    }) + '\n');
    return stores;
  } finally {
    await fixture?.dispose?.().catch(() => null);
    await fresh?.dispose?.().catch(() => null);
  }
};

const runPostUnload = async (mode, drainStores) => {
  let fixture = null;
  let fresh = null;
  try {
    const emptyChat = { id: LATE.chatId, chatId: LATE.chatId, name: 'Host', message: [], messages: [] };
    fixture = await createFixture({ nativeFetch: syntheticFetch, characterId: LATE.characterId, chat: emptyChat,
      arguments: { memory_suite_server_mode: 'plugin_only' } });
    const api = fixture.api;
    await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.registered && state.backend === 'chat_output_v3' ? state : null;
    }, 'registered official output listener in the separate empty fixture');
    await configure(fixture, mode);
    await assertFixtureIdentity(fixture, LATE);
    const stores = { pluginStorage: fixture.pluginStorage, localStorage: fixture.host.safeLocalStorage };
    assert.notEqual(stores.pluginStorage, drainStores.pluginStorage);
    assert.notEqual(stores.localStorage, drainStores.localStorage);
    assert.notEqual(stores.pluginStorage, stores.localStorage);
    assert.deepEqual(plain(fixture.currentChat.message), []);
    assert.deepEqual(plain(fixture.currentChat.messages), []);
    const empty = await api._test.loadScopeRecords(LATE.scopeKey);
    assert.equal(empty.records.length, 0);
    await assertEmptyDurable(stores, LATE);
    // Keep the intended completed input outside the old live host. No old beforeRequest/pending capture.
    const chat = structuredClone(fixture.currentChat);
    chat.message = [{ role: 'user', chatId: 'u1', data: USER }, { role: 'assistant', chatId: 'a1', data: REPLY }];
    chat.messages = chat.message;
    const event = { char: structuredClone(fixture.character), chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 };
    await fixture.dispose();
    fixture = null;
    await assertEmptyDurable(stores, LATE);
    const afterDispose = storeSnapshot(stores);
    const refused = await api._test.processRisuChatOutputEvent(event);
    assert.deepEqual(Object.keys(refused).sort(), ['ok', 'reason', 'skipped']);
    assert.deepEqual(plain(refused), { ok: false, skipped: true, reason: 'unloaded' });
    assert.equal(storeSnapshot(stores), afterDispose, 'post-unload refusal cannot mutate either backing store');
    await assertEmptyDurable(stores, LATE);

    fresh = await createFixture({ nativeFetch: syntheticFetch, pluginStorage: stores.pluginStorage,
      safeLocalStorage: stores.localStorage, characterId: LATE.characterId, chat,
      arguments: { memory_suite_server_mode: 'plugin_only' } });
    assert.equal(fresh.pluginStorage, stores.pluginStorage);
    assert.equal(fresh.host.safeLocalStorage, stores.localStorage);
    const freshApi = fresh.api;
    await configure(fresh, mode);
    const scope = await assertFixtureIdentity(fresh, LATE);
    assert.deepEqual(plain(fresh.currentChat.message), [
      { role: 'user', chatId: 'u1', data: USER }, { role: 'assistant', chatId: 'a1', data: REPLY }
    ]);
    const beforeColdStart = await freshApi._test.loadScopeRecords(scope.scopeKey);
    assert.equal(beforeColdStart.records.length, 0);
    assert.equal(beforeColdStart.records.some(record => String(record.text || '').includes(FACT)), false,
      'B: the actual unloaded refusal left no source for the fresh runtime');
    assert.equal(beforeColdStart.manifest.missingShards, 0);
    assert.equal(beforeColdStart.manifest.corruptShards, 0);
    assert.equal(beforeColdStart.manifest.recordCountMismatch, false);
    await assertEmptyDurable(stores, LATE);
    const coldStart = await freshApi.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    assert.equal(coldStart.scopeKey, LATE.scopeKey);
    assert.equal(coldStart.sources, 1);
    assert.equal(coldStart.missingTurns, 1, 'B recovered the previously absent intended source');
    const restored = await waitFor(async () => {
      const readback = await freshApi._test.loadScopeRecords(scope.scopeKey);
      return readback.records.some(record => String(record.text || '').includes(FACT)) ? readback : null;
    }, 'cold-start recovery after the separate post-unload refusal');
    assertComplete(restored, LATE);
    const recovered = await readDurableSource(stores, LATE);
    assert.equal(restored.manifest.commitId, recovered.manifest.commitId);
    assert.equal(sourceIdentity(restored.records), sourceIdentity(recovered.records));
    const recallProof = await readyForRecall(fresh, mode, FACT);
    const messages = await freshApi._selectionTest.beforeRequest([{ role: 'user', chatId: 'u8', content: QUERY }], 'model');
    assert.equal(JSON.stringify(messages ?? null).includes(FACT), mode === 'configured',
      'raw-only recovery stays unconfigured; configured recovery injects source-bound semantic evidence');
    const final = await freshApi._test.loadScopeRecords(scope.scopeKey);
    assertComplete(final, LATE);
    const durableFinal = await readDurableSource(stores, LATE);
    assert.equal(sourceIdentity(durableFinal.records), sourceIdentity(recovered.records));
    assert.equal(final.manifest.commitId, durableFinal.manifest.commitId);
    process.stdout.write(JSON.stringify({
      test: 'flashback_chat_output_unload_microtask_recovery', scenario: 'B_post_unload_absent_recovery',
      listenerObserved: false, officialPreWorkerCancellationVerified: false, postUnloadResult: plain(refused),
      preColdStartCanonicalCount: beforeColdStart.records.length, recoveredCanonicalCount: restored.records.length,
      mode, recallProof, recoveredAndInjected: JSON.stringify(messages ?? null).includes(FACT)
    }) + '\n');
  } finally {
    await fixture?.dispose?.().catch(() => null);
    await fresh?.dispose?.().catch(() => null);
  }
};
(async () => {
  for (const mode of ['raw-only', 'configured']) {
    const drainStores = await runDrain(mode);
    await runPostUnload(mode, drainStores);
  }
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
