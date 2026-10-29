'use strict';
// Shared storage client (HAYAKU, Flashback, RETRACE, GRADIA): the pluginStorage routing
// table is primary; the device copy is an emergency source that restores it.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROUTE='__memory_suite_internal_scope_routes_v1__:flashback';
const A={scopeId:'scope:alpha',scopeKey:'scope:alpha',label:'Alpha'};
const store=(entries={})=>{const map=new Map(Object.entries(entries));return {map,
 async getItem(k){return map.has(String(k))?map.get(String(k)):null;},async setItem(k,v){map.set(String(k),v);return true;},
 async removeItem(k){map.delete(String(k));return true;},async keys(){return [...map.keys()];}};};
const routes=(mode,updatedAt)=>JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'flashback',legacyGlobalModeImported:true,
 entries:{[A.scopeId]:{...A,mode,origin:'user_explicit',updatedAt}}});

async function bridgeWith(pluginEntries,deviceEntries){
 const plugin=store(pluginEntries),device=store(deviceEntries),previous=globalThis.risuai;
 globalThis.risuai={pluginStorage:plugin,async getLocalPluginStorage(){return device;},
  async getArgument(name){return name==='memory_suite_server_mode'?'plugin_only':'';},async setArgument(){return true;},
  async nativeFetch(){throw new Error('offline');}};
 const sdk=fs.readFileSync(path.join(__dirname,'..','sdk','MemorySuiteStorageClient.source.js'),'utf8');
 const bridge=new Function(`${sdk}\nreturn createMemorySuiteStorageBridge;`)()({namespace:'flashback',pluginId:'vector_rag_memory',pluginVersion:'test',
  managementButton:false,migrationDelayMs:100000,startupDiagnostics:false,currentScopeProvider:async()=>A,resolveKeyScope:async()=>({kind:'global'})});
 return {bridge,plugin,device,close:async()=>{try{await bridge.dispose?.();}finally{globalThis.risuai=previous;}}};
}

test('a newer device copy does not override the pluginStorage routing table',async()=>{
 const f=await bridgeWith({[ROUTE]:routes('plugin_only',1)},{[ROUTE]:routes('server_only',5)});
 try{const mode=await f.bridge.getScopeMode(A,true);assert.equal(mode?.mode??mode,'plugin_only');}finally{await f.close();}
});

test('a lost pluginStorage table is restored from the device backup',async()=>{
 const f=await bridgeWith({},{[ROUTE]:routes('plugin_only',3)});
 try{
  const mode=await f.bridge.getScopeMode(A,true);assert.equal(mode?.mode??mode,'plugin_only');
  const started=Date.now();while(!f.plugin.map.has(ROUTE)&&Date.now()-started<3000)await new Promise(resolve=>setTimeout(resolve,10));
  const restored=JSON.parse(f.plugin.map.get(ROUTE));
  assert.equal(restored.entries[A.scopeId].mode,'plugin_only');
  if(restored.modePublication)assert.equal(restored.modePublication.reason,'routing_restored_device');
 }finally{await f.close();}
});

test('the routing writer succeeds on pluginStorage even when the device backup write fails',async()=>{
 const f=await bridgeWith({[ROUTE]:routes('plugin_only',1)},{});
 f.device.setItem=async()=>{throw new Error('device write failed');};
 try{
  await f.bridge.setScopeMode(A,'plugin_only');
  assert.equal(JSON.parse(f.plugin.map.get(ROUTE)).entries[A.scopeId].mode,'plugin_only');
 }finally{await f.close();}
});

test('every embedded client copy carries the same primary-copy rule',()=>{
 for(const name of ['HAYAKU_Locator_Continuity.js','Flashback_Memory.js','RETRACE.js','GRADIA.js','LIBRA.js','LIA_Persona_Linker.js']){
  const source=fs.readFileSync(path.join(__dirname,'..','plugins',name),'utf8');
  assert.match(source,/const registry = mergeScopeRegistries\(pluginRaw \|\| deviceRaw \|\| serverRaw\);/,name);
  assert.match(source,/const success = pluginStore\?\.setItem \? pluginSuccess : deviceSuccess;/,name);
  assert.match(source,/const scheduleScopeRegistryRestore = /,name);
 }
});
