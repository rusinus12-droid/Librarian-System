'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
const jobKey=namespace=>`__memory_suite_internal_sync_job_v1__:${namespace}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function partial(f){
 let requested=false;
 const stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.checkpoints?.A){requested=true;void f.bridge.pauseGlobalModeJob();}});
 try{const preview=await f.bridge.previewGlobalMode('server_only');assert.equal((await f.bridge.setGlobalMode('server_only',{previewFingerprint:preview.inventoryFingerprint})).status,'paused');}finally{stop();}
}
for(const variant of variants){
 const namespace=variant[0];
 test(`${namespace}: 110-chat rollback uses bounded durable writes and reports its own progress`,{timeout:30000},async()=>{
  const chats=[{id:'A'},{id:'B'},...Array.from({length:108},(_,i)=>({id:'extra_'+i}))];
  const f=await fixture(variant,{catalog:{characters:[{chaId:'one',chats}]}});let observe;
  try{
   await partial(f);
   const previous=f.bridge.getSyncJob(),before=f.writes.length,events=[];
   observe=f.bridge.subscribeSyncJob(job=>{if(job?.phase==='rollback_routes')events.push(job);});
   const result=await f.bridge.cancelSyncJob();
   const journalWrites=f.writes.slice(before).filter(key=>key===jobKey(namespace));
   console.log(JSON.stringify({namespace,chats:110,routes:111,journalWrites:journalWrites.length}));
   assert(journalWrites.length<=6,`110 chats must not trigger per-route journal writes: ${journalWrites.length}`);
   assert.equal(result.rollbackComplete,true);
   assert.equal(result.rollbackProgress.totalScopes,111,'global settings are included');
   assert.equal(result.rollbackProgress.checkedScopes,111);
   assert.equal(result.rollbackProgress.verifiedScopes,111);
   assert.equal(result.rollbackProgress.stage,'complete');
   assert(events.length>0);assert(events.every(job=>job.status==='running'));
   assert(events.some(job=>job.rollbackProgress.stage==='publish_routes'));
   assert.deepEqual(result.globalPlan,previous.globalPlan);
   assert.equal(result.globalPlanDigest,previous.globalPlanDigest);
   assert.equal(f.values.get(namespace+'.A'),'A_SOURCE');
   const beforeRead=f.calls.length;
   await f.proxy.setItem(namespace+'.A','AFTER_RECOVERY');
   assert.equal(await f.proxy.getItem(namespace+'.A'),'AFTER_RECOVERY');
   assert.equal(f.calls.length,beforeRead);
  }finally{observe?.();await f.close();}
 });

 for(const crashStage of ['publish_routes','verify_routes'])test(`${namespace}: journal interruption at ${crashStage} replays the original plan`,{timeout:30000},async()=>{
  let recovering=false,interrupted=false;
  const f=await fixture(variant,{writeFault:async(key,value)=>{
   if(recovering&&key===jobKey(namespace)&&!interrupted&&JSON.parse(value).rollbackProgress?.stage===crashStage){
    interrupted=true;throw Error('synthetic_crash_after_local_routes');
   }
  }});let fresh;
  try{
   await partial(f);const original=f.bridge.getSyncJob();recovering=true;
   await assert.rejects(()=>f.bridge.cancelSyncJob());assert.equal(interrupted,true);
   assert.equal((await f.bridge.getScopeMode({scopeId:'A'})).mode,'plugin_only');
   assert.equal(f.bridge.getSyncJob().status,'paused');
   await f.bridge.dispose();
   fresh=await fixture(variant,{app:f.app,values:f.values});
   const result=await fresh.bridge.cancelSyncJob();
   assert.equal(result.rollbackComplete,true);assert.equal(result.jobId,original.jobId);
   assert.deepEqual(JSON.parse(JSON.stringify(result.globalPlan)),JSON.parse(JSON.stringify(original.globalPlan)));assert.equal(result.globalPlanDigest,original.globalPlanDigest);
   assert.equal(f.values.get(namespace+'.A'),'A_SOURCE');
  }finally{if(fresh)await fresh.close();await f.close();}
 });

 // Retired with 09f07fa2 (batched transfers): the progress card no longer runs legacy rollback attempts.
 // A stopped legacy job is shown as one stale card and finished through [모드 전환 중 자동 복구].
 test(`${namespace}: GUI routes a stopped legacy rollback to automatic recovery and finishes it once the server returns`,{timeout:30000},async()=>{
  const original=await fixture(variant);let active,ui;
  try{
   await partial(original);await original.bridge.dispose();
   const control={fail:true,publications:0};
   active=await fixture(variant,{app:original.app,values:original.values,transportFactory:base=>async(url,init={})=>{
    if(String(url).endsWith('/v1/kv/set')&&JSON.parse(init.body).key===`__memory_suite_scope_routes_v1__:${namespace}`){
     control.publications++;
     if(control.fail)return new Response(JSON.stringify({ok:false,error:'synthetic_server_offline'}),{status:503});
    }
    return base(url,init);
   }});
   await assert.rejects(()=>active.bridge.cancelSyncJob(),error=>error.code==='MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING');
   const stopped=active.bridge.getSyncJob();
   ui=makePanelDom();await active.bridge.mountConnectionPanel(ui.container);
   ui.byAttr('data-url').value='http://127.0.0.1:47631';
   assert.equal(ui.byAttr('data-job-title').textContent,'끝나지 않은 전환 작업이 남아 있습니다');
   assert.equal(ui.byAttr('data-job-phase').textContent,'현재 단계: 조치 필요');
   assert.match(ui.byAttr('data-job-workflow').textContent,/\[모드 전환 중 자동 복구\]/);
   assert.equal(ui.byAttr('data-job-retry').style.display,'none','the stale card offers no in-card retry');
   const recover=async choice=>{
    const pending=ui.byAttr('data-recover').onclick();
    for(let i=0;i<400&&typeof ui.byAttr('data-ask-a').onclick!=='function';i++)await pause(5);
    assert.equal(ui.byAttr('data-ask-title').textContent,'모드 전환 중 자동 복구');
    ui.byAttr(choice==='plugin'?'data-ask-a':'data-ask-b').onclick();await pending;
   };
   // Server still offline: recovery stops, the journal and the original data stay.
   await recover('plugin');
   assert.match(ui.byAttr('data-status').textContent,/자동 복구를 마치지 못했습니다\nMEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING/);
   assert(control.publications>0,'recovery actually retried the route publication');
   const kept=active.bridge.getSyncJob();
   assert.equal(kept.jobId,stopped.jobId);assert.equal(kept.status,'paused');
   assert.deepEqual(kept.globalPlan,stopped.globalPlan);assert.equal(kept.globalPlanDigest,stopped.globalPlanDigest);
   assert.equal(ui.byAttr('data-job-title').textContent,'끝나지 않은 전환 작업이 남아 있습니다');
   assert.equal(original.values.get(namespace+'.A'),'A_SOURCE');
   // Server back: one recovery finishes the rollback and the plugin-only switch.
   control.fail=false;await recover('plugin');
   assert.match(ui.byAttr('data-status').textContent,/자동 복구 완료 · 현재 모드: 플러그인 단독/);
   assert.match(ui.byAttr('data-status').textContent,/끝나지 않은 전환 작업 \(MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING\)/);
   const done=active.bridge.getSyncJob();
   assert.equal(done.status,'completed');assert.equal(done.engine,'fast');
   assert.match(ui.byAttr('data-job-title').textContent,/플러그인 단독.*100%/);
   assert.equal((await active.bridge.getGlobalMode()).mode,'plugin_only');
   const beforeRead=active.calls.length;
   assert.equal(await active.proxy.getItem(namespace+'.A'),'A_SOURCE');
   await active.proxy.setItem(namespace+'.A','AFTER_RECOVERY');
   assert.equal(await active.proxy.getItem(namespace+'.A'),'AFTER_RECOVERY');
   assert.equal(active.calls.length,beforeRead,'memory I/O is local again');
  }finally{if(ui)ui.root.isConnected=false;if(active)await active.close();await original.close();}
 });
}
