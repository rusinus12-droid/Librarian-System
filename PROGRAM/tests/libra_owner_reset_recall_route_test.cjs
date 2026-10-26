'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

async function fixture(){
 const url='http://127.0.0.1:47630',dataInstanceId='A'.repeat(32),values=new Map(),events=[];
 const store={getItem:async key=>values.get(key)??null,setItem:async(key,value)=>{events.push('write');values.set(key,value);return true;},keys:async()=>[...values.keys()]};
 const host={pluginStorage:store,getLocalPluginStorage:async()=>store,getArgument:async key=>key==='memory_suite_server_mode'?'server_only':key==='memory_suite_server_url'?url:'',nativeFetch:async()=>{
  events.push('fetch');return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,schema:'memory-suite.storage.bootstrap.v1',token:'synthetic-only',url,version:'fixture',protocol:{major:1},namespaces:['libra'],dataInstanceId,dataIdentityContract:'memory-suite.physical-data-identity.v1',resetEpochs:{libra:2},capabilities:Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1','data-instance-binding.v1'].map(key=>[key,true]))})};}};
 const source=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.libra.source.js'),'utf8');
 const create=new Function('risuai',source+'\nreturn createMemorySuiteStorageBridge;')(host);
 const bridge=create({namespace:'libra',pluginId:'libra',startupDiagnostics:false,managementButton:false,autoMigratePlugin:false,autoMigrateLocal:false});bridge.createPluginStorageProxy(store);
 values.set('libra:v1:scope-registry:v1',JSON.stringify({'c::h':{characterId:'c',chatId:'h',scopeKey:'scope'}}));
 values.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',legacyGlobalModeImported:true,entries:{scope:{scopeId:'scope',scopeKey:'scope',mode:'server_only',origin:'user_explicit',updatedAt:1}}}));
 await bridge.bootstrap();
 const choice={schema:'memory-suite.reset-choice.v2',namespace:'libra',url,dataInstanceId,dataIdentityContract:'memory-suite.physical-data-identity.v1',dataIdentityCertified:true,resetEpochCertified:true,epoch:2,choice:'empty'};
 const key='memory_suite_reset_choice.v2.libra';
 values.set(key,JSON.stringify(choice));
 return {bridge,values,events,key,choice,input:{requestId:'owner-recall',characterId:'c',chatId:'h',durationMs:30000}};
}

test('native owner recall accepts an already certified reset choice without writes or bootstrap',async()=>{
 const f=await fixture();try{
  const before=f.events.length,route=await f.bridge.observeOwnerReadonlyRoute(f.input);
  assert.equal(route.summary.mode,'server_only');
  assert.equal((await f.bridge.assertReadonlyRouteCurrent({handle:route.handle,requestId:f.input.requestId})).status,'request-local-current');
  assert.equal(f.events.length,before,'observational read never imports, writes or bootstraps');
  await assert.rejects(()=>f.bridge.observeReadonlyRoute({...f.input,requestId:'external'}),/READ_ROUTE_RESET_UNAVAILABLE/);
  f.values.set(f.key,JSON.stringify({...f.choice,choice:'upload'}));
  await assert.rejects(()=>f.bridge.assertReadonlyRouteCurrent({handle:route.handle,requestId:f.input.requestId}),/READ_ROUTE_CHANGED/);
 }finally{await f.bridge.dispose();}
});
for(const change of [{epoch:1},{dataInstanceId:'B'.repeat(32)},{url:'http://localhost:47630'},{choice:'unknown'},{choice:'owner_scope_deleted',deletedScopeIds:['scope']}])test('unqualified or deleted-scope reset still blocks owner recall: '+JSON.stringify(change),async()=>{
 const f=await fixture();try{f.values.set(f.key,JSON.stringify({...f.choice,...change}));await assert.rejects(()=>f.bridge.observeOwnerReadonlyRoute(f.input),/READ_ROUTE_RESET_UNAVAILABLE/);}finally{await f.bridge.dispose();}
});
