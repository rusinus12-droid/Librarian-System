'use strict';
// RisuAI API v3 serializes getLocalPluginStorage() as a remote instance, so the
// guest receives a NEW proxy on every call. Owner recall fences compare storage
// providers by identity; they must stay current across such re-reads.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

async function fixture(sourceFile=path.join(__dirname,'../sdk/MemorySuiteStorageClient.libra.source.js')){
 const url='http://127.0.0.1:47630',dataInstanceId='A'.repeat(32),values=new Map();let localCalls=0;
 const store={getItem:async key=>values.get(key)??null,setItem:async(key,value)=>{values.set(key,value);return true;},keys:async()=>[...values.keys()]};
 const freshProxy=()=>{localCalls++;return {getItem:(...a)=>store.getItem(...a),setItem:(...a)=>store.setItem(...a),keys:()=>store.keys()};};
 const host={pluginStorage:store,getLocalPluginStorage:async()=>freshProxy(),getArgument:async key=>key==='memory_suite_server_mode'?'server_only':key==='memory_suite_server_url'?url:'',nativeFetch:async()=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true,schema:'memory-suite.storage.bootstrap.v1',token:'synthetic-only',url,version:'fixture',protocol:{major:1},namespaces:['libra'],dataInstanceId,dataIdentityContract:'memory-suite.physical-data-identity.v1',resetEpochs:{libra:2},capabilities:Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','scope-catalog.v1'].map(name=>[name,true]))})})};
 const source=fs.readFileSync(sourceFile,'utf8');
 const create=new Function('risuai',source+'\nreturn createMemorySuiteStorageBridge;')(host);
 const bridge=create({namespace:'libra',pluginId:'libra',startupDiagnostics:false,managementButton:false,autoMigratePlugin:false,autoMigrateLocal:false});bridge.createPluginStorageProxy(store);
 values.set('libra:v1:scope-registry:v1',JSON.stringify({'c::h':{characterId:'c',chatId:'h',scopeKey:'scope'}}));
 values.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',legacyGlobalModeImported:true,entries:{scope:{scopeId:'scope',scopeKey:'scope',mode:'server_only',origin:'user_explicit',updatedAt:1}}}));
 return {bridge,values,localCalls:()=>localCalls,input:{requestId:'owner-recall',characterId:'c',chatId:'h',durationMs:30000}};
}

test('owner recall route stays current when every getLocalPluginStorage() call returns a new proxy',async()=>{
 const f=await fixture();try{
  const route=await f.bridge.observeOwnerReadonlyRoute(f.input);
  assert.equal(route.summary.mode,'server_only');
  assert.equal((await f.bridge.assertReadonlyRouteCurrent({handle:route.handle,requestId:f.input.requestId})).status,'request-local-current');
  assert.ok(f.localCalls()>=1,'host local storage is still read');
 }finally{await f.bridge.dispose();}
});

test('a real route change is still detected with per-call proxies',async()=>{
 const f=await fixture();try{
  const route=await f.bridge.observeOwnerReadonlyRoute(f.input);
  const routes=JSON.parse(f.values.get('__memory_suite_internal_scope_routes_v1__:libra'));routes.entries.scope.updatedAt=2;
  f.values.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify(routes));
  await assert.rejects(()=>f.bridge.assertReadonlyRouteCurrent({handle:route.handle,requestId:f.input.requestId}),/READ_ROUTE_CHANGED/);
 }finally{await f.bridge.dispose();}
});
