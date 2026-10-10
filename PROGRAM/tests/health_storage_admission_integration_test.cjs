'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const health=new Function(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteHealthRecovery.source.js'),'utf8')+';return MemorySuiteHealthRecovery;')();
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
const sdkRoot=process.env.LIB_STORAGE_SDK_ROOT||path.join(__dirname,'../sdk');
async function run(owner,variant){
 const create=new Function(fs.readFileSync(path.join(sdkRoot,variant),'utf8')+';return createMemorySuiteStorageBridge;')();
 let reads=0,writes=0,readHold=null,writeHold=null,derived=true;const data=new Map();
 const store={keys:async()=>[...data.keys()],getItem:async k=>{reads++;return data.get(k)??null},setItem:async(k,v)=>{writes++;if(k==='record'&&writeHold)await writeHold.promise;data.set(k,v);return true},removeItem:async k=>{writes++;data.delete(k);return true}};
 const previous=globalThis.risuai;globalThis.risuai={pluginStorage:store,getArgument:async()=>null,setArgument:async()=>true};
 const adapter=health.localOwnerAdapter({owner,snapshot:async()=>{await readHold?.promise;return{valid:true,mode:'plugin_only',scopeKey:'s',binding:'stable',assertCurrent:()=>true,withFreshContext:async publish=>publish()}},captureCache:()=>{const captured=derived;return{matches:()=>derived===captured,invalidate:()=>{derived=false;return{changedFields:captured?1:0}},verify:()=>derived===false}}});
 const bridge=create({namespace:owner.toLowerCase(),pluginKeys:['record'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>({scopeId:'s',scopeKey:'s'}),enterOwnerOperation:()=>adapter.enterMutation()});
 const proxy=bridge.createPluginStorageProxy(store);
 try{
  const ticket=await adapter.preview();readHold=deferred();const clearing=adapter.repair(ticket);
  const actions=[()=>proxy.getItem('record'),()=>proxy.setItem('record',{}),()=>proxy.removeItem('record'),()=>proxy.keys(),()=>bridge.setMode('server_only'),()=>bridge.setGlobalMode('server_only'),()=>bridge.clearGlobalMode(),()=>bridge.setServerUrl('http://127.0.0.1:47630'),()=>bridge.startRestoreJob(),()=>bridge.startConnectionConfigurationJob({mode:'plugin_only'}),()=>bridge.resumePendingSyncJob()];
  for(const action of actions){const before={reads,writes};await assert.rejects(action,/HEALTH_OPERATION_IN_PROGRESS/);assert.deepEqual({reads,writes},before,'health rejects owner admission before any I/O')}
  readHold.resolve();assert.equal((await clearing).status,'cache_invalidated');readHold=null;
  writeHold=deferred();const pending=proxy.setItem('record',{v:1});await new Promise(setImmediate);assert(writes>0);assert.equal((await adapter.preview()).allowed,false);adapter.clear();assert.equal((await adapter.preview()).allowed,false,'clear must not abandon an in-flight physical write');writeHold.resolve();await pending;writeHold=null;assert.equal((await adapter.preview()).allowed,true);assert.deepEqual(data.get('record'),{v:1});
 }finally{readHold?.resolve();writeHold?.resolve();await bridge.dispose();globalThis.risuai=previous}
}
(async()=>{for(const owner of ['LIA','RETRACE'])for(const variant of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'])await run(owner,variant);console.log('PASS 4 owner/SDK combinations, 44 pre-I/O exclusions, physical-tail lifetime, safe admission after settlement, no model/network')})().catch(error=>{console.error(error);process.exitCode=1});
