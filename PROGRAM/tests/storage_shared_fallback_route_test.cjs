'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const scope={scopeId:'route-a',scopeKey:'route-a',characterId:'character-a',chatId:'chat-a',available:true};
const cases=[
 {name:'argument-only server fallback',argument:'server_only',registry:{},scopeMode:'server_only',sharedMode:'mirror'},
 {name:'plugin-only fallback',argument:'plugin_only',registry:{},scopeMode:'plugin_only',sharedMode:'plugin_only'},
 {name:'consumed legacy argument',argument:'server_only',registry:{legacyGlobalModeImported:true},scopeMode:'plugin_only',sharedMode:'plugin_only'},
 {name:'explicit global plugin-only overrides old argument',argument:'server_only',registry:{entries:{__memory_suite_global__:{scopeId:'__memory_suite_global__',scopeKey:'__memory_suite_global__',global:true,mode:'plugin_only',updatedAt:1}}},scopeMode:'plugin_only',sharedMode:'plugin_only'},
 {name:'persisted server scope',argument:'plugin_only',registry:{entries:{[scope.scopeId]:{...scope,mode:'server_only',updatedAt:1}}},scopeMode:'server_only',sharedMode:'mirror'}
];
for(const [namespace,file] of [['libra','MemorySuiteStorageClient.libra.source.js'],['flashback','MemorySuiteStorageClient.source.js'],['hayaku','MemorySuiteStorageClient.source.js']])for(const row of cases)test(namespace+': '+row.name,async()=>{
 const key='__memory_suite_internal_scope_routes_v1__:'+namespace;
 const values=new Map([[key,JSON.stringify({schema:'memory-suite.scope-routing.v1',version:1,namespace,entries:{},...row.registry})]]),before=[...values];
 let writes=0,network=0;
 const store={getItem:async k=>values.get(k)??null,setItem:async()=>{writes++;throw Error('unexpected write');}};
 const api={pluginStorage:store,getLocalPluginStorage:async()=>store,getArgument:async n=>n==='memory_suite_server_mode'?row.argument:'',nativeFetch:async()=>{network++;throw Error('unexpected network');}};
 const source=fs.readFileSync(path.join(root,'sdk',file),'utf8');
 assert.equal(source.split('  return bridge;').length,2);
 const context=vm.createContext({risuai:api,console,setTimeout,clearTimeout,TextEncoder,URL,crypto:globalThis.crypto});
 const make=vm.runInContext(source.replace('  return bridge;','  return {readScopeModeValue,normalizeRouteDescriptor};')+'\ncreateMemorySuiteStorageBridge',context);
 const bridge=make({namespace,pluginId:namespace,startupDiagnostics:false,managementButton:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>scope});
 assert.equal((await bridge.readScopeModeValue(scope)).mode,row.scopeMode);
 const shared=await bridge.normalizeRouteDescriptor({kind:'shared'},'plugin',namespace+'.registry',scope);
 assert.equal(shared.mode,row.sharedMode,'shared infrastructure must follow the same admitted fallback as scoped records');
 assert.equal(writes,0);assert.equal(network,0);assert.deepEqual([...values],before);
});
