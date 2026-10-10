'use strict';
// A writer-release request may outlast the bounded host unload callback.
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
  const manifestRows = db.prepare('SELECT space, key, revision, digest, deleted, length(value_json) AS bytes, value_json FROM kv WHERE key = ? ORDER BY space')
    .all(manifestKey).map(row => {
      let manifest = null;
      try { manifest = JSON.parse(String(row.value_json || '')); if (typeof manifest === 'string') manifest = JSON.parse(manifest); } catch (_) {}
      return { space: row.space, key: row.key, revision: row.revision, digest: row.digest, deleted: row.deleted, bytes: row.bytes,
        manifest: manifest ? { scopeKey: manifest.scopeKey || '', storageHash: manifest.storageHash || '', commitId: manifest.commitId || '', count: Number(manifest.count || 0), shardCount: Number(manifest.shardCount || 0) } : null };
    });
  const manifest = manifestRows.find(row => row.deleted === 0 && row.manifest?.commitId);
  const hash = String(manifestKey || '').match(/^vector_rag_memory:scope:([^:]+):manifest:v2$/)?.[1] || '';
  const shardRows = hash && manifest ? db.prepare('SELECT space, key, revision, digest, deleted, length(value_json) AS bytes FROM kv WHERE space = ? AND key LIKE ? ORDER BY key')
    .all(manifest.space, `vector_rag_memory:scope:${hash}:records:commit:${manifest.manifest.commitId}:shard:%`) : [];
  return { manifestRows: manifestRows.map(({ value_json, ...row }) => row), shardRows };
};
const readCanonicalCommit = async (app, api, scope, manifestKey, fact) => {
  const physical = physicalScopeSnapshot(app, manifestKey);
  const row = physical.manifestRows.find(item => item.deleted === 0 && item.manifest?.scopeKey === scope?.scopeKey);
  const expectedShards = Number(row?.manifest?.shardCount || 0);
  const durableShards = physical.shardRows.filter(item => item.deleted === 0).length;
  if (!row?.manifest?.commitId || expectedShards < 1 || durableShards < expectedShards) return { verified: false, physical };
  const loaded = await api._test.loadScopeRecords(scope.scopeKey);
  const matches = loaded.records.filter(record => String(record.text || '').includes(fact)).length;
  return { verified: matches > 0 && loaded.manifest?.commitId === row.manifest.commitId
      && Number(loaded.manifest?.missingShards || 0) === 0 && Number(loaded.manifest?.corruptShards || 0) === 0
      && loaded.manifest?.recordCountMismatch !== true,
    physical, semantic: { commitId: loaded.manifest?.commitId || '', count: loaded.records.length, matches,
      missingShards: Number(loaded.manifest?.missingShards || 0), corruptShards: Number(loaded.manifest?.corruptShards || 0),
      recordCountMismatch: loaded.manifest?.recordCountMismatch === true } };
};

const run = async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-unload-timeout-'));
  let app = null;
  let fixture = null;
  let fresh = null;
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
    const address = await app.listen();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const fixtureOptions = {
      exposeStorageBridge: true,
      arguments: { memory_suite_server_mode: 'mirror', memory_suite_server_url: serverUrl },
      nativeFetch: async (url, options) => {
        if (new URL(String(url)).hostname === 'unload-fixture.invalid') return syntheticFetch(url, options);
        assert.equal(new URL(String(url)).hostname, '127.0.0.1', 'no external server requests');
        if (String(url).endsWith('/v1/flashback/writer')) {
          let body = {};
          try { body = JSON.parse(String(options?.body || '{}')); } catch (_) {}
          const event = { action: body.action || '', key: body.key || '', owner: body.owner || '' };
          writerEvents.push(event);
          if (holdRelease && !heldReleaseOwner && body.action === 'release') {
            const canonicalReadback = await readCanonicalCommit(app, api, activeScope, body.key, FACT);
            event.canonicalReadback = canonicalReadback;
            if (!canonicalReadback.verified) return await fetch(url, options);
            heldReleaseOwner = body.owner;
            releaseSeenResolve({ key: body.key, owner: body.owner, canonicalReadback });
            await releaseGate;
          }
        }
        return await fetch(url, options);
      }
    };
    fixture = await createFixture(fixtureOptions);
    api = fixture.api;
    await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.registered && state.backend === 'chat_output_v3' ? state : null;
    }, 'registered official output listener');
    const bridge = fixture.context.__fixtureStorageBridge;
    await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,fixture.pluginStorage);
    assert.equal(await bridge.getMode(), 'mirror');
    await configure(fixture, mode);
    await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    const selection = api._selectionTest;
    await selection.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
    await delay(50);
    fixture.currentChat.message = [
      { role: 'user', chatId: 'u1', data: USER },
      { role: 'assistant', chatId: 'a1', data: REPLY }
    ];
    fixture.currentChat.messages = fixture.currentChat.message;
    activeScope = await api.resolveCurrentScope();
    const baselineRuns = api.getCaptureBackendState().observedRuns;
    holdRelease = true;
    assert.equal(await fixture.dispatchRisuChatEvent('output', {
      char: fixture.character, chat: fixture.currentChat, characterIndex: 0, chatIndex: 0, messageIndex: 1
    }), 1, 'capture runs through the registered host listener');
    await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.observedRuns > baselineRuns ? state : null;
    }, 'registered output handler invocation');
    const commitWaitStartedAt = Date.now();
    try {
      await waitFor(async () => (await api._test.loadScopeRecords(activeScope.scopeKey)).records
        .some(record => String(record.text || '').includes(FACT)), 'durable canonical commit');
    } catch (error) {
      const manifestKey = writerEvents.find(event => event.action === 'acquire')?.key || '';
      error.message += `; captureDiagnostics=${JSON.stringify({ elapsedMs: Date.now() - commitWaitStartedAt, scopeKey: activeScope.scopeKey,
        physical: physicalScopeSnapshot(app, manifestKey), output: api.getCaptureBackendState(), pending: api._test.pendingCaptureRuntimeSnapshot?.(),
        writerEvents, writerRows: writerRows(app), activity: api.getActivityLog().slice(-8) })}`;
      throw error;
    }
    const canonicalCommitWaitMs = Date.now() - commitWaitStartedAt;
    const release = await Promise.race([releaseSeen, delay(7000).then(() => null)]);
    assert.ok(release, `output reached a verified held writer release: ${JSON.stringify(writerEvents)}`);
    assert.equal(release.canonicalReadback.verified, true, `release is held only after physical manifest/shard and fresh semantic readback: ${JSON.stringify(release.canonicalReadback)}`);
    const activeBeforeUnload = writerRows(app).find(row => row.alias && row.owner === release.owner && row.expires_at > Date.now());
    assert.ok(activeBeforeUnload, 'server fence owner is active before unload');
    const captureStateBeforeUnload = api.getCaptureBackendState();
    const storage = fixture.pluginStorage;
    const localStorage = fixture.host.safeLocalStorage;
    const chat = structuredClone(fixture.currentChat);
    const character = structuredClone(fixture.character);

    const unloadStarted = Date.now();
    await fixture.dispose();
    fixture = null;
    const unloadElapsedMs = Date.now() - unloadStarted;
    assert.ok(unloadElapsedMs >= 200 && unloadElapsedMs < 1000,
      `unload times out its 250ms drain but stays below the approximate 1s host budget; elapsed=${unloadElapsedMs}ms`);
    const ownerAfterTimeout = writerRows(app).find(row => row.alias === activeBeforeUnload.alias);
    assert.equal(ownerAfterTimeout?.owner, activeBeforeUnload.owner,
      'the timeout does not claim that the server released a still-held owner');

    fresh = await createFixture({ ...fixtureOptions, pluginStorage: storage, safeLocalStorage: localStorage, chat, character });
    const freshApi = fresh.api;
    await configure(fresh, mode);
    const firstMessages = await freshApi._selectionTest.beforeRequest([{ role: 'user', chatId: 'u8', content: QUERY }], 'model');
    const firstInjection = JSON.stringify(firstMessages ?? null);
    assert.ok(Array.isArray(firstMessages), 'the fresh runtime fails closed with a normal request result while the old server writer remains active');
    assert.equal(firstInjection.includes(FACT), false, 'a provisional raw-only record cannot be claimed as semantic recall while the old writer is active');
    const heldSourceJournalError = freshApi.getSourceEditSyncStatus().error;
    assert.equal(heldSourceJournalError, 'SOURCE_EDIT_JOURNAL_WRITE_REJECTED', 'the first request actually reaches the held-writer source-journal refusal');
    releaseResolve();
    const released = await waitFor(() => {
      const row = writerRows(app).find(item => item.alias === activeBeforeUnload.alias);
      return row && !row.owner && Number(row.expires_at || 0) === 0 ? row : null;
    }, 'server-confirmed writer release after test opens the gate');
    // The held writer may reject source-journal preparation. Retry the real request
    // boundary after release before asking the separate semantic queue to run.
    const releasedRawRequest = await freshApi._selectionTest.beforeRequest([{ role: 'user', chatId: 'u9', content: QUERY }], 'model');
    assert.ok(Array.isArray(releasedRawRequest), 'post-release raw request remains usable before vector readiness');
    assert.equal(freshApi.getSourceEditSyncStatus().error, '', 'released writer allows source journal recovery');
    const recallProof = await readyForRecall(fresh, mode, FACT);
    const recoveryMessages = await freshApi._selectionTest.beforeRequest([{ role: 'user', chatId: 'u9', content: QUERY }], 'model');
    const recoveryInjection = JSON.stringify(recoveryMessages ?? null);
    assert.equal(recoveryInjection.includes(FACT), mode === 'configured', 'after release raw-only stays fail-closed while configured semantic recall injects the durable fact');
    process.stdout.write(JSON.stringify({
      mode, recallProof, test: 'flashback_chat_output_unload_timeout_recovery',
      unloadElapsedMs,
      canonicalCommitWaitMs,
      scopeKey: activeScope.scopeKey,
      captureState: { backend: captureStateBeforeUnload.backend, observedRuns: captureStateBeforeUnload.observedRuns,
        trackedTurnRevisions: captureStateBeforeUnload.trackedTurnRevisions, lastEventAt: captureStateBeforeUnload.lastEventAt },
      canonicalReadback: release ? { verified: release.canonicalReadback.verified, physical: release.canonicalReadback.physical,
        semantic: release.canonicalReadback.semantic } : null,
      writerActions: writerEvents.filter(event => event.owner === release?.owner),
      ownerBefore: { owner: activeBeforeUnload.owner, expiresAt: activeBeforeUnload.expires_at },
      ownerAfterBoundedTimeout: { owner: ownerAfterTimeout.owner, expiresAt: ownerAfterTimeout.expires_at },
      ownerAfterConfirmedRelease: { owner: released.owner, expiresAt: released.expires_at },
      heldSourceJournalError, postReleaseSourceJournalError: freshApi.getSourceEditSyncStatus().error,
      firstFreshRequestHadCanonical: firstInjection.includes(FACT),
      firstFreshRecallReason: freshApi._test.pendingCaptureRuntimeSnapshot().lastRecall?.reason || '',
      recoveredAfterRelease: recoveryInjection.includes(FACT)
    }) + '\n');
  } finally {
    releaseResolve?.();
    await fixture?.dispose?.().catch(() => null);
    await fresh?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
};
(async () => { for (const mode of ['raw-only', 'configured']) await run(mode); })().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
