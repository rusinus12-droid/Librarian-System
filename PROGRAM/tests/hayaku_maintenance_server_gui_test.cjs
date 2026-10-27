'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createMemorySuiteServer,mockFetch,trace}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {createHayakuRuntime,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const {plain,messages,envelope,coldResponder}=require('./fixtures/hayaku_maintenance_fixture.cjs');
const instrument=source=>source.replace('        updateRecoveryJournalBackgroundDecision,','        storageBridgeForHostTest:MemorySuiteStorageBridge,\n        updateRecoveryJournalBackgroundDecision,');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(row=>row.isDirectory()?files(path.join(dir,row.name)):[path.join(dir,row.name)]);
const snapshot=(name,gui)=>{if(process.env.HAYAKU_MAINTENANCE_VISUAL_DIR){fs.mkdirSync(process.env.HAYAKU_MAINTENANCE_VISUAL_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.HAYAKU_MAINTENANCE_VISUAL_DIR,name+'.html'),gui.dom.serialize());}};
async function fixture(mode,source,fn){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'hayaku-maintenance-')),app=createMemorySuiteServer({dataDir,autoBackup:false,port:0}),address=await app.listen();
 let offline=false;const storeOptions={autoRepair:false,afterRequestAutoRepair:false,messages:source,transformSource:instrument,
  arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`},nativeFetch:(url,init)=>{if(offline)throw Error('fixture_server_offline');return mockFetch(url,init);}};
 const r=await createHayakuRuntime(storeOptions);const bridge=r.hayaku._test.storageBridgeForHostTest;
 try{if(mode==='server_only'){const connection=await bridge.getConnectionSettings({force:true});await bridge.setScopeMode(connection.scope,mode);}
  await fn(r,{bridge,app,dataDir,storeOptions,offline:value=>offline=value});
 }finally{await r.dispose();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}
for(const mode of ['plugin_only','server_only'])for(const scenario of ['missing','cold'])test(`${mode} actual GUI one-touch ${scenario} runs live job, confirmation and durable readback`,()=>fixture(mode,messages(scenario==='cold'?[1,2]:[2],2),async(r,server)=>{
 const gui=createColdStartGuiDocument();let release;
 try{
  Object.assign(r.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,KeyboardEvent:gui.dom.window.KeyboardEvent,
   HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});
  r.setLlmResponder(async call=>{await new Promise(resolve=>release=resolve);return scenario==='cold'?coldResponder(call):{type:'success',result:JSON.stringify(envelope(2))};});
  const source=plain(r.chat.message);await r.hayaku.showUi();
  const nav=gui.document.querySelector('[data-go="recovery"]')||gui.document.querySelector('#hayakuViewerTabRecovery');await nav?.fire('click');
  const run=gui.document.querySelector('#hayakuMaintenanceRun');assert(run,'production action must exist');const pending=run.fire('click');
  const choices=await waitFor(()=>{const n=gui.document.querySelector('#hayakuMaintenanceAnalysisChoices');return n&&!n.hidden?n:null;},'analysis confirmation');
  assert.equal(r.llmCalls.length,0);assert.equal(gui.document.querySelector('#hayakuNativeJobOverlay').hidden,false);
  assert.match(gui.document.querySelector('#hayakuMaintenanceJobPlan').textContent,/기본.*회.*최대/);snapshot(mode+'-'+scenario+'-confirmation',gui);
  choices.querySelector('[data-maintenance-analysis="yes"]').click();
  await waitFor(()=>release,'real native model boundary');assert.equal(gui.document.querySelector('#hayakuNativeJobOverlay').hidden,false);
  assert.match(gui.document.querySelector('#hayakuNativeJobState').textContent,/분석/);snapshot(mode+'-'+scenario+'-running',gui);
  gui.document.querySelector('#minimizeHayakuNativeJob').click();assert.equal(gui.document.querySelector('#hayakuNativeJobOverlay').hidden,true);
  gui.document.querySelector('#hayakuNativeJobChip').click();assert.equal(gui.document.querySelector('#hayakuNativeJobOverlay').hidden,false);
  const first=release;release=null;first();
  if(scenario==='cold'){await waitFor(()=>release,'second cold start unit');const second=release;release=null;second();}
  const result=await pending;assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.physicalCalls,scenario==='cold'?2:1);
  assert.deepEqual(plain(r.chat.message),source);assert.equal(result.after.needsBinding,false);assert.deepEqual(plain(result.after.targetTurns),[]);
  assert.match(gui.document.querySelector('#hayakuSafeHealthStatus').textContent,/점검·복구 완료/);assert.equal(gui.document.querySelector('#hayakuNativeJobTitle').textContent,'상태 점검 및 자동 복구');
  snapshot(mode+'-'+scenario+'-completed',gui);
  if(mode==='server_only'){
   const dbFile=files(server.dataDir).find(p=>path.basename(p)==='hayaku.sqlite');assert(dbFile);const db=new DatabaseSync(dbFile,{readOnly:true});
   const rows=db.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all();db.close();assert(rows.some(row=>row.key.startsWith('hayaku.v2.ledger.')),'actual server SQLite must contain the owner ledger');
   assert(rows.some(row=>row.value_json.includes(scenario==='cold'?'bridge_cold_start':'bridge_incremental_recovery')));
   const restarted=await createHayakuRuntime({...server.storeOptions,pluginStorage:r.pluginStorage,safeLocalStorage:r.safeLocalStorage,messages:source});
   try{const report=await restarted.hayaku.recovery.maintenance.inspect();assert.equal(report.known,true,JSON.stringify(report));assert.equal(report.storageMode,'server_only');assert.equal(report.status,'healthy',JSON.stringify(report));assert.equal(restarted.llmCalls.length,0);}finally{await restarted.dispose();}
  }
  assert.deepEqual(gui.errors,[]);
 }finally{release?.();gui.dom.window.close();}
}));
test('server read-only inspection never imports retained local bytes and fails closed offline',()=>fixture('server_only',messages([1],1),async(r,{bridge,offline})=>{
 const scope=await r.hayaku._test.currentChatScope(),key='hayaku.v2.ledger.'+scope.key;
 await bridge.ownerLegacyWrite('plugin',key,JSON.stringify({version:'hayaku_storage_ledger_v2',scopeKey:scope.key,records:[]}));
 const before=trace.length,stored=plain([...r.pluginStorage.values]);const report=await r.hayaku.recovery.maintenance.inspect();assert.equal(report.known,true,JSON.stringify(report));assert.equal(report.mode,'cold_start');
 const calls=trace.slice(before);assert(calls.every(row=>!row.url.endsWith('/v1/kv/set')&&!row.url.endsWith('/v1/kv/batch')),'inspection may not bootstrap-import retained local owner bytes');assert.deepEqual(plain([...r.pluginStorage.values]),stored);
 offline(true);const result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.before,null);assert.equal(r.llmCalls.length,0);assert.deepEqual(plain([...r.pluginStorage.values]),stored);
}));
test('server one-touch engine cannot promote a valid retained local ledger while repairing an absent server root',()=>fixture('server_only',messages([1],1),async(r,{bridge})=>{
 const local=await createHayakuRuntime({autoRepair:false,messages:messages([],1)});let retained,key;
 try{assert.equal((await local.hayaku.recovery.maintenance.run()).ok,true);key='hayaku.v2.ledger.'+(await local.hayaku._test.currentChatScope()).key;retained=await local.pluginStorage.getItem(key);}finally{await local.dispose();}
 await bridge.ownerLegacyWrite('plugin',key,retained);r.setLlmResponder(coldResponder);
 const result=await r.hayaku.recovery.maintenance.run({allowModel:true});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.before.mode,'cold_start');assert.equal(result.physicalCalls,1,'current server authority has no canonical packet and requires its own analysis');
 assert.equal(await bridge.ownerLegacyRead('plugin',key),retained,'retained local recovery bytes are preserved');
 const ledger=await r.hayaku.ledger.inspect({includeRecords:true});assert(ledger.records.some(record=>record.captureSource==='bridge_cold_start'));
 assert.equal(ledger.records.some(record=>record.captureSource==='live_chat'),false,'old local live packet must not become server canonical history');
}));
test('a server-to-local-to-server transition invalidates an earlier confirmation even after mode returns',()=>fixture('server_only',messages([1],1),async(r,{bridge})=>{
 const result=await r.hayaku.recovery.maintenance.run({confirmAnalysis:async plan=>{
  await bridge.setScopeMode({scopeId:plan.scopeKey,scopeKey:plan.scopeKey},'plugin_only');
  await bridge.setScopeMode({scopeId:plan.scopeKey,scopeKey:plan.scopeKey},'server_only');return true;
 }});
 assert.equal(result.ok,false,JSON.stringify(result));assert.equal(r.llmCalls.length,0);assert.match(result.reason,/CHANGED|changed/);
}));
test('read-only production GUI action does not write owner records or invoke a model',()=>fixture('plugin_only',messages([2],2),async r=>{
 const gui=createColdStartGuiDocument();try{
  Object.assign(r.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,KeyboardEvent:gui.dom.window.KeyboardEvent,
   HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});
  await r.hayaku.showUi();r.hayaku._test.stopWorldlineTopologyObserver();const before=plain([...r.pluginStorage.values]);
  await gui.document.querySelector('#hayakuSafeHealthInspect').fire('click');assert.equal(r.llmCalls.length,0);assert.deepEqual(plain([...r.pluginStorage.values]),before);
  assert.match(gui.document.querySelector('#hayakuSafeHealthStatus').textContent,/읽기 전용.*모델 호출 0회/);assert.equal(gui.document.querySelector('#hayakuNativeJobOverlay').hidden,false);
 }finally{gui.dom.window.close();}
}));
test('closing GUI at the analysis choice settles the job without dispatch or reopening the window',()=>fixture('server_only',messages([1],1),async r=>{
 const gui=createColdStartGuiDocument();try{
  Object.assign(r.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,KeyboardEvent:gui.dom.window.KeyboardEvent,
   HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});
  await r.hayaku.showUi();let shown=0;const show=r.host.showContainer;r.host.showContainer=async(...args)=>{shown++;return show?.(...args);};
  const pending=gui.document.querySelector('#hayakuMaintenanceRun').fire('click');await waitFor(()=>{const n=gui.document.querySelector('#hayakuMaintenanceAnalysisChoices');return n&&!n.hidden;},'choice before close');
  await gui.document.querySelector('#closeHayakuViewer').fire('click');const result=await pending;assert.equal(result.status,'needs_confirmation');assert.equal(r.llmCalls.length,0);assert.equal(shown,0);assert.equal(r.hayaku.recovery.jobStatus().state,'suspended');
 }finally{gui.dom.window.close();}
}));
