'use strict';
// Public SDK aggregate path, synthetic owner adapter, existing in-process handlers.
// No sockets, external network, host permission grants, or model calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=process.env.LIB_TEST_PROGRAM_ROOT||path.resolve(__dirname,'..');
const {createMemorySuiteServer}=require(path.join(root,'server/server.cjs'));
const transport=require('./helpers/inprocess-review-transport.cjs');
const variants=[['hayaku','hayaku_locator_continuity','MemorySuiteStorageClient.source.js'],['flashback','flashback_memory','MemorySuiteStorageClient.source.js'],['libra','libra','MemorySuiteStorageClient.libra.source.js']];
const clone=x=>JSON.parse(JSON.stringify(x));
async function fixture([namespace,pluginId,sdk],opts={}){
 const app=opts.app||createMemorySuiteServer({dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'allchat-job-')),autoBackup:false,computeEnabled:false});
 const registryKey=`__memory_suite_internal_scope_routes_v1__:${namespace}`;
 const registry={schema:'memory-suite.scope-routing.v1',namespace,legacyGlobalModeImported:true,globalMigrationRemoteHistory:false,entries:{__memory_suite_global__:{scopeId:'__memory_suite_global__',mode:'plugin_only',origin:'user_explicit'},A:{scopeId:'A',scopeKey:'A',characterId:'one',chatId:'A',mode:'plugin_only',origin:'user_explicit'},B:{scopeId:'B',scopeKey:'B',characterId:'two',chatId:'B',mode:'plugin_only',origin:'inherited'}}};
 const values=opts.values||new Map([[registryKey,JSON.stringify(registry)],[namespace+'.A','A_SOURCE'],[namespace+'.B','B_SOURCE']]);
 const calls=[],writes=[];
 const store={getItem:async k=>{if(opts.readFault)await opts.readFault(k);return values.get(k)??null;},setItem:async(k,v)=>{if(opts.writeFault)await opts.writeFault(k,v);writes.push(k);values.set(k,v);return true;},removeItem:async k=>{writes.push(k);values.delete(k);return true;},keys:async()=>[...values.keys()]};
 const catalog=opts.catalog||{characters:[{chaId:'one',chats:[{id:'A'}]},{chaId:'two',chats:[{id:'B'},{id:'C'}]}]};
 const argumentsMap=new Map([['memory_suite_server_url',opts.url||'http://127.0.0.1:47631']]);
 const host={pluginStorage:store,getArgument:async k=>k.includes('url')?(argumentsMap.get(k)||'http://127.0.0.1:47631'):'plugin_only',setArgument:async(k,v)=>{argumentsMap.set(k,v);return true;},nativeFetch:opts.transportFactory?opts.transportFactory(transport(app,calls)):opts.transport||transport(app,calls),getDatabase:async()=>opts.catalogRead?await opts.catalogRead():clone(catalog)};
 if(opts.noHost)delete host.getDatabase;
 let current=opts.current===undefined?'A':opts.current;
 const context=vm.createContext({risuai:host,console,setTimeout,clearTimeout,setInterval,clearInterval,crypto:globalThis.crypto,AbortController,URL,TextEncoder,TextDecoder,structuredClone});
 vm.runInContext(fs.readFileSync(opts.sdkSource||path.join(root,'sdk',sdk),'utf8')+'\nglobalThis.factory=createMemorySuiteStorageBridge;',context);
 const adapter=async({hostScopes,registries,records})=>{
  const map=new Map(hostScopes.map(s=>[s.chatId,{...s,scopeId:s.chatId,scopeKey:s.chatId}]));
  for(const r of registries)for(const row of Object.values(r.entries||{}))if(row.scopeId!=='__memory_suite_global__'&&!row.removed)map.set(row.scopeId,{...map.get(row.scopeId),...row});
  const classified=records.map(r=>({...r,classification:'scope',scopeId:r.scopeId||r.logicalKey.slice(namespace.length+1)}));
  for(const r of classified)if(!map.has(r.scopeId))map.set(r.scopeId,{scopeId:r.scopeId,scopeKey:r.scopeId});
  return {scopes:[...map.values()],records:classified,blockers:[],completeKnownScopes:true};
 };
 const bridge=context.factory({namespace,pluginId,pluginVersion:'allchat-test',managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,pluginPrefixes:[namespace+'.'],currentScopeProvider:async()=>({scopeId:current,scopeKey:current}),resolveKeyScope:async({key})=>({kind:'scope',scopeId:key.slice(namespace.length+1),scopeKey:key.slice(namespace.length+1)}),discoverGlobalScopes:opts.adapter||adapter,allowEmptyRestore:true,...opts.bridgeOptions});
 const proxy=bridge.createPluginStorageProxy(store);
 return {bridge,app,values,calls,writes,host,store,proxy,context,registryKey,setCurrent:v=>{current=v;},close:async()=>{await bridge.dispose();if(!opts.app)app.server.emit('close');}};
}
async function run(){
 for(const variant of variants){
  const f=await fixture(variant);
  try{
   const before=[...f.values.entries()];
   assert.equal(typeof f.bridge.previewGlobalMode,'function','strict all-chat preview is public');
   const preview=await f.bridge.previewGlobalMode('server_only');
   assert.equal(preview.completeKnownScopes,true);assert.equal(preview.discoveredScopes,3,'all characters/inactive chats, not only active/registry followers');
   assert.deepEqual([...f.values.entries()],before,'preview does not mutate local routing or data');
   const result=await f.bridge.setGlobalMode('server_only');
   assert.equal(result.completeKnownScopes,true);assert.equal(result.verifiedScopes,3);assert.equal(result.failed.length,0);
   for(const id of ['A','B','C']){const mode=await f.bridge.getScopeMode({scopeId:id});assert.equal(mode.mode,'server_only');assert.equal(mode.explicit,false,'legacy override retires only after verification');}
   assert.equal((await f.bridge.getScopeMode({scopeId:'NEW'})).mode,'server_only');
   const rows=f.app.repositories[variant[0]].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all();
   for(const id of ['A','B'])assert(rows.some(r=>r.key.startsWith(variant[0]+'.'+id)&&JSON.parse(r.value_json)===id+'_SOURCE'));
   assert.equal(f.values.get(variant[0]+'.A'),'A_SOURCE');
   assert.equal(f.bridge.getSyncJob().status,'completed');
   console.log('PASS '+variant[0]+' complete all-chat forward and override retirement');
  }finally{await f.close();}
  const blocked=await fixture(variant,{noHost:true});
  try{const before=[...blocked.values.entries()];await assert.rejects(()=>blocked.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE');assert.deepEqual([...blocked.values.entries()],before);console.log('PASS '+variant[0]+' unavailable host blocks before effects');}finally{await blocked.close();}
 }
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture,variants,run};
