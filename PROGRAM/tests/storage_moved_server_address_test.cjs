'use strict';
// A server-backed plugin may change its server address only when the new address serves the same
// physical DATA (the server port was moved). Other DATA, an unreachable address, or an address
// change before the DATA was ever reached is still refused, and the old address is kept.
const assert=require('node:assert/strict');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const OLD='http://127.0.0.1:47631',MOVED='http://127.0.0.1:47642',OTHER='http://127.0.0.1:47643',DOWN='http://127.0.0.1:47644';
const urlKey=ns=>'__memory_suite_internal_server_url_v1__:'+ns,dataKey=ns=>'__memory_suite_internal_server_data_v1__:'+ns;
const until=async(fn,label)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('timeout '+label);};
(async()=>{
 const results=[];
 for(const variant of variants){
  const ns=variant[0];
  const other=await fixture(variant);
  // MOVED reaches the same server app (same DATA on another port); OTHER reaches a different DATA.
  const route=base=>(url,init)=>{const port=new URL(url).port;
    if(port==='47642')return base(url.replace(':47642',':47631'),init);
    if(port==='47643')return other.host.nativeFetch(url.replace(':47643',':47631'),init);
    if(port==='47644')return Promise.reject(Object.assign(Error('connect ECONNREFUSED'),{cause:{code:'ECONNREFUSED'}}));
    return base(url,init);};
  const f=await fixture(variant,{transportFactory:route});
  try{
   // Before any certified connection there is nothing to compare: a server-backed plugin cannot move.
   const fresh=await fixture(variant,{transportFactory:route,values:new Map([...f.values].filter(([k])=>k!==dataKey(ns)))});
   try{
    const registry=JSON.parse(fresh.values.get(fresh.registryKey));registry.entries.__memory_suite_global__.mode='server_only';
    fresh.values.set(fresh.registryKey,JSON.stringify(registry));fresh.values.delete(dataKey(ns));
    await assert.rejects(()=>fresh.bridge.configureConnection({url:MOVED,mode:'server_only'}),error=>error.code==='MEMORY_SUITE_SERVER_URL_IN_USE'&&error.details.reason==='server_data_unknown');
   }finally{await fresh.close();}

   await f.bridge.setGlobalMode('server_only');assert.equal(f.bridge.getSyncJob()?.status,'completed');
   await until(()=>f.values.has(dataKey(ns)),'DATA identity remembered');
   const remembered=JSON.parse(f.values.get(dataKey(ns)));
   assert.equal(remembered.schema,'memory-suite.server-data-binding.v1');assert.equal(remembered.namespace,ns);
   assert.equal(remembered.dataInstanceId,(await f.bridge.testConnection()).dataInstanceId,'the identity of the configured server is kept');

   // A probe of another server never replaces the remembered identity.
   assert.equal((await f.bridge.testConnection(OTHER)).ok,true);
   assert.deepEqual(JSON.parse(f.values.get(dataKey(ns))),remembered,'testing another address is not remembered');

   // Other DATA and an unreachable address are refused on both paths; the address stays.
   await assert.rejects(()=>f.bridge.setGlobalMode('server_only',{url:OTHER}),error=>error.code==='MEMORY_SUITE_SERVER_URL_IN_USE'&&error.details?.reason==='different_data');
   await assert.rejects(()=>f.bridge.configureConnection({url:OTHER,mode:'server_only'}),error=>error.code==='MEMORY_SUITE_SERVER_URL_IN_USE'&&error.details.reason==='different_data');
   await assert.rejects(()=>f.bridge.configureConnection({url:DOWN,mode:'server_only'}),error=>error.code==='MEMORY_SUITE_SERVER_URL_IN_USE'&&error.details.reason==='target_unreachable');
   assert.equal((await f.bridge.getConnectionSettings({force:true})).url,OLD);
   assert.deepEqual(JSON.parse(f.values.get(dataKey(ns))),remembered);

   // The same DATA on a moved port: the global apply path moves the address and keeps the data.
   await f.bridge.setGlobalMode('server_only',{url:MOVED});
   assert.equal(f.bridge.getSyncJob()?.status,'completed',JSON.stringify(f.bridge.getSyncJob()?.error||''));
   assert.equal(f.values.get(urlKey(ns)),MOVED);
   assert.equal((await f.bridge.getConnectionSettings({force:true})).url,MOVED);
   assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
   assert.equal(await f.proxy.getItem(ns+'.A'),'A_SOURCE','memory reads through the moved address');
   await f.proxy.setItem(ns+'.A','AFTER_MOVE');assert.equal(await f.proxy.getItem(ns+'.A'),'AFTER_MOVE');
   assert.deepEqual(JSON.parse(f.values.get(dataKey(ns))),remembered,'the DATA identity is unchanged by a port move');

   // And back again through the scope connection path.
   await f.bridge.configureConnection({url:OLD,mode:'server_only'});
   assert.equal(f.values.get(urlKey(ns)),OLD);assert.equal(await f.proxy.getItem(ns+'.A'),'AFTER_MOVE');
   results.push(ns);
  }finally{await f.close();await other.close();}
 }
 console.log('storage_moved_server_address_test: PASS ('+results.join(', ')+': same DATA moves, other DATA / unreachable / unknown refused, probes not remembered)');
})().catch(e=>{console.error(e);process.exitCode=1;});
