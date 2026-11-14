'use strict';
const assert = require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture, variants} = require('./storage_global_allchat_job_test.cjs');
(async () => {
 const libra=variants.find(variant=>variant[0]==='libra');
 let releaseCatalog;
 const catalogGate=new Promise(resolve=>{releaseCatalog=resolve;});
 const previewFixture=await fixture(libra,{bridgeOptions:{scopeManagement:true},catalogRead:()=>catalogGate});
 const previewDom=new JSDOM('<!doctype html><div id="host"></div>');
 try {
   const container=previewDom.window.document.getElementById('host');
   const mounted=previewFixture.bridge.mountScopeManagementPanel(container);
   try {
     for(let n=0;n<100&&!container.querySelector('[data-scope-row="B"]');n++)await new Promise(resolve=>setTimeout(resolve,5));
     const row=container.querySelector('[data-scope-row="B"]');
     assert.ok(row,'registered scope is shown while full host inventory is blocked');
     assert.match(container.querySelector('[data-scope-summary]').textContent,/등록된 스코프/);
     assert.equal(row.querySelector('[data-scope-select]').disabled,true);
     assert.equal(container.querySelector('[data-scope-action="delete"]').disabled,true);
   } finally {
     releaseCatalog({characters:[{chaId:'one',chats:[{id:'A'}]},{chaId:'two',chats:[{id:'B'},{id:'C'}]}]});
     await mounted;
   }
   assert.match(container.querySelector('[data-scope-summary]').textContent,/확인된 스코프/);
   assert.ok(container.querySelector('[data-scope-row="C"]'),'completed inventory adds unregistered scopes');
 } finally {
   previewDom.window.close();
   await previewFixture.close();
 }
 for(const variant of variants.filter(([name])=>name!=='flashback'))for(const mode of ['plugin_only','server_only']){
   const [namespace]=variant,reads=[],remoteReads=[];
   let releaseListing,hostReads=0,blockListing=false;
   const listingGate=new Promise(resolve=>{releaseListing=resolve;});
   const root=namespace+'.B',payload=namespace+'.X';
   const f=await fixture(variant,{
     readFault:key=>reads.push(key),
     catalogRead:()=>{hostReads++;return {characters:[{chaId:'one',chats:[{id:'A'}]},{chaId:'two',chats:[{id:'B'}]}]};},
     transportFactory:send=>async(url,init)=>{
       const request=new URL(url);
       if(request.pathname==='/v1/kv/keys'&&blockListing)await listingGate;
       if(request.pathname==='/v1/kv/get-many')remoteReads.push(...JSON.parse(init.body).keys);
       return send(url,init);
     },
     bridgeOptions:{
       scopeManagement:true,
       scopeListServerPrefix:namespace+'.',
       classifyScopeListKey:key=>key===root?{scopeId:'B',root:true}:null,
       scopeDataSummary:({records})=>({primary:records.find(row=>row.logicalKey===root)?.value==='B_SOURCE'?3:0,secondary:2})
     }
   });
   const dom=new JSDOM('<!doctype html><div id="host"></div>');
   try{
     if(mode==='server_only')await f.bridge.setGlobalMode(mode);
     const beforeHostReads=hostReads;
     f.values.set(payload,'PRIVATE_PAYLOAD');
     reads.length=0;remoteReads.length=0;blockListing=mode==='server_only';
     const host=dom.window.document.getElementById('host'),q=selector=>host.querySelector(selector);
     const mounted=f.bridge.mountScopeManagementPanel(host);
     try{
       for(let n=0;n<200&&!q('[data-scope-row="B"]');n++)await new Promise(resolve=>setTimeout(resolve,5));
       assert.ok(q('[data-scope-row="B"]'),'registered scope appears even while server key listing is blocked');
       assert.equal(hostReads,beforeHostReads);
       assert.equal(q('[data-scope-select="B"]').disabled,false);
       assert.equal(q('[data-scope-select="A"]').disabled,true);
     }finally{releaseListing();await mounted;}
     assert.match(q('[data-scope-row="B"] [data-scope-counts]').textContent,/3 \/ 2/);
     assert.ok(!reads.includes(payload),'the quick list never opens unrelated plugin payloads');
     if(mode==='server_only')assert.equal(remoteReads.length,1,'only the summary root is fetched from server');
     else assert.equal(remoteReads.length,0);
     assert.doesNotMatch(q('[data-scope-diagnostics-text]').value,/PRIVATE_PAYLOAD|B_SOURCE/);
     q('[data-scope-select="B"]').click();
     const deletion=q('[data-scope-action="delete"]').onclick();
     for(let n=0;n<200&&q('[data-scope-confirm]').hidden;n++)await new Promise(resolve=>setTimeout(resolve,5));
     assert.equal(q('[data-scope-confirm]').hidden,false,'an action verifies the selected row before asking for approval');
     assert.ok(hostReads>beforeHostReads);
     assert.ok(reads.includes(payload),'the existing full inspection runs on demand');
     q('[data-scope-cancel]').click();await deletion;
     console.log(namespace+' '+mode+' registry-first scope list: PASS');
   }finally{releaseListing();dom.window.close();await f.close();}
 }
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
    assert.match(container.querySelector('[data-scope-confirm-text]').textContent,new RegExp(({local:'플러그인 데이터 삭제',server:'서버 데이터 삭제',both:'둘 다 삭제'})[deleteTarget]));
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
