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
test('server mode re-chunks turns whose derived chunk schema is old',async()=>{
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

    assert.equal(syncPlan.automatic.derivedRechunk,true);

    // With nothing left to sync, the old chunks alone must still have a server-mode
    // route. A standing "blocked" verdict here froze the scope at every later check.
    f.currentChat.message.splice(2);
    const rechunkPlan=await f.api.inspectMemoryMaintenance();
    assert.equal(rechunkPlan.missingTurns,0);
    assert.equal(rechunkPlan.requiresFullRebuild,true);
    assert.equal(rechunkPlan.automatic.strategy,'server_turn_sync');
    assert.equal(rechunkPlan.automatic.blocked,false);
    assert.equal(rechunkPlan.automatic.reason,'derived_chunk_rechunk_available');
    assert.equal(rechunkPlan.automatic.derivedRechunk,true);
    const result=await f.api.runMemoryMaintenance('auto',{preflight:rechunkPlan});
    assert.equal(result.after.liveChunkSchemaMismatch,0,'the live source re-derives current-schema chunks');
    assert.equal(result.after.requiresFullRebuild,false);
    assert.notEqual(result.after.automatic.blocked===true&&/rebuild/.test(result.after.automatic.reason||''),true);
    assert.equal(result.after.embeddingWorkIncompleteRecords,0);
    const rows=(await f.api._test.loadScopeRecords(scope.scopeKey)).records.filter(r=>r.sourceType==='response');
    assert.ok(rows.length>0&&rows.every(r=>Number(r.chunkSchemaVersion)>=2));
    assert.equal(result.operation.sync.rechunkedTurns,1);

    // Diagnostics keep the deciding inputs of the latest (post-repair) inspection,
    // so the same verdict is explainable offline.
    const counts=(await f.api.debugState())?.maintenanceInspection?.counts||{};
    assert.equal(counts.requiresFullRebuild,false);
    assert.equal(counts.requiresDerivedSchemaRebuildOnly,false);
    assert.equal(counts.liveChunkSchemaMismatch,0);
    assert.equal(counts.legacySanitizerRecords,0);
  } finally { await f.dispose(); await app.close?.(); }
});
