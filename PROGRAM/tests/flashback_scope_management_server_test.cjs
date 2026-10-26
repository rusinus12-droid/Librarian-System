'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
(async () => {
  for (const mode of ['server_only', 'plugin_only']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-management-server-'));
    let app, f, offline = false, changeAfterPlan = false, receipt;
    try {
      app = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir:root, autoBackup:false });
      const url = 'http://127.0.0.1:' + (await app.listen()).port;
      const source = fs.readFileSync(path.join(__dirname, '../plugins/Flashback_Memory.js'), 'utf8')
        .replace('_test: { maintenanceResultText,', '_test: { repairScopeRegistryMetadata,classifyScopeForManagement,selectableStorageScopeKeys,deleteSelectedScopeStorages,scopeKeys,clearVerificationForTest:()=>Runtime.guiStorageVerificationByScope.clear(),maintenanceResultText,');
      f = await createFixture({ source, exposeStorageBridge:true, arguments:{ memory_suite_server_url:url }, nativeFetch:async (u, i) => {
        if (offline && (u.includes('/v1/kv/') || u.includes('/scope-delete/'))) return new Response(JSON.stringify({ error:'TEST_STORE_UNAVAILABLE' }), { status:503 });
        const response = await fetch(u, i);
        if (u.endsWith('/scope-delete/plan') && changeAfterPlan) {
          changeAfterPlan = false;
          const body = JSON.parse(i.body), alias = [...app.repositories.flashback.list('plugin', 'vector_rag_memory:scope:').records]
            .find(row => row.key.endsWith(':manifest:v2') && JSON.parse(app.repositories.flashback.get('plugin', row.key).value).scopeKey === body.scopeKey);
          const row = app.repositories.flashback.get('plugin', alias.key);
          app.repositories.flashback.applyConditionalBatch([{ kind:'set', space:'plugin', key:alias.key, value:JSON.stringify({...JSON.parse(row.value),deleteRace:'changed-after-preview'}),
            expectedRevision:row.revision, expectedDigest:row.digest, expectedExists:true, expectedTombstone:false }], { fence:body.fence });
        }
        if (u.endsWith('/scope-delete/execute') && response.ok) receipt = (await response.clone().json()).result;
        return response;
      } });
      const b = f.context.__fixtureStorageBridge, t = f.api._test;
      const connection = await b.getConnectionSettings({ force:true });
      await b.setScopeMode(connection.scope, 'server_only');
      const target = (await t.resolveCurrentScopeIdentityBundle(false)).scope;
      await t.saveAllRecords([{ id:'m', hash:'m', type:'response', sourceType:'response', text:'Real SQLite memory', dim:4, vector:[1,0,0,0] }], null, target);
      const key = t.scopeKeys.manifest(target.scopeKey), routeKey = '__memory_suite_internal_scope_routes_v1__:flashback';
      assert.equal(JSON.parse(app.repositories.flashback.get('plugin', key).value).count, 1);
      const route = await f.pluginStorage.getItem(routeKey);
      await t.repairScopeRegistryMetadata();
      assert.equal(await f.pluginStorage.getItem(routeKey), route, 'inspection preserves server mode');
      assert.equal(app.repositories.flashback.get('plugin', key).exists, true);
      f.currentChat.id = f.currentChat.chatId = 'another';
      await t.resolveCurrentScopeIdentityBundle(false);
      const next = await b.getConnectionSettings({ force:true });
      await b.setScopeMode(next.scope, mode);
      const other = await f.api.resolveCurrentScope(false);
      await t.saveAllRecords([{ id:'other', hash:'other', type:'response', sourceType:'response', text:'Keep this scope', dim:4, vector:[1,0,0,0] }], null, other);
      const otherKey = t.scopeKeys.manifest(other.scopeKey);
      assert.equal((await t.classifyScopeForManagement(target.scopeKey)).kind, 'server_managed');
      assert.deepEqual(Array.from(t.selectableStorageScopeKeys([{ scopeKey:target.scopeKey, managementKind:'server_managed' }], other.scopeKey)), [target.scopeKey]);
      const boot=await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}}).then(r=>r.json());
      const manager=async(route,body)=>{
        const response=await fetch(url+'/v1/manager/'+route,{method:'POST',headers:{Authorization:'Bearer '+boot.token,
          'X-Memory-Suite-Plugin':'flashback_hayaku_bridge','Content-Type':'application/json'},body:JSON.stringify(body)});
        assert.equal(response.status,200,await response.clone().text());
      };
      await manager('scopes/index',{namespace:'flashback',scopes:[{scopeId:target.scopeKey,scopeKey:target.scopeKey,baseClassification:'active',
        coverageComplete:true,members:[{space:'plugin',key}]}]});
      await manager('scope-pin',{namespace:'flashback',scopeId:target.scopeKey,pinned:true});
      const pinned=await t.deleteSelectedScopeStorages([target.scopeKey]);
      assert.equal(pinned.deleted,0);assert.match(pinned.failures[0].reason,/PROTECTED/);
      await manager('scope-pin',{namespace:'flashback',scopeId:target.scopeKey,pinned:false});
      const repo=app.repositories.flashback;
      const checkpoint=repo.checkpoint;repo.checkpoint=()=>{throw Error('INJECTED_BACKUP_FAILURE');};
      try{const noBackup=await t.deleteSelectedScopeStorages([target.scopeKey]);assert.equal(noBackup.deleted,0);assert.equal(repo.get('plugin',key).exists,true);}
      finally{repo.checkpoint=checkpoint;}
      const beforeFailure = app.repositories.flashback.get('plugin', key);
      offline = true;
      const failed = await t.deleteSelectedScopeStorages([target.scopeKey]);
      assert.equal(failed.deleted, 0);
      assert.equal(failed.failed, 1);
      assert.deepEqual(app.repositories.flashback.get('plugin', key), beforeFailure);
      offline = false;
      changeAfterPlan = true;
      const stale = await t.deleteSelectedScopeStorages([target.scopeKey]);
      assert.equal(stale.deleted, 0, 'an outdated delete plan is rejected');
      assert.match(stale.failures[0].reason,/SOURCE_CHANGED/);
      assert.equal(app.repositories.flashback.get('plugin', key).exists, true);
      const result = await t.deleteSelectedScopeStorages([target.scopeKey]);
      assert.equal(result.deleted, 1, JSON.stringify(result));
      assert.equal(result.failed, 0);
      assert.equal(app.repositories.flashback.get('plugin', key).tombstone, true, 'server memory is actually removed');
      assert.equal(await f.pluginStorage.getItem(key), null, 'retained plugin copy is removed');
      assert.ok(mode==='server_only'?app.repositories.flashback.get('plugin', otherKey).exists:await f.pluginStorage.getItem(otherKey), 'other scope survives');
      assert.ok(receipt?.verified && receipt.backupId, 'verified server backup and delete receipt');
      assert.ok(fs.readdirSync(path.join(root, 'backups')).length > 0);
      assert.equal((await b.getScopeMode({ scopeId:other.scopeKey, scopeKey:other.scopeKey })).mode, mode, 'active storage mode is unchanged');
      console.log('flashback_scope_management_server_test: PASS ' + mode + ' HTTP/SQLite delete, backup, offline/stale rejection, inspection and other-scope preservation');
    } finally { await f?.dispose(); await app?.close(); fs.rmSync(root, { recursive:true, force:true }); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
