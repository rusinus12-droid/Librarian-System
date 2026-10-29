'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer,mockFetch}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const pair=(i,long=false)=>[{role:'user',chatId:'u'+i,data:`Where is parcel ${i}?`},
  {role:'assistant',chatId:'a'+i,data:Array.from({length:long?200:1},(_,n)=>`Parcel ${i} item ${n} remains inside the eastern cabinet beside clock ${n}.`).join(' ')}];
for(const scenario of ['missing_turn','failed_queue','anchor_drift'])test(`server ${scenario} recovery finishes every chunk and refreshes its derived episode index`,async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-chunk-recovery-')),app=createMemorySuiteServer({dataDir,autoBackup:false,port:0}),address=await app.listen();
  let providerCalls=0,rejectProvider=false,holdRefresh=false,refreshing,refreshStarted,releaseRefresh;
  const enteredRefresh=new Promise(resolve=>{refreshStarted=resolve;}),refreshGate=new Promise(resolve=>{releaseRefresh=resolve;});
  const source=fs.readFileSync(require.resolve('../plugins/Flashback_Memory.js'),'utf8').replace(
    'const inspectMaintenanceAfterExecution = async (options, assertCurrent) => {',
    'const inspectMaintenanceAfterExecution = async (options, assertCurrent) => { await globalThis.__overlapClosingBootstrap?.();');
  const f=await createFixture({source,exposeStorageBridge:true,chat:{message:pair(1)},
    arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`,embedding_key:'synthetic-key'},
    nativeFetch:async(url,init)=>{
      if(holdRefresh&&String(url).includes('/bootstrap')){holdRefresh=false;refreshStarted();await refreshGate;}
      if(String(url).startsWith('https://provider.invalid/')){providerCalls++;if(rejectProvider)return new Response('invalid test credential',{status:401});return new Response(JSON.stringify({data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});}
      return mockFetch(url,init);
    }});
  try{
    const cfg={...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'chunk-recovery',embeddingUrl:'https://provider.invalid/v1',embeddingDimensions:3,
      embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,embeddingBatchSize:8,episodeIndexEnabled:true,autoEpisodeIndex:true,autoColdStart:false};
    await f.api.saveSettings(cfg);const scope=await f.api.resolveCurrentScope(false);
    await f.context.__fixtureStorageBridge.setScopeMode({scopeId:scope.scopeKey,scopeKey:scope.scopeKey},'server_only');
    await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
    f.currentChat.message.push(...pair(2,true));
    let preservedReady;
    if(scenario!=='missing_turn'){
      await f.api.ingestLiveChatColdStart({scope:'current',canonical:true,deferEmbedding:true});
      rejectProvider=true;const failed=await f.api.processPendingEmbeddingQueue();rejectProvider=false;
      assert(failed.failed>8);assert.equal(failed.reason,'AUTH_ERROR','a definite failure keeps its actual cause');
      const manifest=await f.api._test.loadScopeManifest(scope);
      await f.api._test.saveScopeManifest({...manifest,episodeSourceDigest:'outdated-derived-index'},scope);
      if(scenario==='anchor_drift'){
        const loaded=await f.api._test.loadScopeRecords(scope.scopeKey),ready=loaded.records.find(r=>r.sourceType==='response'&&!r.embeddingWork);
        preservedReady=JSON.parse(JSON.stringify(ready));
        await f.api._test.saveAllRecords(loaded.records.map(r=>r.id===ready.id?{...r,entityAnchors:['obsolete-anchor-only']}:r),cfg,scope);
      }
    }
    const plan=await f.api.inspectMemoryMaintenance();
    assert.equal(plan.missingTurns,scenario==='missing_turn'?1:0);
    assert.equal(plan.automatic.strategy,scenario==='missing_turn'?'server_turn_sync':'embedding_queue');
    assert.notEqual(plan.automatic.blocked,true);
    if(scenario==='anchor_drift'){assert.equal(plan.dirtyRecords,1);assert.equal(plan.anchorOnlyDirtyRecords,1);}
    f.context.__overlapClosingBootstrap=async()=>{
      f.context.__overlapClosingBootstrap=null;holdRefresh=true;
      refreshing=f.context.__fixtureStorageBridge.bootstrap(true);await enteredRefresh;
      setTimeout(releaseRefresh,30);
    };
    const callsBefore=providerCalls,result=await f.api.runMemoryMaintenance('auto',{preflight:plan});
    await refreshing;assert.equal(holdRefresh,false,'a real bootstrap refresh overlaps closing inspection');
    const rows=(await f.api._test.loadScopeRecords(scope.scopeKey)).records.filter(r=>r.sourceType==='response');
    const newRows=rows.filter(r=>r.turnIndex===2);assert(newRows.length>8,'one missing turn requires several embedding batches');
    assert(rows.every(r=>r.embeddingReceipt?.status==='ready'),'all raw chunks have durable model receipts');
    assert.equal(result.after.embeddingWorkIncompleteRecords,0);assert.equal(result.after.episodeStale,false);
    if(scenario==='anchor_drift'){
      assert.equal(result.after.dirtyRecords,0);assert.equal(result.after.storageSourceHealthy,true);
      const kept=rows.find(r=>r.id===preservedReady.id);
      assert.equal(kept.text,preservedReady.text);assert.deepEqual(JSON.parse(JSON.stringify(kept.vector)),preservedReady.vector);
      assert.deepEqual(JSON.parse(JSON.stringify(kept.embeddingReceipt)),preservedReady.embeddingReceipt,'anchor cleanup preserves the paid model receipt');
      assert(!kept.entityAnchors.includes('obsolete-anchor-only'));
    }
    assert(providerCalls>callsBefore);assert.equal(result.operation.queue.failed,0);
    if(scenario==='missing_turn'){
      const format=f.api._test.maintenanceResultText;
      assert.match(format(result),/미완료 임베딩이 없습니다/);
      const unfinished={...result,after:{...result.after,embeddingWorkIncompleteRecords:13}};
      assert.doesNotMatch(format(unfinished),/완전히 일치|\(정상\)|미완료 임베딩이 없습니다/);
    }
    // Derived index staleness is not damage to raw source/queue authority.
    const manifest=await f.api._test.loadScopeManifest(scope);
    await f.api._test.saveScopeManifest({...manifest,episodeSourceDigest:'outdated-derived-index'},scope);
    // Keep this test focused on the actual missing-turn path above; inspection
    // must explain a derived-index block rather than blaming unread credentials.
    const stale=await f.api.inspectMemoryMaintenance();
    assert.equal(stale.automatic.reason,'episode_index_stale');
    assert.equal(stale.inspection.providerCalls,0);
  }finally{releaseRefresh();await refreshing?.catch(()=>{});await f.dispose();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
});
