'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await pause(10);}throw Error('terminal notification timeout');}

for(const variant of variants){
 const namespace=variant[0],jobKey='__memory_suite_internal_sync_job_v1__:'+namespace;
 test(namespace+' terminal subscribers read durable results after owner gates release',async()=>{
  let modeDepth=0,delays=0,lateStop;
  const lateNotifications=[];
  const f=await fixture(variant,{
   writeFault:async(key,value)=>{if(key===jobKey&&['completed','cancelled'].includes(JSON.parse(value).status)){
    delays++;
    if(!lateStop){
     lateStop=f.bridge.subscribeSyncJob(job=>{if(['completed','cancelled'].includes(job?.status))lateNotifications.push({status:job.status,modeDepth,persistedStatus:JSON.parse(f.values.get(jobKey)).status});});
     assert.equal(lateNotifications.length,0,'new subscriptions cannot expose the staged terminal record');
    }
    await pause(100);
   }},
   bridgeOptions:{enterOwnerOperation:meta=>{if(meta.kind!=='mode_configuration')return null;modeDepth++;return()=>{modeDepth--;};}}
  });
  const checks=[];
  const stop=f.bridge.subscribeSyncJob(job=>{
   if(!['completed','cancelled'].includes(job?.status))return;
   checks.push((async()=>{
    assert.equal(modeDepth,0,'physical owner configuration must release before callbacks');
    assert.equal(JSON.parse(f.values.get(jobKey)).status,job.status,'the terminal journal must already be durable');
    assert.equal(await f.proxy.getItem(namespace+'.A'),'A_SOURCE','startup reads must be admitted immediately');
   })());
  });
  try{
   await f.bridge.setGlobalMode('server_only');
   await until(()=>checks.length===1);await Promise.all(checks);
   let cancelRequested=false;
   const cancel=f.bridge.subscribeSyncJob(job=>{if(!cancelRequested&&job?.targetMode==='plugin_only'&&job?.checkpoints?.A){cancelRequested=true;void f.bridge.cancelSyncJob();}});
   try{await f.bridge.setGlobalMode('plugin_only');await until(()=>checks.length===2);await Promise.all(checks);}
   finally{cancel();}
   assert.equal(f.bridge.getSyncJob().status,'cancelled');assert.equal(delays,2);
   assert.deepEqual(lateNotifications,[{status:'completed',modeDepth:0,persistedStatus:'completed'},{status:'cancelled',modeDepth:0,persistedStatus:'cancelled'}]);
  }finally{stop();lateStop?.();await f.close();}
 });
 test(namespace+' rejected completion write never announces success',async()=>{
  const f=await fixture(variant,{writeFault:async(key,value)=>{if(key===jobKey&&JSON.parse(value).status==='completed')throw Error('completion_write_denied');}});
  const completed=[];const stop=f.bridge.subscribeSyncJob(job=>{if(job?.status==='completed')completed.push(job);});
  try{
   await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');
   await pause(30);
   assert.equal(completed.length,0);assert.equal(f.bridge.getSyncJob().status,'paused');
   assert.equal(JSON.parse(f.values.get(jobKey)).status,'paused');
  }finally{stop();await f.close();}
 });
 test(namespace+' global display and diagnostic copy distinguish completed work from a new blocked inspection',async()=>{
  let blocked=false;
  const f=await fixture(variant,{current:'',adapter:async({hostScopes,records})=>({
   scopes:hostScopes.map(scope=>({...scope,scopeId:scope.chatId,scopeKey:scope.chatId})),
   records:records.map(row=>({...row,classification:'scope',scopeId:row.logicalKey.slice(namespace.length+1)})),
   blockers:blocked?[{code:'synthetic_new_inspection_blocked',key:'manifest-key',value:'PRIVATE_BODY',credential:'PRIVATE_TOKEN'}]:[],completeKnownScopes:!blocked
  })});
  const dom=makePanelDom();
  try{
   await f.bridge.setGlobalMode('server_only');await pause(20);
   await f.bridge.mountConnectionPanel(dom.container);
   const settings=await f.bridge.getConnectionSettings({force:true});
   assert.equal(settings.scopeId,'');assert.equal(settings.mode,'plugin_only','unidentified scope remains fail closed');
   assert.equal(settings.global.mode,'server_only');
   assert.equal(dom.byAttr('data-current-mode').textContent,'현재 전역 모드: 서버 단독');
   dom.radios.forEach(radio=>{radio.checked=radio.value==='plugin_only';});
   assert.equal(dom.byAttr('data-current-mode').textContent,'현재 전역 모드: 서버 단독','an unapproved target is not an applied setting');
   blocked=true;
   const before=[...f.values];
   await dom.byAttr('data-apply').onclick();
   assert.match(dom.byAttr('data-status').textContent,/새 이전 검사.*미해결/);
   assert.match(dom.byAttr('data-status').textContent,/저장 설정은 변경되지 않았습니다/);
   await dom.byAttr('data-job-copy').onclick();
   const diagnostic=JSON.parse(dom.byAttr('data-job-diagnostics').value);
   assert.equal(diagnostic.status,'completed');assert.equal(diagnostic.effectiveMode,'server_only');
   assert.equal(diagnostic.migrationPreview.completeKnownScopes,false);
   assert.equal(diagnostic.migrationPreview.blockers[0].code,'synthetic_new_inspection_blocked');
   assert(!JSON.stringify(diagnostic).includes('PRIVATE_'),'copy retains metadata, never source bodies or credentials');
   assert.deepEqual([...f.values],before,'failed reinspection cannot mutate the completed configuration');
   assert.equal((await f.bridge.getGlobalMode({force:true})).mode,'server_only');
  }finally{dom.root.isConnected=false;await f.close();}
 });
}
