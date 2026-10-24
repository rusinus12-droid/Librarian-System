'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
const jobKey=namespace=>`__memory_suite_internal_sync_job_v1__:${namespace}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function partial(f){
 let requested=false;
 const stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.checkpoints?.A){requested=true;void f.bridge.pauseGlobalModeJob();}});
 try{assert.equal((await f.bridge.setGlobalMode('server_only')).status,'paused');}finally{stop();}
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

 test(`${namespace}: GUI separates active recovery, stopped recovery and completed recovery time`,{timeout:30000},async()=>{
  const original=await fixture(variant);let active,ui,release;
  try{
   await partial(original);await original.bridge.dispose();
   const old=JSON.parse(original.values.get(jobKey(namespace)));old.startedAt=Date.now()-12*60*60*1000;
   original.values.set(jobKey(namespace),JSON.stringify(old));
   const control={fail:true,gate:null,entered:null,publications:0};
   active=await fixture(variant,{app:original.app,values:original.values,transportFactory:base=>async(url,init={})=>{
    if(String(url).endsWith('/v1/kv/set')&&JSON.parse(init.body).key===`__memory_suite_scope_routes_v1__:${namespace}`){
     control.publications++;
     if(control.gate){control.entered.resolve();await control.gate.promise;}
     if(control.fail)return new Response(JSON.stringify({ok:false,error:'synthetic_server_offline'}),{status:503});
    }
    return base(url,init);
   }});
   await assert.rejects(()=>active.bridge.cancelSyncJob());
   ui=makePanelDom();await active.bridge.mountConnectionPanel(ui.container);
   ui.byAttr('data-url').value='http://127.0.0.1:47631';
   assert.match(ui.byAttr('data-job-title').textContent,/취소 복구 중단 · 조치 필요/);
   assert.match(ui.byAttr('data-job-phase').textContent,/조치 대기/);
   let diagnostics=JSON.parse(ui.byAttr('data-job-diagnostics').value);
   assert.equal(diagnostics.waitingForUser,true);assert.equal(diagnostics.recoveryState,'action_required');
   const stoppedTime=ui.byAttr('data-job-time').textContent;
   await pause(1100);assert.equal(ui.byAttr('data-job-time').textContent,stoppedTime,'waiting time does not inflate this attempt');
   control.gate=deferred();release=control.gate;control.entered=deferred();
   const before=control.publications;
   const retry=ui.byAttr('data-job-retry').onclick();const duplicate=ui.byAttr('data-job-retry').onclick();
   await control.entered.promise;
   assert.match(ui.byAttr('data-job-title').textContent,/취소 복구 실행 중/);
   assert.match(ui.byAttr('data-job-phase').textContent,/원래 서버 응답·적용 확인/);
   assert.match(ui.byAttr('data-job-count').textContent,/경로 확인: 4 \/ 4 · 복구 검증: 0 \/ 4/);
   assert.doesNotMatch(ui.byAttr('data-job-count').textContent,/대화 검증/);
   assert.match(ui.byAttr('data-job-time').textContent,/이번 복구: \d+초 · 마지막 진행/);
   assert.equal(ui.byAttr('data-job-stalled-actions').style.display,'none');
   diagnostics=JSON.parse(ui.byAttr('data-job-diagnostics').value);
   assert.equal(diagnostics.status,'running');assert.equal(diagnostics.recoveryState,'running');assert.equal(diagnostics.waitingForUser,false);
   assert(diagnostics.attemptStartedAt>old.startedAt+11*60*60*1000,'attempt clock excludes the overnight job');
   assert.equal(diagnostics.attemptFinishedAt,0);
   assert(!Object.hasOwn(diagnostics,'globalPlan'));assert(!Object.hasOwn(diagnostics,'serverPins'));
   release.resolve();await Promise.all([retry,duplicate]);control.gate=null;
   assert.equal(control.publications-before,1,'duplicate clicks share one attempt');
   assert.match(ui.byAttr('data-job-title').textContent,/조치 필요/);
   assert.match(ui.byAttr('data-job-time').textContent,/중단됨/);
   diagnostics=JSON.parse(ui.byAttr('data-job-diagnostics').value);
   assert(diagnostics.attemptFinishedAt>=diagnostics.attemptStartedAt);
   control.fail=false;await ui.byAttr('data-job-retry').onclick();
   assert.equal(active.bridge.getSyncJob().rollbackComplete,true);
   assert.match(ui.byAttr('data-job-title').textContent,/취소 복구 완료.*100%/);
   assert.match(ui.byAttr('data-job-time').textContent,/복구 소요: \d+초/);
   assert.equal(JSON.parse(ui.byAttr('data-job-diagnostics').value).recoveryState,'complete');
  }finally{release?.resolve();if(ui)ui.root.isConnected=false;if(active)await active.close();await original.close();}
 });
}
