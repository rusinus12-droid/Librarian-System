'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {fixture, installedSdkVariants:variants}=require('./storage_global_allchat_job_test.cjs');
const {JSDOM}=require('jsdom');
for(const variant of variants)test(`${variant[0]}: duplicate cleanup follows global mode despite legacy plugin_only argument`,async()=>{
 const f=await fixture(variant),dom=new JSDOM('<main></main>');
 const q=selector=>dom.window.document.querySelector(selector);
 const repo=f.app.repositories[variant[0]];
 const serverDump=()=>JSON.stringify(repo.database.prepare('SELECT space,key,value_json,digest,revision,deleted FROM kv ORDER BY space,key').all());
 try{
  await assert.rejects(f.bridge.globalVerifyPreservation(),e=>e.code==='MEMORY_SUITE_DELETE_REQUIRES_SERVER_MODE');
  await f.bridge.setGlobalMode('server_only');
  assert.equal(await f.host.getArgument('memory_suite_server_mode'),'plugin_only','legacy argument stays unchanged');
  assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
  const before=serverDump();
  f.setCurrent(null); // Management is global and does not require an active chat.
  const checked=await f.bridge.globalVerifyPreservation();
  assert.equal(checked.ok,true);assert.equal(checked.checked,2);
  assert.equal(serverDump(),before,'verification only reads the server');
  await f.bridge.mountConnectionPanel(q('main'));
  await q('[data-delete]').onclick();
  assert.equal(q('[data-cleanup-dialog]').hidden,false);
  assert.equal(q('[data-cleanup-items]').querySelectorAll('article').length,2);
  const confirm=q('[data-cleanup-continue]');
  assert.equal(confirm.disabled,true);
  await confirm.onclick();
  assert.equal(f.values.has(variant[0]+'.A'),true,'review and an untyped confirmation preserve local copies');
  const typed=q('[data-cleanup-typed]');typed.value='삭제';typed.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  assert.equal(confirm.disabled,false);
  await confirm.onclick();
  assert.equal(f.values.has(variant[0]+'.A'),false);
  assert.equal(f.values.has(variant[0]+'.B'),false);
  assert.equal(serverDump(),before,'cleanup never changes server memory');
  assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
  assert.equal((await f.bridge.globalDeletePluginStorageAfterVerification()).deleted,0);
 }finally{q('main').remove();await f.close();dom.window.close();}
});
