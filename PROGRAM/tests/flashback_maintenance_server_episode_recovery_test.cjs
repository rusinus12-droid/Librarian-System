'use strict';
// Production owner API + server handler + disposable SQLite; transport and provider are fixtures.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createMemorySuiteServer,mockFetch}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const {until}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const pair=i=>[{role:'user',chatId:'u'+i,data:`Where is parcel ${i}?`},{role:'assistant',chatId:'a'+i,data:`Parcel ${i} remains in the eastern cabinet beside the marble clock.`}];
const plain=x=>JSON.parse(JSON.stringify(x));
async function fixture(body){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-episode-maint-')),app=createMemorySuiteServer({dataDir,autoBackup:false,port:0}),address=await app.listen();
 let calls=0,forbidProvider=false;
 const source=fs.readFileSync(require.resolve('../plugins/Flashback_Memory.js'),'utf8').replace('  globalThis.__FlashbackMemory = publicApi;',
  '  globalThis.__episodeBatchStep=async scope=>maybeRebuildEpisodeIndex(scope,await loadSettings(true));\n  globalThis.__FlashbackMemory = publicApi;');
 const f=await createFixture({source,pauseScheduledTimers:true,exposeStorageBridge:true,chat:{message:Array.from({length:10},(_,i)=>pair(i+1)).flat()},
  arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`,embedding_key:'synthetic-key'},nativeFetch:async(url,init)=>{
   if(String(url).startsWith('https://')){calls++;assert.equal(forbidProvider,false,'derived maintenance must reuse paid vectors');return new Response(JSON.stringify({data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:Array.from({length:256},(_,i)=>i===0?1:0)}))}),{status:200});}
   return mockFetch(url,init);
  }});
 try{
  const cfg={...await f.api.loadSettings(),embeddingProvider:'voyageai',embeddingModel:'voyage-4-large',embeddingDimensions:256,
   embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,episodeIndexEnabled:true,episodeMinRecords:1,autoEpisodeIndex:true,autoColdStart:false};
  await f.api.saveSettings(cfg);const scope=await f.api.resolveCurrentScope(false);
  await f.context.__fixtureStorageBridge.setScopeMode({scopeId:scope.scopeKey,scopeKey:scope.scopeKey},'server_only');
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  await f.api.processPendingEmbeddingQueue();
  await f.api.rebuildEpisodeIndex(scope);
  const indexed=await f.api._test.loadScopeRecords(scope.scopeKey),oldEpisodes=indexed.records.filter(r=>r.sourceType==='episode_index');assert(oldEpisodes.length>0);
  f.currentChat.message.push(...pair(11),...pair(12));
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true,incremental:true,skipEpisodeRebuild:true});
  await f.api.processPendingEmbeddingQueue();
  // Retain the earlier, real index beside the two newly committed turns, as in
  // the user's capture path (cold-start ingestion may eagerly drop derivatives).
  const current=await f.api._test.loadScopeRecords(scope.scopeKey);
  await f.api._test.saveAllRecords([...current.records.filter(r=>r.sourceType!=='episode_index'),...oldEpisodes],cfg,scope);
  const manifest=await f.api._test.loadScopeManifest(scope);
  await f.api._test.saveScopeManifest({...manifest,episodeSourceDigest:indexed.manifest.episodeSourceDigest},scope);
  await f.context.__episodeBatchStep(scope);
  const debug=await f.api.debugState();assert.equal(debug.lastEpisodeIndex.reason,'batched_incremental_wait',JSON.stringify(debug.lastEpisodeIndex));assert.equal(debug.lastEpisodeIndex.pendingTurns,2);
  forbidProvider=true;const previous=calls,loaded=await f.api._test.loadScopeRecords(scope.scopeKey);
  const responses=rows=>plain(rows.filter(r=>r.sourceType==='response').map(r=>({id:r.id,text:r.text,sourceHash:r.sourceHash,sourceRevision:r.sourceRevision,vector:r.vector,embeddingReceipt:r.embeddingReceipt})));
  await body({...f,scope,app,responses,before:responses(loaded.records),calls:()=>calls,previous,source:JSON.stringify(f.currentChat.message)});
  assert.equal(calls,previous,'no additional embedding or connection probe');
 }finally{await f.dispose();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}
test('server episode-only maintenance resolves a two-turn batch wait without credentials, models or raw loss',()=>fixture(async f=>{
 const plan=await f.api.inspectMemoryMaintenance();assert.equal(plan.liveTurns,12);assert.equal(plan.storedTurns,12);assert.equal(plan.episodeStale,true);
 assert.equal(plan.embeddingWorkIncompleteRecords,0);assert.equal(plan.automatic.strategy,'server_episode_rebuild');assert.equal(plan.automatic.blocked,false);
 const read=f.host.getArgument.bind(f.host);f.host.getArgument=async name=>{assert.notEqual(name,'embedding_key','episode rebuild does not read a provider credential');return read(name);};
 const stages=[],result=await f.api.runMemoryMaintenance('auto',{preflight:plan,onProgress:e=>stages.push(e.stage)});
 assert.equal(result.operation.strategy,'server_episode_rebuild');assert.equal(result.operation.episodes.rebuilt,true);assert.equal(result.after.episodeStale,false);
 assert.equal(result.after.storageSourceHealthy,true);assert.equal(result.after.inspection.credentialStatus,'unverified');assert.equal(result.healthy,false,'provider readiness stays unverified');
 assert(stages.includes('episode_rebuild'));assert(!stages.includes('sync'));assert.equal(JSON.stringify(f.currentChat.message),f.source);
 const reloaded=await f.api._test.loadScopeRecords(f.scope.scopeKey);assert.deepEqual(f.responses(reloaded.records),f.before);
 assert(reloaded.records.some(r=>r.sourceType==='episode_index'&&r.turnRange.end===12));
 const again=await f.api.inspectMemoryMaintenance();assert.equal(again.episodeStale,false);assert.equal(again.storageSourceHealthy,true);
 assert.match(f.api._test.maintenanceResultText(result),/에피소드 인덱스.*갱신/);
 f.host.getArgument=read;
 // Drive the actual product button, diagnosis action and completion surface.
 const gui=createColdStartGuiDocument(),timeouts=new Set(),intervals=new Set();try{
  // Startup timers were paused for deterministic corpus construction. The real
  // GUI needs its render-frame timers; own and clear them explicitly here.
  f.context.setTimeout=(fn,ms,...args)=>{let t;t=setTimeout(()=>{timeouts.delete(t);fn(...args);},ms);timeouts.add(t);return t;};
  f.context.clearTimeout=t=>{timeouts.delete(t);clearTimeout(t);};
  f.context.setInterval=(fn,ms,...args)=>{const t=setInterval(fn,ms,...args);intervals.add(t);return t;};
  f.context.clearInterval=t=>{intervals.delete(t);clearInterval(t);};
  Object.assign(f.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,KeyboardEvent:gui.dom.window.KeyboardEvent,
   HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});
  await f.api.showUi();await gui.document.querySelector('[data-go="care"]').fire('click');
  await until(()=>!gui.document.querySelector('#maintenanceInspectBtn').disabled,'inspection enabled');
  const m=await f.api._test.loadScopeManifest(f.scope);await f.api._test.saveScopeManifest({...m,episodeSourceDigest:'gui-stale-derived-index'},f.scope);
  gui.document.querySelector('#maintenanceInspectBtn').click();
  const action=await until(()=>[...gui.document.querySelectorAll('.overlay.is-open .dialog button')].find(n=>n.textContent.includes('에피소드 인덱스 갱신')),'episode action')
   .catch(e=>{e.message+='; '+gui.document.body.textContent.slice(-1800);throw e;});
  assert.match(action.closest('.dialog').textContent,/제공자 호출 0회/);action.click();
  const popup=await until(()=>{const p=gui.document.querySelector('#flashbackMaintenanceJob');return p?.querySelector('[data-job-result]')?.hidden===false&&p;},'episode completion',12000);
  assert.match(popup.textContent,/서버 저장 점검 통과/);assert.match(popup.querySelector('[data-job-requests]').textContent,/0건/);
  assert(popup.querySelector('[data-job-state]').classList.contains('badge--ok'),'verified server storage completion is not shown as blocked or pending');
  assert.match(popup.querySelector('[data-job-history]').textContent,/에피소드 인덱스/);
  assert.equal((await f.api.inspectMemoryMaintenance()).episodeStale,false);assert.deepEqual(f.responses((await f.api._test.loadScopeRecords(f.scope.scopeKey)).records),f.before);
  assert.deepEqual(gui.errors,[]);
 }finally{for(const t of timeouts)clearTimeout(t);for(const t of intervals)clearInterval(t);gui.dom.window.close();}
}));
for(const scenario of ['source_change','settings_change','storage_change','abort'])test('server derived maintenance rejects '+scenario+' before writes',()=>fixture(async f=>{
 const plan=await f.api.inspectMemoryMaintenance();assert.equal(plan.automatic.strategy,'server_episode_rebuild');
 if(scenario==='source_change')f.currentChat.message[0].data+=' edited';
 if(scenario==='settings_change')await f.api.saveSettings({...await f.api.loadSettings(),episodeMinRecords:3});
 if(scenario==='storage_change'){const m=await f.api._test.loadScopeManifest(f.scope);await f.api._test.saveScopeManifest({...m,episodeSourceDigest:'concurrent-change'},f.scope);}
 const dump=()=>JSON.stringify(f.app.repositories.flashback.database.prepare('SELECT * FROM kv ORDER BY space,key').all()),before=dump(),controller=new AbortController();
 if(scenario==='abort')controller.abort();
 await assert.rejects(()=>f.api.runMemoryMaintenance('auto',{preflight:plan,signal:controller.signal}));assert.equal(dump(),before);
}));
test('unrelated missing paid vector cannot acquire episode-only repair authority',()=>fixture(async f=>{
 const loaded=await f.api._test.loadScopeRecords(f.scope.scopeKey),key=loaded.records.find(r=>r.sourceType==='response').vectorRef.storageKey;
 f.app.repositories.flashback.database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('local',key);
 const plan=await f.api.inspectMemoryMaintenance();assert.equal(plan.automatic.blocked,true);assert.notEqual(plan.automatic.strategy,'server_episode_rebuild');
 plan.automatic={strategy:'server_episode_rebuild',stages:['episode_rebuild'],blocked:false};
 await assert.rejects(()=>f.api.runMemoryMaintenance('auto',{preflight:plan}));
}));
