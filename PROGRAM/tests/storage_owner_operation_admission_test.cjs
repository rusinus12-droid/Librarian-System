'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};
async function run(variant){
 const create=new Function(fs.readFileSync(path.join(__dirname,'../sdk',variant),'utf8')+'\nreturn createMemorySuiteStorageBridge;')();
 let applying=true,active=0,entered=0,released=0,reads=0,writes=0,hold=null;const data=new Map();
 const store={keys:async()=>[...data.keys()],getItem:async k=>{reads++;return data.get(k)??null},setItem:async(k,v)=>{writes++;if(hold&&k==='lia.record')await hold.promise;data.set(k,v);return true},removeItem:async k=>{writes++;data.delete(k);return true}};
 const old=globalThis.risuai;globalThis.risuai={pluginStorage:store,getArgument:async()=>null,setArgument:async()=>true};
 const bridge=create({namespace:'lia',pluginPrefixes:['lia.'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>({scopeId:'s',scopeKey:'s'}),enterOwnerOperation:meta=>{assert.equal(meta.namespace,'lia');if(applying)throw Object.assign(Error('HEALTH_BUSY'),{code:'HEALTH_BUSY'});active++;entered++;let done=false;return ()=>{if(!done){done=true;active--;released++}}}});
 const proxy=bridge.createPluginStorageProxy(store);
 try{
  const actions=[()=>proxy.getItem('lia.record'),()=>proxy.setItem('lia.record',{}),()=>proxy.removeItem('lia.record'),()=>proxy.keys(),()=>bridge.setMode('server_only'),()=>bridge.setGlobalMode('server_only'),()=>bridge.clearGlobalMode(),()=>bridge.setServerUrl('http://127.0.0.1:47630'),()=>bridge.startRestoreJob(),()=>bridge.startConnectionConfigurationJob({mode:'plugin_only'}),()=>bridge.resumePendingSyncJob()];
  for(const action of actions){const before={reads,writes};await assert.rejects(action,e=>e.code==='HEALTH_BUSY');assert.deepEqual({reads,writes},before,'rejection precedes all storage I/O')}
  applying=false;hold=deferred();const pending=proxy.setItem('lia.record',{v:1});await new Promise(setImmediate);assert(active>0,'physical tail must retain admission');assert(entered>released);hold.resolve();await pending;assert.equal(active,0);assert.equal(entered,released);assert.deepEqual(data.get('lia.record'),{v:1});
  const before=entered;await bridge.inspectWholeDataLocalInventory();assert.equal(entered,before,'strict inventory never enters a mutation');
 }finally{hold?.resolve();await bridge.dispose();globalThis.risuai=old}
}
(async()=>{for(const v of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'])await run(v);console.log('PASS owner health admission before I/O, job/config admission, physical-tail lifetime, both SDK variants')})().catch(e=>{console.error(e);process.exitCode=1});
