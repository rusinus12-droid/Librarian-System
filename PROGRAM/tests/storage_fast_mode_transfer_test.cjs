'use strict';
// One-pass whole-plugin transfer: plugin storage <-> server storage.
// Real server handlers in process, synthetic owner adapter, no sockets.
const assert=require('node:assert/strict');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
const liveRows=(f,ns)=>new Map(f.app.repositories[ns].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all().map(row=>[row.key,JSON.parse(row.value_json)]));
const serverValue=(f,ns,id)=>[...liveRows(f,ns)].find(([key])=>key.startsWith(ns+'.'+id))?.[1];
const count=(f,path,from=0)=>f.calls.slice(from).filter(call=>call.path===path).length;
const seed=(ns,registryKey,records)=>{
 const entries={__memory_suite_global__:{scopeId:'__memory_suite_global__',mode:'plugin_only',origin:'user_explicit'}};
 const values=new Map([[registryKey,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:ns,legacyGlobalModeImported:true,globalMigrationRemoteHistory:false,entries})]]);
 for(const [id,value] of records)values.set(ns+'.'+id,value);
 return values;
};
const waitFor=async(test,label)=>{for(let i=0;i<400;i++){if(test())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('timeout:'+label);};

(async()=>{for(const variant of [...variants,['flashback','flashback_memory','MemorySuiteStorageClient.flashback.source.js']]){
 const ns=variant[0],registryKey=`__memory_suite_internal_scope_routes_v1__:${ns}`;

 // 1. Forward: one batch carries the records, nothing is read back value by value.
 const many=Array.from({length:120},(_,i)=>['K'+String(i).padStart(3,'0'),'VALUE_'+i+'_'+'x'.repeat(200)]);
 const catalog={characters:[{chaId:'one',chats:many.map(([id])=>({id}))}]};
 let f=await fixture(variant,{values:seed(ns,registryKey,many),catalog,current:'K000'});
 try{
  const result=await f.bridge.setGlobalMode('server_only');
  assert.equal(result.completeKnownScopes,true);assert.equal(result.discoveredScopes,120);assert.equal(result.uploaded,120);assert.equal(result.matched,0);
  const uploaded=liveRows(f,ns);
  for(const [id,value] of many) assert.equal(uploaded.get(ns+'.'+id),value,'server round-trip for '+id);
  assert(count(f,'/v1/kv/batch')>=1&&count(f,'/v1/kv/batch')<=4,'records travel in a few batches: '+count(f,'/v1/kv/batch'));
  assert(count(f,'/v1/kv/get')<=2,'no record is downloaded to verify its upload (only the route record is read back): '+count(f,'/v1/kv/get'));
  assert.equal(count(f,'/v1/integrity'),0,'no per-chat integrity scans');
  assert((await f.bridge.getScopeMode({scopeId:'K050'})).mode==='server_only');
  assert.equal(f.bridge.getSyncJob().status,'completed');
  assert.equal(await f.proxy.getItem(ns+'.K003'),many[3][1],'memory is readable right after the switch');
  console.log('PASS '+ns+' forward transfer is batched and digest-verified · requests '+f.calls.length);

  // 2. Applying again sends nothing.
  const before=f.calls.length;
  const again=await f.bridge.setGlobalMode('server_only');
  assert.equal(again.uploaded,0);assert.equal(count(f,'/v1/kv/batch',before),0);assert.equal(count(f,'/v1/kv/set',before)<=1,true,'only the route record may be rewritten');
  console.log('PASS '+ns+' repeated apply transfers nothing');

  // 3. Server is the source now: a server-side change wins when moving back.
  await f.proxy.setItem(ns+'.K005','CHANGED_ON_SERVER');
  assert.equal(serverValue(f,ns,'K005'),'CHANGED_ON_SERVER');
  assert.equal(f.values.get(ns+'.K005'),many[5][1],'server mode leaves the plugin copy untouched');
  const back=await f.bridge.setGlobalMode('plugin_only');
  assert.equal(back.completeKnownScopes,true);assert.equal(back.restored,1,'only the changed record is downloaded and written');assert.equal(back.matched,119);
  assert.equal(f.values.get(ns+'.K005'),'CHANGED_ON_SERVER');
  assert((await f.bridge.getScopeMode({scopeId:'K005'})).mode==='plugin_only');
  assert.equal(await f.proxy.getItem(ns+'.K005'),'CHANGED_ON_SERVER');
  console.log('PASS '+ns+' reverse transfer follows the server and skips equal records');
 }finally{await f.close();}

 // 4. A failure switches nothing, blocks nothing, and the next apply finishes the move.
 let failing=true,seen=0;
 f=await fixture(variant,{values:seed(ns,registryKey,many),catalog,current:'K000',bridgeOptions:{},transportFactory:base=>async(url,init={})=>{
  if(failing&&(String(url).endsWith('/v1/kv/batch')||String(url).endsWith('/v1/kv/set'))&&++seen>1)throw new TypeError('fetch failed');
  return base(url,init);
 }});
 try{
  const error=await f.bridge.setGlobalMode('server_only').then(()=>null,e=>e);
  assert(error,'the transfer reports the failure');
  assert.equal(f.bridge.getSyncJob().status,'failed','a failed run is finished, not pending');
  assert.match(error.userMessage,/저장 위치는 바뀌지 않았고/);
  assert.equal((await f.bridge.getScopeMode({scopeId:'K000'})).mode,'plugin_only','nothing is switched before every record is across');
  assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
  assert.equal(await f.proxy.getItem(ns+'.K001'),many[1][1],'memory stays readable after a failed transfer');
  await f.proxy.setItem(ns+'.K001','EDITED_AFTER_FAILURE');
  failing=false;
  const retry=await f.bridge.setGlobalMode('server_only');
  assert.equal(retry.completeKnownScopes,true);assert.equal(retry.uploaded+retry.matched,120);assert(retry.matched>0,'records sent before the failure are not sent again');
  assert.equal(serverValue(f,ns,'K001'),'EDITED_AFTER_FAILURE');
  console.log('PASS '+ns+' failed transfer keeps the source in use and resumes by digest');
 }finally{await f.close();}

 // 5. Data move copies without changing the mode; a stop request ends the run cleanly.
 f=await fixture(variant,{values:seed(ns,registryKey,many),catalog,current:'K000'});
 try{
  const moved=await f.bridge.moveAllData('server');
  assert.equal(moved.operation,'copy');assert.equal(moved.uploaded,120);
  assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only','a data move never changes the mode');
  assert.equal(serverValue(f,ns,'K010'),many[10][1]);
  f.values.set(ns+'.K010','PLUGIN_EDIT');
  const pulled=await f.bridge.moveAllData('plugin');
  assert.equal(pulled.restored,1);assert.equal(f.values.get(ns+'.K010'),many[10][1],'the chosen destination takes the other side\'s content');
  let asked=false,stop=f.bridge.subscribeSyncJob(job=>{if(!asked&&job?.engine==='fast'&&job.phase==='copy'&&job.status==='running'){asked=true;void f.bridge.cancelSyncJob();}});
  for(const [id] of many)f.values.set(ns+'.'+id,'SECOND_'+id);
  const stopped=await f.bridge.setGlobalMode('server_only').then(()=>null,e=>e);stop();
  assert.equal(stopped?.code,'MEMORY_SUITE_TRANSFER_STOPPED');assert.equal(f.bridge.getSyncJob().status,'cancelled');
  assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
  assert.equal(await f.proxy.getItem(ns+'.K002'),'SECOND_K002','a stopped transfer leaves memory usable');
  console.log('PASS '+ns+' data move keeps the mode and a stop request is clean');
 }finally{await f.close();}

 // 6. Automatic recovery clears what an older, unfinished job left behind.
 const stale=seed(ns,registryKey,many.slice(0,6));
 stale.set(`__memory_suite_internal_sync_job_v1__:${ns}`,JSON.stringify({schema:'memory-suite.sync-job.v1',namespace:ns,jobId:'old-job',id:'old-job',kind:'global_mode',scopeId:'__memory_suite_global__',
  status:'paused',phase:'recovery_pending',error:'MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT',targetMode:'server_only',sourceMode:'plugin_only',startedAt:Date.now()-1000,updatedAt:Date.now()-1000,effectsStarted:true}));
 f=await fixture(variant,{values:stale,catalog:{characters:[{chaId:'one',chats:many.slice(0,6).map(([id])=>({id}))}]},current:'K000'});
 try{
  await assert.rejects(()=>f.proxy.getItem(ns+'.K001'),/transition_in_progress/,'the old unfinished job blocks memory I/O');
  const faults=await f.bridge.inspectModeTransitionFaults();
  assert(faults.some(row=>row.code==='job_stalled'));
  const report=await f.bridge.recoverModeTransition('server');
  assert.equal(report.targetMode,'server_only');assert(report.findings.some(row=>row.code==='job_stalled'));
  assert.equal(report.result.completeKnownScopes,true);assert.equal(report.result.uploaded,6);
  assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
  assert.equal(await f.proxy.getItem(ns+'.K001'),many[1][1],'memory I/O works again after recovery');
  assert.equal(f.bridge.getSyncJob().status,'completed');
  const backAgain=await f.bridge.recoverModeTransition('plugin');
  assert.equal(backAgain.targetMode,'plugin_only');assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
  console.log('PASS '+ns+' automatic recovery clears a stalled job and finishes the switch');
 }finally{await f.close();}

 // 7. Panel: simplified advanced section, popup choices, typed delete confirmation.
 f=await fixture(variant,{values:seed(ns,registryKey,many.slice(0,4)),catalog:{characters:[{chaId:'one',chats:many.slice(0,4).map(([id])=>({id}))}]},current:'K000'});
 const dom=makePanelDom();
 try{
  await f.bridge.mountConnectionPanel(dom.container);
  const html=dom.container.innerHTML;
  for(const gone of ['data-global-pause','data-global-resume','data-global-cancel','data-reset-empty','data-reset-upload','전체 이전 관리','서버 초기화·복원 이후 선택','기기 기억 복구','로컬'])
   assert(!html.includes(gone),ns+': removed control or wording still present: '+gone);
  for(const kept of ['data-recover','data-move-plugin','data-move-server','data-delete','data-server-delete','모드 전환 중 발생한 에러를 감지하고 자동으로 해결합니다.','데이터 이동이 완료된 후 나머지 한쪽의 데이터를 삭제할 때도 쓰입니다.'])
   assert(html.includes(kept),ns+': expected control or note missing: '+kept);
  const order=['data-advanced-group="recover"','data-advanced-group="move"','data-advanced-group="cleanup"'].map(mark=>html.indexOf(mark));
  assert(order.every((at,i)=>at>0&&(i===0||at>order[i-1])),'data cleanup is the last advanced group');
  assert.match(html,/mscx-group danger" data-advanced-group="cleanup"/);
  // Apply: one in-panel confirmation, then the transfer.
  const radio=dom.radios.find(row=>row.value==='server_only');dom.radios.forEach(row=>{row.checked=row===radio;});
  dom.byAttr('data-url').value='http://127.0.0.1:47631';
  const applying=dom.byAttr('data-apply').onclick();
  await waitFor(()=>typeof dom.byAttr('data-mode-confirm-approve').onclick==='function','mode confirm');
  dom.byAttr('data-mode-confirm-approve').onclick();await applying;
  assert.equal(f.bridge.getSyncJob()?.status,'completed',dom.byAttr('data-status').textContent);
  assert.match(dom.byAttr('data-status').textContent,/전역 설정 적용 완료 · 서버 단독/);
  assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
  // Recovery popup offers exactly the two directions and does nothing when closed.
  let pending=dom.byAttr('data-recover').onclick();
  await waitFor(()=>typeof dom.byAttr('data-ask-a').onclick==='function','recover popup');
  assert.equal(dom.byAttr('data-ask-a').textContent,'1) 플러그인 모드로 전환 중');assert.equal(dom.byAttr('data-ask-b').textContent,'2) 서버 모드로 전환 중');
  dom.byAttr('data-ask-cancel').onclick();await pending;
  assert.equal((await f.bridge.getGlobalMode()).mode,'server_only','closing the popup changes nothing');
  pending=dom.byAttr('data-recover').onclick();
  await waitFor(()=>typeof dom.byAttr('data-ask-a').onclick==='function','recover popup 2');
  dom.byAttr('data-ask-a').onclick();await pending;
  assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only',dom.byAttr('data-status').textContent);
  assert.match(dom.byAttr('data-status').textContent,/자동 복구 완료 · 현재 모드: 플러그인 단독/);
  // Data move popup.
  pending=dom.byAttr('data-move-server').onclick();
  await waitFor(()=>typeof dom.byAttr('data-ask-a').onclick==='function','move popup');
  assert.match(dom.byAttr('data-ask-text').textContent,/저장 모드는 바뀌지 않습니다/);
  dom.byAttr('data-ask-a').onclick();await pending;
  assert.match(dom.byAttr('data-status').textContent,/데이터 이동 완료 · 플러그인 스토리지 → 서버 스토리지/);
  // Data cleanup: the delete button stays disabled until 삭제 is typed.
  await dom.byAttr('data-delete').onclick();
  assert.equal(dom.byAttr('data-cleanup-title').textContent,'데이터 정리 · 플러그인 스토리지');
  assert.equal(dom.byAttr('data-cleanup-continue').disabled,true,'review alone never enables deletion');
  dom.byAttr('data-cleanup-typed').value='삭제';dom.byAttr('data-cleanup-typed').oninput();
  console.log('PASS '+ns+' panel: three advanced groups, popup choices, typed confirmation');
 }finally{dom.root.isConnected=false;await f.close();}
}})().catch(error=>{console.error(error);process.exitCode=1;});
