'use strict';
// C.3: public derived-index rebuild, canonical preservation, and stale-derived negative control.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const FACT = 'The beacon glows crimson at night.';
const STALE = 'The beacon glows violet at night.';
const QUERY = 'What color does the beacon glow at night?';
const SOURCE_TIME = '2026-09-25T00:00:00.000Z';
const SETTINGS = {
  embeddingProvider: 'hash', embeddingModel: 'hash-64', hashDimensions: 64, embeddingEnabled: true,
  episodeIndexEnabled: true, episodeHierarchyEnabled: false, episodeMinRecords: 1,
  captureAfterRequest: true, hookRecallTimeoutMs: 5000, maxInjectionChars: 6000
};
const stableSource = record => ({ id: record.id, text: record.text, vector: record.vector,
  sourceHash: record.sourceHash, sourceMessageIds: record.sourceMessageIds,
  rawDigest: record.metadata?.sourceRawDigest });
const MODES = ['plugin_only', 'mirror', 'server_only'];

async function checkMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flashback-episode-c3-${mode}-`));
  let app = null;
  let fixture = null;
  const networkCalls = [];
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    fixture = await createFixture({
      exposeStorageBridge: true,
      arguments: { memory_suite_server_mode: mode, memory_suite_server_url: serverUrl },
      nativeFetch: async (url, options) => {
        networkCalls.push({ url: String(url), method: String(options?.method || 'GET') });
        return await fetch(url, options);
      }
    });
    const api = fixture.api;
    const t = api._test;
    const bridge = fixture.context.__fixtureStorageBridge;
    // mirror is imported from the historical argument fixture; it is no longer selectable.
    if (mode !== 'plugin_only' && mode !== 'mirror') await bridge.setMode(mode);
    assert.equal(await bridge.getMode(), mode, `${mode}: scope storage mode is selected`);
    await api.saveSettings({ ...await api.loadSettings(), ...SETTINGS });
    const scope = await api.resolveCurrentScope();
    const settings = { ...await api.loadSettings(), ...SETTINGS };
    const records = [];
    for (let turn = 1; turn <= 8; turn += 1) {
      const response = turn === 1
        ? 'A brass key rests in the lower alcove.'
        : `The crew returns to the cavern after observation ${turn}.`;
      const userObservation = turn === 1 ? `I record this: ${FACT}` : 'I inspect the beacon in the cavern and check its glass lens.';
      const body = `User:\n${userObservation}\n\n---\n\nAssistant:\n${response}`;
      const cleaned = t.cleanRecordForMemory({
        id: `episode-c3-record-${turn}`, sourceType: 'response', sourceId: `episode-c3-chat:turn:${turn}`,
        text: body, title: `Observation ${turn}`, scopeKey: scope.scopeKey, pairIndex: turn, turnIndex: turn,
        tags: [], tokenCount: 16, tokens: 16, vector: t.hashEmbedding(body, 64), dim: 64,
        provider: 'hash', model: 'hash-64', embeddingProvider: 'hash', embeddingModel: 'hash-64',
        embeddingDimensions: 64, createdAt: SOURCE_TIME, updatedAt: SOURCE_TIME,
        lifecycleStatus: 'active', sourceHash: `episode-c3-source-${turn}`
      }, scope, { authoritativeSource: true }).record;
      assert.ok(cleaned, `response ${turn} is accepted as a canonical record`);
      records.push(cleaned);
    }
    await t.saveAllRecords(records, settings, scope);
    const canonicalFirst = (await t.loadScopeRecords(scope.scopeKey)).records.filter(record => record.sourceType !== 'episode_index');
    const baselineSourceBytes = JSON.stringify(canonicalFirst.map(stableSource));

    // The public owner entry point must rebuild a deliberately absent derived index from canonical rows.
    const firstRebuild = await api.rebuildEpisodeIndex(scope);
    assert.equal(firstRebuild.rebuilt, true, `public rebuild executes: ${JSON.stringify(firstRebuild)}`);
    const afterFirstRebuild = await t.loadScopeRecords(scope.scopeKey);
    const firstEpisodes = afterFirstRebuild.records.filter(record => record.autoEpisode || record.sourceType === 'episode_index');
    assert.ok(firstEpisodes.length > 0, 'episode rows survive durable readback after public rebuild');
    assert.ok(firstEpisodes.some(record => String(record.text || '').includes(FACT)), `derived episode records summarize the canonical source text: ${JSON.stringify(firstEpisodes.map(record => record.text))}`);
    assert.equal(JSON.stringify(afterFirstRebuild.records.filter(record => record.sourceType !== 'episode_index').map(stableSource)), baselineSourceBytes,
      'episode rebuild preserves canonical response text, vector, source hash and source identity bytes');

    // Remove only the episode rows, verify canonical bytes, then invoke the public rebuild again.
    await t.saveAllRecords(canonicalFirst, settings, scope);
    const afterRemoval = await t.loadScopeRecords(scope.scopeKey);
    assert.equal(afterRemoval.records.some(record => record.autoEpisode || record.sourceType === 'episode_index'), false,
      'derived episode rows can be removed while canonical responses remain');
    assert.equal(JSON.stringify(afterRemoval.records.map(stableSource)), baselineSourceBytes,
      'removing derived rows leaves canonical response bytes intact');
    assert.equal((await t.loadScopeRecords(scope.scopeKey)).records.some(record => record.autoEpisode || record.sourceType === 'episode_index'), false,
      'derived episode rows are absent immediately before the removal-path request');
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-without-index-warm', content: QUERY }], 'model');
    const withoutIndex = await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-without-index', content: QUERY }], 'model');
    const withoutIndexText = JSON.stringify(withoutIndex ?? null);
    const afterRemovalRequest = await t.loadScopeRecords(scope.scopeKey);
    const indexAbsentDuringRecall = !afterRemovalRequest.records.some(record => record.autoEpisode || record.sourceType === 'episode_index');
    assert.ok(withoutIndexText.includes(FACT), 'the first request after index removal injects the canonical fact');
    const secondRebuild = await api.rebuildEpisodeIndex(scope);
    assert.equal(secondRebuild.rebuilt, true, `public rebuild restores removed rows: ${JSON.stringify(secondRebuild)}`);
    const afterSecondRebuild = await t.loadScopeRecords(scope.scopeKey);
    const rebuiltEpisodes = afterSecondRebuild.records.filter(record => record.autoEpisode || record.sourceType === 'episode_index');
    assert.ok(rebuiltEpisodes.length > 0, 'rebuilt rows are durable after readback');

    // Exercise the final host request hook after index removal and after reconstruction.
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-after-rebuild-warm', content: QUERY }], 'model');
    const afterRebuild = await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-after-rebuild', content: QUERY }], 'model');
    const afterRebuildText = JSON.stringify(afterRebuild ?? null);
    assert.ok(afterRebuildText.includes(FACT), 'a final beforeRequest injects the same canonical fact after index reconstruction');

    const serverRowsWithCanonical = app.repositories.flashback.list('plugin', '').records || [];
    const localValuesWithCanonical = [...fixture.pluginStorage.values.values()].map(value => JSON.stringify(value));
    const localHasCanonical = localValuesWithCanonical.some(value => value.includes('episode-c3-record-1') || value.includes(FACT));
    const localCanonicalKeys = [...fixture.pluginStorage.values.keys()].map(String)
      .filter(key => /:records:commit:|:records:shard:/.test(key));
    if (mode === 'plugin_only') {
      assert.equal(networkCalls.length, 0, 'plugin_only episode rebuild and recall make zero server calls');
      assert.equal(serverRowsWithCanonical.length, 0, 'plugin_only stores no derived or canonical server rows');
      assert.ok(localHasCanonical, 'plugin_only keeps canonical rows locally');
    } else if (mode === 'mirror') {
      assert.ok(serverRowsWithCanonical.length > 0, 'mirror projects canonical and episode rows to the server');
      assert.ok(localHasCanonical, 'mirror retains canonical rows locally');
    } else {
      assert.ok(serverRowsWithCanonical.length > 0, 'server_only stores canonical and episode rows on the server');
      assert.equal(localHasCanonical, false, 'server_only does not retain canonical response text locally');
      assert.equal(localCanonicalKeys.length, 0, 'server_only has no local canonical shard keys');
    }

    // Missing-canonical negative control: preserve the original valid derived rows and key payload
    // fields, but remove every response record. This isolates canonical absence from derived corruption.
    fixture.currentChat.message = [];
    fixture.currentChat.messages = [];
    const validEpisodeFields = JSON.stringify(rebuiltEpisodes.map(record => ({ id: record.id, text: record.text,
      vector: record.vector, hash: record.hash, sourceHash: record.sourceHash, childIds: record.childIds })));
    assert.ok(rebuiltEpisodes.some(record => String(record.text || '').includes(FACT)), 'valid derived episode contains the source fact');
    await t.saveAllRecords(rebuiltEpisodes, settings, scope);
    const missingCanonical = await t.loadScopeRecords(scope.scopeKey);
    assert.equal(missingCanonical.records.some(record => record.sourceType !== 'episode_index' && !record.autoEpisode), false,
      'negative control has no canonical response rows');
    const validEpisodesAfterRemoval = missingCanonical.records.filter(record => record.autoEpisode || record.sourceType === 'episode_index');
    assert.equal(JSON.stringify(validEpisodesAfterRemoval.map(record => ({ id: record.id, text: record.text,
      vector: record.vector, hash: record.hash, sourceHash: record.sourceHash, childIds: record.childIds }))), validEpisodeFields,
    'valid episode key fields are preserved while the canonical response is absent');
    const missingCanonicalRequest = await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-missing-canonical', content: QUERY }], 'model');
    const missingCanonicalInjection = JSON.stringify(missingCanonicalRequest ?? null);
    assert.ok(!missingCanonicalInjection.includes(FACT),
      'first expected missing-canonical negative assertion: valid derived episode text is not injected as canonical evidence');

    // Separate corruption control: preserve valid canonical rows while altering only a derived episode
    // body. The final hook must inject the canonical fact and exclude stale text, isolating corruption.
    const corruptedEpisodes = validEpisodesAfterRemoval.map(record => ({ ...record, text: STALE }));
    await t.saveAllRecords([...canonicalFirst, ...corruptedEpisodes], settings, scope);
    const corruptOnly = await t.loadScopeRecords(scope.scopeKey);
    assert.ok(corruptOnly.records.some(record => record.sourceType === 'episode_index' && String(record.text || '').includes(STALE)),
      'corruption control contains deliberately stale derived text');
    assert.ok(corruptOnly.records.some(record => record.sourceType !== 'episode_index' && !record.autoEpisode && String(record.text || '').includes(FACT)),
      'corruption control retains the valid canonical response');
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-corrupt-derived-warm', content: QUERY }], 'model');
    const corruptionRequest = await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'c3-corrupted-derived', content: QUERY }], 'model');
    const corruptionInjection = JSON.stringify(corruptionRequest ?? null);
    assert.ok(corruptionInjection.includes(FACT) && !corruptionInjection.includes(STALE),
      'separate corruption-control assertion: canonical fact injects while stale text in the damaged derived body does not');
    return {
      mode, networkCalls: networkCalls.length, serverRowsWithCanonical: serverRowsWithCanonical.length,
      localHasCanonical, localCanonicalShardCount: localCanonicalKeys.length,
      canonicalSourceCount: canonicalFirst.length,
      firstRebuild: { episodes: firstEpisodes.length, digest: firstRebuild.digest },
      secondRebuild: { episodes: rebuiltEpisodes.length, digest: secondRebuild.digest },
      sourceBytesStable: true, indexAbsentDuringRecall, beforeRebuildInjection: withoutIndexText.includes(FACT),
      afterRebuildInjection: afterRebuildText.includes(FACT),
      missingCanonical: { validDerivedTextPresent: true, injected: missingCanonicalInjection.includes(FACT) },
      damagedDerived: { staleTextPresent: true, injected: corruptionInjection.includes(STALE) },
      boundary: 'public owner rebuild API + actual beforeRequest; synthetic fixed corpus; no provider call'
    };
  } finally {
    await fixture?.dispose?.();
    await app?.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) results.push(await checkMode(mode));
  assert.deepEqual(results.map(row => `${row.beforeRebuildInjection}|${row.afterRebuildInjection}`), ['true|true', 'true|true', 'true|true'],
    'all storage modes inject the same canonical fact while the episode index is absent and after reconstruction');
  process.stdout.write(JSON.stringify({ test: 'flashback_episode_index_rebuild_injection_negative', results }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
