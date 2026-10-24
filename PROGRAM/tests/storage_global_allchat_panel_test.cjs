'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
const selectorControl=makePanelDom();selectorControl.container.innerHTML='<span data-job-retry></span>';
assert.throws(()=>selectorControl.root.querySelector('button[data-job-retry]').onclick,/panel_selector_missing/,'a stats span must not substitute for a missing action button');
(async()=>{for(const variant of variants){
 const f=await fixture(variant,{sdkSource:process.env.BASELINE_SDK_DIR?path.join(process.env.BASELINE_SDK_DIR,variant[2]):undefined});
 const dom=makePanelDom();
 try{
  f.context.confirm=()=>{throw Error('Native confirmation forbidden');};
  await f.bridge.mountConnectionPanel(dom.container);
  const html=dom.container.innerHTML;
  assert(!html.includes('data-scope-perchat'),variant[0]+': public panel has only global mode selection');
  assert(html.includes('data-scope-global'));
  const radio=dom.radios.find(row=>row.value==='server_only');dom.radios.forEach(row=>{row.checked=row===radio;});
  dom.byAttr('data-url').value='http://127.0.0.1:47631';
  const pending=dom.byAttr('data-apply').onclick();
  for(let i=0;i<200&&!dom.byAttr('data-mode-confirm-approve').onclick;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(typeof dom.byAttr('data-mode-confirm-approve').onclick,'function','mounted approval is required');
  assert.equal(dom.byAttr('data-mode-confirm-title').textContent,'처음 서버 이전');
  assert.equal(dom.byAttr('data-mode-confirm-approve').textContent,'처음 이전 시작');
  assert.match(dom.byAttr('data-mode-confirm-text').textContent,/기존 자료가 발견되지 않았습니다/);
  dom.byAttr('data-mode-confirm-approve').onclick();await pending;
  assert.equal(f.bridge.getSyncJob()?.status,'completed',dom.byAttr('data-status').textContent);
  assert.match(dom.byAttr('data-status').textContent,/3\/3/);
  assert.equal((await f.bridge.getScopeMode({scopeId:'A'})).mode,'server_only');
  console.log('PASS '+variant[0]+' mounted global-only public Apply');
 }finally{dom.root.isConnected=false;await f.close();}
 let rejectPublication=false;
 const recovery=await fixture(variant,{transportFactory:base=>async(url,init={})=>{
  const body=init.body?JSON.parse(init.body):{};
  if(rejectPublication&&String(url).endsWith('/v1/kv/set')&&body.key===`__memory_suite_scope_routes_v1__:${variant[0]}`)
   return new Response(JSON.stringify({ok:false,error:'synthetic_rollback_publication_failure'}),{status:503});
  return base(url,init);
 }});
 const recoveryDom=makePanelDom();let stop;
 try{
  let requested=false;stop=recovery.bridge.subscribeSyncJob(job=>{if(!requested&&job?.checkpoints?.A){requested=true;void recovery.bridge.pauseGlobalModeJob();}});
  await recovery.bridge.setGlobalMode('server_only');rejectPublication=true;
  await assert.rejects(()=>recovery.bridge.cancelSyncJob());
  await recovery.bridge.mountConnectionPanel(recoveryDom.container);
  recoveryDom.byAttr('data-url').value='http://127.0.0.1:47631';
  assert(recoveryDom.container.innerHTML.includes('<button data-global-cancel'),'advanced migration management exposes the documented restore action');
  assert.equal(recoveryDom.byAttr('data-global-cancel').disabled,false);
  assert.equal(recoveryDom.byAttr('data-job-cancel').textContent,'이전 작업 취소 · 기존 경로 복구');
  assert.equal(recoveryDom.byAttr('data-job-retry').textContent,'취소 복구 계속');
  assert.equal(recoveryDom.byAttr('data-global-resume').textContent,'진행 화면으로 이동');
  assert.match(recoveryDom.byAttr('data-job-result').textContent,/진행 화면의 \[취소 복구 계속\]/);
  let focused=0;recoveryDom.byAttr('data-job-retry').focus=()=>{focused++;};
  const unchangedWrites=recovery.writes.length;
  await recoveryDom.byAttr('data-apply').onclick();
  await recoveryDom.byAttr('data-global-resume').onclick();
  await recoveryDom.byAttr('data-global-cancel').onclick();
  assert.equal(focused,3,'all secondary routes only navigate to the primary recovery action');
  assert.equal(recovery.writes.length,unchangedWrites,'navigation cannot execute recovery or change the journal');
  assert.notEqual(typeof recoveryDom.byAttr('data-mode-confirm-approve').onclick,'function');
  assert.equal(recovery.bridge.getSyncJob().status,'paused');
  assert.match(recoveryDom.byAttr('data-status').textContent,/진행 화면의 \[취소 복구 계속\]/);
  rejectPublication=false;await recoveryDom.byAttr('data-job-retry').onclick();
  assert.equal(recovery.bridge.getSyncJob().rollbackComplete,true,recoveryDom.byAttr('data-status').textContent);
  assert.match(recoveryDom.byAttr('data-job-title').textContent,/100%/);
  assert.match(recoveryDom.byAttr('data-job-count').textContent,/저장 경로 복구 완료/);
  assert.doesNotMatch(recoveryDom.byAttr('data-job-result').textContent,/MEMORY_SUITE_GLOBAL_ROLLBACK_/);
  assert.equal((await recovery.bridge.getScopeMode({scopeId:'A'})).mode,'plugin_only');
  console.log('PASS '+variant[0]+' visible advanced rollback action retries recovery and clears stale error/progress');
 }finally{stop?.();recoveryDom.root.isConnected=false;await recovery.close();}

 // Resume keeps the original job; reapply after cancellation is a new check
 // that reuses the server copies. Both must say what they actually do.
 for(const scenario of ['resume','connection_resume','reuse','recheck']){
  const payloadWrites=[];
  let failInventory=false;
  const traceTransport=base=>async(url,init={})=>{
   if(failInventory&&String(url).includes('/v1/kv/keys'))throw Error('synthetic_temporary_discovery_failure');
   if(String(url).endsWith('/v1/kv/set'))payloadWrites.push(JSON.parse(init.body||'{}').key);
   return base(url,init);
  };
  const owner=await fixture(variant,{transportFactory:traceTransport});let active=owner,ui=makePanelDom(),unsubscribe,observe;
  try{
   await active.bridge.mountConnectionPanel(ui.container);
   ui.byAttr('data-url').value='http://127.0.0.1:47631';
   let requested=false;unsubscribe=active.bridge.subscribeSyncJob(job=>{if(!requested&&job?.checkpoints?.A){requested=true;void active.bridge.pauseGlobalModeJob();}});
   await active.bridge.setGlobalMode('server_only');
   const previousId=active.bridge.getSyncJob().jobId;
   if(scenario==='reuse'){
    await active.bridge.cancelSyncJob();await active.bridge.dispose();ui.root.isConnected=false;
    active=await fixture(variant,{app:owner.app,values:owner.values,transportFactory:traceTransport});ui=makePanelDom();
    await active.bridge.mountConnectionPanel(ui.container);
    ui.byAttr('data-url').value='http://127.0.0.1:47631';
   }else if(scenario==='connection_resume'){
    failInventory=true;
    await assert.rejects(()=>active.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED');
    failInventory=false;
    assert.match(ui.byAttr('data-job-workflow').textContent,/재개 전에.*다시 확인/);
   }else if(scenario==='recheck'){
    owner.values.set(variant[0]+'.B','B_CHANGED');
    await assert.rejects(()=>active.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED');
    assert.match(ui.byAttr('data-job-workflow').textContent,/재개 전에.*다시 확인/);
    const diagnostics=JSON.parse(ui.byAttr('data-job-diagnostics').value);
    assert.match(diagnostics.actionRequired,/진행 화면의 \[중단한 이전 재개\]/);
    assert.doesNotMatch(diagnostics.actionRequired,/설정.*적용|고급 작업.*재개/);
   }else{
    assert.match(ui.byAttr('data-job-workflow').textContent,/중단된 이전 재개/);
    assert.match(ui.byAttr('data-job-workflow').textContent,/1 \/ 3/);
    assert.match(ui.byAttr('data-scope-note').textContent,/목표|전역/);
   }
   const beforePreview=[...owner.values];
   const preview=await active.bridge.previewGlobalMode('server_only');
   assert.deepEqual([...owner.values],beforePreview,'classifying the workflow is read-only');
   assert.equal(preview.workflow.kind,scenario==='connection_resume'?'inspection':scenario==='resume'?'resume':'reuse');
   if(scenario!=='connection_resume')assert.equal(preview.workflow.existingDestinationScopes,1);
   if(scenario==='resume')assert.equal(preview.workflow.previousVerifiedScopes,1);
   if(scenario==='recheck')assert.equal(preview.workflow.newCheckRequired,true);
   const beforeWrites=payloadWrites.length,seen=[];
   observe=active.bridge.subscribeSyncJob(job=>{if(job?.currentProgress&&!job.currentProgress.dryRun)seen.push(ui.byAttr('data-job-transfer').textContent);});
   if(scenario==='reuse')ui.radios.forEach(r=>{r.checked=r.value==='server_only';});
   else{
    assert.equal(ui.radios.find(r=>r.checked).value,'plugin_only','resume uses the recorded goal without selecting server mode again');
    let focused=0;ui.byAttr('data-job-retry').focus=()=>{focused++;};
    const writes=owner.writes.length;
    await ui.byAttr('data-apply').onclick();await ui.byAttr('data-global-resume').onclick();
    assert.equal(focused,2);assert.equal(owner.writes.length,writes);
   }
   let applying=ui.byAttr(scenario==='reuse'?'data-apply':'data-job-retry').onclick();
   let duplicate=scenario==='reuse'?null:ui.byAttr('data-job-retry').onclick();
   if(scenario!=='resume'&&scenario!=='connection_resume'){
    for(let i=0;i<200&&!ui.byAttr('data-mode-confirm-approve').onclick;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(ui.byAttr('data-mode-confirm-title').textContent,'기존 서버 자료 확인 후 이전');
    assert.equal(ui.byAttr('data-mode-confirm-approve').textContent,'기존 자료 확인 후 계속');
    assert.match(ui.byAttr('data-mode-confirm-text').textContent,/일치하는 자료는 재전송하지 않/);
    if(scenario==='reuse')assert.match(ui.byAttr('data-mode-confirm-text').textContent,/전체 대화 검증은 다시 시작/);
    if(scenario==='recheck'){
     assert.match(ui.byAttr('data-mode-confirm-text').textContent,/자료가 변경되어/);
     assert.equal(ui.byAttr('data-mode-confirm-cancel').textContent,'닫기 · 미완료 작업 유지');
     ui.byAttr('data-mode-confirm-cancel').onclick();await Promise.all([applying,duplicate]);
     assert.equal(active.bridge.getSyncJob().jobId,previousId);assert.equal(active.bridge.getSyncJob().status,'paused');
     assert.equal(payloadWrites.slice(beforeWrites).filter(key=>key===variant[0]+'.B').length,0,'closing recheck consent cannot upload data');
     applying=ui.byAttr('data-job-retry').onclick();duplicate=ui.byAttr('data-job-retry').onclick();
     for(let i=0;i<200&&!ui.byAttr('data-mode-confirm-approve').onclick;i++)await new Promise(resolve=>setTimeout(resolve,10));
    }
    ui.byAttr('data-mode-confirm-approve').onclick();
   }
   await Promise.all([applying,duplicate]);
   assert.equal(active.bridge.getSyncJob().status,'completed',ui.byAttr('data-status').textContent);
   const resumed=scenario==='resume'||scenario==='connection_resume';
   assert.equal(active.bridge.getSyncJob().workflow.kind,resumed?'resume':'reuse');
   assert.equal(active.bridge.getSyncJob().jobId===previousId,resumed);
   assert.equal(ui.radios.find(r=>r.checked).value,'server_only','completed resume reflects the applied mode');
   const later=payloadWrites.slice(beforeWrites);
   assert.equal(later.filter(key=>key===variant[0]+'.A').length,0,'existing payload is not uploaded again');
   assert.equal(later.filter(key=>key===variant[0]+'.B').length,1,'missing payload is uploaded exactly once');
   assert.match(ui.byAttr('data-job-count').textContent,/대화 검증: 3 \/ 3/);
   if(scenario==='reuse')assert(seen.some(text=>/일치 확인 1건 · 새 전송 0건/.test(text)),JSON.stringify(seen));
   assert(seen.some(text=>/새 전송 1건/.test(text)),JSON.stringify(seen));
   console.log('PASS '+variant[0]+' '+scenario+' has distinct consent/progress and no duplicate payload writes');
  }finally{unsubscribe?.();observe?.();ui.root.isConnected=false;if(active!==owner)await active.close();await owner.close();}
 }
}})().catch(error=>{console.error(error);process.exitCode=1;});
