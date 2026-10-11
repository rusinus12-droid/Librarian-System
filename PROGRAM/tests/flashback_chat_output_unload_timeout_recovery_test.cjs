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

// Full scoped corpus bytes and the live source are measured separately from the
// writer-fence table, whose owner/epoch must change during the explicit probe pair.
const canonicalSourceBytes = (app, manifestKey, fixture) => {
  const alias = String(manifestKey).match(/^vector_rag_memory:scope:([A-Za-z0-9_-]{1,128}):manifest:v2$/)?.[1];
  assert.ok(alias, 'the explicit probe uses the actual held canonical manifest key');
  const prefixes = [`vector_rag_memory:scope:${alias}:`, `vector_rag_memory:local-vector-shard:v1:${alias}:`];
  const scoped = key => prefixes.some(prefix => String(key).startsWith(prefix));
  const localRows = store => [...store.values.entries()].filter(([key]) => scoped(key)).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    server: app.repositories.flashback.database.prepare(
      'SELECT space, key, revision, digest, deleted, value_json, updated_at FROM kv WHERE key LIKE ? OR key LIKE ? ORDER BY space, key'
    ).all(`${prefixes[0]}%`, `${prefixes[1]}%`),
    plugin: localRows(fixture.pluginStorage), local: localRows(fixture.host.safeLocalStorage),
    chat: fixture.currentChat, character: fixture.character
  });
};
// Native node:sqlite rows have a null prototype. Validate the exact ordered
// own columns before projecting every value for strict ordinary-record equality.
const writerRowRecord = row => {
  assert.ok(row && typeof row === 'object', 'writer fence readback is an actual row');
  assert.equal(Object.getPrototypeOf(row), null, 'writer fence row retains its native SQLite null prototype');
  assert.deepEqual(Reflect.ownKeys(row), ['alias', 'epoch', 'owner', 'expires_at'],
    'writer fence row has exactly the four selected own columns in SELECT order');
  return { alias: row.alias, epoch: row.epoch, owner: row.owner, expires_at: row.expires_at };
};
const assertExactRelease = (event, expected, label) => {
  assert.equal(event.action, 'release', `${label}: actual release transport`);
  assert.equal(event.key, expected.key, `${label}: exact manifest key`);
  assert.equal(event.owner, expected.owner, `${label}: exact owner`);
  assert.equal(event.epoch, expected.epoch, `${label}: exact request epoch`);
  assert.equal(event.alias, expected.alias, `${label}: exact request alias`);
  assert.equal(event.status, 200, `${label}: successful transport response`);
  assert.equal(event.payload?.ok, true, `${label}: server accepted the release`);
  assert.deepEqual(event.payload?.result, {
    schema: 'flashback.writer-fence.v1', alias: expected.alias, owner: expected.owner,
    epoch: expected.epoch, expiresAt: 0
  }, `${label}: exact zero-expiry release receipt`);
  assert.deepEqual(writerRowRecord(event.sqlFence), { alias: expected.alias, epoch: expected.epoch, owner: '', expires_at: 0 },
    `${label}: exact SQL row is released, not expired or replaced`);
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
        let writerEvent = null;
        if (String(url).endsWith('/v1/flashback/writer')) {
          let body = {};
          try { body = JSON.parse(String(options?.body || '{}')); } catch (_) {}
          const event = { action: body.action || '', key: body.key || '', owner: body.owner || '',
            alias: body.alias || '', epoch: body.epoch ?? null, status: null, payload: null, sqlFence: null };
          writerEvent = event;
          writerEvents.push(event);
          if (holdRelease && !heldReleaseOwner && body.action === 'release') {
            const canonicalReadback = await readCanonicalCommit(app, api, activeScope, body.key, FACT);
            event.canonicalReadback = canonicalReadback;
            if (canonicalReadback.verified) {
              heldReleaseOwner = body.owner;
              releaseSeenResolve({ key: body.key, owner: body.owner, alias: body.alias, epoch: body.epoch, canonicalReadback, event });
              await releaseGate;
            }
          }
        }
        const response = await fetch(url, options);
        if (writerEvent) {
          writerEvent.status = response.status;
          writerEvent.payload = await response.clone().json();
          const alias = writerEvent.key.match(/^vector_rag_memory:scope:([^:]+):/)?.[1];
          writerEvent.sqlFence = writerRows(app).find(row => row.alias === alias) || null;
        }
        return response;
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
    assert.equal(activeBeforeUnload.alias, release.alias, 'held release belongs to the exact active alias');
    assert.equal(activeBeforeUnload.epoch, release.epoch, 'held release belongs to the exact active epoch');
    assert.ok(Number.isSafeInteger(release.epoch) && release.epoch > 0, 'held owner has a real positive epoch');
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
    assert.equal(ownerAfterTimeout.epoch, activeBeforeUnload.epoch, 'timeout cannot replace the held epoch');
    assert.ok(ownerAfterTimeout.expires_at > Date.now(), 'old owner remains live after bounded unload');

    fresh = await createFixture({ ...fixtureOptions, pluginStorage: storage, safeLocalStorage: localStorage, chat, character });
    const freshApi = fresh.api;
    await configure(fresh, mode);
    const firstMessages = await freshApi._selectionTest.beforeRequest([{ role: 'user', chatId: 'u8', content: QUERY }], 'model');
    const firstFreshDiagnostics = structuredClone(freshApi._test.pendingCaptureRuntimeSnapshot());
    const firstFreshOwner = writerRows(app).find(row => row.alias === activeBeforeUnload.alias);
    const firstInjection = JSON.stringify(firstMessages ?? null);
    assert.ok(Array.isArray(firstMessages), 'the fresh runtime fails closed with a normal request result while the old server writer remains active');
    assert.equal(firstInjection.includes(FACT), false, 'a provisional raw-only record cannot be claimed as semantic recall while the old writer is active');
    assert.equal(firstFreshOwner?.owner, activeBeforeUnload.owner, 'first request still observes the exact old owner');
    assert.equal(firstFreshOwner.epoch, activeBeforeUnload.epoch, 'first request still observes the exact old epoch');
    assert.ok(firstFreshOwner.expires_at > Date.now(), 'old owner is live at the first-request boundary');
    const freshBridge = fresh.context.__fixtureStorageBridge;
    assert.equal(typeof freshBridge?.withFlashbackWriter, 'function', 'the fresh fixture exposes the existing SDK writer receiver');
    assert.notEqual(freshBridge, bridge, 'the explicit probe uses a fresh SDK closure, not the unloaded owner');
    const freshScope = await freshApi.resolveCurrentScope();
    assert.equal(freshScope.scopeKey, activeScope.scopeKey, 'fresh probe keeps the captured source scope');
    const beforeProbeReadback = await readCanonicalCommit(app, freshApi, freshScope, release.key, FACT);
    assert.equal(beforeProbeReadback.verified, true, 'complete durable fact is readable before the explicit fence probes');
    assert.equal(beforeProbeReadback.semantic.commitId, release.canonicalReadback.semantic.commitId, 'fresh read sees the originally held commit');
    assert.deepEqual(beforeProbeReadback, release.canonicalReadback, 'fresh read preserves the originally held physical commit and complete canonical readback');
    const canonicalBytesBeforeProbes = canonicalSourceBytes(app, release.key, fresh);

    // Explicit fence probe only: the first empty hook does not prove a writer attempt.
    let heldProbeCallbackCount = 0;
    let heldProbeError = null;
    const heldProbeEventStart = writerEvents.length;
    await assert.rejects(() => freshBridge.withFlashbackWriter(release.key, () => { heldProbeCallbackCount += 1; }, { forceServer: true }), error => {
      heldProbeError = { message: error?.message, status: error?.status, serverError: error?.payload?.error };
      return error?.message === 'FLASHBACK_WRITER_BUSY' && error?.status === 409 && error?.payload?.error === 'FLASHBACK_WRITER_BUSY';
    }, 'an explicit no-op writer is refused by the live old owner');
    assert.equal(heldProbeCallbackCount, 0, 'the refused explicit probe never enters its callback');
    const heldProbeEvents = writerEvents.slice(heldProbeEventStart);
    assert.equal(heldProbeEvents.length, 1, 'one bounded refused acquire, without retry or release');
    const heldProbeAcquire = heldProbeEvents[0];
    assert.equal(heldProbeAcquire.action, 'acquire');
    assert.equal(heldProbeAcquire.key, release.key);
    assert.ok(heldProbeAcquire.owner && heldProbeAcquire.owner !== release.owner, 'refused probe requested a distinct owner');
    assert.equal(heldProbeAcquire.status, 409);
    assert.equal(heldProbeAcquire.payload?.error, 'FLASHBACK_WRITER_BUSY');
    assert.deepEqual(heldProbeAcquire.sqlFence, firstFreshOwner, 'refused acquire preserves the complete old fence row');
    assert.deepEqual(writerRows(app).find(row => row.alias === release.alias), firstFreshOwner, 'old alias/owner/epoch/expiry remain unchanged');
    assert.ok(firstFreshOwner.expires_at > Date.now(), 'busy rejection is witnessed before old-owner expiry');
    const canonicalBytesAfterHeldProbe = canonicalSourceBytes(app, release.key, fresh);
    assert.equal(canonicalBytesAfterHeldProbe, canonicalBytesBeforeProbes, 'refused no-op probe preserves all scoped canonical and source bytes');
    releaseResolve();
    const released = await waitFor(() => {
      const row = writerRows(app).find(item => item.alias === activeBeforeUnload.alias);
      return row && !row.owner && Number(row.expires_at || 0) === 0 && release.event.payload ? row : null;
    }, 'server-confirmed writer release after test opens the gate');
    assert.equal(released.epoch, release.epoch, 'the exact old epoch is cleared before any new probe');
    assertExactRelease(release.event, release, 'old-owner release');
    const canonicalBytesBeforeReleasedProbe = canonicalSourceBytes(app, release.key, fresh);
    assert.equal(canonicalBytesBeforeReleasedProbe, canonicalBytesBeforeProbes, 'opening the release gate preserves the measured canonical and source bytes');

    let releasedProbeCallbackCount = 0;
    const releasedProbeEventStart = writerEvents.length;
    await freshBridge.withFlashbackWriter(release.key, () => { releasedProbeCallbackCount += 1; }, { forceServer: true });
    assert.equal(releasedProbeCallbackCount, 1, 'one explicit post-release no-op writer callback runs');
    const releasedProbeEvents = writerEvents.slice(releasedProbeEventStart);
    assert.equal(releasedProbeEvents.length, 2, 'one post-release acquire and its exact release, without retries');
    const [probeAcquire, probeRelease] = releasedProbeEvents;
    assert.equal(probeAcquire.action, 'acquire');
    assert.equal(probeAcquire.key, release.key);
    assert.ok(probeAcquire.owner && probeAcquire.owner !== release.owner && probeAcquire.owner !== heldProbeAcquire.owner, 'successful probe acquires a new distinct owner');
    assert.equal(probeAcquire.status, 200);
    assert.equal(probeAcquire.payload?.ok, true);
    const probeReceipt = probeAcquire.payload?.result;
    assert.equal(probeReceipt?.schema, 'flashback.writer-fence.v1');
    assert.equal(probeReceipt.alias, release.alias);
    assert.equal(probeReceipt.owner, probeAcquire.owner);
    assert.equal(probeReceipt.epoch, release.epoch + 1, 'only the successful fresh acquire advances the epoch');
    assert.ok(probeReceipt.expiresAt > Date.now(), 'successful probe acquired a live receipt');
    assert.deepEqual(writerRowRecord(probeAcquire.sqlFence), { alias: release.alias, epoch: probeReceipt.epoch, owner: probeAcquire.owner, expires_at: probeReceipt.expiresAt }, 'actual server row matched the newly acquired receipt');
    assertExactRelease(probeRelease, { key: release.key, alias: release.alias, owner: probeAcquire.owner, epoch: probeReceipt.epoch }, 'explicit fresh-owner release');
    assert.deepEqual(writerRows(app).find(row => row.alias === release.alias), probeRelease.sqlFence, 'fresh probe is actually released before recovery');
    const canonicalBytesAfterReleasedProbe = canonicalSourceBytes(app, release.key, fresh);
    assert.equal(canonicalBytesAfterReleasedProbe, canonicalBytesBeforeReleasedProbe, 'successful no-op probe preserves all scoped canonical and source bytes');
    const afterProbeReadback = await readCanonicalCommit(app, freshApi, freshScope, release.key, FACT);
    assert.equal(afterProbeReadback.verified, true, 'complete durable fact survives both explicit fence probes');
    assert.deepEqual(afterProbeReadback, beforeProbeReadback, 'same physical commit, complete shards and canonical fact survive the probe pair');
    assert.equal(canonicalSourceBytes(app, release.key, fresh), canonicalBytesBeforeProbes, 'canonical readback does not mask a source mutation');
    // Exercise the real request after confirmed release, before the unchanged
    // semantic readiness helper performs its separate current-source work.
    const releasedRawRequest = await freshApi._selectionTest.beforeRequest([{ role: 'user', chatId: 'u9', content: QUERY }], 'model');
    assert.ok(Array.isArray(releasedRawRequest), 'post-release raw request remains usable before vector readiness');
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
      ownerBefore: activeBeforeUnload,
      ownerAfterBoundedTimeout: ownerAfterTimeout,
      ownerAtFirstFreshRequest: firstFreshOwner,
      ownerAfterConfirmedRelease: released,
      oldOwnerRelease: release.event,
      explicitFenceProbes: { held: { callbackCount: heldProbeCallbackCount, error: heldProbeError, events: heldProbeEvents },
        released: { callbackCount: releasedProbeCallbackCount, events: releasedProbeEvents }, canonicalSourceBytesUnchanged: true },
      probeCanonicalReadback: { before: beforeProbeReadback, after: afterProbeReadback },
      probeCanonicalSourceBytes: { beforeHeld: canonicalBytesBeforeProbes, afterHeld: canonicalBytesAfterHeldProbe,
        beforeReleased: canonicalBytesBeforeReleasedProbe, afterReleased: canonicalBytesAfterReleasedProbe },
      firstFreshDiagnostics,
      firstFreshRequestHadCanonical: firstInjection.includes(FACT),
      firstFreshRecallReason: firstFreshDiagnostics.lastRecall?.reason || '',
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
