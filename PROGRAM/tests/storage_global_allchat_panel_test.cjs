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
  assert(recoveryDom.container.innerHTML.includes('<button data-global-cancel'),'advanced migration management exposes the documented restore action');
  assert.equal(recoveryDom.byAttr('data-global-cancel').disabled,false);
  assert.equal(recoveryDom.byAttr('data-job-cancel').textContent,'이전 작업 취소 · 기존 경로 복구');
  assert.equal(recoveryDom.byAttr('data-job-retry').textContent,'경로 복구 다시 시도');
  assert.equal(recoveryDom.byAttr('data-global-resume').textContent,'이전 경로 복구 재개');
  assert.match(recoveryDom.byAttr('data-job-result').textContent,/\[고급 작업\] > \[전체 이전 관리\] > \[이전 작업 취소 · 기존 경로 복구\]/);
  rejectPublication=false;await recoveryDom.byAttr('data-global-cancel').onclick();
  assert.equal(recovery.bridge.getSyncJob().rollbackComplete,true);
  assert.match(recoveryDom.byAttr('data-job-title').textContent,/100%/);
  assert.match(recoveryDom.byAttr('data-job-count').textContent,/저장 경로 복구 완료/);
  assert.doesNotMatch(recoveryDom.byAttr('data-job-result').textContent,/MEMORY_SUITE_GLOBAL_ROLLBACK_/);
  assert.equal((await recovery.bridge.getScopeMode({scopeId:'A'})).mode,'plugin_only');
  console.log('PASS '+variant[0]+' visible advanced rollback action retries recovery and clears stale error/progress');
 }finally{stop?.();recoveryDom.root.isConnected=false;await recovery.close();}
}})().catch(error=>{console.error(error);process.exitCode=1;});
