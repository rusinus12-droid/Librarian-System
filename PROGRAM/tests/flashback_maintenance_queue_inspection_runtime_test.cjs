'use strict';
// Production plugin + authenticated server router + SQLite, with synthetic
// provider responses and in-process transport. No real host/provider requests.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { test } = require('node:test');
const { createMemorySuiteServer, mockFetch } = require('./fixtures/flashback_in_memory_server_fixture.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const success = init => new Response(JSON.stringify({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 });
const chat = { message: [1, 2].flatMap(i => [
  { role: 'user', chatId: `u${i}`, data: `Where is parcel ${i}?` },
  { role: 'assistant', chatId: `a${i}`, data: `Parcel ${i} remains in the eastern cabinet beside the marble clock.` }
]) };

for (const mode of ['server_only', 'plugin_only']) test(`${mode} inspection waits for the issued embedding group and pauses the next group, then recovery finishes`, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-inspection-queue-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const address = await app.listen(), entered = deferred(), release = deferred();
  let providerCalls = 0, healthReads = 0, holdProvider = true, running, inspection, probeDuringInspection = false;
  const pausedAdmissions = [];
  const f = await createFixture({ exposeStorageBridge: true, chat,
    arguments: { memory_suite_server_url: `http://127.0.0.1:${address.port}`, embedding_key: 'synthetic-key' },
    nativeFetch: async (url, init) => {
      if (String(url).startsWith('https://provider.invalid/')) {
        providerCalls++; entered.resolve(); if (holdProvider) await release.promise; return success(init);
      }
      if (String(url).endsWith('/v1/flashback/scope-health')) {
        healthReads++;
        if (probeDuringInspection) pausedAdmissions.push(await f.api.processPendingEmbeddingQueue({ automatic: true }));
      }
      return mockFetch(url, init);
    }
  });
  try {
    const cfg = f.api._test.normalizeSettings({ embeddingProvider: 'openai_compat', embeddingModel: 'inspection-model',
      embeddingUrl: 'https://provider.invalid/v1', embeddingDimensions: 3, embeddingEnabled: true,
      embeddingAutoProcess: false, embeddingMaxRetries: 0, embeddingBatchSize: 1,
      episodeIndexEnabled: false, autoEpisodeIndex: false, autoColdStart: false });
    await f.api.saveSettings(cfg);
    const scope = await f.api.resolveCurrentScope(false);
    await f.context.__fixtureStorageBridge.setScopeMode({ scopeId: scope.scopeKey, scopeKey: scope.scopeKey }, mode);
    await f.api.ingestLiveChatColdStart({ scope: 'current', canonical: true, settings: cfg, skipEpisodeRebuild: true, deferEmbedding: true });
    const rawBefore = (await f.api._test.loadScopeRecords(scope.scopeKey)).records.map(r => [r.id, r.text, r.sourceHash]);
    running = f.api.processPendingEmbeddingQueue({ maxSources: 2, maxRequests: 2 });
    await Promise.race([entered.promise, running.then(result => { throw Error('Queue did not reach provider: ' + JSON.stringify(result)); })]);
    probeDuringInspection = true;
    inspection = f.api.inspectMemoryMaintenance();
    const observed = inspection.then(plan => ({ plan }), error => ({ error }));
    await new Promise(r => setTimeout(r, 75));
    assert.equal(healthReads, 0, 'do not capture a snapshot while an issued group can still publish');
    holdProvider = false; release.resolve();
    const queue = await running, outcome = await observed;
    assert.ifError(outcome.error);
    assert.equal(queue.ready, 1, 'the issued result is durably retained');
    assert.equal(queue.reason, 'maintenance_inspection_active');
    assert.equal(providerCalls, 1, 'inspection does not start or retry provider work');
    assert.equal(outcome.plan.inspection.complete, true);
    assert.equal(outcome.plan.inspection.coverage, mode === 'server_only' ? 'server_snapshot' : 'plugin_only');
    assert.equal(outcome.plan.embeddingWorkPendingRecords, 1);
    assert.equal(outcome.plan.embeddingWorkRunningRecords, 0);
    probeDuringInspection = false;
    if (mode === 'server_only') {
      assert.equal(outcome.plan.automatic.strategy, 'embedding_queue');
      assert(pausedAdmissions.length > 0);
      assert(pausedAdmissions.every(result => result.reason === 'maintenance_inspection_active' && result.physicalRequests === 0));
      // A pending raw job must not turn unrelated physical vector damage into
      // ordinary queue authority. Restore the exact synthetic payload afterwards.
      const ready = (await f.api._test.loadScopeRecords(scope.scopeKey)).records.find(r => r.embeddingReceipt?.status === 'ready');
      const repo = app.repositories.flashback, vectorKey = ready.vectorRef.storageKey;
      const saved = repo.database.prepare('SELECT * FROM kv WHERE space=? AND key=?').get('local', vectorKey);
      // Deliberate disk-loss injection in the disposable test DB; ordinary writes
      // still require the real owner's writer fence.
      repo.database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('local', vectorKey);
      const damaged = await f.api.inspectMemoryMaintenance();
      assert.equal(damaged.embeddingWorkPendingRecords, 1);
      assert.equal(damaged.embeddingQueueSourceHealthy, false);
      assert.equal(damaged.automatic.blocked, true);
      assert.equal(providerCalls, 1);
      repo.database.prepare('INSERT INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(saved.space, saved.key, saved.value_json, saved.deleted, saved.revision, saved.digest, saved.updated_at);
      outcome.plan = await f.api.inspectMemoryMaintenance();
      const repaired = await f.api.runMemoryMaintenance('auto', { preflight: outcome.plan });
      assert.equal(repaired.after.embeddingWorkIncompleteRecords, 0);
    } else assert.equal((await f.api.processPendingEmbeddingQueue()).ready, 1);
    assert.equal(providerCalls, 2, 'only the remaining source is submitted');
    const rows = (await f.api._test.loadScopeRecords(scope.scopeKey)).records;
    assert.deepEqual(rows.map(r => [r.id, r.text, r.sourceHash]), rawBefore);
    assert(rows.every(r => r.embeddingReceipt?.status === 'ready'));
    assert.equal((await f.api.inspectMemoryMaintenance()).embeddingWorkIncompleteRecords, 0);
    assert.equal(providerCalls, 2, 'repeated inspection adds no provider calls');
  } finally {
    release.resolve(); await running?.catch(() => {}); await inspection?.catch(() => {});
    await f.dispose(); await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
