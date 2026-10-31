'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer,mockFetch}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const pair=(i,long=false)=>[{role:'user',chatId:'u'+i,data:`Where is parcel ${i}?`},
  {role:'assistant',chatId:'a'+i,data:Array.from({length:long?60:1},(_,n)=>`Parcel ${i} item ${n} remains inside the eastern cabinet beside clock ${n}.`).join(' ')}];

// A scope written by an older plugin has no derived narrative-chunk version on its
// records. Server mode cannot execute the physical rebuild that would re-derive it,
// so the only forward path is the ordinary turn sync; it must not be refused with a
// verdict that blames the episode index instead.
test('server mode keeps turn sync available when only the derived chunk schema is old',async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-derived-rebuild-'));
  const app=createMemorySuiteServer({dataDir,autoBackup:false,port:0}),address=await app.listen();
  const f=await createFixture({source:fs.readFileSync(require.resolve('../plugins/Flashback_Memory.js'),'utf8'),
    exposeStorageBridge:true,chat:{message:pair(1)},
    arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`,embedding_key:'synthetic-key'},
    nativeFetch:async(url,init)=>{
      if(String(url).startsWith('https://provider.invalid/'))return new Response(JSON.stringify({data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});
      return mockFetch(url,init);
    }});
  try{
    const cfg={...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'derived-rebuild',embeddingUrl:'https://provider.invalid/v1',embeddingDimensions:3,
      embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,embeddingBatchSize:8,episodeIndexEnabled:true,autoEpisodeIndex:true,autoColdStart:false};
    await f.api.saveSettings(cfg);const scope=await f.api.resolveCurrentScope(false);
    await f.context.__fixtureStorageBridge.setScopeMode({scopeId:scope.scopeKey,scopeKey:scope.scopeKey},'server_only');
    await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
    // Simulate records produced before the narrative chunk schema existed.
    const loaded=await f.api._test.loadScopeRecords(scope.scopeKey);
    const legacy=loaded.records.map(record=>{const {chunkSchemaVersion:_,...rest}=record;return rest;});
    assert.ok(legacy.length>0);
    assert.ok(legacy.every(record=>!record.chunkSchemaVersion));
    await f.api._test.saveAllRecords(legacy,cfg,scope);
    const reread=await f.api._test.loadScopeRecords(scope.scopeKey);
    assert.ok(reread.records.every(record=>!record.chunkSchemaVersion),'the legacy chunk version persists');

    f.currentChat.message.push(...pair(2,true));
    const syncPlan=await f.api.inspectMemoryMaintenance();
    assert.equal(syncPlan.missingTurns,1);
    assert.equal(syncPlan.requiresFullRebuild,true,'a missing chunk version is a rebuild requirement');
    assert.equal(syncPlan.requiresDerivedSchemaRebuildOnly,true,'no physical damage is involved');
    assert.equal(syncPlan.liveChunkSchemaMismatch>0,true);
    assert.equal(syncPlan.legacySanitizerRecords,0);
    assert.equal(syncPlan.automatic.strategy,'server_turn_sync');
    assert.equal(syncPlan.automatic.blocked,false);
    assert.equal(syncPlan.automatic.derivedRebuildPending,true);

    // With nothing left to sync the derived rebuild is the only outstanding item, and
    // the verdict must name it instead of the episode index.
    f.currentChat.message.splice(2);
    const blockedPlan=await f.api.inspectMemoryMaintenance();
    assert.equal(blockedPlan.missingTurns,0);
    assert.equal(blockedPlan.requiresFullRebuild,true);
    assert.equal(blockedPlan.automatic.strategy,'server_inspection_only');
    assert.equal(blockedPlan.automatic.blocked,true);
    assert.equal(blockedPlan.automatic.reason,'derived_schema_rebuild_required');
    assert.notEqual(blockedPlan.automatic.reason,'episode_index_stale');

    // Diagnostics keep the deciding inputs, so the same verdict is explainable offline.
    const counts=(await f.api.debugState())?.maintenanceInspection?.counts||{};
    assert.equal(counts.requiresFullRebuild,true);
    assert.equal(counts.requiresDerivedSchemaRebuildOnly,true);
    assert.equal(typeof counts.liveChunkSchemaMismatch,'number');
    assert.equal(counts.legacySanitizerRecords,0);
  } finally { await f.dispose(); await app.close?.(); }
});
