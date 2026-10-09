'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const source = fs.readFileSync(path.resolve(__dirname, '../plugins/Flashback_Memory.js'), 'utf8');
// Inject only the failing dependency; run the production orchestration and reporting.
const marker = 'const synchronizeFlashbackTurnWorldline = async (scope, liveState = {}, settings = null, options = {}) => {';
assert(source.includes(marker));
const injected = source.replace(marker, marker + `
  if (globalThis.__failSync) throw Object.assign(new Error('replacement commit readback failed before manifest swap: missing shards none, loaded 525/525, missing vector payloads 220'), {
    code:'FLASHBACK_REBUILD_COMMIT_READBACK_FAILED', failureStage:'replacement_commit_readback', scopeKey:scope.scopeKey,
    loadedCount:525, expectedCount:525, vectorPayloadMissing:220
  });`);
(async () => {
  const f = await createFixture({ source: injected });
  try {
    const settings = { ...await f.api.loadSettings(), embeddingProvider:'hash', embeddingModel:'hash-v1', embeddingEnabled:true, autoEpisodeIndex:false };
    await f.api.saveSettings(settings);
    await f.api.runMemoryMaintenance('sync');
    let logs = f.api.getActivityLog();
    const empty = logs.find(x => x.event === 'live_chat_sync_completed');
    assert.equal(empty.data.outcome, 'no_sources');
    assert.equal(empty.level, 'info');
    const emptyFinal = logs.find(x => x.event === 'memory_maintenance_completed');
    assert.equal(emptyFinal.data.outcome, 'no_sources');
    assert.equal(emptyFinal.data.sources, 0);

    f.currentChat.message = [{role:'user',chatId:'u1',data:'Open the archive.'},{role:'assistant',chatId:'a1',data:'Alice saved the agreement.'}];
    f.currentChat.messages = f.currentChat.message;
    await f.api.ingestLiveChatColdStart({scope:'current', canonical:true});
    const scope = await f.api.resolveCurrentScope();
    const before = JSON.stringify((await f.api._test.loadScopeRecords(scope.scopeKey)).records);
    const manifestBefore = (await f.api._test.loadScopeManifest(scope)).commitId;
    f.context.__failSync = true;
    // Add work that must never reach the ingest stage after the failure.
    f.currentChat.message.push({role:'user',chatId:'u2',data:'Read it.'},{role:'assistant',chatId:'a2',data:'The archive remains sealed.'});
    await assert.rejects(() => f.api.runMemoryMaintenance('sync'), error => error.code === 'FLASHBACK_REBUILD_COMMIT_READBACK_FAILED');
    logs = f.api.getActivityLog();
    const failed = logs.filter(x => x.event === 'memory_maintenance_failed').at(-1);
    assert.equal(failed.data.vectorPayloadMissing, 220);
    assert.equal(failed.data.loadedCount, 525);
    assert.equal(failed.data.failureStage, 'replacement_commit_readback');
    assert.equal(failed.scopeKey, scope.scopeKey);
    assert(!failed.data.error.includes('SOURCE_EDIT_CONSENT_REQUIRED'));
    const debug = await f.api.debugState();
    assert.equal(debug.maintenanceJournal.failure.expectedCount, 525);
    assert.equal(debug.maintenanceJournal.failure.vectorPayloadMissing, 220);
    assert.equal(debug.maintenanceJournal.status, 'failed');
    assert.equal((await f.api._test.loadScopeManifest(scope)).commitId, manifestBefore);
    assert.equal(JSON.stringify((await f.api._test.loadScopeRecords(scope.scopeKey)).records), before);
    const fresh = await createFixture({pluginStorage:f.pluginStorage, safeLocalStorage:f.host.safeLocalStorage, chat:structuredClone(f.currentChat)});
    try {
      assert.equal(JSON.stringify((await fresh.api._test.loadScopeRecords(scope.scopeKey)).records), before);
      assert.equal((await fresh.api.debugState()).maintenanceJournal.failure.vectorPayloadMissing, 220);
    } finally { await fresh.dispose(); }
    f.context.__failSync = false;
    f.currentChat.message.splice(2);
    const recovered = await f.api.runMemoryMaintenance('sync');
    assert(recovered.operation.sources > 0);
    assert.equal((await f.api.debugState()).maintenanceJournal.failure, null);
    console.log('PASS empty reporting, failure propagation, durable diagnostics, preserved corpus, normal sync recovery');
  } finally { await f.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
