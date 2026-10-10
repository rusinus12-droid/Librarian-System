'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve}};
(async()=>{
 for(const variant of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'])for(const phase of ['transport','body']){
  const create=new Function(fs.readFileSync(path.join(__dirname,'../sdk',variant),'utf8')+';return createMemorySuiteStorageBridge;')();const tail=defer();let active=0,settled=false,calls=0;const old=globalThis.risuai;
  const store={getItem:async()=>null,setItem:async()=>true,keys:async()=>[]};const response={ok:false,status:503,text:()=>tail.promise.then(v=>{settled=true;return v})};
  globalThis.risuai={pluginStorage:store,getArgument:async()=>null,nativeFetch:()=>{calls++;return phase==='transport'?tail.promise.then(v=>{settled=true;return v}):Promise.resolve(response)}};
  const bridge=create({namespace:'lia',pluginKeys:['record'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,bootstrapRequestTimeoutMs:750,enterOwnerOperation:()=>{active++;return()=>active--}});bridge.createPluginStorageProxy(store);
  try{const result=await bridge.testConnection('http://127.0.0.1:47630');await new Promise(setImmediate);assert.equal(result.ok,false);assert.equal(calls,1);assert.equal(settled,false);assert(active>0,phase+' timeout must retain physical owner admission');tail.resolve(phase==='transport'?{ok:false,status:503,data:{ok:false,error:'offline'}}:'{"ok":false,"error":"offline"}');await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(active,0)}finally{tail.resolve({ok:false,status:503,data:{ok:false,error:'offline'}});await new Promise(setImmediate);await bridge.dispose();globalThis.risuai=old}
 }
 // Invoke the real internal transport function from the full SDK solely to
 // cover cleanup transport and the existing strict diagnostic bypass.
 const source=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8').replace('  return bridge;','  return {bridge,fetchJson};');
 let active=0,deny=false;const tail=defer();const create=new Function(source+';return createMemorySuiteStorageBridge;')();const out=create({namespace:'flashback',managementButton:false,startupDiagnostics:false,enterOwnerOperation:()=>{if(deny)throw Error('HEALTH_BUSY');active++;return()=>active--}});
 await assert.rejects(()=>out.fetchJson('http://127.0.0.1:47630',{},'cleanup',250,()=>tail.promise),e=>e.code==='MEMORY_SUITE_TIMEOUT');assert(active>0);tail.resolve({data:{ok:true}});await new Promise(setImmediate);assert.equal(active,0);deny=true;assert.equal((await out.fetchJson('http://127.0.0.1:47630',{},'strict diagnostic',250,async()=>({data:{ok:true}}),true)).ok,true);assert.equal(active,0);await out.bridge.dispose();
 console.log('PASS raw transport/body and cleanup tails outlive logical timeout; strict read-only diagnostic bypass preserved');
})().catch(e=>{console.error(e);process.exitCode=1});
