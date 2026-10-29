'use strict';
// The pluginStorage routing table is primary. The device copy (and the server copy)
// are emergency sources: a lagging or broken device copy no longer blocks recall
// (2026-10-29: READ_ROUTE_MODE_PUBLICATION_UNAVAILABLE "conflict" after 9 retries),
// and a lost plugin copy is restored from the backup.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const ROUTE='__memory_suite_internal_scope_routes_v1__:libra', REG='libra:v1:scope-registry:v1';
const routes=mode=>JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',pluginId:'LIBRA',legacyGlobalModeImported:true,
 entries:{'registered-scope':{scopeId:'registered-scope',scopeKey:'registered-scope',mode,origin:'user_explicit',updatedAt:1}}});

async function fixture({pluginRoute,deviceRoute}){
 const chat={id:'native-chat',fmIndex:-1,message:[{role:'user',chatId:'native-u',data:'U'},{role:'char',chatId:'native-a',data:'A'}]};
 const character={chaId:'native-character',chatPage:0,chats:[chat]};
 const registry={'native-character::native-chat':{characterId:character.chaId,chatId:chat.id,scopeKey:'registered-scope'}};
 const device=new Map(deviceRoute==null?[]:[[ROUTE,deviceRoute]]);
 const deviceStore={async getItem(k){return device.has(k)?device.get(k):null;},async setItem(k,v){device.set(k,v);return true;},async removeItem(k){device.delete(k);return true;},async keys(){return [...device.keys()];}};
 const initialValues=[[REG,JSON.stringify(registry)]];if(pluginRoute!=null)initialValues.push([ROUTE,pluginRoute]);
 const r=await createLibraVmHarness({},{getLocalPluginStorage:async()=>deviceStore,safeLocalStorage:deviceStore},{initialValues,
  transformSource:source=>source.replace('  const RisuCompat = (() => {','  globalThis.__testReadBridge = MemorySuiteStorageBridge;\n  const RisuCompat = (() => {')});
 await new Promise(resolve=>setImmediate(resolve));
 r.context.risuai.getCharacter=async()=>character;
 return {r,device,issue:()=>r.api.captureReadonlySourceContext({requestId:'route-'+Math.random(),durationMs:30000}),close:()=>r.cleanup()};
}

test('recall route reads only the plugin copy; a divergent or broken device copy is ignored',async()=>{
 for(const deviceRoute of ['{broken',routes('server_only')]){
  const f=await fixture({pluginRoute:routes('plugin_only'),deviceRoute});
  try{const issued=await f.issue();assert.equal(issued.summary.route.mode,'plugin_only',deviceRoute);}finally{await f.close();}
 }
});

test('the device copy is the emergency route only when the plugin copy is missing',async()=>{
 const f=await fixture({pluginRoute:null,deviceRoute:routes('plugin_only')});
 try{const issued=await f.issue();assert.equal(issued.summary.route.mode,'plugin_only');}finally{await f.close();}
});

test('a lost plugin copy is restored from the device backup by the owner loader',async()=>{
 const f=await fixture({pluginRoute:null,deviceRoute:routes('plugin_only')});
 try{
  await f.r.context.__testReadBridge.getScopeMode({scopeId:'registered-scope',scopeKey:'registered-scope'},true);
  const started=Date.now();while(!f.r.values.has(ROUTE)&&Date.now()-started<3000)await new Promise(resolve=>setTimeout(resolve,10));
  const restored=JSON.parse(f.r.values.get(ROUTE));
  assert.equal(restored.entries['registered-scope'].mode,'plugin_only');
  assert.equal(restored.modePublication.reason,'routing_restored_device');
 }finally{await f.close();}
});
