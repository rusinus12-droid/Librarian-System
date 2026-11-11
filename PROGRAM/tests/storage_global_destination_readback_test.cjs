'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {fixture, installedSdkVariants:variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
async function applyLegacyPreview(f,target){
 const preview=await f.bridge.previewGlobalMode(target);
 assert.equal(preview.completeKnownScopes,true);
 return await f.bridge.setGlobalMode(target,{previewFingerprint:preview.inventoryFingerprint});
}
async function paused(variant,sourceA){
 const f=await fixture(variant);let requested=false;
 if(sourceA!==undefined)f.values.set(variant[0]+'.A',sourceA);
 const stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.checkpoints?.A){requested=true;void f.bridge.pauseGlobalModeJob();}});
 try{await applyLegacyPreview(f,'server_only');assert.equal(f.bridge.getSyncJob().status,'paused');}
 finally{stop();await f.bridge.dispose();}
 return f;
}
for(const variant of variants){
 const namespace=variant[0],key=namespace+'.A';
 test(`${namespace}: the last verified replica can be refreshed in either direction`,async()=>{
  const f=await fixture(variant);
  try{
   await f.bridge.setGlobalMode('server_only');
   await f.proxy.setItem(key,'SERVER_ADVANCED');
   assert.equal(f.values.get(key),'A_SOURCE');
   await f.bridge.setGlobalMode('plugin_only');
   assert.equal(f.values.get(key),'SERVER_ADVANCED');
   await f.proxy.setItem(key,'PLUGIN_ADVANCED');
   assert.equal(f.app.repositories[namespace].get('plugin',key).value,'SERVER_ADVANCED');
   await f.bridge.setGlobalMode('server_only');
   assert.equal(f.app.repositories[namespace].get('plugin',key).value,'PLUGIN_ADVANCED');
   assert.equal(f.values.get(key),'PLUGIN_ADVANCED');
  }finally{await f.close();}
 });
 test(namespace+': an independently changed local destination is preserved',async()=>{
  const f=await fixture(variant);
  try{
   await f.bridge.setGlobalMode('server_only');
   await f.proxy.setItem(key,'SERVER_ADVANCED');
   f.values.set(key,'LOCAL_INDEPENDENT');
   const error=await f.bridge.setGlobalMode('plugin_only').then(()=>null,error=>error);
   assert.equal(f.values.get(key),'LOCAL_INDEPENDENT','switching modes preserves an independent destination edit');
   assert.equal(f.app.repositories[namespace].get('plugin',key).value,'SERVER_ADVANCED');
   assert.equal((await f.bridge.getScopeMode({scopeId:'A'})).mode,'server_only');
   assert.equal(error?.code,'MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT');
   const diagnostic=f.bridge.getCachedDiagnostics();
   assert.doesNotMatch(JSON.stringify(diagnostic),/LOCAL_INDEPENDENT|SERVER_ADVANCED/);
  }finally{await f.close();}
 });
 test(namespace+': a server source removed after inventory prevents a mode switch',async()=>{
  let removed=false,inject=false;
  const f=await fixture(variant,{transportFactory:base=>async(url,init={})=>{
   if(inject&&!removed&&new URL(url).pathname==='/v1/kv/get-many'&&JSON.parse(init.body).keys.includes(key)){
    removed=true;
    f.app.repositories[namespace].database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',key);
   }
   return base(url,init);
  }});
  try{
   await f.bridge.setGlobalMode('server_only');
   await f.proxy.setItem(key,'SERVER_ADVANCED');
   inject=true;
   const error=await f.bridge.setGlobalMode('plugin_only').then(()=>null,error=>error);
   assert.equal(removed,true,'fault is injected at the batched read after inventory');
   assert.equal((await f.bridge.getGlobalMode()).mode,'server_only','an incomplete source cannot promote the stale replica');
   assert.equal(f.values.get(key),'A_SOURCE');
   assert.ok(error,'the interrupted transfer is reported as a failure');
  }finally{await f.close();}
 });
 test(namespace+': digest matches still require current server metadata before a mode switch',async()=>{
  const f=await fixture(variant);
  let removed=false,unsubscribe;
  try{
   await f.bridge.setGlobalMode('server_only');
   unsubscribe=f.bridge.subscribeSyncJob(job=>{
    if(removed||job?.targetMode!=='plugin_only'||job.phase!=='copy')return;
    removed=true;
    f.app.repositories[namespace].database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',key);
   });
   await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED');
   assert.equal(removed,true);
   assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
   assert.equal(f.values.get(key),'A_SOURCE');
  }finally{unsubscribe?.();await f.close();}
 });
 test(`${namespace}: the local representation is compared through its server projection`,async()=>{
  const bridgeOptions={resolveKeyScope:async({key:logicalKey})=>({
   kind:'scope',scopeId:logicalKey.slice(namespace.length+1),
   projectValue:value=>String(value).replace(/^device:/,''),
   mergeValue:remote=>'device:'+remote
  })};
  const f=await fixture(variant,{bridgeOptions});
  try{
   f.values.set(key,'device:A_SOURCE');
   await f.bridge.setGlobalMode('server_only');
   assert.equal(f.app.repositories[namespace].get('plugin',key).value,'A_SOURCE');
   await f.bridge.setGlobalMode('plugin_only');
   assert.equal(f.values.get(key),'device:A_SOURCE');
  }finally{await f.close();}
 });
 test(`${namespace}: a saved server route does not skip a missing payload on resume`,async()=>{
  const f=await paused(variant);let fresh;
  try{
   f.app.repositories[namespace].database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',key);
   const writes=[];
   fresh=await fixture(variant,{app:f.app,values:f.values,transportFactory:base=>async(url,init={})=>{
    if(new URL(url).pathname==='/v1/kv/set')writes.push(JSON.parse(init.body));return base(url,init);
   }});
   const saved=JSON.parse(JSON.stringify(f.bridge.getSyncJob()));
   const result=await fresh.bridge.setGlobalMode('server_only');
   assert.equal(result.completeKnownScopes,true);assert.equal(fresh.bridge.getSyncJob().verifiedScopes,3);
   const copies=writes.filter(row=>row.key===key);assert.equal(copies.length,1);assert.equal(copies[0].expectedRevision,0);
   assert.equal(f.app.repositories[namespace].get('plugin',key).value,'A_SOURCE');
   assert.equal(f.values.get(key),'A_SOURCE');
   const job=fresh.bridge.getSyncJob();assert.equal(job.jobId,saved.jobId);assert.equal(job.globalPlanDigest,saved.globalPlanDigest);
   assert.deepEqual(JSON.parse(JSON.stringify(job.serverPins)),saved.serverPins);
   assert.equal(job.checkpoints.A.copiedMissingRecords,1);
  }finally{await fresh?.close();await f.close();}
 });
 for(const reason of ['destination_value_mismatch','destination_tombstone'])test(`${namespace}: ${reason} is diagnosed without overwriting the server`,async()=>{
  const f=await paused(variant);let fresh,stop,dom;
  try{
   fresh=await fixture(variant,{app:f.app,values:f.values});let changed=false;
   stop=fresh.bridge.subscribeSyncJob(job=>{
    if(!changed&&job?.status==='running'&&job.currentScopeId==='A'&&job.currentAction==='대화 자료 확인'){
     changed=true;f.app.repositories[namespace].mutate({kind:reason==='destination_tombstone'?'remove':'set',space:'plugin',key,value:'CONCURRENT_SERVER_VALUE',operationId:'concurrent_'+reason});
    }
   });
   await assert.rejects(()=>fresh.bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_DESTINATION_UNVERIFIED'
    &&error.details?.reason===reason&&error.details.key===key&&error.details.space==='plugin'&&error.details.repairable===false);
   const row=f.app.repositories[namespace].get('plugin',key);
   assert.equal(reason==='destination_tombstone'?row.tombstone:row.value,reason==='destination_tombstone'?true:'CONCURRENT_SERVER_VALUE');
   assert.equal(f.values.get(key),'A_SOURCE');assert.equal(fresh.bridge.getSyncJob().verifiedScopes,1);
   dom=makePanelDom();await fresh.bridge.mountConnectionPanel(dom.container);
   const diagnostic=JSON.parse(dom.byAttr('data-job-diagnostics').value);
   assert.equal(diagnostic.details.reason,reason);assert.equal(diagnostic.details.remoteKey,key);
   assert(!JSON.stringify(diagnostic).includes('CONCURRENT_SERVER_VALUE'));assert(!JSON.stringify(diagnostic).includes('A_SOURCE'));
   assert(!diagnostic.actionRequired.includes('[중단한 이전 재개]'),'a confirmed mismatch must not recommend an unchanged retry');
  }finally{stop?.();if(dom)dom.root.isConnected=false;await fresh?.close();await f.close();}
 });
 test(`${namespace}: changed local source cannot fill a missing server record`,async()=>{
  const f=await paused(variant);let fresh,stop;
  try{
   f.app.repositories[namespace].database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',key);
   fresh=await fixture(variant,{app:f.app,values:f.values});let changed=false;
   stop=fresh.bridge.subscribeSyncJob(job=>{if(!changed&&job?.status==='running'&&job.currentScopeId==='A'){
    changed=true;f.values.set(key,'CHANGED_LOCAL_ORIGINAL');
   }});
   await assert.rejects(()=>fresh.bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED');
   assert.equal(f.app.repositories[namespace].get('plugin',key).exists,false);assert.equal(fresh.bridge.getSyncJob().status,'paused');
  }finally{stop?.();await fresh?.close();await f.close();}
 });
 test(namespace+': a failed batch precondition preserves a concurrently created server record',async()=>{
  let inserted=false;
  const f=await fixture(variant,{transportFactory:base=>async(url,init={})=>{
   if(!inserted&&new URL(url).pathname==='/v1/kv/batch'&&JSON.parse(init.body).mutations.some(row=>row.key===key)){
    inserted=true;
    f.app.repositories[namespace].mutate({kind:'set',space:'plugin',key,value:'RACING_SERVER_VALUE',operationId:'concurrent_create'});
   }
   return base(url,init);
  }});
  try{
   const error=await f.bridge.setGlobalMode('server_only').then(()=>null,error=>error);
   assert.equal(inserted,true,'the server changed after inventory and before conditional batch writes');
   assert.ok(f.calls.some(call=>call.path==='/v1/kv/batch'&&call.status===409),'the real server rejected the stale batch precondition');
   assert.equal(f.app.repositories[namespace].get('plugin',key).value,'RACING_SERVER_VALUE');
   assert.equal(f.values.get(key),'A_SOURCE');
   assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
   assert.ok(error,'batch fallback must not report success after a destination conflict');
  }finally{await f.close();}
 });
 test(`${namespace}: an originally server-only source never falls back to a retained local copy`,async()=>{
  const f=await fixture(variant);let stop;
  try{
   await f.bridge.setGlobalMode('server_only');let removed=false;
   stop=f.bridge.subscribeSyncJob(job=>{if(!removed&&job?.engine==='fast'&&job.phase==='copy'){
    removed=true;f.app.repositories[namespace].database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',key);
   }});
   await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'
    &&error.details?.key===key&&error.details.location==='server');
   assert.equal(removed,true);
   assert.equal(f.app.repositories[namespace].get('plugin',key).exists,false);assert.equal(f.values.get(key),'A_SOURCE');
  }finally{stop?.();await f.close();}
 });
 test(`${namespace}: equivalent-looking JSON with a different storage type remains a diagnosed conflict`,async()=>{
  const payload={schema:'fixture.manifest.v1',count:6,commitId:'same_commit'};
  const f=await paused(variant,JSON.stringify(payload));let fresh,stop;
  try{
   fresh=await fixture(variant,{app:f.app,values:f.values});let changed=false;
   stop=fresh.bridge.subscribeSyncJob(job=>{if(!changed&&job?.status==='running'&&job.currentScopeId==='A'){
    changed=true;f.app.repositories[namespace].mutate({kind:'set',space:'plugin',key,value:payload,operationId:'type_changed'});
   }});
   await assert.rejects(()=>fresh.bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_DESTINATION_UNVERIFIED'
    &&error.details?.expectedValueType==='string'&&error.details.actualValueType==='object'&&error.details.jsonEquivalent===true);
   assert.deepEqual(f.app.repositories[namespace].get('plugin',key).value,payload);
  }finally{stop?.();await fresh?.close();await f.close();}
 });
 test(`${namespace}: a preflight conflict reports the exact destination and fingerprints`,async()=>{
  const f=await paused(variant);let fresh;
  try{
   f.app.repositories[namespace].mutate({kind:'set',space:'plugin',key,value:'DIFFERENT_BEFORE_RESUME',operationId:'before_resume'});
   fresh=await fixture(variant,{app:f.app,values:f.values});
   await assert.rejects(()=>fresh.bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT'
    &&error.details?.space==='plugin'&&error.details.remoteKey===key&&error.details.reason==='destination_value_mismatch'
    &&/^[a-f0-9]{64}$/.test(error.details.expectedFingerprint)&&/^[a-f0-9]{64}$/.test(error.details.actualFingerprint)
    &&error.details.expectedFingerprint!==error.details.actualFingerprint);
   assert.equal(f.app.repositories[namespace].get('plugin',key).value,'DIFFERENT_BEFORE_RESUME');
   assert.equal(fresh.bridge.getSyncJob().verifiedScopes,1);
  }finally{await fresh?.close();await f.close();}
 });
 test(`${namespace}: structured conflicts expose field names without exposing their values`,async()=>{
  const f=await paused(variant,JSON.stringify({schema:'fixture.manifest.v1',count:6,shardSummaries:[{privateText:'LOCAL_PRIVATE_VALUE'}]}));let fresh;
  try{
   f.app.repositories[namespace].mutate({kind:'set',space:'plugin',key,value:JSON.stringify({schema:'fixture.manifest.v1',count:6,shardSummaries:[{privateText:'SERVER_PRIVATE_VALUE'}]}),operationId:'structured_conflict'});
   fresh=await fixture(variant,{app:f.app,values:f.values});
   await assert.rejects(()=>fresh.bridge.setGlobalMode('server_only'),error=>{
    if(error.code!=='MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT')return false;
    assert.equal(error.details.jsonEquivalent,false);assert.equal(error.details.differingTopLevelFieldCount,1);
    assert.equal(JSON.stringify(error.details.differingTopLevelFields),'["shardSummaries"]');
    assert(!JSON.stringify(error.details).includes('PRIVATE_VALUE'));return true;
   });
  }finally{await fresh?.close();await f.close();}
 });
 test(`${namespace}: an existing plugin record does not conceal the same key missing from server local space`,async()=>{
  const deviceValues=new Map([[key,'LOCAL_SPACE_SOURCE']]);
  const device={getItem:async key=>deviceValues.get(key)??null,setItem:async(key,value)=>{deviceValues.set(key,value);return true;},removeItem:async key=>{deviceValues.delete(key);return true;},keys:async()=>[...deviceValues.keys()]};
  const bridgeOptions={localPrefixes:[namespace+'.']};
  const f=await fixture(variant,{bridgeOptions});let fresh,stop;
  try{
   f.bridge.createLocalStorageProxy(device);let requested=false;
   stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.checkpoints?.A){requested=true;void f.bridge.pauseGlobalModeJob();}});
   await applyLegacyPreview(f,'server_only');stop();
   const repository=f.app.repositories[namespace];assert.equal(repository.get('plugin',key).value,'A_SOURCE');assert.equal(repository.get('local',key).value,'LOCAL_SPACE_SOURCE');
   repository.database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('local',key);
   await f.bridge.dispose();const writes=[];
   fresh=await fixture(variant,{app:f.app,values:f.values,bridgeOptions,transportFactory:base=>async(url,init={})=>{
    if(new URL(url).pathname==='/v1/kv/set')writes.push(JSON.parse(init.body));return base(url,init);
   }});
   fresh.bridge.createLocalStorageProxy(device);
   assert.equal((await fresh.bridge.setGlobalMode('server_only')).completeKnownScopes,true);
   assert.equal(writes.filter(row=>row.key===key&&row.space==='plugin').length,0);
   assert.equal(writes.filter(row=>row.key===key&&row.space==='local').length,1);
   assert.equal(repository.get('plugin',key).value,'A_SOURCE');assert.equal(repository.get('local',key).value,'LOCAL_SPACE_SOURCE');
   assert.equal(deviceValues.get(key),'LOCAL_SPACE_SOURCE');
  }finally{stop?.();await fresh?.close();await f.close();}
 });
}
