'use strict';
// Task 48 forced-concurrency test: the session-handoff adoption path
// (`adoptSessionHandoff`, reached from `ensureScopeStorageReady` when a chat
// carries a valid `memorySessionBridge` marker) used to write the TARGET scope
// manifest from an unlocked load-modify-save:
//
//   22407  const targetManifest = await loadScopeManifest(targetScope);
//   22409  await saveScopeManifest({ ...targetManifest, copyAdoptedComplete: true, ... })
//
// Two callers interleaving at those awaits both read revision N, so the second
// write either lost the adoption or failed the conditional batch with HTTP 409
// `conditional_batch_state_changed`. The same was true of the main adoption write
// and of the `SOURCE_MUTATION_DETECTED` rollback.
//
// This test forces the interleaving deterministically. It intercepts the target
// manifest conditional batch at the storage-fetch boundary and holds it until a
// competing writer arrives at the SAME key, or a bounded hold expires. Because
// the target write is serialized by `withScopeWriteLock(targetScope.scopeKey)`,
// two writers can never be inside load-modify-save at once, so:
//   arrivals >= 1     -> the adoption really reached the manifest commit point
//   overlap == false  -> no two writers were inside load-modify-save together
//   conflicts == 0    -> no CAS loss
// `arrivals >= 1` is what keeps the test from passing vacuously; without it a
// future change that made the adapter bail before writing would still "pass".
//
// RED guard: point FLASHBACK_HANDOFF_RACE_PLUGIN_SOURCE at the pre-fix plugin byte
// stream and the test FAILS (overlap=true), so the RED state is demonstrated
// rather than asserted.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const { clone } = require('./fixtures/native_branch_fixture.cjs');

const pluginSourceOverride = process.env.FLASHBACK_HANDOFF_RACE_PLUGIN_SOURCE
  ? fs.readFileSync(path.resolve(process.env.FLASHBACK_HANDOFF_RACE_PLUGIN_SOURCE), 'utf8')
  : null;

const ITERATIONS = Number(process.env.FLASHBACK_HANDOFF_RACE_ITERATIONS || 12);
const HOLD_MS = Number(process.env.FLASHBACK_HANDOFF_RACE_HOLD_MS || 400);
const CONFLICT_PATTERN = /conditional_batch_state_changed|FLASHBACK_COMMIT_CONFLICT|operation_id_payload_conflict|FLASHBACK_WRITER_FENCED/;
const BRIDGE_SCHEMA = 'memory-session-bridge-v1';
const physicalScopeSnapshot = (app, scope) => {
  const key = `vector_rag_memory:scope:${scope.storageHash}:manifest:v2`;
  const db = app.repositories.flashback.database;
  const rawRows = db.prepare('SELECT space, key, revision, digest, deleted, value_json FROM kv WHERE key = ? ORDER BY space').all(key);
  const manifestRows = rawRows.map(row => {
    let manifest = null;
    try { manifest = JSON.parse(String(row.value_json || '')); if (typeof manifest === 'string') manifest = JSON.parse(manifest); } catch (_) {}
    return { space: row.space, key: row.key, revision: row.revision, digest: row.digest, deleted: row.deleted,
      valueJson: row.value_json, manifest };
  });
  const manifest = manifestRows.find(row => row.deleted === 0 && row.manifest?.commitId);
  const shardRows = manifest ? db.prepare('SELECT space, key, revision, digest, deleted, value_json FROM kv WHERE space = ? AND key LIKE ? ORDER BY key')
    .all(manifest.space, `vector_rag_memory:scope:${scope.storageHash}:records:commit:${manifest.manifest.commitId}:shard:%`).map(row => ({ ...row })) : [];
  return { key, manifestRows, shardRows };
};
const summarizePhysicalScope = physical => ({ key: physical.key,
  manifestRows: physical.manifestRows.map(row => ({ space: row.space, key: row.key, revision: row.revision, digest: row.digest,
    deleted: row.deleted, bytes: String(row.valueJson || '').length, commitId: row.manifest?.commitId || '', count: Number(row.manifest?.count || 0),
    shardCount: Number(row.manifest?.shardCount || 0), adopted: row.manifest?.copyAdoptedComplete === true,
    archiveId: row.manifest?.archiveRef?.archiveId || '' })),
  shardRows: physical.shardRows.map(({ value_json, ...row }) => ({ ...row, bytes: String(value_json || '').length })) });
const physicalByteFingerprint = physical => ({ key: physical.key,
  manifestRows: physical.manifestRows.map(row => ({ space: row.space, key: row.key, revision: row.revision, digest: row.digest, deleted: row.deleted,
    bytes: String(row.valueJson || '').length, sha256: createHash('sha256').update(String(row.valueJson || ''), 'utf8').digest('hex') })),
  shardRows: physical.shardRows.map(row => ({ space: row.space, key: row.key, revision: row.revision, digest: row.digest, deleted: row.deleted,
    bytes: String(row.value_json || '').length, sha256: createHash('sha256').update(String(row.value_json || ''), 'utf8').digest('hex') })) });
const runSourceMutationRollback = async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-handoff-rollback-'));
  let app = null;
  let fixture = null;
  let sourceMutationFixture = null;
  let api = null;
  let targetManifestKey = '';
  let sourceManifestKey = '';
  let freshReadbackFixture = null;
  let sourceReadFaultArmed = false;
  const sourceReadFaultHits = [];
  let sourceMutationAttempt = null;
  let sourcePhysicalAtMutation = null;
  let sourcePhysicalBeforeMutationAttempt = null;
  let sourceRetirementReceipt = null;
  const lateTargetBatches = [];
  const gate = { armed: false, arrivals: 0, statuses: [], batchEvents: [], beforeTargetCommit: null };
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
    const address = await app.listen();
    const source = { id: 'rollback-source', name: 'Rollback source', message: [
      { role: 'user', data: 'q1' }, { role: 'char', data: 'a1' }, { role: 'user', data: 'q2' }, { role: 'char', data: 'a2' },
      { role: 'user', data: 'q3' }, { role: 'char', data: 'a3' }, { role: 'user', data: 'q4' }, { role: 'char', data: 'a4' }
    ] };
    const target = { id: 'rollback-target', name: 'Rollback target', message: [] };
    fixture = await createFixture({
      chat: clone(target),
      exposeStorageBridge: true,
      arguments: { memory_suite_server_url: `http://127.0.0.1:${address.port}` },
      nativeFetch: async (url, init) => {
        const requestUrl = new URL(String(url));
        if (sourceReadFaultArmed && requestUrl.pathname === '/v1/kv/get'
          && String(init?.method || 'GET').toUpperCase() === 'GET'
          && requestUrl.searchParams.get('key') === sourceManifestKey) {
          const response = await fetch(url, init);
          const payload = await response.clone().json();
          const storedValue = payload?.result?.value;
          const parsedValue = typeof storedValue === 'string' ? JSON.parse(storedValue) : storedValue;
          const originalCount = Number(parsedValue?.count || 0);
          parsedValue.count = originalCount + 1;
          payload.result.value = typeof storedValue === 'string' ? JSON.stringify(parsedValue) : parsedValue;
          sourceReadFaultHits.push({ key: sourceManifestKey, originalCount, injectedCount: parsedValue.count,
            appliedAfterTargetDurableCommit: !!gate.targetCommitPhysical?.copyAdoptedComplete,
            revision: Number(payload?.result?.revision || 0), digest: String(payload?.result?.digest || '') });
          if (sourceReadFaultHits.length === 2) sourceReadFaultArmed = false;
          const headers = new Headers(response.headers);
          headers.delete('content-length');
          return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
        }
        let batchEvent = null;
        let hit = false;
        if (String(url).includes('/v1/kv/batch')) {
          try {
            const body = JSON.parse(String(init?.body || '{}'));
            const mutations = Array.isArray(body?.mutations) ? body.mutations : [];
            hit = !!targetManifestKey && mutations.some(row => row?.key === targetManifestKey);
            if (hit) {
              const manifestMutation = mutations.find(row => row?.key === targetManifestKey);
              let manifestValue = manifestMutation?.value;
              for (let depth = 0; depth < 2 && typeof manifestValue === 'string'; depth++) {
                try { manifestValue = JSON.parse(manifestValue); } catch (_) { break; }
              }
              batchEvent = { gateArmed: gate.armed, kind: manifestMutation?.kind || '',
                adopted: manifestValue?.copyAdoptedComplete === true,
                archiveId: manifestValue?.archiveRef?.archiveId || '',
                transferId: manifestValue?.copyTransferId || '',
                expectedRevision: Number(manifestMutation?.expectedRevision || 0), gateHit: gate.armed, status: null };
              if (gate.armed) gate.batchEvents.push(batchEvent);
              else lateTargetBatches.push(batchEvent);
            }
          } catch (_) {}
        }
        if (hit && gate.armed) {
          gate.arrivals += 1;
          if (gate.beforeTargetCommit) {
            const beforeTargetCommit = gate.beforeTargetCommit;
            gate.beforeTargetCommit = null;
            await beforeTargetCommit();
          }
        }
        const response = await fetch(url, init);
        if (batchEvent) batchEvent.status = response.status;
        if (hit && gate.armed) {
          gate.statuses.push(response.status);
          if (response.status === 200 && gate.arrivals === 1) {
            const row = app.repositories.flashback.get('plugin', targetManifestKey);
            let manifest = row?.value || null;
            if (typeof manifest === 'string') { try { manifest = JSON.parse(manifest); } catch (_) {} }
            gate.targetCommitPhysical = row?.exists && manifest && typeof manifest === 'object' ? {
              key: targetManifestKey, revision: Number(row.revision || 0), commitId: String(manifest.commitId || ''),
              count: Number(manifest.count || 0), shardCount: Number(manifest.shardCount || 0),
              copyAdoptedComplete: manifest.copyAdoptedComplete === true,
              archiveId: String(manifest.archiveRef?.archiveId || ''), archiveScopeKey: String(manifest.archiveRef?.archiveScopeKey || '')
            } : null;
            if (gate.targetCommitPhysical?.copyAdoptedComplete && gate.targetCommitPhysical.archiveId
              && sourceMutationAttempt?.accepted !== true) sourceReadFaultArmed = true;
          }
        }
        return response;
      }
    });
    api = fixture.api;
    const t = api._test;
    const bridge = fixture.context.__fixtureStorageBridge;
    const snapshot = chat => ({ character: clone(fixture.character), chat: clone(chat),
      db: { personas: [], selectedPersona: '' }, chatInfo: { characterIndex: 0, chatIndex: 0 } });
    const storageScope = scope => ({ scopeId: scope.scopeKey, scopeKey: scope.scopeKey,
      characterId: scope.characterId, chatId: scope.chatId, aliases: [scope.scopeKey, scope.storageHash, scope.chatId].filter(Boolean) });
    const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });

    sourceMutationFixture = await createFixture({
      chat: clone(source),
      exposeStorageBridge: true,
      arguments: { memory_suite_server_url: `http://127.0.0.1:${address.port}` },
      nativeFetch: async (url, init) => {
        return await fetch(url, init);
      }
    });
    const sourceMutationTest = sourceMutationFixture.api._test;
    const sourceBridge = sourceMutationFixture.context.__fixtureStorageBridge;
    const sourceSnapshot = { character: clone(sourceMutationFixture.character), chat: clone(sourceMutationFixture.currentChat),
      db: { personas: [], selectedPersona: '' }, chatInfo: { characterIndex: 0, chatIndex: 0 } };
    const from = sourceMutationTest.resolveScopeFromSnapshot(sourceSnapshot);
    await sourceBridge.setScopeMode(storageScope(from), 'server_only');
    sourceManifestKey = `vector_rag_memory:scope:${from.storageHash}:manifest:v2`;
    const records = [];
    for (let i = 1; i <= 4; i++) records.push(t.cleanRecordForMemory({
      id: `rollback-record-${i}`, sourceType: 'response', sourceId: `rollback-source:turn:${i}`,
      text: `User:\nQ${i}\n\n---\n\nAssistant:\nA${i}`, title: `Turn ${i}`, scopeKey: from.scopeKey,
      pairIndex: i, turnIndex: i, tags: [], tokenCount: 4, tokens: 4,
      vector: [1, 0, 0, 0, 0, 0, 0, 0], dim: 8, provider: 'hash', model: 'hash-8',
      embeddingProvider: 'hash', embeddingModel: 'hash-8', embeddingDimensions: 8,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lifecycleStatus: 'active', sourceHash: `rollback-turn-${i}`
    }, from, { authoritativeSource: true }).record);
    await sourceMutationTest.saveAllRecords(records, cfg, from);
    sourceRetirementReceipt = await sourceMutationTest.retireExternalRecordsForScope(from, { reason: 'handoff_source_baseline_settle' });
    await sourceBridge.whenFlashbackWritersIdle();
    const sourceBeforeMutation = physicalScopeSnapshot(app, from);
    assert.ok(sourceBeforeMutation.manifestRows.some(row => row.deleted === 0 && row.manifest?.count === 4),
      'rollback source starts with four physically committed records');
    assert.ok(Number(sourceBeforeMutation.manifestRows.find(row => row.deleted === 0)?.manifest?.externalRetirementVersion || 0) >= 1,
      'source initialization retirement is settled before the physical handoff baseline is captured');
    assert.equal(sourceBeforeMutation.key, sourceManifestKey, 'source baseline is read from the canonical source manifest key');

    // The source writer stays in its own runtime while the target runtime holds
    // the target commit, so its writer boundary remains valid.
    const mutationScope = sourceMutationTest.resolveScopeFromSnapshot(sourceSnapshot);
    assert.equal(mutationScope.scopeKey, from.scopeKey, 'independent writer resolves the same source scope');

    fixture.character.chats = [fixture.currentChat, clone(source)];
    const targetBase = t.resolveScopeFromSnapshot(snapshot(fixture.currentChat));
    await bridge.setScopeMode(storageScope(targetBase), 'server_only');
    const sourceAfterTargetMode = physicalScopeSnapshot(app, from);
    assert.deepEqual(physicalByteFingerprint(sourceAfterTargetMode), physicalByteFingerprint(sourceBeforeMutation),
      'target mode preparation preserves the settled source manifest and shard bytes');
    assert.notEqual(targetBase.storageHash, from.storageHash, 'target and source use distinct canonical storage hashes');
    const targetBefore = await t.loadScopeManifest(targetBase);
    const targetRecordsBefore = await t.loadScopeRecords(targetBase.scopeKey);
    const targetPhysicalBefore = physicalScopeSnapshot(app, targetBase);
    assert.notEqual(targetBefore.copyAdoptedComplete, true, 'target is empty before the handoff marker is installed');
    const marker = { schema: BRIDGE_SCHEMA, includeFlashback: true, sourceChatId: source.id, targetChatId: target.id,
      transferId: 'rollback-transfer', sourceFlashbackScopeKey: from.scopeKey, flashbackRecordCount: 4 };
    const targetWithBridge = { ...target, memorySessionBridge: marker };
    Object.assign(fixture.currentChat, clone(targetWithBridge));
    fixture.character.chats = [clone(targetWithBridge), clone(source)];
    const to = t.resolveScopeFromSnapshot(snapshot(fixture.currentChat));
    assert.equal(to.bridgeHandoffValid, true, 'rollback marker is valid before adoption');
    targetManifestKey = `vector_rag_memory:scope:${to.storageHash}:manifest:v2`;
    const injectedRecord = t.cleanRecordForMemory({
      id: 'rollback-concurrent-source-edit', sourceType: 'response', sourceId: 'rollback-source:turn:5',
      text: 'User:\nQ5\n\n---\n\nAssistant:\nA5', title: 'Concurrent source edit', scopeKey: from.scopeKey,
      pairIndex: 5, turnIndex: 5, tags: [], tokenCount: 4, tokens: 4,
      vector: [1, 0, 0, 0, 0, 0, 0, 0], dim: 8, provider: 'hash', model: 'hash-8',
      embeddingProvider: 'hash', embeddingModel: 'hash-8', embeddingDimensions: 8,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lifecycleStatus: 'active', sourceHash: 'rollback-edit'
    }, from, { authoritativeSource: true }).record;
    gate.beforeTargetCommit = async () => {
      sourcePhysicalBeforeMutationAttempt = physicalScopeSnapshot(app, from);
      try {
        await sourceMutationTest.saveAllRecords([...records, injectedRecord], cfg, mutationScope);
        sourceMutationAttempt = { accepted: true, errorCode: '' };
      } catch (error) {
        const errorCode = error?.code || error?.message || String(error);
        sourceMutationAttempt = { accepted: false, errorCode, status: Number(error?.status || 0) };
        if (errorCode !== 'FLASHBACK_WRITER_BUSY' && Number(error?.status || 0) !== 409) throw error;
      }
      sourcePhysicalAtMutation = physicalScopeSnapshot(app, from);
      const liveSourceManifest = sourcePhysicalAtMutation.manifestRows.find(row => row.deleted === 0)?.manifest || null;
      const sourceSemanticAtMutation = await sourceMutationTest.loadScopeRecords(from.scopeKey);
      sourceMutationAttempt = { ...sourceMutationAttempt,
        physicalCount: Number(liveSourceManifest?.count || 0), semanticCount: sourceSemanticAtMutation.records.length,
        sourceOwner: String(app.repositories.flashback.database.prepare('SELECT owner FROM flashback_writer_fences WHERE alias=?')
          .get(from.storageHash)?.owner || '') };
    };

    gate.armed = true;
    let adoptionError = null;
    let adoptionResult = null;
    try { adoptionResult = await t.ensureScopeStorageReady(to, cfg); } catch (error) { adoptionError = error; }
    gate.armed = false;
    gate.beforeTargetCommit = null;
    delete fixture.currentChat.memorySessionBridge;
    for (const chat of fixture.character.chats || []) if (chat?.id === target.id) delete chat.memorySessionBridge;
    const hostCurrentChatAfterMarkerRemoval = await fixture.host.getCurrentChat();
    const hostCharacterAfterMarkerRemoval = await fixture.host.getCharacter();
    assert.equal(hostCurrentChatAfterMarkerRemoval?.memorySessionBridge, undefined,
      'the host current-chat getter reflects bridge-marker removal immediately after the failed handoff');
    assert.ok((hostCharacterAfterMarkerRemoval?.chats || []).filter(chat => chat?.id === target.id)
      .every(chat => chat?.memorySessionBridge === undefined),
    'the host character getter exposes no remaining copy of the bridge marker');
    assert.equal(adoptionError, null, `handoff returns a classified result rather than throwing: ${adoptionError?.message || ''}`);
    const handoffFailure = adoptionResult?.handoff || null;
    assert.equal(String(handoffFailure?.reason || ''), 'SOURCE_MUTATION_DETECTED',
      `source integrity mismatch triggers target rollback: ${JSON.stringify({ reason: handoffFailure?.reason || '',
        error: handoffFailure?.error || '', rollbackError: handoffFailure?.targetRollbackError || '',
        rollbackConfirmed: handoffFailure?.targetRollbackConfirmed === true, arrivals: gate.arrivals, statuses: gate.statuses,
        targetCommitPhysical: gate.targetCommitPhysical, sourceMutationAttempt, sourceReadFaultHits })}`);
    if (sourceMutationAttempt?.accepted !== true) {
      assert.match(String(handoffFailure?.error || ''), /manifestHash, count/,
        'the source integrity comparator reports the two injected manifest fingerprint differences');
    }
    assert.ok(gate.arrivals >= 2, `gate observes target adoption and rollback writes: ${JSON.stringify({ arrivals: gate.arrivals, statuses: gate.statuses,
      sourceReadFaultHits, result: adoptionResult?.reason || '', target: summarizePhysicalScope(physicalScopeSnapshot(app, to)) })}`);
    assert.equal(handoffFailure.targetRollbackConfirmed, true, 'handoff returns only after confirming target rollback');
    assert.ok(gate.batchEvents.filter(event => event.gateHit).length >= 2, 'both target mutation and rollback batch reached the gate');
    assert.ok(gate.statuses.length >= 2 && gate.statuses.every(status => status === 200),
      `target mutation and rollback batches are accepted: ${JSON.stringify(gate.statuses)}`);
    assert.ok(sourceMutationAttempt.accepted === true || sourceMutationAttempt.errorCode === 'FLASHBACK_WRITER_BUSY',
      `concurrent source write either commits durably or is rejected by owner fence: ${JSON.stringify(sourceMutationAttempt)}`);
    if (!sourceMutationAttempt.accepted) assert.equal(sourceMutationAttempt.status, 409,
      'the independent writer reports the owner-fence conflict');
    if (sourceMutationAttempt.accepted) {
      assert.equal(sourceMutationAttempt.physicalCount, 5, 'accepted concurrent source writer durably commits five records');
      assert.equal(sourceMutationAttempt.semanticCount, 5, 'source runtime reads back the concurrent fifth record');
      assert.equal(sourceReadFaultHits.length, 0, 'real source mutation is sufficient; no read fault is injected');
    } else {
      assert.equal(sourceMutationAttempt.physicalCount, 4, 'rejected source writer leaves four physical records');
      assert.equal(sourceMutationAttempt.semanticCount, 4, 'rejected source writer leaves four semantic records');
      assert.ok(sourceMutationAttempt.sourceOwner, 'busy result coincides with an active canonical source owner');
      assert.deepEqual(physicalByteFingerprint(sourcePhysicalAtMutation), physicalByteFingerprint(sourcePhysicalBeforeMutationAttempt),
        'HTTP 409 leaves canonical source manifest and shard bytes unchanged');
      assert.equal(sourceReadFaultHits.length, 2, 'both consecutive source manifest reads in the final integrity snapshot receive the isolated fault');
      assert.ok(sourceReadFaultHits.every(hit => hit.appliedAfterTargetDurableCommit),
        'the read faults occur after SQLite shows the adopted manifest and archive link');
      assert.ok(sourceReadFaultHits.every(hit => hit.originalCount === 4 && hit.injectedCount === 5),
        'the read fault changes only the returned count from four to five, not durable SQLite');
      assert.equal(sourceReadFaultArmed, false, 'fault is disarmed immediately after the two manifest reads in the integrity snapshot');
    }
    assert.deepEqual(physicalByteFingerprint(sourcePhysicalBeforeMutationAttempt), physicalByteFingerprint(sourceBeforeMutation),
      'handoff preparation leaves the settled source manifest and shard bytes unchanged before the external writer attempt');

    const targetAfter = await t.loadScopeManifest(to);
    const targetRecordsAfter = await t.loadScopeRecords(to.scopeKey);
    const targetPhysicalAfter = physicalScopeSnapshot(app, to);
    const targetLiveManifest = targetPhysicalAfter.manifestRows.find(row => row.deleted === 0);
    assert.ok(targetLiveManifest, 'rolled-back target manifest is physically readable');
    assert.notEqual(targetAfter.copyAdoptedComplete, true, 'failed adoption does not remain logically complete');
    assert.notEqual(targetLiveManifest.manifest.copyAdoptedComplete, true, 'fresh physical manifest readback clears the adopted flag');
    assert.equal(targetAfter.archiveRef || null, targetBefore.archiveRef || null, 'rollback removes the new archive reference');
    assert.equal(String(targetAfter.copyTransferId || ''), String(targetBefore.copyTransferId || ''), 'rollback restores the prior transfer id');
    assert.equal(Array.from(targetRecordsAfter.records, record => record.id).sort().join('|'),
      Array.from(targetRecordsBefore.records, record => record.id).sort().join('|'), 'rollback restores the target semantic record set');
    assert.deepEqual(physicalByteFingerprint({ ...targetPhysicalAfter, manifestRows: [] }).shardRows,
      physicalByteFingerprint({ ...targetPhysicalBefore, manifestRows: [] }).shardRows,
      'rollback leaves target shard bytes unchanged from its pre-adoption state');
    const sourceAfterRollback = physicalScopeSnapshot(app, from);
    assert.deepEqual(physicalByteFingerprint(sourceAfterRollback), physicalByteFingerprint(sourcePhysicalAtMutation),
      'target rollback preserves exact source bytes after the mutation or read fault');
    const expectedSourceCount = sourceMutationAttempt.accepted ? 5 : 4;
    assert.equal((await t.loadScopeRecords(from.scopeKey)).records.length, expectedSourceCount,
      'source contents remain at the canonical pre-rollback state');
    const durableSourceRecords = (await t.loadScopeRecords(from.scopeKey)).records;
    const expectedSourceIds = sourceMutationAttempt.accepted ? [...records.map(record => record.id), injectedRecord.id] : records.map(record => record.id);
    assert.equal(Array.from(durableSourceRecords, record => record.id).sort().join('|'),
      expectedSourceIds.sort().join('|'), 'source retains only the original records plus an accepted concurrent edit');
    // Drain/unload the marker-free owner before asking a fresh runtime to read.
    await bridge.whenFlashbackWritersIdle();
    await fixture.dispose();
    fixture = null;
    const targetAfterOwnerDrain = physicalScopeSnapshot(app, to);
    const drainedTargetManifest = targetAfterOwnerDrain.manifestRows.find(row => row.deleted === 0)?.manifest || null;
    assert.notEqual(drainedTargetManifest?.copyAdoptedComplete, true,
      `owner drain after removing the bridge marker does not re-adopt the target: ${JSON.stringify({
        lateTargetBatches, gateBatchEvents: gate.batchEvents, target: summarizePhysicalScope(targetAfterOwnerDrain)
      })}`);
    assert.equal(drainedTargetManifest?.archiveRef || null, targetBefore.archiveRef || null,
      'owner drain preserves the rolled-back target archive reference');
    assert.ok(lateTargetBatches.every(event => event.adopted !== true && !event.archiveId && !event.transferId),
      `late target writes cannot re-publish the failed adoption: ${JSON.stringify(lateTargetBatches)}`);
    assert.equal(gate.batchEvents.length, 2,
      `only adoption and rollback target writes reached the active gate: ${JSON.stringify(gate.batchEvents)}`);
    freshReadbackFixture = await createFixture({
      chat: clone(target), exposeStorageBridge: true,
      arguments: { memory_suite_server_url: `http://127.0.0.1:${address.port}` },
      nativeFetch: async (url, init) => fetch(url, init)
    });
    const freshTest = freshReadbackFixture.api._test;
    const freshTargetScope = freshTest.resolveScopeFromSnapshot({
      character: clone(freshReadbackFixture.character), chat: clone(freshReadbackFixture.currentChat),
      db: { personas: [], selectedPersona: '' }, chatInfo: { characterIndex: 0, chatIndex: 0 }
    });
    assert.equal(freshTargetScope.scopeKey, to.scopeKey, 'fresh marker-free bridge resolves the same canonical target identity');
    const freshBridge = freshReadbackFixture.context.__fixtureStorageBridge;
    await freshBridge.setScopeMode(storageScope(from), 'server_only');
    await freshBridge.setScopeMode(storageScope(freshTargetScope), 'server_only');
    const freshSourceReadback = await freshTest.loadScopeRecords(from.scopeKey);
    const freshTargetReadback = await freshTest.loadScopeRecords(freshTargetScope.scopeKey);
    const freshTargetManifest = await freshTest.loadScopeManifest(freshTargetScope);
    assert.equal(freshSourceReadback.records.length, expectedSourceCount, 'fresh bridge reads the canonical source record count after rollback');
    assert.equal(freshSourceReadback.manifest.missingShards, 0, 'fresh bridge reports no source shard loss');
    assert.equal(freshSourceReadback.manifest.corruptShards, 0, 'fresh bridge reports no source shard corruption');
    assert.notEqual(freshSourceReadback.manifest.recordCountMismatch, true, 'fresh bridge verifies source record-count completeness');
    assert.equal(Array.from(freshTargetReadback.records, record => record.id).sort().join('|'),
      Array.from(targetRecordsBefore.records, record => record.id).sort().join('|'),
      `fresh bridge reads the target semantic baseline after rollback: ${JSON.stringify({
        freshScope: freshTargetScope.scopeKey, freshArchive: freshTargetManifest.archiveRef?.archiveId || '',
        freshTransfer: freshTargetManifest.copyTransferId || '', beforeIds: targetRecordsBefore.records.map(record => record.id),
        freshIds: freshTargetReadback.records.map(record => record.id), lateTargetBatches
      })}`);
    assert.notEqual(freshTargetManifest.copyAdoptedComplete, true, 'fresh bridge reads the target adoption flag cleared');
    assert.equal(freshTargetManifest.archiveRef || null, targetBefore.archiveRef || null,
      'fresh bridge reads the prior target archive reference after rollback');
    return { arrivals: gate.arrivals, statuses: gate.statuses, sourceMutationAttempt,
      sourceBaseline: { scopeKey: from.scopeKey, storageHash: from.storageHash,
        externalRetirementReason: sourceRetirementReceipt?.reason || '', externalRetirementVersion: Number(sourceBeforeMutation.manifestRows.find(row => row.deleted === 0)?.manifest?.externalRetirementVersion || 0) },
      sourceReadFaultHits, targetCommitPhysical: gate.targetCommitPhysical,
      sourceRecordsAfterRollback: expectedSourceCount, freshSourceRecords: freshSourceReadback.records.length,
      freshTargetRecords: freshTargetReadback.records.length,
      targetAdoptedAfterRollback: targetLiveManifest.manifest.copyAdoptedComplete === true,
      targetArchiveAfterRollback: targetAfter.archiveRef?.archiveId || '' };
  } finally {
    await freshReadbackFixture?.dispose?.().catch(() => null);
    await sourceMutationFixture?.dispose?.().catch(() => null);
    await fixture?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
};

(async () => {
  const aggregate = { iterations: 0, passed: 0, conflicts: 0, overlaps: 0, arrivalsTotal: 0, pendingMax: 0, iterationsWithArrival: 0 };
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    aggregate.iterations += 1;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-handoff-race-'));
    const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
    const address = await app.listen();

    let manifestKey = null;
    const gate = { armed: false, pending: [], arrivals: 0, overlap: false, statuses: [], pendingMax: 0, batchEvents: [], beforeTargetCommit: null };
    const releaseAll = () => { const waiting = gate.pending.splice(0); for (const release of waiting) release(); };
    const gatedFetch = async (url, init) => {
      const target = String(url);
      let hit = false;
      let batchEvent = null;
      if (gate.armed && target.includes('/v1/kv/batch')) {
        try {
          const body = JSON.parse(String((init && init.body) || ''));
          const mutations = Array.isArray(body?.mutations) ? body.mutations : [];
          batchEvent = { mutations: mutations.map(row => ({ space: row?.space || '', key: row?.key || '', kind: row?.kind || '', expectedRevision: Number(row?.expectedRevision || 0) })), status: null };
          gate.batchEvents.push(batchEvent);
          hit = !!manifestKey && mutations.some(row => row?.key === manifestKey);
          batchEvent.gateHit = hit;
        } catch (_) { hit = false; }
      }
      if (!hit) {
        const response = await fetch(url, init);
        if (batchEvent) batchEvent.status = response.status;
        return response;
      }
      if (gate.beforeTargetCommit) {
        const beforeTargetCommit = gate.beforeTargetCommit;
        gate.beforeTargetCommit = null;
        await beforeTargetCommit();
      }
      gate.arrivals += 1;
      await new Promise(resolve => {
        gate.pending.push(resolve);
        gate.pendingMax = Math.max(gate.pendingMax, gate.pending.length);
        if (gate.pending.length >= 2) { gate.overlap = true; releaseAll(); return; }
        setTimeout(() => { const index = gate.pending.indexOf(resolve); if (index >= 0) gate.pending.splice(index, 1); resolve(); }, HOLD_MS);
      });
      const response = await fetch(url, init);
      gate.statuses.push(response.status);
      if (batchEvent) batchEvent.status = response.status;
      return response;
    };

    const f = await createFixture({
      exposeStorageBridge: true,
      arguments: { memory_suite_server_url: `http://127.0.0.1:${address.port}` },
      nativeFetch: gatedFetch,
      ...(pluginSourceOverride ? { source: pluginSourceOverride } : {})
    });
    try {
      const t = f.api._test;
      const bridge = f.context.__fixtureStorageBridge;
      assert.ok(bridge, 'fixture storage bridge exposed');
      const snapshot = chat => ({
        character: clone(f.character), chat: clone(chat),
        db: { personas: [], selectedPersona: '' }, chatInfo: { characterIndex: 0, chatIndex: 0 }
      });
      const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });

      // Source chat holding the memory that the handoff will link.
      const source = {
        id: 'race-handoff-source', name: 'Source', message: [
          { role: 'user', data: 'q1' }, { role: 'char', data: 'a1' },
          { role: 'user', data: 'q2' }, { role: 'char', data: 'a2' },
          { role: 'user', data: 'q3' }, { role: 'char', data: 'a3' },
          { role: 'user', data: 'q4' }, { role: 'char', data: 'a4' }
        ]
      };
      Object.assign(f.currentChat, clone(source));
      f.character.chats = [f.currentChat];
      const from = t.resolveScopeFromSnapshot(snapshot(f.currentChat));
      const records = [];
      for (let i = 1; i <= 4; i++) {
        records.push(t.cleanRecordForMemory({
          id: 'handoff-record-' + i, sourceType: 'response', sourceId: `race-handoff-source:turn:${i}`,
          text: `User:\nQ${i}\n\n---\n\nAssistant:\nA${i}`, title: 'Turn ' + i,
          scopeKey: from.scopeKey, pairIndex: i, turnIndex: i, tags: [], tokenCount: 4, tokens: 4,
          vector: [1, 0, 0, 0, 0, 0, 0, 0], dim: 8, provider: 'hash', model: 'hash-8',
          embeddingProvider: 'hash', embeddingModel: 'hash-8', embeddingDimensions: 8,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          lifecycleStatus: 'active', sourceHash: 'handoff-turn-' + i
        }, from, { authoritativeSource: true }).record);
      }
      await t.saveAllRecords(records, cfg, from);
      const sourceManifestBefore = JSON.stringify(await t.loadScopeManifest(from));
      let sourcePhysicalBefore = null;

      // Put the target into server_only while it has no handoff marker. The safe
      // mode transition can itself discover/copy chat content, so applying the
      // marker first would commit the archive before the concurrency gate is armed.
      const target = { id: 'race-handoff-target', name: 'Target', message: [] };
      Object.assign(f.currentChat, clone(target));
      f.character.chats = [clone(target), clone(source)];
      const targetBaseScope = t.resolveScopeFromSnapshot(snapshot(f.currentChat));
      const targetStorageScope = {
        scopeId: targetBaseScope.scopeKey, scopeKey: targetBaseScope.scopeKey,
        characterId: targetBaseScope.characterId, chatId: targetBaseScope.chatId,
        aliases: [targetBaseScope.scopeKey, targetBaseScope.storageHash, targetBaseScope.chatId].filter(Boolean)
      };
      const targetBeforeMode = { manifest: await t.loadScopeManifest(targetBaseScope), physical: physicalScopeSnapshot(app, targetBaseScope) };
      await bridge.setScopeMode(targetStorageScope, 'server_only');
      const targetAfterMode = { manifest: await t.loadScopeManifest(targetBaseScope), physical: physicalScopeSnapshot(app, targetBaseScope) };
      sourcePhysicalBefore = physicalScopeSnapshot(app, from);
      assert.notEqual(targetAfterMode.manifest.copyAdoptedComplete, true,
        `server mode preparation without a bridge marker must leave archive adoption pending (iteration ${iteration})`);

      // Now add the valid bridge marker and race two readiness calls against
      // the target manifest's physical conditional batch commit.
      const targetWithBridge = {
        ...target,
        memorySessionBridge: {
          schema: BRIDGE_SCHEMA,
          includeFlashback: true,
          sourceChatId: 'race-handoff-source',
          targetChatId: 'race-handoff-target',
          transferId: `race-transfer-${iteration}`,
          sourceFlashbackScopeKey: from.scopeKey,
          flashbackRecordCount: 4
        }
      };
      Object.assign(f.currentChat, clone(targetWithBridge));
      f.character.chats = [clone(targetWithBridge), clone(source)];
      const to = t.resolveScopeFromSnapshot(snapshot(f.currentChat));
      assert.equal(to.bridgeHandoffValid, true, `bridge marker resolves to a valid handoff (iteration ${iteration})`);
      assert.equal(to.bridgeHandoffTransferId, `race-transfer-${iteration}`, `transfer id preserved (iteration ${iteration})`);
      assert.equal(to.bridgeHandoffSourceScopeKey, from.scopeKey, `source scope key preserved (iteration ${iteration})`);
      assert.equal(to.scopeKey, targetBaseScope.scopeKey, `marker does not change target scope identity (iteration ${iteration})`);
      assert.equal(to.storageHash, targetBaseScope.storageHash, `marker does not change target storage key (iteration ${iteration})`);

      // Arm the gate on the TARGET manifest key, then race two adoptions.
      manifestKey = `vector_rag_memory:scope:${to.storageHash}:manifest:v2`;
      gate.armed = true;
      const settled = await Promise.allSettled([
        t.ensureScopeStorageReady(to, cfg),
        t.ensureScopeStorageReady(to, cfg)
      ]);
      gate.armed = false;

      const settledSummary = settled.map(row => ({ status: row.status,
        value: row.status === 'fulfilled' ? { adopted: row.value?.adopted === true, reason: String(row.value?.reason || ''), fastPath: row.value?.fastPath === true,
          scopeKey: String(row.value?.scope?.scopeKey || ''), commitId: String(row.value?.manifest?.commitId || ''),
          copyAdoptedComplete: row.value?.manifest?.copyAdoptedComplete === true,
          archiveId: String(row.value?.manifest?.archiveRef?.archiveId || '') } : null,
        reason: row.status === 'rejected' ? String(row.reason && (row.reason.message || row.reason)) : '' }));

      const failures = settled.filter(row => row.status === 'rejected')
        .map(row => String(row.reason && (row.reason.message || row.reason)));
      const conflicts = failures.filter(message => CONFLICT_PATTERN.test(message));
      aggregate.arrivalsTotal += gate.arrivals;
      aggregate.pendingMax = Math.max(aggregate.pendingMax, gate.pendingMax);
      aggregate.iterationsWithArrival += gate.arrivals > 0 ? 1 : 0;
      aggregate.conflicts += conflicts.length;
      if (gate.overlap) aggregate.overlaps += 1;

      let diagnosticContext = null;
      if (gate.arrivals === 0) {
        const diagnosticSourceAfter = await t.loadScopeManifest(from);
        const diagnosticTargetAfter = await t.loadScopeManifest(to);
        diagnosticContext = {
        iteration, settled: settledSummary, batchEvents: gate.batchEvents, arrivals: gate.arrivals, statuses: gate.statuses,
        sourceScope: { scopeKey: from.scopeKey, storageHash: from.storageHash, characterId: from.characterId, chatId: from.chatId },
        targetScope: { scopeKey: to.scopeKey, storageHash: to.storageHash, characterId: to.characterId, chatId: to.chatId,
          bridgeHandoffValid: to.bridgeHandoffValid, bridgeHandoffSourceScopeKey: to.bridgeHandoffSourceScopeKey },
        targetMode: await bridge.getScopeMode(targetStorageScope),
        targetBeforeMode: { manifest: { count: targetBeforeMode.manifest.count, shardCount: targetBeforeMode.manifest.shardCount,
          copyAdoptedComplete: targetBeforeMode.manifest.copyAdoptedComplete, archiveId: targetBeforeMode.manifest.archiveRef?.archiveId || '' },
          physical: { manifestRows: targetBeforeMode.physical.manifestRows.map(row => ({ key: row.key, revision: row.revision, digest: row.digest, deleted: row.deleted })), shardCount: targetBeforeMode.physical.shardRows.length } },
        targetAfterMode: { manifest: { count: targetAfterMode.manifest.count, shardCount: targetAfterMode.manifest.shardCount,
          copyAdoptedComplete: targetAfterMode.manifest.copyAdoptedComplete, archiveId: targetAfterMode.manifest.archiveRef?.archiveId || '' },
          physical: { manifestRows: targetAfterMode.physical.manifestRows.map(row => ({ key: row.key, revision: row.revision, digest: row.digest, deleted: row.deleted })), shardCount: targetAfterMode.physical.shardRows.length } },
        sourceManifestBefore: (() => { const value = JSON.parse(sourceManifestBefore); return { commitId: value.commitId, count: value.count, shardCount: value.shardCount, digest: value.sourceIntegrityFingerprint }; })(),
        sourceManifestAfter: { commitId: diagnosticSourceAfter.commitId, count: diagnosticSourceAfter.count, shardCount: diagnosticSourceAfter.shardCount, digest: diagnosticSourceAfter.sourceIntegrityFingerprint },
        targetManifestAfter: { commitId: diagnosticTargetAfter.commitId, count: diagnosticTargetAfter.count, shardCount: diagnosticTargetAfter.shardCount,
          adopted: diagnosticTargetAfter.copyAdoptedComplete, archiveId: diagnosticTargetAfter.archiveRef?.archiveId || '', transferId: diagnosticTargetAfter.copyTransferId },
        sourcePhysical: summarizePhysicalScope(physicalScopeSnapshot(app, from)),
        targetPhysical: summarizePhysicalScope(physicalScopeSnapshot(app, to))
        };
      }

      assert.deepEqual(failures, [], `no handoff writer may fail (iteration ${iteration})`);
      assert.equal(conflicts.length, 0, `no CAS conflict (iteration ${iteration}): ${conflicts.join(' | ')}`);
      assert.ok(gate.arrivals >= 1, `the handoff really reached the target manifest commit point (iteration ${iteration}): ${JSON.stringify(diagnosticContext)}`);
      assert.equal(gate.overlap, false, `handoff writers are serialized, never concurrently inside load-modify-save (iteration ${iteration})`);
      assert.ok(gate.statuses.every(status => status === 200), `every manifest batch accepted (iteration ${iteration}): ${JSON.stringify(gate.statuses)}`);
      assert.ok(gate.batchEvents.some(event => event.gateHit && event.status === 200),
        `gate observed a successful target manifest mutation request (iteration ${iteration}): ${JSON.stringify(gate.batchEvents)}`);

      // The adoption is real and durable, exactly once.
      const manifestAfter = await t.loadScopeManifest(to);
      assert.equal(manifestAfter.copyAdoptedComplete, true, `target content-adopted (iteration ${iteration})`);
      assert.equal(manifestAfter.copyAdoptionMode, 'shared_archive', `target adopted through the shared archive (iteration ${iteration})`);
      assert.equal(manifestAfter.copyTransferId, `race-transfer-${iteration}`, `transfer id committed once (iteration ${iteration})`);
      assert.equal(Number(manifestAfter.copyExpectedRecordCount || 0), 4, `expected record count committed (iteration ${iteration})`);
      assert.ok(manifestAfter.archiveRef, `target linked to the immutable archive (iteration ${iteration})`);
      const archiveProof = await t.verifyFlashbackArchiveRef(manifestAfter.archiveRef, 4);
      assert.equal(archiveProof.verified, true, `target archive link resolves to four durable records (iteration ${iteration}): ${archiveProof.reason}`);
      const archiveManifest = await t.loadScopeManifest(manifestAfter.archiveRef.archiveScopeKey);
      const archivePhysical = physicalScopeSnapshot(app, { storageHash: archiveManifest.storageHash });
      const archivePhysicalManifest = archivePhysical.manifestRows.find(row => row.deleted === 0 && row.manifest?.archiveOwner === true);
      assert.ok(archivePhysicalManifest, `immutable archive manifest is physically present (iteration ${iteration})`);
      assert.equal(archivePhysicalManifest.manifest.archiveId, manifestAfter.archiveRef.archiveId,
        `physical archive identity matches the target reference (iteration ${iteration})`);
      assert.ok(archivePhysical.shardRows.some(row => row.deleted === 0), `archive records have a live physical shard (iteration ${iteration})`);

      // The handoff is non-destructive: the source is untouched.
      assert.equal(JSON.stringify(await t.loadScopeManifest(from)), sourceManifestBefore, `source manifest unchanged (iteration ${iteration})`);
      assert.equal((await t.loadScopeRecords(from.scopeKey)).records.length, 4, `source records preserved (iteration ${iteration})`);
      const sourcePhysicalAfter = physicalScopeSnapshot(app, from);
      assert.deepEqual(physicalByteFingerprint(sourcePhysicalAfter), physicalByteFingerprint(sourcePhysicalBefore),
        `source manifest and shard bytes, digests, revisions, and tombstone state are unchanged (iteration ${iteration}): ${JSON.stringify({ before: physicalByteFingerprint(sourcePhysicalBefore), after: physicalByteFingerprint(sourcePhysicalAfter) })}`);

      // A repeat pass must stay idempotent.
      const repeat = await Promise.allSettled([t.ensureScopeStorageReady(to, cfg), t.ensureScopeStorageReady(to, cfg)]);
      const repeatFailures = repeat.filter(row => row.status === 'rejected')
        .map(row => String(row.reason && (row.reason.message || row.reason)));
      assert.deepEqual(repeatFailures, [], `idempotent repeat has no failure (iteration ${iteration})`);
      const manifestRepeat = await t.loadScopeManifest(to);
      assert.equal(manifestRepeat.copyTransferId, `race-transfer-${iteration}`, `transfer id stable on repeat (iteration ${iteration})`);
      assert.equal(manifestRepeat.copyAdoptedCompleteAt, manifestAfter.copyAdoptedCompleteAt, `adoption timestamp not rewritten on repeat (iteration ${iteration})`);

      aggregate.passed += 1;
    } finally {
      await f.dispose(); await app.close(); fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  const rollback = await runSourceMutationRollback();
  assert.equal(aggregate.conflicts, 0, 'zero CAS conflicts across all iterations');
  assert.equal(aggregate.overlaps, 0, 'zero concurrent load-modify-save windows across all iterations');
  assert.ok(aggregate.arrivalsTotal >= ITERATIONS, 'every iteration exercised the target manifest commit point');
  assert.equal(aggregate.iterationsWithArrival, ITERATIONS, 'every iteration reached the commit point, not a bail-out path');
  console.log(JSON.stringify({
    test: 'flashback_session_handoff_concurrency',
    passed: aggregate.passed,
    iterations: aggregate.iterations,
    http_409: 0,
    lost_adoptions: 0,
    source_mutations: 0,
    manifestCommitsObserved: aggregate.arrivalsTotal,
    concurrentWindows: aggregate.overlaps,
    maxPendingAtGate: aggregate.pendingMax,
    sourceMutationRollback: rollback
  }));
})().catch(e => { console.error(e); process.exitCode = 1; });
