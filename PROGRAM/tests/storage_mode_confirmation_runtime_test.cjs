'use strict';
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<300;i++){if(fn())return;await pause(10);}throw Error('confirmation did not appear');}
const deadline=setTimeout(()=>{throw Error('Confirmation regression timed out');},35000);
(async()=>{for(const variant of variants){
 const f=await fixture(variant),dom=new JSDOM('<!doctype html><div id="panel"></div>');
 try{
  let nativeCalls=0;f.context.confirm=()=>{nativeCalls++;return Promise.resolve(false);};
  const container=dom.window.document.getElementById('panel');await f.bridge.mountConnectionPanel(container);
  const q=s=>container.querySelector(s),apply=q('[data-apply]'),original=[f.values.get(variant[0]+'.A'),f.values.get(variant[0]+'.B')];
  const select=()=>{q('input[value="server_only"]').checked=true;q('[data-url]').value='http://127.0.0.1:47631';};
  const begin=async()=>{select();const pending=apply.onclick();await until(()=>q('[data-mode-confirm-approve]').onclick);return {pending};};
  let {pending}=await begin();
  assert.equal(nativeCalls,0,'CSP/Tauri native confirm is never called');assert.equal(apply.disabled,true);
  assert.equal(f.bridge.getSyncJob(),null,'preview cannot start a migration before explicit approval');
  assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
  assert.match(q('[data-mode-confirm-text]').textContent,/전체 3개 대화/);
  q('[data-mode-confirm-cancel]').click();await pending;
  assert.equal(f.bridge.getSyncJob(),null);assert.equal(apply.disabled,false);
  assert.deepEqual([f.values.get(variant[0]+'.A'),f.values.get(variant[0]+'.B')],original);
  ({pending}=await begin());q('.mscx-scope-root').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pending;
  assert.equal(f.bridge.getSyncJob(),null,'Escape is cancellation');
  ({pending}=await begin());q('[data-url]').value='http://127.0.0.1:47632';q('[data-mode-confirm-approve]').click();await pending;
  assert.match(q('[data-status]').textContent,/대상 설정이 바뀌/);assert.equal(f.bridge.getSyncJob(),null,'approval does not follow a changed destination');
  ({pending}=await begin());q('[data-mode-confirm-approve]').click();await pending;
  assert.equal(f.bridge.getSyncJob().status,'completed');assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
  assert.deepEqual([f.values.get(variant[0]+'.A'),f.values.get(variant[0]+'.B')],original);
  console.log('PASS '+variant[0]+': in-panel consent, cancel, Escape, destination change, source preservation and approved server migration');
 }finally{containerConnectedOff(dom);await f.close();}
}
 const blocked=await fixture(variants[0],{adapter:async()=>({scopes:[],records:[],blockers:[{code:'fixture_dependency_missing',key:'manifest-key',detail:'missing-shard-key',rawBody:'PRIVATE_BODY_MUST_NOT_APPEAR'}],completeKnownScopes:false})}),dom=new JSDOM('<!doctype html><div id="panel"></div>');
 try{
  const container=dom.window.document.getElementById('panel');await blocked.bridge.mountConnectionPanel(container);
  container.querySelector('input[value="server_only"]').checked=true;
  await container.querySelector('[data-apply]').onclick();
  const details=container.querySelector('[data-preview-diagnostics]');assert.equal(details.hidden,false);
  const value=container.querySelector('[data-preview-diagnostics-text]').value;
  assert.ok(value.includes('missing-shard-key'));assert.ok(!value.includes('PRIVATE_BODY_MUST_NOT_APPEAR'));
  assert.equal(blocked.bridge.getSyncJob(),null);assert.match(container.querySelector('[data-status]').textContent,/missing-shard-key/);
  console.log('PASS blocked inventory: full missing-key diagnostics, no payload disclosure and no migration');
 }finally{containerConnectedOff(dom);await blocked.close();}
 function containerConnectedOff(dom){dom.window.document.getElementById('panel')?.remove();dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
