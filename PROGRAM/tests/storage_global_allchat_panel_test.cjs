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
}})().catch(error=>{console.error(error);process.exitCode=1;});
