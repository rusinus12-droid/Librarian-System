'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'),{fixture,variants}=require('./storage_global_allchat_job_test.cjs');
for(const v of variants)test(`${v[0]} actual cleanup GUI: review, acknowledgement, progress, stop and server copy removal`,async()=>{
 const f=await fixture(v),dom=new JSDOM('<main id="panel"></main>');
 const q=selector=>dom.window.document.querySelector(selector);
 try{
  await f.bridge.setGlobalMode('server_only');f.values.set(v[0]+'.A','MISMATCH <script>');
  await f.bridge.mountConnectionPanel(q('#panel'),{theme:'book'});
  await q('[data-delete]').onclick();assert.equal(q('[data-cleanup-dialog]').hidden,false);
  assert.equal(q('[data-cleanup-items]').querySelectorAll('article').length,2);
  const dialog=q('[data-cleanup-dialog]');
  await f.bridge.mountConnectionPanel(q('#panel'),{theme:'book'});
  assert.equal(q('[data-cleanup-dialog]'),dialog,'a settings refresh cannot remove the open review/progress dialog');
  assert.equal(dom.window.document.querySelectorAll('[data-cleanup-dialog]').length,1);
  assert.equal(q('[data-cleanup-items]').querySelectorAll('article').length,2,'review choices survive a panel remount');
  assert.match(q('[data-cleanup-items]').textContent,/두 사본의 내용이 다름/);assert.equal(q('script'),null);
  const select=q('[data-cleanup-choice="0"]');assert.equal(select.value,'keep');select.value='delete';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.equal(q('[data-cleanup-ack-row]').hidden,false);assert.equal(q('[data-cleanup-continue]').disabled,true);
  await q('[data-cleanup-continue]').onclick();assert(f.values.has(v[0]+'.A'),'disabled confirmation cannot trigger deletion');
  q('[data-cleanup-ack]').checked=true;q('[data-cleanup-ack]').onchange();assert.equal(q('[data-cleanup-continue]').disabled,false);
  let release,entered;const held=new Promise(resolve=>entered=resolve),unblock=new Promise(resolve=>release=resolve),remove=f.store.removeItem;
  f.store.removeItem=async key=>{entered();await unblock;return remove(key);};
  const running=q('[data-cleanup-continue]').onclick();await held;
  assert.equal(q('[data-cleanup-close]').disabled,true);assert.equal(q('[data-cleanup-stop]').hidden,false);assert.match(q('[data-cleanup-phase]').textContent,/선택한 사본 정리/);
  q('[data-cleanup-stop]').onclick();release();await running;
  assert.match(q('[data-cleanup-phase]').textContent,/중단됨/);assert(f.values.has(v[0]+'.B'));assert.equal(q('[data-cleanup-close]').disabled,false);
  q('[data-cleanup-close]').onclick();assert.equal(q('[data-cleanup-dialog]').hidden,true);
  f.store.removeItem=remove;
  await f.bridge.setGlobalMode('plugin_only');
  await q('[data-server-delete]').onclick();assert.match(q('[data-cleanup-title]').textContent,/서버 사본/);
  await q('[data-cleanup-continue]').onclick();assert.match(q('[data-cleanup-summary]').textContent,/정리 완료.*2개 항목 삭제/);
  assert(f.values.has(v[0]+'.A'));assert(f.values.has(v[0]+'.B'));
 }finally{dom.window.document.querySelector('#panel').innerHTML='';await f.close();dom.window.close();}
});
