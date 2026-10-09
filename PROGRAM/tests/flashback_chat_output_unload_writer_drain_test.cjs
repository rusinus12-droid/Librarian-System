'use strict';
// A committed output may still own its server writer fence when the host unloads the plugin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const USER = 'I check the gauge and step back.';
const REPLY = 'The needle holds at the red mark and the spare valve hangs on the north wall hook.';
const FACT = 'needle holds at the red mark';
const QUERY = 'What did the gauge show, and where is the spare valve?';
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
const writerRows = app => app.repositories.flashback.database.prepare(
  'SELECT alias, epoch, owner, expires_at FROM flashback_writer_fences'
).all();
const physicalScopeSnapshot = (app, manifestKey) => {
  const db = app.repositories.flashback.database;
  const manifestRows = db.prepare(
    'SELECT space, key, revision, digest, deleted, length(value_json) AS bytes, value_json FROM kv WHERE key = ? ORDER BY space'
  ).all(manifestKey).map(row => ({
    ...row,
    manifest: (() => {
      try {
        let value = JSON.parse(String(row.value_json || ''));
        if (typeof value === 'string') value = JSON.parse(value);
        return {
          schema: value?.schema || '', scopeKey: value?.scopeKey || '', storageHash: value?.storageHash || '',
          commitId: value?.commitId || '', count: Number(value?.count || 0), shardCount: Number(value?.shardCount || 0)
        };
      } catch (_) { return null; }
    })()
  }));
  const manifestRow = manifestRows.find(row => row.deleted === 0 && row.manifest?.commitId);
  const hash = String(manifestKey || '').match(/^vector_rag_memory:scope:([^:]+):manifest:v2$/)?.[1] || '';
  const shardRows = hash && manifestRow
    ? db.prepare('SELECT space, key, revision, digest, deleted, length(value_json) AS bytes FROM kv WHERE space = ? AND key LIKE ? ORDER BY key')
      .all(manifestRow.space, `vector_rag_memory:scope:${hash}:records:commit:${manifestRow.manifest.commitId}:shard:%`)
      .map(row => ({ ...row }))
    : [];
  return {
    manifestKey,
    manifestRows: manifestRows.map(({ value_json, ...row }) => ({ repository: 'flashback', ...row })),
    shardRows
  };
};

const run = async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-unload-writer-'));
  let app = null;
  let fixture = null;
  let api = null;
  let activeScope = null;
  let holdRelease = false;
  let heldReleaseOwner = null;
  let releaseResolve;
  let releaseSeenResolve;
  const releaseGate = new Promise(resolve => { releaseResolve = resolve; });
  const releaseSeen = new Promise(resolve => { releaseSeenResolve = resolve; });
  const writerEvents = [];
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const readCanonicalCommit = async manifestKey => {
      if (!api || !activeScope?.scopeKey) return { verified: false, reason: 'capture_scope_not_ready' };
      const physical = physicalScopeSnapshot(app, manifestKey);
      const row = physical.manifestRows.find(item => item.deleted === 0 && item.manifest?.scopeKey === activeScope.scopeKey);
      const shardCount = Number(row?.manifest?.shardCount || 0);
      const durableShardCount = physical.shardRows.filter(item => item.deleted === 0).length;
      const physicalVerified = !!row?.manifest?.commitId && shardCount > 0 && durableShardCount >= shardCount;
      if (!physicalVerified) return { verified: false, physical: { repository: 'flashback', space: row?.space || '', key: row?.key || '', manifest: row?.manifest || null, revision: row?.revision || 0, digest: row?.digest || '', shardCount: durableShardCount } };
      const loaded = await api._test.loadScopeRecords(activeScope.scopeKey);
      const semanticVerified = loaded.records.some(record => String(record.text || '').includes(FACT))
        && loaded.manifest?.commitId === row?.manifest?.commitId
        && Number(loaded.manifest?.missingShards || 0) === 0
        && Number(loaded.manifest?.corruptShards || 0) === 0
        && loaded.manifest?.recordCountMismatch !== true;
      return {
        verified: !!row && !!row.manifest?.commitId && shardCount > 0 && durableShardCount >= shardCount && semanticVerified,
        physical: { repository: 'flashback', space: row?.space || '', key: row?.key || '', manifest: row?.manifest || null, revision: row?.revision || 0, digest: row?.digest || '', shardCount: durableShardCount },
        semantic: { commitId: loaded.manifest?.commitId || '', count: loaded.records.length, matches: loaded.records.filter(record => String(record.text || '').includes(FACT)).length,
          missingShards: Number(loaded.manifest?.missingShards || 0), corruptShards: Number(loaded.manifest?.corruptShards || 0),
          recordCountMismatch: loaded.manifest?.recordCountMismatch === true }
      };
    };
    const address = await app.listen();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const fixtureOptions = {
      exposeStorageBridge: true,
      arguments: { memory_suite_server_mode: 'mirror', memory_suite_server_url: serverUrl },
      nativeFetch: async (url, options) => {
        if (new URL(String(url)).hostname === 'unload-fixture.invalid') return syntheticFetch(url, options);
        assert.equal(new URL(String(url)).hostname, '127.0.0.1', 'no external server requests');
        let writerEvent = null;
        if (String(url).endsWith('/v1/flashback/writer')) {
          let body = {};
          try { body = JSON.parse(String(options?.body || '{}')); } catch (_) {}
          writerEvent = { action: body.action || '', key: body.key || '', owner: body.owner || '', status: null };
          writerEvents.push(writerEvent);
          if (holdRelease && !heldReleaseOwner && body.action === 'release') {
            const canonicalReadback = await readCanonicalCommit(body.key);
            writerEvent.canonicalReadback = canonicalReadback;
            if (canonicalReadback.verified) {
              heldReleaseOwner = body.owner;
              releaseSeenResolve({ key: body.key, owner: body.owner, canonicalReadback });
              await releaseGate;
            }
          }
        }
        const response = await fetch(url, options);
        if (writerEvent) writerEvent.status = response.status;
        return response;
      }
    };
    fixture = await createFixture(fixtureOptions);
    api = fixture.api;
    await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.registered && state.backend === 'chat_output_v3' ? state : null;
    }, 'registered official output listener');
    const initialCaptureState = api.getCaptureBackendState();
    const bridge = fixture.context.__fixtureStorageBridge;
    await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,fixture.pluginStorage);
    assert.equal(await bridge.getMode(), 'mirror');
    await configure(fixture, mode);
    await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
    await delay(50);
    fixture.currentChat.message = [
      { role: 'user', chatId: 'u1', data: USER },
      { role: 'assistant', chatId: 'a1', data: REPLY }
    ];
    fixture.currentChat.messages = fixture.currentChat.message;
    activeScope = await api.resolveCurrentScope();
    holdRelease = true;
    assert.equal(await fixture.dispatchRisuChatEvent('output', {
      char: fixture.character, chat: fixture.currentChat, characterIndex: 0, chatIndex: 0, messageIndex: 1
    }), 1, 'the committed event runs through the registered host listener');
    const outputState = await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.observedRuns > initialCaptureState.observedRuns ? state : null;
    }, 'registered output handler capture');
    const scope = activeScope;
    let semanticRead = null;
    const commitWaitStartedAt = Date.now();
    try {
      await waitFor(async () => {
        const loaded = await api._test.loadScopeRecords(scope.scopeKey);
        semanticRead = {
          scopeKey: scope.scopeKey,
          manifest: {
            commitId: loaded.manifest?.commitId || '', count: Number(loaded.manifest?.count || 0),
            shardCount: Number(loaded.manifest?.shardCount || 0), missingShards: Number(loaded.manifest?.missingShards || 0),
            corruptShards: Number(loaded.manifest?.corruptShards || 0), recordCountMismatch: loaded.manifest?.recordCountMismatch === true
          },
          loadedCount: loaded.records.length,
          matchingRecords: loaded.records.filter(record => String(record.text || '').includes(FACT)).length
        };
        return semanticRead.matchingRecords > 0 ? loaded : null;
      }, 'durable server canonical commit');
    } catch (error) {
      const manifestKey = writerEvents.filter(event => event.action === 'acquire').at(-1)?.key || '';
      error.message += `; captureDiagnostics=${JSON.stringify({
        elapsedMs: Date.now() - commitWaitStartedAt, scopeKey: scope.scopeKey, semanticRead,
        physical: physicalScopeSnapshot(app, manifestKey), outputState,
        pending: api._test.pendingCaptureRuntimeSnapshot?.(), writerEvents, writerRows: writerRows(app)
      })}`;
      throw error;
    }
    const canonicalCommitWaitMs = Date.now() - commitWaitStartedAt;
    const release = await Promise.race([releaseSeen, delay(7000).then(() => null)]);
    assert.ok(release, `capture reached verified writer release (${JSON.stringify(writerEvents)})`);
    assert.equal(release.canonicalReadback.verified, true, `release latch only holds after physical manifest/shard and fresh semantic readback: ${JSON.stringify(release.canonicalReadback)}`);
    const activeBeforeUnload = writerRows(app).find(row => row.alias && row.owner === release.owner && row.expires_at > Date.now());
    assert.ok(activeBeforeUnload, 'the committed capture is still holding its fenced server writer');
    const captureStateAtCommit = api.getCaptureBackendState();
    assert.ok(writerEvents.some(event => event.action === 'acquire' && event.owner === release.owner),
      'the held release owner is the owner acquired by this capture');
    const storage = fixture.pluginStorage;
    const localStorage = fixture.host.safeLocalStorage;
    const chatSnapshot = structuredClone(fixture.currentChat);
    const characterSnapshot = structuredClone(fixture.character);

    let disposed = false;
    const disposePromise = fixture.dispose().then(() => { disposed = true; });
    await delay(40);
    assert.equal(disposed, false,
      `plugin unload must await its committed-output worker before it returns; active=${JSON.stringify(writerRows(app))}`);
    assert.ok(writerRows(app).some(row => row.alias === activeBeforeUnload.alias && row.owner === activeBeforeUnload.owner),
      'the same writer remains active while unload waits');
    releaseResolve();
    await disposePromise;
    const released = await waitFor(() => {
      const row = writerRows(app).find(item => item.alias === activeBeforeUnload.alias);
      return row && !row.owner && Number(row.expires_at || 0) === 0 ? row : null;
    }, 'server writer release after output drain');
    assert.equal(released.owner, '');
    const manifestKey = writerEvents.find(event => event.action === 'acquire' && event.owner === activeBeforeUnload.owner)?.key || '';
    const physicalAfterRelease = physicalScopeSnapshot(app, manifestKey);
    fixture = await createFixture({ ...fixtureOptions, pluginStorage: storage, safeLocalStorage: localStorage, chat: chatSnapshot, character: characterSnapshot });
    const freshApi = fixture.api;
    await configure(fixture, mode);
    const freshScope = await freshApi.resolveCurrentScope();
    const freshSemantic = await freshApi._test.loadScopeRecords(freshScope.scopeKey);
    const durableManifest = physicalAfterRelease.manifestRows.find(row => row.deleted === 0 && row.manifest?.scopeKey === scope.scopeKey);
    assert.ok(durableManifest?.manifest?.commitId, 'release leaves a physical canonical manifest after drain');
    assert.equal(freshScope.scopeKey, scope.scopeKey, 'fresh runtime resolves the same canonical chat scope');
    assert.equal(freshSemantic.manifest?.commitId, durableManifest.manifest.commitId,
      'fresh runtime reads the same physical commit after release');
    assert.equal(Number(freshSemantic.manifest?.missingShards || 0), 0, 'fresh runtime reports no missing canonical shards');
    assert.equal(Number(freshSemantic.manifest?.corruptShards || 0), 0, 'fresh runtime reports no corrupt canonical shards');
    assert.notEqual(freshSemantic.manifest?.recordCountMismatch, true, 'fresh runtime verifies canonical record-count completeness');
    assert.ok(freshSemantic.records.some(record => String(record.text || '').includes(FACT)),
      'fresh runtime reads the committed canonical fact before prompt injection');
    const recallProof = await readyForRecall(fixture, mode, FACT);
    const firstRequest = [{ role: 'user', chatId: 'u8', content: QUERY }];
    const firstMessages = await freshApi._selectionTest.beforeRequest(firstRequest, 'model');
    const firstInjection = JSON.stringify(firstMessages ?? null);
    assert.equal(firstInjection.includes(FACT), mode === 'configured', `the first fresh-runtime request injects the durable canonical fact: ${JSON.stringify({
      query: firstRequest[0]?.content || '', scopeKey: freshScope.scopeKey, priorScopeKey: scope.scopeKey,
      releaseConfirmed: !writerRows(app).some(row => row.alias === activeBeforeUnload.alias && row.owner), releasedOwner: released.owner,
      physicalManifest: physicalAfterRelease.manifestRows, physicalShards: physicalAfterRelease.shardRows,
      freshSemantic: { count: freshSemantic.records.length, commitId: freshSemantic.manifest?.commitId || '', matches: freshSemantic.records.filter(record => String(record.text || '').includes(FACT)).length,
        missingShards: Number(freshSemantic.manifest?.missingShards || 0), corruptShards: Number(freshSemantic.manifest?.corruptShards || 0), recordCountMismatch: freshSemantic.manifest?.recordCountMismatch === true },
      firstRecallReason: freshApi._test.pendingCaptureRuntimeSnapshot?.().lastRecall?.reason || ''
    })}`);
    process.stdout.write(JSON.stringify({
      mode, recallProof, test: 'flashback_chat_output_unload_writer_drain',
      writerAlias: activeBeforeUnload.alias,
      releaseOwner: release.owner,
      writerEpoch: released.epoch,
      canonicalCommitWaitMs,
      captureState: { backend: captureStateAtCommit.backend, observedRuns: captureStateAtCommit.observedRuns,
        trackedTurnRevisions: captureStateAtCommit.trackedTurnRevisions, lastEventAt: captureStateAtCommit.lastEventAt },
      canonicalReadback: { physical: { manifest: durableManifest, shards: physicalAfterRelease.shardRows },
        fresh: { scopeKey: freshScope.scopeKey, commitId: freshSemantic.manifest?.commitId || '', count: freshSemantic.records.length,
          matches: freshSemantic.records.filter(record => String(record.text || '').includes(FACT)).length,
          missingShards: Number(freshSemantic.manifest?.missingShards || 0), corruptShards: Number(freshSemantic.manifest?.corruptShards || 0),
          recordCountMismatch: freshSemantic.manifest?.recordCountMismatch === true } },
      firstFreshRequestInjectedCanonical: firstInjection.includes(FACT),
      heldOwnerActions: writerEvents.filter(event => event.owner === release.owner).map(({ action, key, owner, status }) => ({ action, key, owner, status }))
    }) + '\n');
  } finally {
    releaseResolve?.();
    await fixture?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
};
(async () => { for (const mode of ['raw-only', 'configured']) await run(mode); })().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
