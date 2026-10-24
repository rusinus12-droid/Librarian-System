'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
const jobKey=namespace=>`__memory_suite_internal_sync_job_v1__:${namespace}`;
async function replaced(variant,options={}){
 const original=await fixture(variant);let replacement,active,stop;
 try{
  if(options.remoteScopeMode){const registry=JSON.parse(original.values.get(original.registryKey));Object.assign(registry.entries.B,{mode:options.remoteScopeMode,origin:'user_explicit'});original.values.set(original.registryKey,JSON.stringify(registry));}
  if(options.remoteSource)await original.bridge.setGlobalMode('server_only');
  let requested=false;stop=original.bridge.subscribeSyncJob(job=>{if(!requested&&job?.status!=='completed'&&job?.checkpoints?.A){requested=true;void original.bridge.pauseGlobalModeJob();}});
  await original.bridge.setGlobalMode(options.remoteSource?'plugin_only':'server_only');stop();await original.bridge.dispose();
  replacement=await fixture(variant);
  replacement.app.repositories[variant[0]].mutate({kind:'set',space:'plugin',key:'restored.sentinel',value:'RESTORED_SERVER_DATA',operationId:'restore_fixture'});
  active=await fixture(variant,{app:original.app,values:original.values,transport:replacement.host.nativeFetch,...options.activeOptions});
  await assert.rejects(()=>active.bridge.cancelSyncJob(),error=>error.code==='MEMORY_SUITE_GLOBAL_ROLLBACK_PUBLICATION_PENDING');
  return {original,replacement,active,close:async()=>{await active.close();await replacement.close();await original.close();}};
 }catch(error){await active?.close();await replacement?.close();await original.close();throw error;}finally{stop?.();}
}
const rows=f=>f.replacement.app.repositories[f.active.bridge.namespace].database.prepare('SELECT * FROM kv ORDER BY space,key').all();
async function historicalWitness(f,variant,localStatus='matching'){
 const namespace=variant[0],key=jobKey(namespace),job=JSON.parse(f.original.values.get(key));
 let remoteKey=f.original.app.repositories[namespace].database.prepare('SELECT key FROM kv WHERE key LIKE ?').all(namespace+'.A%')[0].key;
 let source=job.globalPlan.sources.find(item=>item.identity==='plugin\u0000plugin\u0000'+namespace+'.A');
 if(localStatus==='missing')remoteKey=remoteKey.replace(namespace+'.A',namespace+'.ABSENT');
 if(localStatus==='chunk'){
  const suffix='::chunk:v1:historical:0',value='EXACT_LOCAL_CHUNK';
  f.original.values.set(namespace+'.A'+suffix,value);remoteKey+=suffix;
  source={fingerprint:require('node:crypto').createHash('sha256').update(JSON.stringify([false,value])).digest('hex')};
 }
 job.globalPlan.sources.push({identity:'server\u0000plugin\u0000'+remoteKey,
  fingerprint:localStatus==='different'?'d'.repeat(64):source.fingerprint,revision:1,digest:'historical-server-digest'});
 for(const scope of job.globalPlan.scopes)delete scope.sourceMode;
 delete job.globalPlan.legacyMode;
 const canonical=JSON.stringify(job.globalPlan,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
 job.globalPlanDigest=require('node:crypto').createHash('sha256').update(canonical).digest('hex');
 f.original.values.set(key,JSON.stringify(job));await f.active.bridge.dispose();
 const fresh=await fixture(variant,{app:f.original.app,values:f.original.values,transport:f.replacement.host.nativeFetch});
 return {fresh,remoteKey,job};
}
for(const variant of variants){
 const namespace=variant[0];
 test(`${namespace}: reviewed cancellation uses exact local originals and never writes to restored server`,{timeout:30000},async()=>{
  const f=await replaced(variant);
  try{
   const saved=f.active.bridge.getSyncJob(),before=rows(f),requests=f.replacement.calls.length;
   const preference={schema:'memory-suite.reset-choice.v2',namespace,url:'http://127.0.0.1:47631',dataInstanceId:'R'.repeat(32),dataIdentityContract:'memory-suite.physical-data-identity.v1',dataIdentityCertified:true,resetEpochCertified:true,epoch:3,choice:'empty'};
   f.original.values.set('memory_suite_reset_choice.v2.'+namespace,JSON.stringify(preference));
   const values=[...f.original.values],preview=await f.active.bridge.previewLocalCancellation();
   assert.equal(preview.localSourceRecords,2);assert.deepEqual([...f.original.values],values,'preview is read-only');
   assert.equal(f.replacement.calls.length,requests,'preview does not contact the new server');
   const result=await f.active.bridge.cancelSyncJob({localOnly:true,previewFingerprint:preview.fingerprint});
   assert.equal(result.status,'cancelled');assert.equal(result.rollbackComplete,true);
   assert.equal(result.rollbackPublication.status,'skipped_changed_server');
   assert.deepEqual(result.globalPlan,saved.globalPlan);assert.equal(result.globalPlanDigest,saved.globalPlanDigest);
   assert.deepEqual(result.serverPins,saved.serverPins,'the old physical binding is never replaced');
   const backup=JSON.parse(f.original.values.get(jobKey(namespace)+':local-cancel:'+saved.jobId));
   assert.equal(backup.schema,'memory-suite.local-cancellation-backup.v1');assert.deepEqual(backup.resetPreferenceRaw,JSON.stringify(preference));
   assert(!f.original.values.has('memory_suite_reset_choice.v2.'+namespace));
   assert.deepEqual(rows(f),before);assert.equal(f.replacement.calls.length,requests);
   const localRequests=f.active.calls.length;
   for(const id of ['A','B','C','NEW'])assert.equal((await f.active.bridge.getScopeMode({scopeId:id})).mode,'plugin_only');
   await f.active.proxy.setItem(namespace+'.A','LOCAL_AFTER_CANCEL');assert.equal(await f.active.proxy.getItem(namespace+'.A'),'LOCAL_AFTER_CANCEL');
   assert.equal(f.active.calls.length,localRequests);assert.equal(f.replacement.calls.length,requests);
  }finally{await f.close();}
 });
 for(const damage of ['missing','changed'])test(`${namespace}: ${damage} local original blocks cancellation without clearing the journal`,{timeout:30000},async()=>{
  const f=await replaced(variant);
  try{
   if(damage==='missing')f.original.values.delete(namespace+'.B');else f.original.values.set(namespace+'.B','CHANGED');
   const before=[...f.original.values],server=rows(f),calls=f.replacement.calls.length;
   await assert.rejects(()=>f.active.bridge.previewLocalCancellation(),error=>error.code==='MEMORY_SUITE_LOCAL_CANCEL_SOURCE_'+damage.toUpperCase());
   assert.deepEqual([...f.original.values],before);assert.deepEqual(rows(f),server);assert.equal(f.replacement.calls.length,calls);
   assert.equal(f.active.bridge.getSyncJob().status,'paused');
   await assert.rejects(()=>f.active.proxy.setItem(namespace+'.A','BLOCKED'),error=>error.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');
  }finally{await f.close();}
 });
 test(`${namespace}: original server-only routes cannot be unlocked using retained local copies`,{timeout:30000},async()=>{
  const f=await replaced(variant,{remoteSource:true});
  try{
   await assert.rejects(()=>f.active.bridge.previewLocalCancellation(),error=>error.code==='MEMORY_SUITE_LOCAL_CANCEL_REMOTE_SOURCE_REQUIRED'&&error.details?.reason==='original_global_mode');
   assert.equal(f.active.bridge.getSyncJob().status,'paused');
  }finally{await f.close();}
 });
 test(`${namespace}: remote per-chat mode identifies the exact blocking original route`,{timeout:30000},async()=>{
  const f=await replaced(variant,{remoteScopeMode:'mirror'});
  try{
   await assert.rejects(()=>f.active.bridge.previewLocalCancellation(),error=>error.code==='MEMORY_SUITE_LOCAL_CANCEL_REMOTE_SOURCE_REQUIRED'
    &&error.details?.reason==='original_scope_mode'&&error.details.scopeId==='B'&&error.details.mode==='mirror'&&error.details.origin==='user_explicit');
  }finally{await f.close();}
 });
 for(const localStatus of ['matching','chunk'])test(`${namespace}: ${localStatus} local counterpart satisfies a historical server witness without rebinding the new server`,{timeout:30000},async()=>{
  const f=await replaced(variant);let fresh;
  try{
   const historical=await historicalWitness(f,variant,localStatus);fresh=historical.fresh;
   const before=rows(f),requests=f.replacement.calls.length;
   const preview=await fresh.bridge.previewLocalCancellation();
   assert.equal(preview.localSourceRecords,localStatus==='chunk'?3:2,'count physical originals rather than repeated witnesses');
   const result=await fresh.bridge.cancelSyncJob({localOnly:true,previewFingerprint:preview.fingerprint});
   assert.equal(result.status,'cancelled');assert.equal(result.rollbackComplete,true);
   assert.deepEqual(JSON.parse(JSON.stringify(result.globalPlan)),historical.job.globalPlan);assert.equal(result.globalPlanDigest,historical.job.globalPlanDigest);
   assert.deepEqual(JSON.parse(JSON.stringify(result.serverPins)),historical.job.serverPins);
   assert.deepEqual(rows(f),before);assert.equal(f.replacement.calls.length,requests);
   assert.equal(await fresh.proxy.getItem(namespace+'.A'),'A_SOURCE');
  }finally{await fresh?.close();await f.close();}
 });
 for(const localStatus of ['missing','different'])test(`${namespace}: ${localStatus} local counterpart identifies the blocked server witness without claiming local memory is absent`,{timeout:30000},async()=>{
  const f=await replaced(variant);let fresh,dom;
  try{
   const historical=await historicalWitness(f,variant,localStatus);fresh=historical.fresh;
   const {remoteKey}=historical,requests=f.replacement.calls.length,before=rows(f);
   await assert.rejects(()=>fresh.bridge.previewLocalCancellation(),error=>error.code==='MEMORY_SUITE_LOCAL_CANCEL_REMOTE_SOURCE_REQUIRED'
    &&error.details?.reason==='server_source_witness'&&error.details.key===remoteKey&&error.details.space==='plugin'&&error.details.localStatus===localStatus);
   dom=makePanelDom();await fresh.bridge.mountConnectionPanel(dom.container);dom.byAttr('data-url').value='http://127.0.0.1:47631';
   await dom.byAttr('data-job-retry').onclick();
   const diagnostic=JSON.parse(dom.byAttr('data-job-diagnostics').value);
   assert.equal(diagnostic.details.reason,'server_source_witness');assert.equal(diagnostic.details.key,remoteKey);assert.equal(diagnostic.details.localStatus,localStatus);
   assert.match(diagnostic.blockerReason,/서버 저장 키/);assert.match(diagnostic.actionRequired,/기기 원본이 없다는 뜻은 아니며/);
   assert.equal(f.replacement.calls.length,requests);assert.equal(f.original.values.get(namespace+'.A'),'A_SOURCE');assert.deepEqual(rows(f),before);
  }finally{if(dom)dom.root.isConnected=false;await fresh?.close();await f.close();}
 });
 test(`${namespace}: proof changes during review block execution before local preference removal`,{timeout:30000},async()=>{
  const f=await replaced(variant);
  try{
   const preview=await f.active.bridge.previewLocalCancellation();f.original.values.set(namespace+'.B','CHANGED_AFTER_REVIEW');
   const before=rows(f),calls=f.replacement.calls.length;
   await assert.rejects(()=>f.active.bridge.cancelSyncJob({localOnly:true,previewFingerprint:preview.fingerprint}),error=>error.code==='MEMORY_SUITE_LOCAL_CANCEL_SOURCE_CHANGED');
   assert.equal(f.active.bridge.getSyncJob().status,'paused');assert.equal(f.active.bridge.getSyncJob().localCancellationIntent,undefined);
   assert.deepEqual(rows(f),before);assert.equal(f.replacement.calls.length,calls);
  }finally{await f.close();}
 });
 test(`${namespace}: interrupted reviewed cancellation resumes from saved intent without any server request`,{timeout:30000},async()=>{
  let fail=true;
  const f=await replaced(variant,{activeOptions:{writeFault:async(key,value)=>{
   const job=key===jobKey(namespace)?JSON.parse(value):null;
   if(fail&&job?.localCancellationIntent&&job.rollbackProgress?.stage==='verify_routes'){fail=false;throw Error('synthetic_local_cancel_interruption');}
  }}});let fresh;
  try{
   f.original.values.set('memory_suite_reset_choice.v2.'+namespace,JSON.stringify({choice:'empty',oldPreference:true}));
   const preview=await f.active.bridge.previewLocalCancellation(),calls=f.replacement.calls.length;
   await assert.rejects(()=>f.active.bridge.cancelSyncJob({localOnly:true,previewFingerprint:preview.fingerprint}));
   assert(!f.original.values.has('memory_suite_reset_choice.v2.'+namespace));
   await f.active.bridge.dispose();
   fresh=await fixture(variant,{app:f.original.app,values:f.original.values,transport:async()=>{throw Error('NO_SERVER_REQUEST_ALLOWED');}});
   assert.equal((await fresh.bridge.cancelSyncJob()).rollbackComplete,true);
   assert.equal(f.replacement.calls.length,calls);
  }finally{await fresh?.close();await f.close();}
 });
 test(`${namespace}: primary recovery button reviews local cancellation and closing keeps the old job`,{timeout:30000},async()=>{
  const f=await replaced(variant),dom=makePanelDom();
  try{
   await f.active.bridge.mountConnectionPanel(dom.container);dom.byAttr('data-url').value='http://127.0.0.1:47631';
   assert.equal(dom.byAttr('data-job-retry').textContent,'기기 원본 확인 후 취소');
   assert.match(dom.byAttr('data-job-result').textContent,/서버 복원·초기화|DATA 교체/);
   const before=[...f.original.values],calls=f.replacement.calls.length;
   let running=dom.byAttr('data-job-retry').onclick();
   for(let i=0;i<200&&typeof dom.byAttr('data-mode-confirm-approve').onclick!=='function';i++)await new Promise(resolve=>setTimeout(resolve,5));
   assert.equal(dom.byAttr('data-mode-confirm-title').textContent,'새 서버를 보존하고 이전 취소');
   assert.equal(dom.byAttr('data-mode-confirm-approve').textContent,'기기 경로 복구로 취소');
   assert.match(dom.byAttr('data-mode-confirm-text').textContent,/현재 서버.*변경하지|현재 서버에 자료를 전송/);
   dom.byAttr('data-mode-confirm-cancel').onclick();await running;
   assert.deepEqual([...f.original.values],before);assert.equal(f.replacement.calls.length,calls);
   running=dom.byAttr('data-job-retry').onclick();
   for(let i=0;i<200&&typeof dom.byAttr('data-mode-confirm-approve').onclick!=='function';i++)await new Promise(resolve=>setTimeout(resolve,5));
   dom.byAttr('data-mode-confirm-approve').onclick();await running;
   assert.equal(f.active.bridge.getSyncJob().rollbackComplete,true);
   const diagnostic=JSON.parse(dom.byAttr('data-job-diagnostics').value);
   assert.equal(diagnostic.rollbackPublication.status,'skipped_changed_server');
   assert(!Object.hasOwn(diagnostic,'localCancellationIntent'));assert(!Object.hasOwn(diagnostic,'serverPins'));
   assert.equal(f.replacement.calls.length,calls);
  }finally{dom.root.isConnected=false;await f.close();}
 });
}
