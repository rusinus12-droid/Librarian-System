'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const values=new Map([['__memory_suite_internal_scope_routes_v1__:retrace',JSON.stringify({schema:'memory-suite.scope-routing.v1',legacyGlobalModeImported:true,entries:{scope:{scopeId:'scope',mode:'server_only'}}})]]),writes=[];
const store={getItem:async key=>values.get(key)??null,setItem:async(key,value)=>{writes.push(key);values.set(key,value);return true},removeItem:async key=>{writes.push(key);values.delete(key);return true},keys:async()=>[...values.keys()]};
const sandbox={console,URL,TextEncoder,TextDecoder,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,fetch:globalThis.fetch,Headers,Response,crypto:globalThis.crypto,risuai:{pluginStorage:store,getLocalPluginStorage:async()=>store,getArgument:async name=>name==='memory_suite_server_mode'?'server_only':''}};sandbox.Risuai=sandbox.risuai;vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8')+'\nglobalThis.factory=createMemorySuiteStorageBridge;',sandbox);
(async()=>{const api=sandbox.factory({namespace:'retrace',pluginId:'flashback_hayaku_bridge',storagePolicy:'manager_only',currentScopeProvider:async()=>({scopeId:'scope',scopeKey:'scope'}),managementButton:false});try{
 for(const method of ['set','remove','setMode','setScopeMode','setGlobalMode','createPluginStorageProxy','startSynchronizationJob','resumePendingSyncJob'])assert.equal(api[method],undefined,'manager-only client has no own writer '+method);
 for(const method of ['managerControl','managerPortable','managerServerGet','managerListScopes','managerPlanScopeDeletion'])assert.equal(typeof api[method],'function',method+' remains');
 assert.equal(await api.getMode(),'plugin_only');assert.equal(api.getSyncJob(),null);assert.equal(writes.length,0,'old registry/ARG does not trigger migration or registry persistence');
 assert.equal(JSON.parse(values.get('__memory_suite_internal_scope_routes_v1__:retrace')).entries.scope.mode,'server_only','historical registry bytes preserved');
 console.log('retrace_manager_only_client_test: PASS (no writer/proxy/job surface; old registry preserved; manager API retained)');
}finally{await api.dispose()}})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
