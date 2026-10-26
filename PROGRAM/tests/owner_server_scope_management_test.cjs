'use strict';
const assert=require('node:assert/strict');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
(async()=>{
 for(const variant of variants.filter(row=>row[0]!=='flashback')){
  const f=await fixture(variant,{bridgeOptions:{scopeManagement:true}}),ns=variant[0];
  try{
   await f.bridge.setGlobalMode('server_only');
   const before=await f.bridge.inspectScopeCatalog(),row=before.rows.find(r=>r.scopeId==='B');
   assert.equal(row.canDelete,true);
   const result=await f.bridge.manageScope({scopeId:'B',action:'delete',expectedFingerprint:row.fingerprint});
   assert.equal(result.localPreserved,true);assert.ok(result.backupId);
   assert.equal(f.app.repositories[ns].get('plugin',ns+'.B').exists,false);
   assert.equal(f.values.get(ns+'.B'),'B_SOURCE');
   assert.equal(f.app.repositories[ns].get('plugin',ns+'.A').exists,true);
   assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,'plugin_only');
   console.log(ns+': server scope copy deleted, local source and other scope preserved');
   assert.ok(!f.calls.some(call=>call.path==='/v1/manager/scope-delete/execute'),'uses owner-scoped authority');

  }finally{await f.close();}
 }
 for(const variant of variants.filter(row=>row[0]!=='flashback'))for(const scenario of ['pinned','referenced','navigation']){
  const f=await fixture(variant,{bridgeOptions:{scopeManagement:true}}),ns=variant[0];
  try{
   await f.bridge.setGlobalMode('server_only');
   if(scenario!=='navigation'){
    const call=f.host.nativeFetch,base='http://127.0.0.1:47631';
    const boot=await (await call(base+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'flashback_hayaku_bridge'}})).json();
    const headers={Authorization:'Bearer '+boot.token,'X-Memory-Suite-Plugin':'flashback_hayaku_bridge','Content-Type':'application/json'};
    let r=await call(base+'/v1/manager/scopes/index',{method:'POST',headers,body:JSON.stringify({namespace:ns,scopes:[{scopeId:'B',scopeKey:'B',baseClassification:'active',coverageComplete:true,members:[{space:'plugin',key:ns+'.B'}]},...(scenario==='referenced'?[{scopeId:'A',scopeKey:'A',baseClassification:'active',coverageComplete:true,members:[],links:[{targetRef:'B',kind:'predecessor'}]}]:[])]})});assert.equal(r.status,200);
    if(scenario==='pinned')r=await call(base+'/v1/manager/scope-pin',{method:'POST',headers,body:JSON.stringify({namespace:ns,scopeId:'B',pinned:true})});assert.equal(r.status,200);
   }else{
    const fetch=f.host.nativeFetch;f.host.nativeFetch=async(u,i)=>{const r=await fetch(u,i);if(u.endsWith('/scope-copy-delete/plan'))f.setCurrent('C');return r;};
   }
   const c=await f.bridge.inspectScopeCatalog(),row=c.rows.find(r=>r.scopeId==='B');
   await assert.rejects(()=>f.bridge.manageScope({scopeId:'B',action:'delete',expectedFingerprint:row.fingerprint}),scenario==='pinned'?/pinned/:scenario==='referenced'?/referenced_ancestor/:/context_changed/);
   assert.equal(f.app.repositories[ns].get('plugin',ns+'.B').exists,true);
   assert.equal(f.values.get(ns+'.B'),'B_SOURCE');
   console.log(ns+': '+scenario+' blocks deletion');
  }finally{await f.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
