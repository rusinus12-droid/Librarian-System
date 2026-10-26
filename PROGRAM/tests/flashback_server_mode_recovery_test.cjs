'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const createSnapshot = require('../server/core/flashback-scope-health.cjs');

const source = fs.readFileSync(process.env.FLASHBACK_TEST_PLUGIN || require.resolve('../plugins/Flashback_Memory.js'), 'utf8');
const makeStore = values => ({
  values: new Map(values),
  async getItem(k) { return this.values.get(k) ?? null; },
  async setItem(k, v) { this.values.set(k, v); return true; },
  async removeItem(k) { this.values.delete(k); return true; },
  async keys() { return [...this.values.keys()]; }
});
const id = 'S'.repeat(32);
const url = 'http://127.0.0.1:47630';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function serverModeFixture(options = {}) {
  const initialChat = [
    { role: 'user', chatId: 'u1', data: 'Where is the compass?' },
    { role: 'assistant', chatId: 'a1', data: 'The amber compass rests inside the cedar cabinet.' }
  ];

  const fullChat = [
    { role: 'user', chatId: 'u1', data: 'Where is the compass?' },
    { role: 'assistant', chatId: 'a1', data: 'The amber compass rests inside the cedar cabinet.' },
    { role: 'user', chatId: 'u2', data: 'Where is the map?' },
    { role: 'assistant', chatId: 'a2', data: 'The folded map is lying on the oak desk.' }
  ];

  const f = await createFixture({
    source: source
      .replace('  const bridge = Object.freeze({', `  globalThis.__inspectionFixture={state,dataBinding,routeKey:SCOPE_ROUTING_LOCAL_KEY,resetChoiceKey,withModeConfiguration};\n  const bridge = Object.freeze({`)
      .replace('  globalThis.__FlashbackMemory = publicApi;', `  globalThis.__inspectionFixtureText={plan:maintenancePlanText,judgement:maintenanceJudgementText};\n  globalThis.__FlashbackMemory = publicApi;`)
      .replace('_test: { maintenanceResultText,', '_test: { repairScopeRegistryMetadata, classifyScopeForManagement, maintenanceResultText,'),
    chat: { message: initialChat }
  });

  await f.api.saveSettings({
    ...await f.api.loadSettings(),
    embeddingProvider: 'hash',
    embeddingModel: 'hash-v1',
    embeddingEnabled: true,
    embeddingAutoProcess: false,
    episodeIndexEnabled: false
  });

  const scope = await f.api.resolveCurrentScope(false);
  const raw = f.context.__inspectionFixture;

  // Ingest Turn 1 first so server rows will contain Turn 1
  await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
  await new Promise(r => setTimeout(r, 50));

  // Now seed server KV rows with ONLY Turn 1
  const serverRows = new Map();
  for (const [space, store] of [['plugin', f.pluginStorage], ['local', f.host.safeLocalStorage]]) {
    for (const [key, value] of store.values) {
      serverRows.set(space + '\n' + key, {
        space,
        key,
        value,
        exists: true,
        tombstone: false,
        revision: 1,
        digest: sha(JSON.stringify(value)),
        valueBytes: Buffer.byteLength(JSON.stringify(value))
      });
    }
  }

  // Clear local memory stores to simulate server_only state where local corpus does not exist
  for (const key of [...f.pluginStorage.values.keys()]) {
    if (key.startsWith('vector_rag_memory:scope:')) f.pluginStorage.values.delete(key);
  }
  for (const key of [...f.host.safeLocalStorage.values.keys()]) {
    if (key.startsWith('vector_rag_memory:local-vector-shard:')) f.host.safeLocalStorage.values.delete(key);
  }

  // Restore live chat back to full 2 turns (so Turn 2 is missing in server records)
  f.currentChat.message = fullChat;
  f.character.chats[0].message = fullChat;

  const repository = {
    database: { exec() {} },
    list: (space, prefix, { limit }) => {
      const list = [...serverRows.values()]
        .filter(r => r.space === space && r.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { records: list.slice(0, limit).map(({ value, exists, ...r }) => r), page: { hasMore: list.length > limit } };
    },
    get: (space, key) => serverRows.get(space + '\n' + key) || { exists: false, tombstone: false, value: null, revision: 0, digest: '', updatedAt: 0 }
  };

  const endpoint = createSnapshot({
    getRepository: () => repository,
    dataInstanceId: id,
    epochs: () => ({ flashback: 1 }),
    canRead: () => true
  });

  const connection = {
    url,
    requestedUrl: url,
    token: 'synthetic-token',
    dataInstanceId: id,
    dataIdentityContract: 'memory-suite.physical-data-identity.v1',
    dataIdentityCertified: true,
    resetEpochCertified: true,
    resetEpochs: { flashback: 1 },
    capabilities: {
      'flashback-scope-health.v1': true,
      'flashback-writer-fence.v1': true,
      'conditional-batch.v1': true,
      'kv.v1': true,
      'revision.v1': true,
      'digest.v1': true,
      'tombstone.v1': true
    }
  };

  Object.assign(raw.dataBinding, {
    url,
    dataInstanceId: id,
    dataIdentityContract: connection.dataIdentityContract,
    certified: true,
    generation: 1,
    rejected: false
  });
  raw.state.bootstrap = { value: connection, baseUrl: url, at: Date.now(), pending: null };

  if (options.uninitializedRegistry) {
    // Leave SCOPE_ROUTING_LOCAL_KEY empty, but set memory_suite_server_mode argument
    f.pluginStorage.values.delete(raw.routeKey);
    f.host.safeLocalStorage.values.delete(raw.routeKey);
  } else if (options.legacyGlobalModeImportedNoScope) {
    const route = {
      schema: 'memory-suite.scope-routing.v1',
      version: 1,
      namespace: 'flashback',
      legacyGlobalModeImported: true,
      entries: {}
    };
    f.pluginStorage.values.set(raw.routeKey, JSON.stringify(route));
    f.host.safeLocalStorage.values.set(raw.routeKey, JSON.stringify(route));
  } else if (options.transitionPendingScope) {
    const route = {
      schema: 'memory-suite.scope-routing.v1',
      version: 1,
      namespace: 'flashback',
      legacyGlobalModeImported: true,
      entries: {
        [scope.scopeKey]: {
          scopeId: scope.scopeKey,
          scopeKey: scope.scopeKey,
          mode: 'plugin_only',
          origin: 'transition_pending',
          pendingTargetMode: 'server_only',
          updatedAt: 1
        },
        '__memory_suite_global__': {
          scopeId: '__memory_suite_global__',
          scopeKey: '__memory_suite_global__',
          mode: 'server_only',
          origin: 'user_explicit',
          updatedAt: 1
        }
      }
    };
    f.pluginStorage.values.set(raw.routeKey, JSON.stringify(route));
    f.host.safeLocalStorage.values.set(raw.routeKey, JSON.stringify(route));
  } else if (options.removedScopeRow) {
    const route = {
      schema: 'memory-suite.scope-routing.v1',
      version: 1,
      namespace: 'flashback',
      legacyGlobalModeImported: true,
      entries: {
        [scope.scopeKey]: {
          scopeId: scope.scopeKey,
          scopeKey: scope.scopeKey,
          removed: true,
          updatedAt: 1
        },
        '__memory_suite_global__': {
          scopeId: '__memory_suite_global__',
          scopeKey: '__memory_suite_global__',
          mode: 'server_only',
          origin: 'user_explicit',
          updatedAt: 1
        }
      }
    };
    f.pluginStorage.values.set(raw.routeKey, JSON.stringify(route));
    f.host.safeLocalStorage.values.set(raw.routeKey, JSON.stringify(route));
  } else {
    const route = {
      schema: 'memory-suite.scope-routing.v1',
      version: 1,
      namespace: 'flashback',
      legacyGlobalModeImported: true,
      entries: Object.fromEntries([scope.scopeKey, '__memory_suite_global__'].map(scopeId => [
        scopeId,
        { scopeId, scopeKey: scopeId, mode: 'server_only', origin: 'user_explicit', updatedAt: 1 }
      ]))
    };
    f.pluginStorage.values.set(raw.routeKey, JSON.stringify(route));
    f.host.safeLocalStorage.values.set(raw.routeKey, JSON.stringify(route));
  }

  await f.host.setArgument('memory_suite_server_url', url);
  await f.host.setArgument('memory_suite_server_mode', 'server_only');

  f.host.nativeFetch = async (u, init) => {
    if (u.includes('/bootstrap')) {
      return new Response(JSON.stringify({
        ok: true,
        schema: 'memory-suite.storage.bootstrap.v1',
        url,
        token: 'synthetic-token',
        protocol: { major: 1, minor: 0 },
        namespaces: ['flashback', 'hayaku', 'libra'],
        dataInstanceId: id,
        dataIdentityContract: 'memory-suite.physical-data-identity.v1',
        resetEpochCertified: true,
        resetEpochs: { flashback: 1 },
        capabilities: {
          'data-instance-binding.v1': true,
          'flashback-scope-health.v1': true,
          'flashback-writer-fence.v1': true,
          'conditional-batch.v1': true,
          'kv.v1': true,
          'keys.v1': true,
          'revision.v1': true,
          'digest.v1': true,
          'idempotency.v1': true,
          'tombstone.v1': true,
          'readback.v1': true,
          'namespace-integrity.v1': true
        }
      }), { status: 200 });
    }
    assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
    if (u === url + '/v1/flashback/scope-health') {
      const result = await endpoint({ namespace: 'flashback', roles: ['owner'] }, JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, dataInstanceId: id, result }), { status: 200 });
    }
    // Handle server KV get/set/batch endpoints for cold start ingestion
    if (u.includes('/v1/flashback/writer')) {
      const b = JSON.parse(init.body || '{}');
      const alias = String(b.key || '').match(/^vector_rag_memory:(?:scope:|local-vector-shard:v1:)([A-Za-z0-9_-]{1,128}):/)?.[1] || '';
      return new Response(JSON.stringify({
        ok: true,
        dataInstanceId: id,
        result: {
          schema: 'flashback.writer-fence.v1',
          alias,
          owner: b.owner,
          epoch: 1,
          expiresAt: b.action === 'release' ? 0 : Date.now() + 60000
        }
      }), { status: 200 });
    }
    if (u.includes('/v1/kv/batch')) {
      const body = JSON.parse(init.body || '{}');
      const receipts = [];
      if (body.mutations) {
        for (const m of body.mutations) {
          const k = m.space + '\n' + m.key;
          const digest = sha(JSON.stringify(m.value));
          const rev = (m.expectedRevision || 0) + 1;
          serverRows.set(k, {
            space: m.space,
            key: m.key,
            value: m.value,
            exists: true,
            tombstone: false,
            revision: rev,
            digest,
            valueBytes: Buffer.byteLength(JSON.stringify(m.value))
          });
          receipts.push({
            schema: 'memory-suite.storage.receipt.v1',
            kind: m.kind || 'set',
            namespace: 'flashback',
            operationId: m.operationId || body.operationId,
            space: m.space,
            key: m.key,
            durable: true,
            verified: true,
            revision: rev,
            digest
          });
        }
      }
      return new Response(JSON.stringify({
        ok: true,
        dataInstanceId: id,
        result: {
          schema: 'memory-suite.storage.batch-receipt.v1',
          namespace: 'flashback',
          operationId: body.operationId,
          durable: true,
          verified: true,
          atomicScope: 'single_namespace_sqlite',
          receipts
        }
      }), { status: 200 });
    }
    if (u.includes('/v1/kv/set')) {
      const body = JSON.parse(init.body || '{}');
      const digest = sha(JSON.stringify(body.value));
      const k = body.space + '\n' + body.key;
      serverRows.set(k, {
        space: body.space,
        key: body.key,
        value: body.value,
        exists: true,
        tombstone: false,
        revision: 1,
        digest,
        valueBytes: Buffer.byteLength(JSON.stringify(body.value))
      });
      return new Response(JSON.stringify({
        ok: true,
        dataInstanceId: id,
        result: {
          schema: 'memory-suite.storage.receipt.v1',
          namespace: 'flashback',
          operationId: body.operationId,
          space: body.space,
          key: body.key,
          durable: true,
          verified: true,
          revision: 1,
          digest
        }
      }), { status: 200 });
    }
    if (u.includes('/v1/kv/remove')) {
      const body = JSON.parse(init.body || '{}');
      const k = body.space + '\n' + body.key;
      const digest = sha('null');
      serverRows.set(k, {
        space: body.space,
        key: body.key,
        value: null,
        exists: false,
        tombstone: true,
        revision: 1,
        digest,
        valueBytes: 0
      });
      return new Response(JSON.stringify({
        ok: true,
        dataInstanceId: id,
        result: {
          schema: 'memory-suite.storage.receipt.v1',
          namespace: 'flashback',
          operationId: body.operationId,
          space: body.space,
          key: body.key,
          durable: true,
          verified: true,
          revision: 1,
          digest
        }
      }), { status: 200 });
    }
    if (u.includes('/v1/kv/get')) {
      const urlObj = new URL(u);
      const space = urlObj.searchParams.get('space');
      const key = urlObj.searchParams.get('key');
      const r = repository.get(space, key);
      return new Response(JSON.stringify({ ok: true, dataInstanceId: id, result: r }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, dataInstanceId: id }), { status: 200 });
  };

  return { ...f, scope, serverRows, endpoint };
}

if (require.main === module) (async () => {
  console.log('Testing Server Mode Recovery and Missing Turn Sync...');

  // Test 1: Uninitialized scope routing registry falls back to server_only argument
  {
    const f = await serverModeFixture({ uninitializedRegistry: true });
    try {
      const plan = await f.api.inspectMemoryMaintenance();
      console.log('DEBUG PLAN:', { liveTurns: plan.liveTurns, storedTurns: plan.storedTurns, missingTurns: plan.missingTurns, automatic: plan.automatic });
      assert.equal(plan.inspection.coverage, 'server_snapshot');
      assert.equal(plan.inspection.complete, true);
      console.log('  PASS Test 1: Uninitialized registry properly resolved argument_fallback');
    } finally {
      await f.dispose();
    }
  }

  // Test 2: Server inspection detects missing turn and unblocks server_turn_sync
  {
    const f = await serverModeFixture();
    try {
      const plan = await f.api.inspectMemoryMaintenance();
      console.log('DEBUG PLAN:', { liveTurns: plan.liveTurns, storedTurns: plan.storedTurns, missingTurns: plan.missingTurns, automatic: plan.automatic });
      assert.equal(plan.inspection.coverage, 'server_snapshot');
      assert.equal(plan.inspection.complete, true);
      assert.equal(plan.liveTurns, 2);
      assert.equal(plan.storedTurns, 1);
      assert.equal(plan.missingTurns, 1);
      assert.equal(plan.storageSourceHealthy, false);
      assert.equal(plan.automatic.strategy, 'server_turn_sync');
      assert.equal(plan.automatic.stages.length, 1);
      assert.equal(plan.automatic.stages[0], 'sync');
      assert.equal(plan.automatic.blocked, false);
      const judgement = f.context.__inspectionFixtureText.judgement(plan);
      assert.equal(judgement.includes('누락 1개, 변경 0개 턴 동기화 가능'), true);
      console.log('  PASS Test 2: Missing turn detected; automatic server_turn_sync plan enabled (blocked: false) with accurate judgement');

      // Test 3: Running server sync executes successfully
      console.log('STARTING TEST 3...');
      let result;
      try {
        result = await f.api.runMemoryMaintenance('sync', { preflight: plan });
        console.log('Test 3 result status:', result?.status);
      } catch (e) {
        console.error('Test 3 threw:', e);
        throw e;
      }
      assert.equal(result.status, 'completed');
      assert.equal(result.operation.strategy, 'server_turn_sync');
      assert.equal(result.operation.sync.inserted > 0 || result.operation.sync.sources > 0, true);
      console.log('  PASS Test 3: runMemoryMaintenance(sync) completed successfully in server mode');

      // Test 4: Destructive rebuild is rejected in server mode
      await assert.rejects(
        () => f.api.runMemoryMaintenance('rebuild', { preflight: plan }),
        err => err.code === 'HEALTH_LOCAL_MODE_REQUIRED' || err.message.includes('로컬 저장 방식') || err.message.includes('HEALTH_LOCAL_MODE_REQUIRED')
      );
      console.log('  PASS Test 4: Destructive rebuild correctly rejected in server mode');

      // Test 5: Re-inspecting after sync confirms 0 missing turns and server_inspection_only (no unneeded sync)
      const afterPlan = await f.api.inspectMemoryMaintenance();
      assert.equal(afterPlan.missingTurns, 0);
      assert.equal(afterPlan.changedTurns, 0);
      assert.equal(afterPlan.automatic.strategy, 'server_inspection_only');
      assert.equal(afterPlan.automatic.blocked, true);
      console.log('  PASS Test 5: Post-sync inspection confirms 0 missing turns (no unneeded sync prompt)');
    } finally {
      await f.dispose();
    }
  }

  // Test 6: legacyGlobalModeImported: true with empty entries properly falls back to server_only argument
  {
    const f = await serverModeFixture({ legacyGlobalModeImportedNoScope: true });
    try {
      const plan = await f.api.inspectMemoryMaintenance();
      assert.equal(plan.inspection.coverage, 'server_snapshot');
      assert.equal(plan.inspection.complete, true);
      assert.equal(plan.liveTurns, 2);
      assert.equal(plan.storedTurns, 1);
      assert.equal(plan.missingTurns, 1);
      console.log('  PASS Test 6: legacyGlobalModeImported=true with empty entries properly falls back to server_only argument');
    } finally {
      await f.dispose();
    }
  }

  // Test 7: Scope row with origin: 'transition_pending' and pendingTargetMode: 'server_only'
  // succeeds in inspecting server snapshot and completes sync, settling the transition
  {
    const f = await serverModeFixture({ transitionPendingScope: true });
    try {
      const plan = await f.api.inspectMemoryMaintenance();
      assert.equal(plan.inspection.coverage, 'server_snapshot');
      assert.equal(plan.inspection.complete, true);
      assert.equal(plan.missingTurns, 1);
      const syncResult = await f.api.runMemoryMaintenance('sync', { preflight: plan });
      assert.equal(syncResult.status, 'completed');

      // Verify stored row transition_pending was settled
      const reg = JSON.parse(await f.pluginStorage.getItem(f.context.__inspectionFixture.routeKey));
      assert.equal(reg.entries[f.scope.scopeKey].origin, 'user_scope_setting');
      assert.equal(reg.entries[f.scope.scopeKey].mode, 'server_only');
      assert.equal(reg.entries[f.scope.scopeKey].pendingTargetMode, null);
      console.log('  PASS Test 7: transition_pending scope successfully inspects and settles on sync');
    } finally {
      await f.dispose();
    }
  }

  // Test 8: Scope row with removed: true inherits global server_only mode cleanly
  {
    const f = await serverModeFixture({ removedScopeRow: true });
    try {
      const plan = await f.api.inspectMemoryMaintenance();
      assert.equal(plan.inspection.coverage, 'server_snapshot');
      assert.equal(plan.inspection.complete, true);
      console.log('  PASS Test 8: removed: true scope cleanly inherits global server_only');
    } finally {
      await f.dispose();
    }
  }

  console.log('ALL SERVER MODE RECOVERY TESTS PASSED!');
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});

module.exports = {serverModeFixture};
