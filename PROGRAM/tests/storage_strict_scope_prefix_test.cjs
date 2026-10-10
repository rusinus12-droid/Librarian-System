'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{let passed=0;for(const sdk of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js']){
 for(const preResolveKeyScope of [false,true])for(const strict of [false,true])for(const matching of [false,true]){
  const values=new Map([[matching?'evidence.test':'regular.test','payload']]);
  const storage={getItem:async key=>values.get(key)??null,setItem:async(key,value)=>{values.set(key,value);return true;},removeItem:async key=>values.delete(key),keys:async()=>[...values.keys()]};
  const host={pluginStorage:storage,getArgument:async name=>name.includes('url')?'http://127.0.0.1:47631':'plugin_only',nativeFetch:async()=>{throw Error('NETWORK_FORBIDDEN');}};
  const ctx=vm.createContext({risuai:host,console,setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto,AbortController,TextEncoder,TextDecoder,URL});
  vm.runInContext(fs.readFileSync(path.join(process.env.LIB_TEST_SDK_ROOT || path.join(__dirname,'../sdk'),sdk),'utf8')+'\nglobalThis.make=createMemorySuiteStorageBridge;',ctx);
  const bridge=ctx.make({namespace:'hayaku',pluginId:'hayaku_locator_continuity',managementButton:false,startupDiagnostics:false,
   pluginPrefixes:['evidence.','regular.'],preResolveKeyScope,strictPluginScopePrefixes:strict?['evidence.']:[],
   currentScopeProvider:async()=>({scopeId:'current'}),resolveKeyScope:async()=>{throw Error('SCOPE_METADATA_UNREADABLE');}});
  bridge.createPluginStorageProxy(storage);
  try{if(strict&&matching)await assert.rejects(()=>bridge.inspectNativeBranchTargetLocalData({scopeId:'current'}),/SCOPE_METADATA_UNREADABLE/);
   else assert.equal((await bridge.inspectNativeBranchTargetLocalData({scopeId:'current'})).total,1,'non-opt-in owner keeps existing fallback');passed++;}
  finally{await bridge.dispose();}
 }
}
console.log(JSON.stringify({test:'storage_strict_scope_prefix',passed,sockets:0,externalApis:0}));})().catch(e=>{console.error(e);process.exitCode=1;});
