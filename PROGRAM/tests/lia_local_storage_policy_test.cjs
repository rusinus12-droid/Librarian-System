'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.LIA_SDK_DRAFT || path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8');
const scope={scopeId:'lia-test-scope',scopeKey:'lia-test-scope',chatId:'chat',characterId:'char'};
function fixture(policy){
 const values=new Map(),writes=[];let network=0,scopeCalls=0;
 const storage={async getItem(k){return values.get(k)??null;},async setItem(k,v){writes.push(k);values.set(k,v);return true;},async removeItem(k){values.delete(k);return true;},async keys(){return [...values.keys()];}};
 const registry=JSON.stringify({schema:'memory-suite.scope-routing.v1',legacyGlobalModeImported:true,entries:{[scope.scopeId]:{...scope,mode:'server_only',updatedAt:10}}});values.set('__memory_suite_internal_scope_routes_v1__:lia',registry);
 const context=vm.createContext({console,setTimeout,clearTimeout,setInterval,clearInterval,URL,TextEncoder,TextDecoder,AbortController,crypto:globalThis.crypto,risuai:{pluginStorage:storage,async getArgument(k){return k==='memory_suite_server_mode'?'server_only':'';},async nativeFetch(){network++;throw Error('fake network forbidden');}}});
 vm.runInContext(source+'\nglobalThis.create=createMemorySuiteStorageBridge;',context);
 const bridge=context.create({namespace:'lia',pluginId:'lia_persona_linker',storagePolicy:policy,pluginKeys:['a','b'],currentScopeProvider:()=>{scopeCalls++;return scope;},resolveKeyScope:()=>({kind:'scope',...scope}),managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false});
 const proxy=bridge.createPluginStorageProxy(storage);
 return {bridge,proxy,values,writes,registry,get network(){return network;},get scopeCalls(){return scopeCalls;}};
}
test('local-only owner ignores old modes without changing registry or consulting host context',async()=>{const f=fixture('local_only');try{
 assert.equal(await f.bridge.getMode(),'plugin_only');const count=f.scopeCalls;await f.proxy.setItem('a','kept');assert.equal(await f.proxy.getItem('a'),'kept');await f.proxy.keys();assert.equal(f.scopeCalls,count);assert.equal(f.values.get('__memory_suite_internal_scope_routes_v1__:lia'),f.registry);
 await assert.rejects(f.bridge.setMode('server_only'),/MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY/);await assert.rejects(f.bridge.startSynchronizationJob(),/MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY/);assert.equal(f.network,0);
 assert.equal((await f.bridge.inspectLocalHealthSnapshot(scope,'a',{strictPhysical:true})).raw,'kept');
}finally{await f.bridge.dispose();}});
test('local recovery validates first and rejects changed local expected values',async()=>{const f=fixture('local_only');try{
 assert.equal(typeof f.bridge.publishLocalRecovery,'function','staged local publication API is required');
 await assert.rejects(f.bridge.publishLocalRecovery({records:[{key:'a',value:'new',expectedValue:null}],validate:async()=>false}),/VALIDATION/);assert.equal(f.values.has('a'),false);
 f.values.set('a','user');await assert.rejects(f.bridge.publishLocalRecovery({records:[{key:'a',value:'new',expectedValue:null}],validate:async()=>true}),/CONFLICT/);assert.equal(f.values.get('a'),'user');
 const r=await f.bridge.publishLocalRecovery({records:[{key:'b',value:'restored',expectedValue:null}],validate:async()=>true});assert.equal(r.verified,true);assert.equal(f.values.get('b'),'restored');assert.equal(f.network,0);
}finally{await f.bridge.dispose();}});
test('local key prefix and recovery false/zero/empty values remain exact',async()=>{const f=fixture('local_only');try{
 f.values.set('a','alpha');f.values.set('b','beta');assert.deepEqual(Array.from(await f.proxy.keys('a')),['a']);
 for(const value of [false,0,'']){f.values.delete('b');await f.bridge.publishLocalRecovery({records:[{key:'b',value,expectedValue:null}],validate:async()=>true});assert.equal(f.values.get('b'),value);}
}finally{await f.bridge.dispose();}});
