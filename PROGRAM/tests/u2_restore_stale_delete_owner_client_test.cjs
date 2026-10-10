'use strict';
// U2 connected owner bridge reset/reload retention with a synthetic server-plan prerequisite;
// it is not proof of the public coordinator path.  This runs Flashback's deployed
// MemorySuiteStorageBridge against the same localhost SQLite backend used for restore/stale-409.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const jsonFetch = async (url, options = {}) => {
  const response = await fetch(url, options);
  let body = null;
  try { body = await response.json(); } catch (_) { body = null; }
  return { status: response.status, body };
};

const corpus = async (api, scopeKey) => JSON.stringify((await api._test.loadScopeRecords(scopeKey)).records
  .map(record => ({ id:record.id, hash:record.hash, text:record.text, vector:record.vector }))
  .sort((left, right) => String(left.id).localeCompare(String(right.id))));

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2-owner-client-'));
  const app = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir, autoBackup:false });
  let fixture = null;
  let reopened = null;
  try {
    const base = `http://127.0.0.1:${(await app.listen()).port}`;
    const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');
    fixture = await createFixture({
      source,
      exposeStorageBridge:true,
      arguments:{ memory_suite_server_mode:'plugin_only', memory_suite_server_url:base },
      nativeFetch:fetch,
      chat:{ id:'u2-owner-client-chat', chatId:'u2-owner-client-chat', message:[], messages:[] }
    });
    const bridge = fixture.context.__fixtureStorageBridge;
    const ownerScope = await fixture.api.resolveCurrentScope(false);
    // First create the owner copy through the real plugin-only writer.  Transitioning this exact owner
    // scope to mirror then uses the production bridge to upload that copy to the same backend.
    await fixture.api._test.saveAllRecords([{
      id:'u2-owner-client-record', hash:'u2-owner-client-record', type:'response', sourceType:'response',
      text:'This Flashback owner corpus is restored through the actual owner delete-preparation path.',
      dim:4, vector:[0.1, 0.2, 0.3, 0.4]
    }], null, ownerScope);
    const before = await corpus(fixture.api, ownerScope.scopeKey);
    assert.ok(before.includes('u2-owner-client-record'), 'Flashback own reader must see its plugin-only seed');
    await require('./helpers/legacy_mirror_fixture.cjs').seedLegacyMirrorFixture(bridge,fixture.pluginStorage,ownerScope);
    assert.equal(await bridge.getMode(), 'mirror', 'the real owner bridge must upload the existing owner copy into mirror mode');
    assert.equal(await corpus(fixture.api, ownerScope.scopeKey), before,
      'the bridge mode transition must retain the owner reader corpus before backend restore');

    const repo = app.repositories.flashback;
    const pluginRows = repo.list('plugin', '').records.filter(row => row.tombstone !== true);
    const localRows = repo.list('local', '').records.filter(row => row.tombstone !== true);
    const serverRows = [...pluginRows, ...localRows];
    assert.ok(pluginRows.length > 0, `the owner mirror write must create real server rows (mode=${await bridge.getMode()}, plugin=${JSON.stringify(app.repositories.flashback.list('plugin', '').records)}, local=${JSON.stringify(app.repositories.flashback.list('local', '').records)})`);
    const members = serverRows.map(row => ({ space:row.space, key:row.key }));
    const mutations = serverRows.map(row => ({
      kind:'remove', space:row.space, key:row.key, expectedRevision:Number(row.revision),
      expectedDigest:String(row.digest || ''), expectedExists:true, expectedTombstone:false
    }));

    const controlBoot = await jsonFetch(`${base}/bootstrap`, { headers:{ 'X-Memory-Suite-Plugin':'flashback_hayaku_bridge' } });
    const managerHeaders = {
      Authorization:`Bearer ${controlBoot.body?.token || ''}`, 'X-Memory-Suite-Plugin':'flashback_hayaku_bridge',
      'Content-Type':'application/json'
    };
    const adminHeaders = { Authorization:`Bearer ${app.token}`, 'X-Memory-Suite-Admin':'1', 'Content-Type':'application/json' };
    const scopeId = String(ownerScope.scopeId || ownerScope.scopeKey);
    const scopes = [{
      namespace:'flashback', scopeId, scopeKey:ownerScope.scopeKey, kind:'chat_scope', baseClassification:'active',
      coverageComplete:true, members
    }];
    assert.equal((await jsonFetch(`${base}/v1/manager/scopes/index`, {
      method:'POST', headers:managerHeaders, body:JSON.stringify({ namespace:'flashback', scopes })
    })).status, 200, 'the actual owner scope must be indexed for delete planning');
    const planResponse = await jsonFetch(`${base}/v1/manager/scope-delete/plan`, {
      method:'POST', headers:managerHeaders,
      body:JSON.stringify({ namespace:'flashback', scopeId, mutations, modeProof:{ verified:true, modeAfter:'plugin_only', namespace:'flashback', scopeId } })
    });
    assert.equal(planResponse.status, 200, 'the pre-restore delete plan must prepare');
    const stalePlan = planResponse.body?.result || planResponse.body;

    const backup = await jsonFetch(`${base}/v1/admin/backups/create`, {
      method:'POST', headers:adminHeaders, body:JSON.stringify({ kind:'manual', label:'u2-owner-client' })
    });
    const backupId = String((backup.body?.result || backup.body)?.id || (backup.body?.result || backup.body)?.backupId || '');
    assert.ok(backupId, 'the backend backup must have an id');
    assert.equal((await jsonFetch(`${base}/v1/admin/restore`, {
      method:'POST', headers:adminHeaders, body:JSON.stringify({ backupId, namespaces:['flashback'] })
    })).status, 200, 'the backend restore must execute');
    const stale = await jsonFetch(`${base}/v1/manager/scope-delete/execute`, {
      method:'POST', headers:managerHeaders,
      body:JSON.stringify({ planId:stalePlan.planId, mutationFingerprint:stalePlan.mutationFingerprint })
    });
    assert.equal(stale.status, 409, 'the plan prepared before restore must be fenced');
    assert.equal(stale.body?.error, 'scope_delete_generation_changed');

    // A server restore deliberately fences the old owner client.  Exercise the actual reset-choice API,
    // reload on the same physical stores, then explicitly select plugin_only before the owner reads again.
    // This observes the public client boundary; it does not pretend that a reset backend authorized a
    // coordinator delete proof.
    const resetChoice = await bridge.acceptServerReset('upload');
    assert.equal(resetChoice.reloadRequired, true, 'the actual owner client must require a reload after restore');
    reopened = await createFixture({
      source, exposeStorageBridge:true, pluginStorage:fixture.pluginStorage, safeLocalStorage:fixture.host.safeLocalStorage,
      arguments:{ memory_suite_server_mode:'plugin_only', memory_suite_server_url:base }, nativeFetch:fetch,
      chat:structuredClone(fixture.currentChat)
    });
    const reopenedScope = await reopened.api.resolveCurrentScope(false);
    const reopenedBridge = reopened.context.__fixtureStorageBridge;
    await reopenedBridge.setMode('plugin_only', { scope:reopenedScope });
    assert.equal(await reopenedBridge.getMode(), 'plugin_only');
    assert.equal(await corpus(reopened.api, reopenedScope.scopeKey), before,
      'a reloaded actual owner reader must preserve its local corpus after restore and stale 409');
    console.log('u2_restore_stale_delete_owner_client_test: PASS (restore 200, stale 409, actual owner reset choice, plugin-only reopen readback)');
  } finally {
    await reopened?.dispose?.().catch(() => null);
    await fixture?.dispose?.().catch(() => null);
    await app.close().catch(() => null);
    fs.rmSync(dataDir, { recursive:true, force:true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
