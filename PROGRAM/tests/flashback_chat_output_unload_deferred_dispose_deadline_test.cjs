'use strict';
// A held release is canceled by the finite deferred-disposal deadline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const USER = 'I check the gauge and step back.';
const REPLY = 'The needle holds at the red mark and the spare valve hangs on the north wall hook.';
const FACT = 'needle holds at the red mark';
const SETTINGS = { embeddingProvider: 'hash', embeddingModel: 'hash-v1', embeddingEnabled: true, captureAfterRequest: true, episodeIndexEnabled: false, hookRecallTimeoutMs: 5000, maxInjectionChars: 4000 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 8000) => {
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
  return { manifestRows, shardRows };
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

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-unload-dispose-deadline-'));
  let app = null;
  let fixture = null;
  let api = null;
  let activeScope = null;
  let holdRelease = false;
  let heldReleaseOwner = null;
  let releaseSeenResolve;
  let abortResolve;
  const releaseSeen = new Promise(resolve => { releaseSeenResolve = resolve; });
  const abortSeen = new Promise(resolve => { abortResolve = resolve; });
  const writerEvents = [];
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    fixture = await createFixture({
      exposeStorageBridge: true,
      keepTimersAfterDispose: true,
      arguments: { memory_suite_server_mode: 'mirror', memory_suite_server_url: serverUrl },
      nativeFetch: async (url, options) => {
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
            const signal = options?.signal;
            await Promise.race([new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true })), new Promise(() => {})]);
            if (signal?.aborted) {
              abortResolve(true);
              throw Object.assign(new Error('ABORTED_FOR_TEST'), { name: 'AbortError' });
            }
          }
        }
        return await fetch(url, options);
      }
    });
    api = fixture.api;
    await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.registered && state.backend === 'chat_output_v3' ? state : null;
    }, 'registered official output listener');
    const bridge = fixture.context.__fixtureStorageBridge;
    await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,fixture.pluginStorage);
    await api.saveSettings({ ...await api.loadSettings(), ...SETTINGS });
    await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    await api._selectionTest.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
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
    await waitFor(() => api.getCaptureBackendState().observedRuns > baselineRuns, 'registered output handler invocation');
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

    const unloadStarted = Date.now();
    await fixture.dispose();
    fixture = null;
    const unloadElapsedMs = Date.now() - unloadStarted;
    assert.ok(unloadElapsedMs >= 200 && unloadElapsedMs < 1000,
      `unload returns within the approximate 1s host budget; elapsed=${unloadElapsedMs}ms`);
    const disposeAbort = await Promise.race([abortSeen, delay(8000).then(() => false)]);
    assert.equal(disposeAbort, true, 'finite deferred-disposal deadline aborts the locally held release request');
    const ownerAfterDisposeDeadline = writerRows(app).find(row => row.alias === activeBeforeUnload.alias);
    assert.equal(ownerAfterDisposeDeadline?.owner, activeBeforeUnload.owner,
      'after the finite cleanup cap, server release remains unconfirmed and the fence row is still owned');
    process.stdout.write(JSON.stringify({
      test: 'flashback_chat_output_unload_deferred_dispose_deadline',
      unloadElapsedMs,
      deferredDisposeDeadlineMs: 5000,
      canonicalCommitWaitMs,
      captureState: { backend: captureStateBeforeUnload.backend, observedRuns: captureStateBeforeUnload.observedRuns,
        trackedTurnRevisions: captureStateBeforeUnload.trackedTurnRevisions, lastEventAt: captureStateBeforeUnload.lastEventAt },
      scopeKey: activeScope.scopeKey,
      canonicalReadback: { verified: release.canonicalReadback.verified, physical: release.canonicalReadback.physical,
        semantic: release.canonicalReadback.semantic },
      writerActions: writerEvents.filter(event => event.owner === release.owner),
      abortObserved: disposeAbort,
      ownerBefore: { owner: activeBeforeUnload.owner, expiresAt: activeBeforeUnload.expires_at },
      ownerAfterDeadline: { owner: ownerAfterDisposeDeadline.owner, expiresAt: ownerAfterDisposeDeadline.expires_at },
      serverReleaseConfirmed: !ownerAfterDisposeDeadline?.owner && Number(ownerAfterDisposeDeadline?.expires_at || 0) === 0
    }) + '\n');
  } finally {
    await fixture?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
