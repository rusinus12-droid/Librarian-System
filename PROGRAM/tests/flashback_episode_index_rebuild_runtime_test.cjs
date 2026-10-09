'use strict';
// Task 21 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// FLASHBACK-EPISODE-INDEX was recorded as plugin_only = verified_supported with
// zero direct test references: `rebuildEpisodeIndex` (1 definition) and
// `maybeRebuildEpisodeIndex` (11 references) never appeared under tests/. The
// public `api.rebuildEpisodeIndex` wrapper exists, but it resolves the *host*
// scope and can never be driven from a fixture, so nothing exercised the real
// entry point.
//
// This test executes the real entry point and asserts a durable readback:
//   record corpus -> maybeRebuildEpisodeIndex -> reload (fresh runtime, same
//   storage) -> identical episode membership, digest and manifest counters.
//
// It deliberately asserts the durable store, not the returned summary, because
// a `verified_supported` claim is only valid with an executed entry point plus
// durable readback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { clone, parent } = require('./fixtures/native_branch_fixture.cjs');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
// FLASHBACK_EPISODE_INDEX_PLUGIN_SOURCE points the same test at another plugin
// revision (e.g. a released checkpoint) for comparison runs. Note that Task 21
// is evidence reconciliation, not a defect fix: the missing thing was the
// execution evidence itself, so there is no pre-fix code revision whose failure
// this test could reproduce.
const pluginSource = fs.readFileSync(
  process.env.FLASHBACK_EPISODE_INDEX_PLUGIN_SOURCE
    ? path.resolve(process.env.FLASHBACK_EPISODE_INDEX_PLUGIN_SOURCE)
    : pluginPath,
  'utf8'
);

// Expose the closure-owned episode index entry points. Nothing else changes:
// the deployed plugin file is read as a string and never modified.
const HOOK = '  const scheduleEpisodeIndexRebuild =';
const exposedSource = pluginSource.replace(
  HOOK,
  '  globalThis.__episodeIndexTest = { maybeRebuildEpisodeIndex, episodeSourceDigestForRecords, buildEpisodeIndexRecords, detectEpisodeBoundaries };\n' + HOOK
);

const snapshot = (f, chat) => ({ character: clone(f.character), chat: clone(chat), db: { personas: [], selectedPersona: '' }, chatInfo: { characterIndex: 0, chatIndex: 0 } });
// Cross-realm note: records loaded through two different plugin VM contexts are
// distinct Object prototypes, so deepStrictEqual would fail on the prototype
// alone. Normalise to plain JSON data before comparing membership.
const plain = value => JSON.parse(JSON.stringify(value));
const episodeMembership = episodes => plain(episodes
  .map(episode => ({
    id: episode.id,
    sourceHash: episode.sourceHash,
    sourceId: episode.sourceId,
    episodeLevel: episode.episodeLevel || 'scene',
    turnRange: episode.turnRange,
    childIds: Array.isArray(episode.childIds) ? [...episode.childIds].sort() : [],
    childHashes: Array.isArray(episode.childHashes) ? [...episode.childHashes].sort() : []
  }))
  .sort((left, right) => String(left.id).localeCompare(String(right.id))));
const readEpisodes = async (t, scope) => (await t.loadScopeRecords(scope))
  .records.filter(record => record.sourceType === 'episode_index');

(async () => {
  const parentChat = parent('fb-episode-parent', 8);
  const f = await createFixture({ source: exposedSource, chat: parentChat });
  const observations = {};
  try {
    const t = f.api._test;
    const episodes = f.api.__episodeIndexTest || f.context.__episodeIndexTest;
    assert.ok(episodes, 'episode index entry points are reachable (deployed plugin exposes maybeRebuildEpisodeIndex for execution)');

    const scope = t.resolveScopeFromSnapshot(snapshot(f, f.currentChat));
    const settings = t.normalizeSettings({
      ...await f.api.loadSettings(),
      embeddingProvider: 'hash',
      embeddingModel: 'hash-8',
      hashDimensions: 8,
      embeddingEnabled: true,
      shardSize: 50,
      episodeIndexEnabled: true,
      episodeHierarchyEnabled: false,
      episodeMinRecords: 1,
      autoEpisodeIndex: true
    });
    await f.api.saveSettings(settings);

    const records = [];
    for (let turn = 1; turn <= 8; turn += 1) {
      const cleaned = t.cleanRecordForMemory({
        id: `record-${turn}`,
        sourceType: 'response',
        sourceId: `fb-episode-parent:turn:${turn}`,
        text: `User:\nUser ${turn}\n\n---\n\nAssistant:\nAssistant ${turn}`,
        title: `Turn ${turn}`,
        scopeKey: scope.scopeKey,
        pairIndex: turn,
        turnIndex: turn,
        tags: [],
        tokenCount: 8,
        tokens: 8,
        vector: [1, 0, 0, 0, 0, 0, 0, 0],
        dim: 8,
        provider: 'hash',
        model: 'hash-8',
        embeddingProvider: 'hash',
        embeddingModel: 'hash-8',
        embeddingDimensions: 8,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lifecycleStatus: 'active',
        sourceHash: `turn-${turn}`
      }, scope, { authoritativeSource: true }).record;
      assert.ok(cleaned, `record ${turn} is a valid memory record`);
      records.push(cleaned);
    }
    await t.saveAllRecords(records, settings, scope);
    assert.equal(await readEpisodes(t, scope).then(rows => rows.length), 0, 'no episode exists before the rebuild is executed');

    const sourceDigest = episodes.episodeSourceDigestForRecords(records, settings);
    assert.ok(sourceDigest, 'the source digest is derived from the response corpus');

    // --- real entry point execution -----------------------------------------
    const rebuilt = await episodes.maybeRebuildEpisodeIndex(scope, settings, null, { force: true, reason: 'episode_index_task21_test' });
    assert.equal(rebuilt.rebuilt, true, `episode rebuild executed: ${JSON.stringify(rebuilt)}`);
    assert.ok(rebuilt.episodes >= 1, 'at least one episode centroid was produced');

    // --- durable readback ---------------------------------------------------
    const durable = await readEpisodes(t, scope);
    assert.equal(durable.length, rebuilt.episodes, 'durable episode count matches the executed rebuild summary');
    assert.equal(durable.length, rebuilt.episodes);
    const manifest = await t.loadScopeManifest(scope);
    assert.equal(manifest.episodeSourceDigest, sourceDigest, 'manifest records the digest the rebuild was derived from');
    assert.equal(manifest.episodeCount, durable.length, 'manifest episodeCount survives the commit');
    assert.equal(manifest.episodeSourceDigest, rebuilt.digest);
    const membership = episodeMembership(durable);
    observations.executed = { episodes: durable.length, digest: manifest.episodeSourceDigest };

    // Episode membership must reference real record identities, not invented ones.
    const recordIds = new Set(records.map(record => record.id));
    const recordHashes = new Set(records.filter(record => record.hash).map(record => record.hash));
    for (const episode of durable) {
      assert.equal(episode.scopeKey, scope.scopeKey, 'episode belongs to the rebuilt scope');
      assert.ok(Array.isArray(episode.childIds) && episode.childIds.length >= 1, 'episode keeps its child record identities');
      assert.ok(episode.childIds.every(id => recordIds.has(id)), 'every episode child id is a real source record id');
      if (recordHashes.size) assert.ok(episode.childHashes.every(hash => recordHashes.has(hash)), 'every episode child hash is a real source record hash');
      assert.ok(Number(episode.turnRange?.start || 0) >= 1 && Number(episode.turnRange?.end || 0) <= 8, 'episode turn range stays inside the source corpus');
      assert.ok(Array.isArray(episode.vector) && episode.vector.length, 'episode centroid carries a vector');
    }
    assert.deepEqual(
      [...new Set(durable.flatMap(episode => episode.childIds))].sort(),
      [...recordIds].sort(),
      'the episode index covers the whole response corpus'
    );
    observations.coveredChildren = recordIds.size;

    // --- unchanged digest is not rebuilt again ------------------------------
    const repeat = await episodes.maybeRebuildEpisodeIndex(scope, settings, null, { reason: 'episode_index_task21_repeat' });
    assert.equal(repeat.rebuilt, false, 'an unchanged source digest is not rebuilt');
    assert.equal(repeat.reason, 'unchanged');
    assert.equal((await readEpisodes(t, scope)).length, durable.length, 'the no-op rebuild does not duplicate episodes');

    // --- reload from the same durable storage -------------------------------
    const reopened = await createFixture({
      source: exposedSource,
      pluginStorage: f.pluginStorage,
      safeLocalStorage: f.host.safeLocalStorage,
      chat: clone(f.currentChat)
    });
    try {
      const reloadedScope = reopened.api._test.resolveScopeFromSnapshot(snapshot(reopened, reopened.currentChat));
      assert.equal(reloadedScope.scopeKey, scope.scopeKey, 'the reloaded runtime resolves the same scope');
      const reloadedManifest = await reopened.api._test.loadScopeManifest(reloadedScope);
      const reloaded = (await reopened.api._test.loadScopeRecords(reloadedScope)).records.filter(record => record.sourceType === 'episode_index');
      assert.equal(reloaded.length, durable.length, 'reload yields the same episode count');
      assert.equal(reloadedManifest.episodeSourceDigest, manifest.episodeSourceDigest);
      assert.equal(reloadedManifest.episodeCount, manifest.episodeCount);
      assert.deepEqual(episodeMembership(reloaded), membership, 'reload yields identical episode membership');
      observations.reloaded = { episodes: reloaded.length, digestSame: true };
    } finally {
      await reopened.dispose();
    }

    console.log(JSON.stringify({
      test: 'flashback_episode_index_rebuild_runtime',
      passed: 1,
      boundary: 'real deployed Flashback plugin entry point + durable storage readback; no model or provider calls',
      observations
    }));
  } finally {
    await f.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
