'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
const busy=()=>new Response(JSON.stringify({ok:false,error:'server_maintenance_in_progress'}),{status:503});
const finalRead=(f,url,key)=>f?.bridge.getSyncJob()?.phase==='final_verify'&&new URL(url).pathname==='/v1/kv/get'&&new URL(url).searchParams.get('key')===key;
const catalog110={characters:[{chaId:'one',chats:[{id:'A'}]},{chaId:'two',chats:[{id:'B'},{id:'C'},...Array.from({length:107},(_,i)=>({id:'extra_'+i}))]}]};
for(const variant of variants){
 const namespace=variant[0],key=namespace+'.A';
 test(`${namespace}: a brief maintenance pause retries the exact final read with all 110 checkpoints`,{timeout:30000},async()=>{
  let f,reads=0,waitJournalWrites=0;const writes=[],waits=[];const dom=makePanelDom();let stop;
  try{
   f=await fixture(variant,{catalog:catalog110,writeFault:async(k,value)=>{
    if(k===`__memory_suite_internal_sync_job_v1__:${namespace}`&&JSON.parse(value).serverWait?.active){waitJournalWrites++;await new Promise(resolve=>setTimeout(resolve,2000));}
   },transportFactory:base=>async(url,init={})=>{
    if(new URL(url).pathname==='/v1/kv/set')writes.push(JSON.parse(init.body).key);
    if(finalRead(f,url,key)&&++reads<=2)return busy();return base(url,init);
   }});
   await f.bridge.mountConnectionPanel(dom.container);
   stop=f.bridge.subscribeSyncJob(job=>{if(job?.serverWait?.active)waits.push({job,diagnostic:JSON.parse(dom.byAttr('data-job-diagnostics').value),phase:dom.byAttr('data-job-phase').textContent});});
   assert.equal((await f.bridge.setGlobalMode('server_only')).completeKnownScopes,true);
   assert.equal(reads,3);assert.equal(waits.length,2);
   for(const wait of waits){assert.equal(wait.job.verifiedScopes,110);assert.equal(wait.job.discoveredScopes,110);
    assert.equal(wait.diagnostic.recoveryState,'waiting_server');assert.equal(wait.diagnostic.waitingForUser,false);assert.match(wait.phase,/서버 작업 종료 대기/);}
   assert.equal(writes.filter(value=>value===key).length,1,'matching payload is never resent during the wait');
   assert.equal(waitJournalWrites,0,'transient wait timers must not enqueue journal writes that can overtake durable completion');
   assert.equal(f.bridge.getSyncJob().status,'completed');assert.equal(f.bridge.getSyncJob().serverWait.active,false);
  }finally{stop?.();dom.root.isConnected=false;await f?.close();}
 });
 test(`${namespace}: persistent maintenance pauses with clear guidance and the same resumable job`,{timeout:30000},async()=>{
  let f,locked=true,reads=0;const dom=makePanelDom();const writes=[];
  try{
   f=await fixture(variant,{transportFactory:base=>async(url,init={})=>{
    if(new URL(url).pathname==='/v1/kv/set')writes.push(JSON.parse(init.body).key);
    if(locked&&finalRead(f,url,key)){reads++;return busy();}return base(url,init);
   }});
   await f.bridge.mountConnectionPanel(dom.container);
   await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_SERVER_MAINTENANCE'&&error.details.readOnly===true&&error.details.retries===5);
   const saved=f.bridge.getSyncJob(),diagnostic=JSON.parse(dom.byAttr('data-job-diagnostics').value);
   assert.equal(reads,6);assert.equal(saved.status,'paused');assert.equal(saved.failedPhase,'final_verify');assert.equal(saved.verifiedScopes,3);
   assert.equal(saved.serverWait.active,false);assert.equal(diagnostic.waitingForUser,true);
   assert.match(diagnostic.blockerReason,/백업·복원·업데이트/);assert.match(diagnostic.actionRequired,/작업이 끝난 뒤.*중단한 이전 재개/);
   assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only','global mode remains uncommitted');
   locked=false;assert.equal((await f.bridge.setGlobalMode('server_only')).completeKnownScopes,true);
   assert.equal(f.bridge.getSyncJob().jobId,saved.jobId);assert.equal(f.bridge.getSyncJob().globalPlanDigest,saved.globalPlanDigest);
   assert.equal(writes.filter(value=>value===key).length,1);assert.equal(f.values.get(key),'A_SOURCE');
  }finally{dom.root.isConnected=false;await f?.close();}
 });
 test(`${namespace}: the user can pause maintenance waiting without another server read`,{timeout:30000},async()=>{
  let f,reads=0,requested=false,stop;
  try{
   f=await fixture(variant,{transportFactory:base=>async(url,init)=>{if(finalRead(f,url,key)){reads++;return busy();}return base(url,init);}});
   stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.serverWait?.active){requested=true;void f.bridge.pauseGlobalModeJob();}});
   const result=await f.bridge.setGlobalMode('server_only');
   assert.equal(result.status,'paused');assert.equal(result.phase,'paused_resumable');assert.equal(result.error,'');assert.equal(result.verifiedScopes,3);
   assert.equal(reads,1);assert.equal(result.serverWait.active,false);assert.equal(f.values.get(key),'A_SOURCE');
  }finally{stop?.();await f?.close();}
 });
 test(`${namespace}: unrelated 503 errors do not enter maintenance retry`,{timeout:30000},async()=>{
  let f,reads=0;
  try{
   f=await fixture(variant,{transportFactory:base=>async(url,init)=>{
    if(finalRead(f,url,key)){reads++;return new Response(JSON.stringify({ok:false,error:'unrelated_failure'}),{status:503});}return base(url,init);
   }});
   await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),error=>error.message==='unrelated_failure');
   assert.equal(reads,1);assert.equal(f.bridge.getSyncJob().serverWait,null);
  }finally{await f?.close();}
 });
 test(`${namespace}: cancellation leaves maintenance waiting and restores original routes`,{timeout:30000},async()=>{
  let f,reads=0,requested=false,stop;
  try{
   f=await fixture(variant,{transportFactory:base=>async(url,init)=>{if(finalRead(f,url,key)){reads++;return busy();}return base(url,init);}});
   stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.serverWait?.active){requested=true;void f.bridge.cancelSyncJob();}});
   const result=await f.bridge.setGlobalMode('server_only');
   assert.equal(result.status,'cancelled');assert.equal(result.rollbackComplete,true);assert.equal(reads,1);
   assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');assert.equal(f.values.get(key),'A_SOURCE');
   assert.equal(f.app.repositories[namespace].get('plugin',key).value,'A_SOURCE');
  }finally{stop?.();await f?.close();}
 });
 test(`${namespace}: replacement DATA during maintenance waiting is never adopted`,{timeout:30000},async()=>{
  const replacement=await fixture(variant);let f,useReplacement=false,stop;
  try{
   const before=replacement.app.repositories[namespace].database.prepare('SELECT * FROM kv ORDER BY space,key').all();
   f=await fixture(variant,{transportFactory:base=>async(url,init)=>{
    if(useReplacement)return replacement.host.nativeFetch(url,init);
    if(finalRead(f,url,key))return busy();return base(url,init);
   }});
   stop=f.bridge.subscribeSyncJob(job=>{if(job?.serverWait?.active)useReplacement=true;});
   await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),error=>/DATA_INSTANCE|CONNECTION_STALE|SERVER_PIN/.test(error.code||error.message));
   assert.equal(f.bridge.getSyncJob().status,'paused');assert.notEqual(f.bridge.getSyncJob().error,'MEMORY_SUITE_SERVER_MAINTENANCE');
   assert.deepEqual(replacement.app.repositories[namespace].database.prepare('SELECT * FROM kv ORDER BY space,key').all(),before);
   assert(!replacement.calls.some(row=>row.method!=='GET'),'no mutation reaches the replacement server');
  }finally{stop?.();await f?.close();await replacement.close();}
 });
 test(`${namespace}: cancellation blocked by maintenance explains the same lock and recovery action`,{timeout:30000},async()=>{
  let f,requested=false,stop;const dom=makePanelDom();
  try{
   f=await fixture(variant,{transportFactory:base=>async(url,init)=>{
    if(finalRead(f,url,key)||f?.bridge.getSyncJob()?.phase==='rollback_routes'&&new URL(url).pathname.startsWith('/v1/'))return busy();
    return base(url,init);
   }});
   await f.bridge.mountConnectionPanel(dom.container);
   stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.serverWait?.active){requested=true;void f.bridge.cancelSyncJob();}});
   await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING');
   const diagnostic=JSON.parse(dom.byAttr('data-job-diagnostics').value);
   assert.match(diagnostic.blockerReason,/백업·복원·업데이트/);assert.match(diagnostic.actionRequired,/작업이 끝난 뒤.*취소 복구 계속/);
   assert.equal(f.bridge.getSyncJob().status,'paused');assert.equal(f.values.get(key),'A_SOURCE');
  }finally{stop?.();dom.root.isConnected=false;await f?.close();}
 });
 test(`${namespace}: actual server backup maintenance can finish before the exact read resumes`,{timeout:30000},async()=>{
  let f,backupPromise,started=false,observed=false,stop;
  try{
   f=await fixture(variant,{transportFactory:base=>async(url,init)=>{
    if(!started&&finalRead(f,url,key)){started=true;backupPromise=f.app.createBackup('manual','migration-final-read');}
    return base(url,init);
   }});
   stop=f.bridge.subscribeSyncJob(job=>{if(job?.serverWait?.active)observed=true;});
   assert.equal((await f.bridge.setGlobalMode('server_only')).completeKnownScopes,true);
   // A backup now only fences writes: the final read is served without a maintenance wait,
   // and the following publication write retries through the short backup window.
   assert.equal((await backupPromise).ok,true);assert.equal(observed,false);assert.equal(f.bridge.getSyncJob().verifiedScopes,3);
  }finally{stop?.();await backupPromise?.catch(()=>{});await f?.close();}
 });
}
