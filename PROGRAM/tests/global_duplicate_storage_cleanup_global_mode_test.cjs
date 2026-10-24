'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const {makePanelDom}=require('./helpers/global-allchat-panel-dom.cjs');
for(const variant of variants)test(`${variant[0]}: duplicate cleanup follows global mode despite legacy plugin_only argument`,async()=>{
 const f=await fixture(variant);const dom=makePanelDom();
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
  await f.bridge.mountConnectionPanel(dom.container);
  const button=dom.byAttr('data-delete');
  await button.onclick();
  assert.match(button.textContent,/검증 완료/,'first click must verify and arm, not claim server is stopped');
  assert.equal(f.values.has(variant[0]+'.A'),true,'first click preserves local copies');
  await button.onclick();
  assert.equal(f.values.has(variant[0]+'.A'),false);
  assert.equal(f.values.has(variant[0]+'.B'),false);
  assert.equal(serverDump(),before,'cleanup never changes server memory');
  assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
  assert.equal((await f.bridge.globalDeletePluginStorageAfterVerification()).deleted,0);
 }finally{dom.root.isConnected=false;await f.close();}
});
