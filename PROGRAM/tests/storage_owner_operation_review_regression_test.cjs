'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve}};
const sourceFor=variant=>fs.readFileSync(path.join(__dirname,'../sdk',variant),'utf8');
const createFor=variant=>new Function(sourceFor(variant)+';return createMemorySuiteStorageBridge;')();
async function rejectedPaths(variant){
 const create=createFor(variant);let reads=0,writes=0,net=0,entered=0;const data=new Map();
 const store={keys:async()=>[...data.keys()],getItem:async k=>{reads++;return data.get(k)??null},setItem:async(k,v)=>{writes++;data.set(k,v);return true},removeItem:async()=>{writes++;return true}};
 const old=globalThis.risuai;globalThis.risuai={pluginStorage:store,getArgument:async()=>null,setArgument:async()=>true,nativeFetch:async()=>{net++;throw Error('NETWORK_FORBIDDEN')}};
 const bridge=create({namespace:'lia',pluginKeys:['record'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>({scopeId:'s',scopeKey:'s'}),enterOwnerOperation:()=>{entered++;throw Object.assign(Error('HEALTH_BUSY'),{code:'HEALTH_BUSY'})}});bridge.createPluginStorageProxy(store);
 try{
  const cases=[['retire',()=>bridge.retireNativeBranchLocalTargetData({scope:{scopeId:'s'},keys:[]})],['delete_prepare',()=>bridge.prepareServerScopeDeletion({scopeId:'s'})],['reset',()=>bridge.acceptServerReset('empty')],['bootstrap',()=>bridge.bootstrap()],['connection_probe',()=>bridge.testConnection()],['manager_connection',()=>bridge.managerConnection()],['manager_reset',()=>bridge.managerExecuteReset({})],['handoff',()=>bridge.ensureHandoffReady({scope:{scopeId:'s'}})]];
  for(const [name,action] of cases){const before={reads,writes,net};await assert.rejects(action,e=>e.code==='HEALTH_BUSY',name+' must enter owner gate');assert.deepEqual({reads,writes,net},before,name+' must stop before physical access')}
 }finally{await bridge.dispose();globalThis.risuai=old}
}
async function terminalPhysicalTail(variant){
 const create=createFor(variant);let active=0,entered=0,released=0,held=false;const tail=defer(),data=new Map();let terminal;
 const store={keys:async()=>[...data.keys()],getItem:async k=>data.get(k)??null,setItem:async(k,v)=>{let row;try{row=JSON.parse(v)}catch{}if(['completed','failed','cancelled'].includes(row?.status)){held=true;terminal=row.status;await tail.promise}data.set(k,v);return true},removeItem:async k=>{data.delete(k);return true}};
 const old=globalThis.risuai;globalThis.risuai={pluginStorage:store,getArgument:async()=>null,setArgument:async()=>true,nativeFetch:async()=>{throw Error('NETWORK_FORBIDDEN')}};
 const bridge=create({namespace:'lia',pluginKeys:['record'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>({scopeId:'s',scopeKey:'s'}),enterOwnerOperation:()=>{active++;entered++;let done=false;return()=>{if(!done){done=true;active--;released++}}}});bridge.createPluginStorageProxy(store);
 try{const job=await bridge.startConnectionConfigurationJob({mode:'plugin_only'});await bridge.waitForSyncJob(job.jobId,1000);await new Promise(setImmediate);await new Promise(setImmediate);assert(held,'holds an actual physical terminal-job write');assert.equal(terminal,'completed');assert(active>0,'terminal UI must not release the gate while physical persistence is unresolved');assert(entered>released);tail.resolve();await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(active,0);assert.equal(entered,released)}finally{tail.resolve();await bridge.dispose();globalThis.risuai=old}
}
(async()=>{for(const variant of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js']){await rejectedPaths(variant);await terminalPhysicalTail(variant)}console.log('PASS review regressions: eight mutating entry refusals and detached terminal persistence lifetime, both full SDK variants')})().catch(e=>{console.error(e);process.exitCode=1});
