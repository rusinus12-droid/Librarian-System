'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
function fixture(file,certified=false){
 let url='http://127.0.0.1:47630',hold=null,fail=false,nextUrlRead=null,fault=null;
 const identity=certified?{dataInstanceId:'A'.repeat(32),dataIdentityContract:'memory-suite.physical-data-identity.v1',resetEpochs:{hayaku:0}}:{};
 const caps=Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1'].map(k=>[k,true]));
 if(certified)caps['data-instance-binding.v1']=true;
 const host={async getArgument(k){const value=k==='memory_suite_server_mode'?'server_only':k==='memory_suite_server_url'?url:'';if(k==='memory_suite_server_url'&&nextUrlRead){const h=nextUrlRead;nextUrlRead=null;h.entered.resolve();await h.release.promise;}return value;},async setArgument(k,v){if(k==='memory_suite_server_url')url=v;return true;},async nativeFetch(target){
  const route=new URL(target).pathname;
  if(fault){nextUrlRead=fault;fault=null;throw new Error('network failure synthetic');}
  if(fail)throw new Error('network failure synthetic');
  if(route==='/v1/integrity'&&hold){const h=hold;hold=null;h.entered.resolve();await h.release.promise;if(h.error)throw h.error;}
  const payload=route==='/bootstrap'?{ok:true,schema:'memory-suite.storage.bootstrap.v1',token:'synthetic-only',url,version:'fixture',protocol:{major:1},namespaces:['hayaku'],capabilities:caps,...identity}:{ok:true,...identity,result:{ok:true,result:'ok',records:0}};
  return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
 }};
 const context=vm.createContext({risuai:host,console,URL,AbortController,setTimeout,clearTimeout,setInterval,clearInterval});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk',file),'utf8')+'\nglobalThis.make=createMemorySuiteStorageBridge;',context);
 const bridge=context.make({namespace:'hayaku',scopeRouting:false,autoMigratePlugin:false,autoMigrateLocal:false,startupDiagnostics:false,managementButton:false});
 return {bridge,url,holdCatch(){return fault={entered:deferred(),release:deferred()};},hold(){return hold={entered:deferred(),release:deferred()};},fail(){fail=true;}};
}
for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js']){
 test(file+': stale probe must preserve newer healthy bootstrap status',async()=>{
  const f=fixture(file),b=f.bridge;try{
   await b.bootstrap();const h=f.hold(),probe=b.testConnection(f.url);await h.entered.promise;
   const fresh=await b.bootstrap(true);const binding=JSON.stringify(b.serverBinding());assert.equal(b.status().state,'connected');
   h.release.resolve();const result=await probe;assert.equal(result.ok,false);assert.equal(result.error,'MEMORY_SUITE_CONNECTION_STALE');
   assert.equal(JSON.stringify(b.serverBinding()),binding);assert.equal(await b.bootstrap(),fresh);
   assert.equal(b.status().state,'connected','obsolete probe must not overwrite newer connected status');
  }finally{await b.dispose();}
 });
 test(file+': old failed probe cannot overwrite a newer successful bootstrap',async()=>{
  const f=fixture(file),b=f.bridge;try{await b.bootstrap();const h=f.hold(),probe=b.testConnection(f.url);await h.entered.promise;await b.bootstrap(true);h.error=new Error('network failure synthetic');h.release.resolve();assert.equal((await probe).ok,false);assert.equal(b.status().state,'connected');}finally{await b.dispose();}
 });
 for(const change of ['bootstrap','probe','dispose','url'])test(file+': catch URL await respects newer '+change,async()=>{
  const f=fixture(file,true),b=f.bridge;try{await b.bootstrap();const h=f.holdCatch(),pending=b.testConnection(f.url);await h.entered.promise;
   if(change==='bootstrap')await b.bootstrap(true);else if(change==='probe')assert.equal((await b.testConnection(f.url)).ok,true);else if(change==='dispose')await b.dispose();else await b.setServerUrl('http://localhost:47630');
   const status=JSON.stringify(b.status()),binding=JSON.stringify(b.serverBinding());h.release.resolve();assert.equal((await pending).ok,false);assert.equal(JSON.stringify(b.status()),status);assert.equal(JSON.stringify(b.serverBinding()),binding);
  }finally{await b.dispose();}
 });
 test(file+': current certified genuine probe failure reports unavailable',async()=>{
  const f=fixture(file,true),b=f.bridge;try{await b.bootstrap();assert.equal(b.serverBinding().certified,true);f.fail();assert.equal((await b.testConnection(f.url)).ok,false);assert.equal(b.status().state,'unavailable');}finally{await b.dispose();}
 });
 test(file+': current genuine probe transport failure reports unavailable',async()=>{
  const f=fixture(file),b=f.bridge;try{await b.bootstrap();f.fail();const result=await b.testConnection(f.url);assert.equal(result.ok,false);assert.equal(result.error,'memory_suite_server_unavailable');assert.equal(b.status().state,'unavailable');}finally{await b.dispose();}
 });
}
