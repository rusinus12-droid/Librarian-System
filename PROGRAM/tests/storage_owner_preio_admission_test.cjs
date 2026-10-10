'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// Explicit optional SDK callback contract; no local-health adapter is configured for core3 here.
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
const sdkRoot=process.env.LIB_STORAGE_SDK_ROOT||path.join(__dirname,'../sdk');
async function run(owner,variant){
 const create=new Function(fs.readFileSync(path.join(sdkRoot,variant),'utf8')+';return createMemorySuiteStorageBridge;')();
 let reads=0,writes=0,writeHold=null,blocked=true,active=0;const data=new Map();
 const store={keys:async()=>[...data.keys()],getItem:async k=>{reads++;return data.get(k)??null},setItem:async(k,v)=>{writes++;if(k==='record'&&writeHold)await writeHold.promise;data.set(k,v);return true},removeItem:async k=>{writes++;data.delete(k);return true}};
 const previous=globalThis.risuai;globalThis.risuai={pluginStorage:store,getArgument:async()=>null,setArgument:async()=>true};
 const enterOwnerOperation=()=>{if(blocked)throw Object.assign(Error('HEALTH_OPERATION_IN_PROGRESS'),{code:'HEALTH_OPERATION_IN_PROGRESS'});active++;let done=false;return()=>{assert.equal(done,false);done=true;active--;};};
 const bridge=create({namespace:owner.toLowerCase(),pluginKeys:['record'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>({scopeId:'s',scopeKey:'s'}),enterOwnerOperation});
 const proxy=bridge.createPluginStorageProxy(store);
 try{
  // Every attempted action must reject synchronously before reading even its internal journal.
  const actions=[()=>proxy.getItem('record'),()=>proxy.setItem('record',{}),()=>proxy.removeItem('record'),()=>proxy.keys(),()=>bridge.setMode('server_only'),()=>bridge.setGlobalMode('server_only'),()=>bridge.clearGlobalMode(),()=>bridge.setServerUrl('http://127.0.0.1:47630'),()=>bridge.startRestoreJob(),()=>bridge.startConnectionConfigurationJob({mode:'plugin_only'}),()=>bridge.resumePendingSyncJob()];
  for(const action of actions){const before={reads,writes};await assert.rejects(action,/HEALTH_OPERATION_IN_PROGRESS/);assert.deepEqual({reads,writes},before,'health rejects owner admission before any I/O')}
  blocked=false;writeHold=deferred();const pending=proxy.setItem('record',{v:1});await new Promise(setImmediate);assert(writes>0);assert(active>0,'owner admission lives through the held physical write');writeHold.resolve();await pending;writeHold=null;assert.equal(active,0,'all nested admissions release after settlement');assert.deepEqual(data.get('record'),{v:1});
 }finally{writeHold?.resolve();await bridge.dispose();globalThis.risuai=previous}
}
(async()=>{for(const owner of ['LIBRA','HAYAKU','FLASHBACK'])for(const variant of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'])await run(owner,variant);console.log('PASS 6 synthetic core3/SDK callback combinations, 66 pre-I/O exclusions, physical-tail lifetime, no model/network')})().catch(error=>{console.error(error);process.exitCode=1});
