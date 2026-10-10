'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
(async()=>{for(const variant of variants){
 const f=await fixture(variant,{sdkSource:process.env.BASELINE_SDK_DIR?path.join(process.env.BASELINE_SDK_DIR,variant[2]):undefined});
 const dom=makePanelDom();
 try{
  f.context.confirm=()=>true;
  await f.bridge.mountConnectionPanel(dom.container);
  const html=dom.container.innerHTML;
  assert(!html.includes('data-scope-perchat'),variant[0]+': public panel has only global mode selection');
  assert(html.includes('data-scope-global'));
  const radio=dom.radios.find(row=>row.value==='server_only');dom.radios.forEach(row=>{row.checked=row===radio;});
  dom.byAttr('data-url').value='http://127.0.0.1:47631';
  await dom.byAttr('data-apply').onclick();
  assert.equal(f.bridge.getSyncJob()?.status,'completed',dom.byAttr('data-status').textContent);
  assert.match(dom.byAttr('data-status').textContent,/3\/3/);
  assert.equal((await f.bridge.getScopeMode({scopeId:'A'})).mode,'server_only');
  console.log('PASS '+variant[0]+' mounted global-only public Apply');
 }finally{dom.root.isConnected=false;await f.close();}
}})().catch(error=>{console.error(error);process.exitCode=1;});
