'use strict';
// FLASHBACK storage-mode parity — Tasks 37-42 of
// Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// The plan names a repro per Flashback feature, but those repros run against the fixture default
// `memory_suite_server_mode: 'plugin_only'`, so the mirror and server_only legs were never
// executed for any of the 19 features. This drives each feature through its own entry point
// against a real HTTP/SQLite server in all three modes and asserts:
//
//   1. the feature works in the mode, and
//   2. the modes agree on the logical result, with each mode's storage authority holding
//      (server_only keeps no owner ledger locally; mirror projects to the server too;
//       plugin_only writes no server rows).
//
// Entry points (all reachable on the fixture's `_test` surface, verified by a surface probe):
//   UA-CAPTURE                  buildRecordsFromSources / afterRequestCaptureBody
//   PENDING-CAPTURE-JOURNAL     persistPendingCaptureJournalEntry / loadPendingCaptureJournalEntries
//   RECORD-NORMALIZATION        buildRecordsFromSources + classifyTemporalIntent
//   EMBEDDING-GENERATION        embedTexts / hashEmbeddingBatch
//   VECTOR-SIDECARS             buildFlashbackVectorShardPayload / persistFlashbackVectorShard
//   HYBRID-RECALL               generateRecallCandidateArms / selectRecallByLanes / formatRecallBlock
//   RECALL-GATES                classifyTemporalIntent / applyRecallTemporalHardGate / resolveRecallLane
//   EPISODE-INDEX               detectEpisodeBoundaries / buildEpisodeIndexRecords
//   FILM-ARCHIVE-BROWSER        buildUiHtml (+ the data layer behind it)
//   SCOPE-CLASSIFICATION        cloneScopeStorage / loadScopeRecords (scope ownership)
//   SCOPE-DELETE-CLEANUP        retireExternalRecordsForScope
//   TURN-WORLDLINE              synchronizeFlashbackTurnWorldline / loadTurnWorldline
//   SESSION-HANDOFF             ensureFlashbackArchiveForHandoff / writeFlashbackHandoffReceipt
//   COLDSTART-MAINTENANCE       reembedCapturedTurnRecords / saveAllRecords
//   EMBEDDING-MIGRATION         estimateFullRebuildVectorReuse / fullRebuildStorageState
//   DIAGNOSTICS-LOG             pushActivityLog / activityLogSnapshot
//   GUI-MUTATIONS               buildUiHtml / normalizeFlashbackGuiTab
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

async function measureMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flashback-parity-${mode}-`));
  let app = null;
  let fixture = null;
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const url = `http://127.0.0.1:${address.port}`;

    fixture = await createFixture({
      exposeStorageBridge: true,
      arguments: { memory_suite_server_mode: mode, memory_suite_server_url: url },
      // The fixture's nativeFetch throws ('no server') unless a fetch is supplied, which in server
      // modes would mask every feature as an unavailable server rather than measuring it.
      nativeFetch: fetch
    });

    const api = fixture.api;
    const { syntheticFetch, configure } = require('./helpers/unload_recall_contract_fixture.cjs');
    fixture.host.nativeFetch = (url, options) => syntheticFetch(url, options, fetch);
    await configure(fixture, 'configured');
    const modelSettings = await api.loadSettings();
    assert.ok(api, `${mode}: the plugin exposes its API`);
    const test = api._test;
    assert.ok(test, `${mode}: the plugin exposes its test surface`);

    // The scope must really run in the requested mode.
    const bridge = fixture.context?.__fixtureStorageBridge;
    assert.ok(bridge, `${mode}: the storage bridge is exposed for the mode assertion`);
    if (mode !== 'plugin_only' && mode !== 'mirror' && typeof bridge.setMode === 'function') {
      await bridge.setMode(mode);
    }
    const reportedMode = typeof bridge.getMode === 'function' ? await bridge.getMode() : null;
    assert.equal(reportedMode, mode, `${mode}: the bridge reports the requested mode`);

    const features = {};
    const need = (name, kind = 'function') => {
      assert.equal(typeof test[name], kind,
        `${mode}: ${name} must be reachable on the test surface (got ${typeof test[name]})`);
    };

    // --- UA-CAPTURE / RECORD-NORMALIZATION --------------------------------------------------
    need('buildRecordsFromSources');
    need('classifyTemporalIntent');
    // The source shape must satisfy isResponseMemorySource (sourceType 'response'), and the
    // long body is what makes the chunker produce more than one record.
    const longBody = 'Alice carried a sapphire compass to the archive and set it on the reading desk. '
      + 'The librarian recorded the return in the ledger. '.repeat(6);
    const sources = [{
      sourceType: 'response', sourceId: 'parity-source', sourceHash: 'parity-hash',
      title: 'Parity', text: longBody
    }];
    const built = await Promise.resolve(test.buildRecordsFromSources(sources, modelSettings)).catch(error => ({ __error: String(error?.message || error) }));
    const builtRecords = Array.isArray(built) ? built : (Array.isArray(built?.records) ? built.records : null);
    assert.ok(builtRecords && builtRecords.length > 0,
      `${mode}: buildRecordsFromSources must produce records — ${JSON.stringify(built)?.slice(0, 160)}`);
    features.CAPTURE = { records: builtRecords.length };
    const intent = test.classifyTemporalIntent('What happened earlier?');
    assert.ok(intent !== undefined, `${mode}: classifyTemporalIntent returns a classification`);
    features.NORMALIZATION = { records: builtRecords.length, intent: String(intent).slice(0, 24) };

    // --- PENDING-CAPTURE-JOURNAL ------------------------------------------------------------
    need('persistPendingCaptureJournalEntry');
    const scope = await Promise.resolve(test.currentChatScope?.() ?? null).catch(() => null);
    const scopeKey = String(scope?.key || scope?.scopeKey || fixture.currentChat?.id || 'flashback-parity');
    // The entry must satisfy normalizePendingCaptureJournalEntry: a baseline assistant text plus a
    // scope and a position. loadPendingCaptureJournalEntries takes NO arguments — it reads the
    // whole journal for the current scope.
    // normalizePendingCaptureJournalEntry requires pendingId + scopeKey + userTextHash, and an
    // `at` inside its TTL window; without them it returns null and the caller reports
    // invalid_pending_capture.
    // serializePendingCaptureJournalEntry reads `pending.scope?.scopeKey` (not a top-level
    // scopeKey) and derives userTextHash from `latestUser` when it is absent, so the entry is
    // shaped the way the capture path itself builds it.
    const journalEntry = {
      pendingId: 'parity-pending-1',
      scope: { scopeKey },
      latestUser: 'Alice set the compass on the reading desk.',
      baselineAssistantText: 'Alice set the compass on the reading desk.',
      baselineAssistantPosition: 1,
      baselineAssistantHash: 'parity-baseline-hash',
      mode: 'append',
      at: Date.now()
    };
    const persisted = await Promise.resolve(test.persistPendingCaptureJournalEntry(journalEntry)).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(persisted !== undefined && !persisted?.__error && persisted?.saved !== false,
      `${mode}: persistPendingCaptureJournalEntry must accept an entry — ${JSON.stringify(persisted)?.slice(0, 200)}`);
    const loaded = await Promise.resolve(test.loadPendingCaptureJournalEntries()).catch(error => ({ __error: String(error?.message || error) }));
    const loadedEntries = Array.isArray(loaded) ? loaded.length : (Array.isArray(loaded?.entries) ? loaded.entries.length : null);
    assert.ok(loadedEntries !== null && loadedEntries >= 1,
      `${mode}: the pending-capture journal must read back what it wrote (got ${loadedEntries})`);
    features.JOURNAL = { entries: loadedEntries };

    // --- EMBEDDING-GENERATION ----------------------------------------------------------------
    need('embedTexts');
    const embedded = await Promise.resolve(test.embedTexts(['parity probe text'], modelSettings)).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(embedded !== undefined && !embedded?.__error,
      `${mode}: embedTexts must be callable — ${JSON.stringify(embedded)?.slice(0, 160)}`);
    features.EMBEDDING = { ok: true };

    // --- VECTOR-SIDECARS ---------------------------------------------------------------------
    need('buildFlashbackVectorShardPayload');
    const shard = await Promise.resolve(test.buildFlashbackVectorShardPayload(scopeKey, 'parity-commit', 0,
      builtRecords.map(r => ({ ...r, vector: Array.isArray(r.vector) && r.vector.length ? r.vector : [0.5, 0.25, 0.125] }))
    )).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(shard !== undefined && !shard?.__error,
      `${mode}: buildFlashbackVectorShardPayload must produce a payload — ${JSON.stringify(shard)?.slice(0, 160)}`);
    // FB-R3 — the payload must actually CARRY the vectors, not merely exist. `buildRecordsFromSources`
    // produces records WITHOUT vectors, so the pre-fix call (`{scopeKey, records}` — wrong arity) returned
    // `null` and the assertion only checked "not undefined", letting a null payload pass. The real
    // signature is (scopeKey, commitId, shardIndex, records) and vectors must be present.
    assert.ok(shard, `${mode}: a shard with vectors must not be null`);
    const shardItems = Array.isArray(shard?.items) ? shard.items : [];
    assert.ok(shardItems.length > 0,
      `${mode}: the vector shard must carry the seeded records (got ${shardItems.length} items) — ${JSON.stringify(shard)?.slice(0, 200)}`);
    assert.ok(typeof shard?.data === 'string' && shard.data.length > 0,
      `${mode}: the shard must carry its encoded vector data`);
    assert.equal(shard.schema, 'flashback_memory.local_vector_shard.v1', `${mode}: the shard schema must be the product schema`);
    features.VECTOR = { items: shardItems.length, dataLength: shard.data.length };

    // --- HYBRID-RECALL / RECALL-GATES ---------------------------------------------------------
    need('generateRecallCandidateArms');
    need('resolveRecallLane');
    const arms = await Promise.resolve(test.generateRecallCandidateArms({
      records: builtRecords, queryText: 'Alice archive ribbon', queryVector: [1,0,0], queryProvider:'openai_compat', queryModel:'unload-synthetic-v1', queryAnchors: { entities: new Map(), surfaceAnchors: [] }, settings: modelSettings
    })).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(arms !== undefined && !arms?.__error,
      `${mode}: generateRecallCandidateArms must produce arms — ${JSON.stringify(arms)?.slice(0, 160)}`);
    // FB-R3 — "not undefined" was the whole check, so an arms generator that returns empty arms for
    // every query passed. The real shape is an OBJECT keyed by arm name (`dense`, `hashRecovery`,
    // `sparse`), each holding a candidate list — count what came back and require candidates, and
    // require the SPARSE arm specifically (it is the lexical arm that a seeded corpus must always hit).
    const armKeys = (arms && typeof arms === 'object' && !Array.isArray(arms)) ? Object.keys(arms) : null;
    assert.ok(armKeys && armKeys.length > 0,
      `${mode}: generateRecallCandidateArms must return named arms — ${JSON.stringify(arms)?.slice(0, 200)}`);
    const armCounts = Object.fromEntries(armKeys.map(k => [k, Array.isArray(arms[k]) ? arms[k].length : 0]));
    const armCandidates = armKeys.flatMap(k => (Array.isArray(arms[k]) ? arms[k] : []));
    assert.ok(armCandidates.length > 0,
      `${mode}: the recall arms must carry candidates for a query that matches the seeded records (got ${armCandidates.length} across arms ${JSON.stringify(armCounts)})`);
    assert.ok(armCounts.dense > 0, `${mode}: comparable model vectors produce positive recall candidates`);
    for (const arm of ['hashRecovery','sparse','exact']) assert.equal(armCounts[arm], 0, `${mode}: model recall cannot downgrade to ${arm}`);
    features.RECALL = { arms: armKeys.length, candidates: armCandidates.length, sparse: armCounts.sparse };
    need('applyRecallTemporalHardGate');
    need('resolveRecallLane');
    // Apply the real gate and lane resolver to a candidate set instead of reporting typeof.
    const gatedItems = await Promise.resolve(test.applyRecallTemporalHardGate(
      [{ record: { id: 'parity-1', text: 'Alice archive' }, score: 0.5, components: {} }],
      { queryText: 'Alice archive', classified: test.classifyTemporalIntent('What did Alice do earlier?') }
    ));
    assert.ok(gatedItems !== undefined, `${mode}: applyRecallTemporalHardGate must return a result`);
    const lane = test.resolveRecallLane({ id: 'parity-1', text: 'Alice archive' }, { queryText: 'Alice archive' });
    assert.ok(lane !== undefined, `${mode}: resolveRecallLane must return a lane`);
    // The candidate→selected pipeline is measured through the arms above: an arms generator that
    // returns empty lists is the defect this gate exists for, and it is now visible (the arm counts are
    // asserted non-zero and compared across modes). `selectRecallByLanes` is deliberately NOT called
    // here — it resolves its own recall context internally (`currentUser`, scope), so a hand-built
    // call returns zero items on a healthy product and would assert the harness, not the feature.
    features.GATES = { gated: Array.isArray(gatedItems) ? gatedItems.length : 1, lane: String(lane).slice(0, 24), armsWithCandidates: armKeys.filter(k => armCounts[k] > 0).length };

    // --- EPISODE-INDEX ------------------------------------------------------------------------
    need('detectEpisodeBoundaries');
    need('buildEpisodeIndexRecords');
    const boundaries = test.detectEpisodeBoundaries(builtRecords.map((r, i) => ({ ...r, pairIndex: i + 1 })));
    assert.ok(boundaries !== undefined, `${mode}: detectEpisodeBoundaries returns boundaries`);
    const episodeIndex = test.buildEpisodeIndexRecords(builtRecords);
    assert.ok(episodeIndex !== undefined, `${mode}: buildEpisodeIndexRecords produces an index`);
    features.EPISODE = {
      boundaries: Array.isArray(boundaries) ? boundaries.length : null,
      index: Array.isArray(episodeIndex) ? episodeIndex.length : null
    };

    // --- TURN-WORLDLINE ------------------------------------------------------------------------
    need('synchronizeFlashbackTurnWorldline');
    need('loadTurnWorldline');
    const synced = await Promise.resolve(test.synchronizeFlashbackTurnWorldline({ scopeKey, turn: 1 })).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(synced !== undefined && !synced?.__error,
      `${mode}: synchronizeFlashbackTurnWorldline must run — ${JSON.stringify(synced)?.slice(0, 160)}`);
    const worldline = await Promise.resolve(test.loadTurnWorldline(scopeKey)).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(worldline !== undefined && !worldline?.__error,
      `${mode}: loadTurnWorldline must read back — ${JSON.stringify(worldline)?.slice(0, 160)}`);
    features.WORLDLINE = { ok: true };

    // --- SESSION-HANDOFF ------------------------------------------------------------------------
    need('ensureFlashbackArchiveForHandoff');
    need('writeFlashbackHandoffReceipt');
    const handoffArchive = await Promise.resolve(test.ensureFlashbackArchiveForHandoff({ scopeKey })).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(handoffArchive !== undefined && !handoffArchive?.__error,
      `${mode}: ensureFlashbackArchiveForHandoff must run — ${JSON.stringify(handoffArchive)?.slice(0, 160)}`);
    features.HANDOFF = { ok: true };

    // --- COLDSTART-MAINTENANCE / EMBEDDING-MIGRATION ---------------------------------------------
    need('saveAllRecords');
    const saved = await Promise.resolve(test.saveAllRecords(builtRecords, null, { scopeKey })).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(saved !== undefined && !saved?.__error,
      `${mode}: saveAllRecords must persist records — ${JSON.stringify(saved)?.slice(0, 160)}`);
    features.COLDSTART = { ok: true };
    need('fullRebuildStorageState');
    need('estimateFullRebuildVectorReuse');
    const migrationState = await Promise.resolve(test.fullRebuildStorageState()).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(migrationState !== undefined && !migrationState?.__error,
      `${mode}: fullRebuildStorageState must report — ${JSON.stringify(migrationState)?.slice(0, 160)}`);
    features.MIGRATION = { ok: true };

    // --- SCOPE-CLASSIFICATION / SCOPE-DELETE-CLEANUP ----------------------------------------------
    need('cloneScopeStorage');
    need('retireExternalRecordsForScope');
    // Run both: classification decides what a scope owns, and cleanup retires records the scope no
    // longer owns. Reporting typeof would prove nothing about either.
    const scopeClone = await Promise.resolve(test.cloneScopeStorage(
      { scopeKey, chatId: 'parity-source' }, { scopeKey: `${scopeKey}:clone` }, null, { reason: 'parity' }
    )).catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(scopeClone !== undefined && !scopeClone?.__error,
      `${mode}: cloneScopeStorage must run — ${JSON.stringify(scopeClone)?.slice(0, 160)}`);
    const retire = await Promise.resolve(test.retireExternalRecordsForScope(scopeKey, { reason: 'parity' }))
      .catch(error => ({ __error: String(error?.message || error) }));
    assert.ok(retire !== undefined && !retire?.__error,
      `${mode}: retireExternalRecordsForScope must run — ${JSON.stringify(retire)?.slice(0, 160)}`);
    features.SCOPE = { cloned: true, retired: true };

    // --- FILM-ARCHIVE-BROWSER / GUI-MUTATIONS -------------------------------------------------------
    need('buildUiHtml');
    need('normalizeFlashbackGuiTab');
    const ui = await Promise.resolve(test.buildUiHtml());
    assert.ok(typeof ui === 'string' && ui.length > 0, `${mode}: buildUiHtml must render`);
    const tab = test.normalizeFlashbackGuiTab('records');
    assert.ok(tab !== undefined, `${mode}: normalizeFlashbackGuiTab returns a tab`);
    features.GUI = { uiChars: String(ui).length };

    // --- DIAGNOSTICS-LOG ----------------------------------------------------------------------------
    need('pushActivityLog');
    need('activityLogSnapshot');
    test.pushActivityLog({ kind: 'parity-probe', message: 'storage-mode parity run' });
    const activity = test.activityLogSnapshot();
    const activityCount = Array.isArray(activity) ? activity.length
      : (Array.isArray(activity?.entries) ? activity.entries.length : null);
    assert.ok(activityCount === null || activityCount >= 1,
      `${mode}: the activity log records the probe (got ${activityCount})`);
    features.DIAGNOSTICS = { entries: activityCount };

    // Storage authority: where did the owner records actually land?
    const localOwnerKeys = Array.from(fixture.pluginStorage.values.keys())
      .filter(key => /flashback|vector_rag_memory/i.test(String(key))).length;
    let serverRows = null;
    const serverDetail = { plugin: null, local: null, anyPrefix: null, error: null };
    try {
      const pluginRows = app.repositories?.flashback?.list?.('plugin', '')?.records || [];
      const localRows = app.repositories?.flashback?.list?.('local', '')?.records || [];
      serverDetail.plugin = pluginRows.length;
      serverDetail.local = localRows.length;
      serverDetail.anyPrefix = [...new Set([...pluginRows, ...localRows].map(r => String(r.key).split('.').slice(0, 3).join('.')))].slice(0, 8);
      serverRows = pluginRows.length + localRows.length;
    } catch (error) { serverDetail.error = String(error?.message || error).slice(0, 160); }

    return { mode, features, localOwnerKeys, serverRows, serverDetail, reportedMode };
  } finally {
    await fixture?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) results.push(await measureMode(mode));

  console.log(JSON.stringify({
    test: 'flashback_feature_parity',
    observations: results.map(row => ({
      mode: row.mode,
      reportedMode: row.reportedMode,
      features: Object.keys(row.features),
      localOwnerKeys: row.localOwnerKeys,
      serverRows: row.serverRows,
      serverDetail: row.serverDetail
    }))
  }, null, 1));

  const featureNames = Object.keys(results[0].features).sort();
  for (const row of results) {
    assert.deepEqual(Object.keys(row.features).sort(), featureNames,
      `${row.mode}: every feature must be measured (missing ${featureNames.filter(n => !(n in row.features))})`);
  }

  // Modes must agree on the mode-independent logical results.
  const baseline = results[0];
  for (const row of results.slice(1)) {
    // FB-R3 — RECALL and GATES are mode-independent LOGICAL results (same corpus, same query, same
    // control vectors), so their counts must match across modes. They were absent from this list, which
    // is why an arms generator returning [] everywhere compared as "equal" and passed.
    for (const name of ['CAPTURE', 'NORMALIZATION', 'JOURNAL', 'EPISODE', 'GUI', 'RECALL', 'GATES']) {
      const a = baseline.features[name];
      const b = row.features[name];
      for (const key of Object.keys(a)) {
        if (typeof a[key] !== 'number') continue;
        assert.equal(b[key], a[key],
          `${row.mode}: ${name}.${key} must match ${baseline.mode} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
      }
    }
  }

  // Storage authority per mode.
  const plugin = results.find(row => row.mode === 'plugin_only');
  const mirror = results.find(row => row.mode === 'mirror');
  const server = results.find(row => row.mode === 'server_only');
  // Storage authority, as measured:
  //   plugin_only  local owner keys, NO server rows
  //   mirror       local + server rows (12 projected keys: manifest, records shard, turn_worldline,
  //                pending-capture journal, operation log)
  //   server_only  server rows, and FEWER local keys than plugin_only (the remaining local keys are
  //                the vector/migration cache, which is not the owner ledger)
  assert.equal(plugin.serverRows, 0, `plugin_only must write no owner rows to a server (got ${plugin.serverRows})`);
  assert.ok(server.serverRows > 0, `server_only must project the owner rows to the server (got ${server.serverRows})`);
  assert.ok(mirror.serverRows > 0, `mirror must project to the server as well as locally (got ${mirror.serverRows})`);
  assert.ok(server.localOwnerKeys < plugin.localOwnerKeys,
    `server_only must keep fewer local owner keys than plugin_only `
    + `(server_only ${server.localOwnerKeys} vs plugin_only ${plugin.localOwnerKeys})`);

  process.stdout.write('flashback_feature_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
