'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const owners=['libra','hayaku','flashback','lia','retrace'];
function fixture(owner,mutate){
 const source=fs.readFileSync(path.join(__dirname,'../sdk',owner==='libra'?'MemorySuiteStorageClient.libra.source.js':'MemorySuiteStorageClient.source.js'),'utf8');
 const create=new Function(source+'\nreturn createMemorySuiteStorageBridge;')();
 const data=new Map([[owner+'.inactive::memory-suite-scope:v1:never-opened',{text:'inactive'}],[owner+'.orphan',{text:'orphan'}],[owner+'.global',{text:'global'}],['foreign.secret','not-owned']]);
 let writes=0,network=0,current=0,reads=0;
 const store={getItem:async k=>{if(mutate)mutate(data,k,++reads);return data.has(k)?data.get(k):null},keys:async()=>[...data.keys()],setItem:async()=>{writes++;throw Error('WRITE')},removeItem:async()=>{writes++;throw Error('DELETE')}};
 const old=globalThis.risuai;globalThis.risuai={pluginStorage:store,getArgument:async()=>{throw Error('ARGUMENT_READ')},nativeFetch:async()=>{network++;throw Error('NETWORK')}};
 const bridge=create({namespace:owner,pluginPrefixes:[owner+'.'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>{current++;throw Error('ACTIVE_SCOPE')}});
 bridge.createPluginStorageProxy(store);
 return {bridge,data,store,counts:()=>({writes,network,current}),close:async()=>{await bridge.dispose();globalThis.risuai=old}};
}
(async()=>{let groups=0;
 for(const owner of owners){const f=fixture(owner);try{
  assert.equal(typeof f.bridge.inspectWholeDataLocalInventory,'function','SDK physical inventory entry point must exist');
  const out=await f.bridge.inspectWholeDataLocalInventory();assert.equal(out.owner,owner);assert.equal(out.inventoryComplete,true);assert.equal(out.suiteComplete,false);assert.equal(out.canCutover,false);assert.equal(out.records.length,3);assert.equal(out.records.find(r=>r.key.includes('inactive')).scopeId,'never-opened');assert.equal(out.records.find(r=>r.key.endsWith('orphan')).scopeKind,'unclassified');assert.deepEqual(f.counts(),{writes:0,network:0,current:0});await out.assertCurrent();out.records[0].value.text='mutated result';assert.equal(f.data.values().next().value.text,'inactive');
  await assert.rejects(()=>f.bridge.migrateWholeData('server_only',{operationId:'sdk'}),e=>e.code==='MEMORY_SUITE_WHOLE_MIGRATION_PROVIDER_UNAVAILABLE');assert.deepEqual(f.counts(),{writes:0,network:0,current:0});groups++;
 }finally{await f.close()}}
 {const f=fixture('hayaku');try{delete f.store.keys;const out=await f.bridge.inspectWholeDataLocalInventory();assert.equal(out.inventoryComplete,false);assert(out.reasons.includes('plugin_key_enumeration_unavailable'));assert.equal(out.canCutover,false);groups++}finally{await f.close()}}
 {const f=fixture('lia');try{const out=await f.bridge.inspectWholeDataLocalInventory();f.data.set('lia.new-inactive',{v:1});await assert.rejects(()=>out.assertCurrent(),e=>e.code==='MEMORY_SUITE_WHOLE_INVENTORY_CHANGED');groups++}finally{await f.close()}}
 {const f=fixture('lia');try{f.data.set('lia.nonjson',{nested:undefined});const out=await f.bridge.inspectWholeDataLocalInventory();assert.equal(out.inventoryComplete,false,'lossy JSON must never certify complete physical inventory');assert(out.reasons.includes('plugin_value_unreadable'));groups++}finally{await f.close()}}
 {const f=fixture('retrace');try{const out=await f.bridge.inspectWholeDataLocalInventory();await f.bridge.clearGlobalMode();await assert.rejects(()=>out.assertCurrent(),e=>e.code==='MEMORY_SUITE_WHOLE_INVENTORY_CHANGED');groups++}finally{await f.close()}}
 {const f=fixture('flashback');try{f.data.set('flashback.orphan::chunk:v1:0','opaque chunk');const out=await f.bridge.inspectWholeDataLocalInventory();assert.equal(out.records.find(r=>r.key.endsWith('::chunk:v1:0')).artifact,true);groups++}finally{await f.close()}}
 console.log('PASS '+groups+' concrete SDK local inventory and capability-refusal groups');
})().catch(e=>{console.error(e);process.exitCode=1});
