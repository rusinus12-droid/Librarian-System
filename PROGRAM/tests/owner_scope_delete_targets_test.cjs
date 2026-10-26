'use strict';
const assert = require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture, variants} = require('./storage_global_allchat_job_test.cjs');
(async () => {
 for (const variant of variants.filter(v => v[0] !== 'flashback')) for (const mode of ['plugin_only','server_only']) for (const deleteTarget of ['local','server','both']) {
  const f = await fixture(variant,{bridgeOptions:{scopeManagement:true}}), ns=variant[0];
  try {
   await f.bridge.setGlobalMode('server_only');
   if (mode === 'plugin_only') await f.bridge.setGlobalMode(mode);
   assert.equal(f.values.get(ns+'.B'),'B_SOURCE');
   assert.equal(f.app.repositories[ns].get('plugin',ns+'.B').exists,true);
   const routing = f.values.get(f.registryKey);
   const dom=new JSDOM('<!doctype html><div id="host"></div>');
   try{
    const container=dom.window.document.getElementById('host');await f.bridge.mountScopeManagementPanel(container);
    const menu=container.querySelector('[data-scope-delete-target]');assert.deepEqual(Array.from(menu.options,o=>o.value),['local','server','both']);
    menu.value=deleteTarget;menu.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
    for(let n=0;n<100&&container.querySelector('[data-scope-refresh]').disabled;n++)await new Promise(resolve=>setTimeout(resolve,1));
    const checkbox=container.querySelector('[data-scope-select="B"]');assert.equal(checkbox.disabled,false);checkbox.click();
    container.querySelector('[data-scope-action="delete"]').click();
    assert.match(container.querySelector('[data-scope-confirm-text]').textContent,new RegExp(({local:'로컬 데이터 삭제',server:'서버 데이터 삭제',both:'둘 다 삭제'})[deleteTarget]));
    container.querySelector('[data-scope-cancel]').click();
    for(let n=0;n<100&&container.querySelector('[data-scope-refresh]').disabled;n++)await new Promise(resolve=>setTimeout(resolve,1));
   }finally{dom.window.close();}
   const catalog = await f.bridge.inspectScopeCatalog({deleteTarget}), row=catalog.rows.find(r=>r.scopeId==='B');
   const result = await f.bridge.manageScope({scopeId:'B',action:'delete',deleteTarget,expectedFingerprint:row.fingerprint});
   assert.equal(result.ok,true);assert.equal(result.deleteTarget,deleteTarget);
   assert.equal(f.values.has(ns+'.B'),deleteTarget==='server','only the selected local copy is removed');
   assert.equal(f.app.repositories[ns].get('plugin',ns+'.B').exists,deleteTarget==='local','only the selected server copy is removed');
   assert.equal(f.values.get(f.registryKey),routing,'routing bytes remain unchanged');
   assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,mode);
   assert.equal(f.values.get(ns+'.A'),'A_SOURCE');assert.equal(f.app.repositories[ns].get('plugin',ns+'.A').exists,true);
   console.log(ns+' '+mode+' '+deleteTarget+': PASS');
  } finally {await f.close();}
 }
 for(const variant of variants.filter(v=>v[0]!=='flashback'))for(const mode of ['plugin_only','server_only'])for(const firstTarget of ['local','server']){
  const f=await fixture(variant,{bridgeOptions:{scopeManagement:true}}),ns=variant[0];try{
   await f.bridge.setGlobalMode('server_only');if(mode==='plugin_only')await f.bridge.setGlobalMode(mode);
   let c=await f.bridge.inspectScopeCatalog({deleteTarget:firstTarget});await f.bridge.manageScope({scopeId:'B',action:'delete',deleteTarget:firstTarget,expectedFingerprint:c.rows.find(r=>r.scopeId==='B').fingerprint});
   c=await f.bridge.inspectScopeCatalog({deleteTarget:'both'});const result=await f.bridge.manageScope({scopeId:'B',action:'delete',deleteTarget:'both',expectedFingerprint:c.rows.find(r=>r.scopeId==='B').fingerprint});
   assert.equal(result.ok,true);assert.equal(f.values.has(ns+'.B'),false);assert.equal(f.app.repositories[ns].get('plugin',ns+'.B').exists,false);assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,mode);
   console.log(ns+' '+mode+' both with '+firstTarget+' already empty: PASS');
  }finally{await f.close();}
 }
 for(const variant of variants.filter(v=>v[0]!=='flashback'))for(const mode of ['plugin_only','server_only'])for(const deleteTarget of ['local','server']){
  const f=await fixture(variant,{bridgeOptions:{scopeManagement:true}}),ns=variant[0];try{
   await f.bridge.setGlobalMode('server_only');if(mode==='plugin_only')await f.bridge.setGlobalMode(mode);
   if(deleteTarget==='local')f.host.nativeFetch=async()=>{throw Error('SERVER_OFFLINE');};
   else f.store.setItem=f.store.removeItem=async()=>{throw Error('LOCAL_STORAGE_WRITE_UNAVAILABLE');};
   const c=await f.bridge.inspectScopeCatalog({deleteTarget}),row=c.rows.find(r=>r.scopeId==='B');
   const result=await f.bridge.manageScope({scopeId:'B',action:'delete',deleteTarget,expectedFingerprint:row.fingerprint});
   assert.equal(result.ok,true);assert.equal(f.values.has(ns+'.B'),deleteTarget==='server');assert.equal(f.app.repositories[ns].get('plugin',ns+'.B').exists,deleteTarget==='local');
   assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,mode);
   console.log(ns+' '+mode+' '+deleteTarget+' with other location unavailable: PASS');
  }finally{await f.close();}
 }
 for (const variant of variants.filter(v=>v[0]!=='flashback')) for (const mode of ['plugin_only','server_only']) {
  const f=await fixture(variant,{bridgeOptions:{scopeManagement:true}}),ns=variant[0];
  try {
   await f.bridge.setGlobalMode('server_only');if(mode==='plugin_only')await f.bridge.setGlobalMode(mode);
   const catalog=await f.bridge.inspectScopeCatalog({deleteTarget:'both'}),row=catalog.rows.find(r=>r.scopeId==='B');
   const remove=f.store.removeItem;f.store.removeItem=async key=>key===ns+'.B'?false:remove(key);
   await assert.rejects(()=>f.bridge.manageScope({scopeId:'B',action:'delete',deleteTarget:'both',expectedFingerprint:row.fingerprint}),error=>{
    assert.equal(error.deletionResult.server.ok,true);assert.equal(error.deletionResult.local.ok,false);assert.equal(error.deletionResult.partial,true);return true;
   });
   assert.equal(f.values.get(ns+'.B'),'B_SOURCE');assert.equal(f.app.repositories[ns].get('plugin',ns+'.B').exists,false);
   assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,mode);
   console.log(ns+' '+mode+' partial failure: PASS');
  }finally{await f.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
