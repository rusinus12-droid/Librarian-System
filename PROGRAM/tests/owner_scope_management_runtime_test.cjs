'use strict';
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let n=0;n<500;n++){if(fn())return;await delay(10);}throw Error('scope manager did not settle');}
const deadline=setTimeout(()=>{throw Error('scope management regression timeout');},60000);
(async()=>{
 for(const variant of variants.filter(row=>row[0]!=='flashback')){
  const f=await fixture(variant,{bridgeOptions:{scopeManagement:true}}),ns=variant[0],key=ns+'.B';
  try{
   const before=[...f.values];let c=await f.bridge.inspectScopeCatalog();
   assert.deepEqual([...f.values],before,'opening inventory is read-only');assert.equal(c.rows.length,3);
   assert.equal(c.rows.find(row=>row.scopeId==='A').current,true);assert.equal(c.rows.find(row=>row.scopeId==='B').current,false);
   assert.ok(!JSON.stringify(c).includes('B_SOURCE'),'catalog never contains memory bodies');
   const request=(catalog,id,action)=>({scopeId:id,action,expectedFingerprint:catalog.rows.find(row=>row.scopeId===id).fingerprint});
   await assert.rejects(()=>f.bridge.manageScope({scopeId:'missing',action:'sync',expectedFingerprint:'forged'}),/MANAGEMENT_CHANGED/);
   const stale=request(c,'B','sync');f.values.set(key,'B_NEW');await assert.rejects(()=>f.bridge.manageScope(stale),/MANAGEMENT_CHANGED/);f.values.set(key,'B_SOURCE');
   c=await f.bridge.inspectScopeCatalog();const result=await f.bridge.manageScope(request(c,'B','sync'));assert.equal(result.ok,true);
   assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,'plugin_only','copy never changes authority');
   await assert.rejects(()=>f.bridge.deletePluginStorageAfterServerVerification({scope:{scopeId:'B',scopeKey:'B'},preserveMode:true}),/MANAGEMENT_REQUIRES_SERVER_ONLY/);
   assert.equal(f.values.get(key),'B_SOURCE','retained-policy cleanup cannot erase a plugin-only original');
   let server=f.app.repositories[ns].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all();
   assert.ok(server.some(row=>row.key===key&&JSON.parse(row.value_json)==='B_SOURCE'));
   assert.ok(!server.some(row=>row.key===ns+'.A'),'only the selected scope is copied');assert.equal(f.values.get(ns+'.A'),'A_SOURCE');
   f.values.set(key,'B_CONFLICT');c=await f.bridge.inspectScopeCatalog();
   await assert.rejects(()=>f.bridge.manageScope(request(c,'B','sync')),/scope_sync_incomplete/);
   assert.equal(f.values.get(key),'B_CONFLICT');server=f.app.repositories[ns].database.prepare('SELECT key,value_json FROM kv WHERE key=?').get(key);assert.equal(JSON.parse(server.value_json),'B_SOURCE');f.values.set(key,'B_SOURCE');
   await f.bridge.setGlobalMode('server_only');c=await f.bridge.inspectScopeCatalog();const registry=f.values.get(f.registryKey);
   await assert.rejects(()=>f.bridge.manageScope(request(c,'A','cleanup')),/CLEANUP_BLOCKED/);
   const cleaned=await f.bridge.manageScope(request(c,'B','cleanup'));assert.equal(cleaned.deleted,1);assert.equal(f.values.has(key),false);assert.equal(f.values.get(ns+'.A'),'A_SOURCE');
   assert.equal(f.values.get(f.registryKey),registry,'cleanup preserves the global and per-scope policy');
   c=await f.bridge.inspectScopeCatalog();const restored=await f.bridge.manageScope(request(c,'B','restore'));assert.equal(restored.restored,1);assert.equal(f.values.get(key),'B_SOURCE');
   assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,'server_only');
   console.log('PASS '+ns+': full catalog, selected copy, conflicts, stale requests, current-scope protection, cleanup and restore');
  }finally{await f.close();}
  const values=new Map(Array.from({length:337},(_,i)=>[ns+'.'+(i===0?'A':i===1?'B':'K'+i),'PRIVATE_BODY_'+i]));values.set(ns+'.ORPHAN','PRIVATE_ORPHAN');
  const catalog={characters:[{chaId:'one',name:'<img src=x onerror=bad>',chats:Array.from({length:337},(_,i)=>({id:i===0?'A':i===1?'B':'K'+i,name:'Chat '+i}))}]};
  const g=await fixture(variant,{values,catalog,bridgeOptions:{scopeManagement:true}}),dom=new JSDOM('<!doctype html><div id="host"></div>');
  try{
   const host=dom.window.document.getElementById('host');await g.bridge.mountScopeManagementPanel(host);
   const q=selector=>host.querySelector(selector);assert.match(q('[data-scope-summary]').textContent,/338/);
   assert.equal(host.querySelectorAll('[data-scope-row]').length,50,'bounded rendering does not cap the inventory');assert.equal(host.querySelectorAll('img').length,0,'native labels are escaped');
   q('[data-scope-filter]').value='detached';q('[data-scope-filter]').dispatchEvent(new dom.window.Event('change'));
   assert.equal(host.querySelectorAll('[data-scope-row]').length,1);assert.equal(q('[data-scope-row]').getAttribute('data-scope-row'),'ORPHAN');
   q('[data-scope-filter]').value='all';q('[data-scope-search]').value='K336';q('[data-scope-search]').dispatchEvent(new dom.window.Event('input'));
   assert.equal(host.querySelectorAll('[data-scope-row]').length,1,'search includes scopes beyond the first page');
   q('[data-scope-select-all]').checked=true;q('[data-scope-select-all]').dispatchEvent(new dom.window.Event('change'));assert.match(q('[data-scope-selection]').textContent,/1/);
   const pending=q('[data-scope-action="sync"]').onclick();await until(()=>q('[data-scope-confirm]').hidden===false);
   q('[data-scope-cancel]').click();await pending;assert.equal(g.values.get(ns+'.K336'),'PRIVATE_BODY_336');
   const json=q('[data-scope-diagnostics-text]').value;assert.ok(!json.includes('PRIVATE_BODY_'));
   g.host.getDatabase=async()=>{throw Error('HOST_UNAVAILABLE');};
   q('[data-scope-refresh]').click();await until(()=>!q('[data-scope-refresh]').disabled);
   assert.match(q('[data-scope-summary]').textContent,/미완료/);assert.ok(!JSON.parse(q('[data-scope-diagnostics-text]').value).rows.some(row=>row.canManage));
   g.context.crypto=undefined;const readOnly=await g.bridge.inspectScopeCatalog();
   assert.equal(readOnly.rows.length,338,'missing WebCrypto still permits viewing all local scopes');
   assert.ok(readOnly.blockers.some(row=>row.code==='scope_catalog_read_only_crypto_unavailable'));
   assert.ok(readOnly.rows.every(row=>!row.canManage&&!row.fingerprint),'unfingerprinted inventory cannot authorize a write');
   console.log('PASS '+ns+': 338 scopes, pagination, search, orphan filter, escaped names, cancellation and unavailable inventory');
  }finally{dom.window.document.getElementById('host').remove();dom.window.close();await g.close();}
 }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
