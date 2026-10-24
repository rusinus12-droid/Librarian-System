'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {declaration}=require('./helpers/libra_navigation_contract.cjs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../plugins/LIBRA.js'),'utf8');
const declarations=['isLibraServerUnavailableError','isLibraStorageTransitionError','clearLibraServerUnavailable','routeLibraGuiToStorageRecovery','retryLibraServerAvailability','hydrateSettingsGuiAfterOpen','syncBookCurrentStatus'];
(async()=>{
 const Runtime={serverUnavailable:true,serverUnavailableError:'previous failure',storageStartupCompleted:false};
 const Gui={visible:true,openSerial:1,state:null,openPerf:{},dirty:false,mockupApp:null};
 let failure=null,retries=0,mode='server_only',probe=true,returnFailure=true,statusText='',statusError=false;
 const rows=Object.fromEntries(['storage','analysis','search'].map(id=>[id,{textContent:'',style:{}}]));
 const help={textContent:'old server warning'};
 const foot={querySelector:selector=>selector==='[data-current-status]'?rows.storage:selector==='.current-status-help'?help:rows[/="([^"]+)"/.exec(selector)?.[1]]};
 const app={querySelector:()=>foot};Gui.mockupApp=app;
 const snapshot={scope:{scopeKey:'test'}};
 const ctx={Runtime,Gui,Date,Boolean,Promise,bookCurrentStatus:{serial:0,subscribed:false},GUI_OPEN_STATE_FRESH_MS:1000,GUI_OPEN_EMBEDDING_FRESH_MS:1000,
  guiNowMs:()=>Date.now(),guiSnapshotLimits:()=>({}),compact:v=>String(v),loadSettings:async()=>({}),readSettingsPersistenceBasis:async()=>({semanticHash:'basis'}),applyGuiSettingsState:()=>{},
  retryLibraStorageInitialization:async()=>{retries++;Runtime.storageStartupCompleted=true;return{ok:true};},
  LibraMemoryCore:{state:{disposed:false},loadEmbeddingSettings:async()=>{},refreshSnapshot:async()=>{if(failure){if(returnFailure)return{...snapshot,error:failure.message};throw failure;}return snapshot;},peekSnapshot:()=>snapshot},
  renderSettingsGui:async()=>{},guiSetStatus:(text,error)=>{statusText=text;statusError=error;},backgroundNativeCopyProbeForGui:async()=>{},ensureLibraStorageTransitionWatcher:()=>{},
  libraEmbeddingStatusSummary:()=>({state:'ready'}),
  MemorySuiteStorageBridge:{getScopeMode:async()=>({mode}),subscribeSyncJob:()=>()=>{},getConnectionSettings:async()=>{throw Error('scope settings unavailable');},testConnection:async()=>({ok:probe,error:'network error'})}
 };vm.createContext(ctx);
 vm.runInContext(declarations.map(n=>declaration(source,n)).join('\n')+'\nthis.test={hydrateSettingsGuiAfterOpen,syncBookCurrentStatus,retryLibraServerAvailability};',ctx);
 const t=ctx.test;
 await t.hydrateSettingsGuiAfterOpen(1);
 assert.equal(Runtime.serverUnavailable,false,'successful live snapshot clears an earlier startup outage');
 assert.equal(Runtime.serverUnavailableError,'');assert.equal(retries,1,'deferred initialization is resumed');
 failure=Error('memory_suite_server_unavailable');
 await t.hydrateSettingsGuiAfterOpen(1);
 assert.equal(Runtime.serverUnavailable,true);assert.equal(Gui.bookPage,'server','recovery uses the new sidebar server page');
 assert.equal(statusError,true);assert.match(statusText,/서버 자료 요청에 실패/);assert.doesNotMatch(statusText,/최신 LIBRA/);
 returnFailure=false;await t.hydrateSettingsGuiAfterOpen(1);
 assert.equal(Runtime.serverUnavailable,true,'rejected reads still preserve the outage');
 returnFailure=true;failure=Error('memory_suite_storage_transition_in_progress');
 await t.hydrateSettingsGuiAfterOpen(1);
 assert.equal(Runtime.storageTransitionPending,true,'returned transition errors still route to recovery');
 assert.match(statusText,/저장소 이전 작업/);assert.equal(statusError,true);
 failure=Error('snapshot read failed');await t.hydrateSettingsGuiAfterOpen(1);
 assert.match(statusText,/일부 백그라운드 갱신 실패/);assert.equal(statusError,true);
 t.syncBookCurrentStatus(app);await Promise.resolve();
 assert.match(rows.storage.textContent,/서버 연결 확인 필요/);assert.doesNotMatch(rows.storage.textContent,/미실행/);
 mode='plugin_only';t.syncBookCurrentStatus(app);await Promise.resolve();
 assert.match(rows.storage.textContent,/플러그인 모드/,'unused server outage does not override active local mode');
 assert.equal(help.textContent,'각 항목을 눌러 설정 변경');
 failure=null;await t.retryLibraServerAvailability();assert.equal(Runtime.serverUnavailable,false);
 Runtime.serverUnavailable=true;probe=false;
 await assert.rejects(t.retryLibraServerAvailability(),/network error/);assert.equal(Runtime.serverUnavailable,true,'failed probe cannot clear outage');
 // An older GUI hydration must not re-publish its failure after a newer open.
 let resolve;ctx.LibraMemoryCore.refreshSnapshot=()=>new Promise(r=>resolve=r);
 const old=t.hydrateSettingsGuiAfterOpen(1);await Promise.resolve();await Promise.resolve();
 Gui.openSerial=2;Runtime.serverUnavailable=false;resolve({...snapshot,error:'memory_suite_server_unavailable'});await old;
 assert.equal(Runtime.serverUnavailable,false,'obsolete GUI result cannot restore an old warning');
 console.log('PASS LIBRA actual GUI availability paths: recovery, confirmed mode, explicit probe and stale replies');
})().catch(e=>{console.error(e);process.exitCode=1;});
