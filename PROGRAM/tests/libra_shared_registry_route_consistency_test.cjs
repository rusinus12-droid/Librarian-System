'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const L=path.resolve(__dirname,'..');
const {serverFixture}=require(path.join(L,'tests/fixtures/libra_server_runtime_fixture.cjs'));
const key='libra:v1:scope-registry:v1',routeKey='__memory_suite_internal_scope_routes_v1__:libra';
const transformSource=source=>{const seam='  resolveRestoreDependencies:memorySuiteLibraResolveRestoreDependencies,\n  validateRestore:memorySuiteLibraValidateRestore,\n  requireRestoreValidation:true\n});';assert.equal(source.split(seam).length,2);return source.replace(seam,seam+'\nglobalThis.__REGISTRY_BRIDGE__=MemorySuiteStorageBridge;');};
(async()=>{
 const rows=[];
 for(const persisted of [false,true]){
  const fx=await serverFixture({mode:'server_only',transformSource});
  try{
   let bridge=fx.f.r.context.__REGISTRY_BRIDGE__;
   const scope={scopeId:'seventh-server-scope',scopeKey:'seventh-server-scope',characterId:'unified-char',chatId:'unified-chat'};
   if(persisted){
    fx.local.set(routeKey,JSON.stringify({schema:'memory-suite.scope-routing.v1',version:1,namespace:'libra',legacyGlobalModeImported:true,updatedAt:1,entries:{[scope.scopeId]:{...scope,mode:'server_only',source:'explicit_control',updatedAt:1}}}));
    await fx.restart();bridge=fx.f.r.context.__REGISTRY_BRIDGE__;
   }
   const mode=await bridge.getScopeMode(scope);
   const value=JSON.stringify({'unified-char::unified-chat':{scopeKey:scope.scopeKey,characterId:scope.characterId,chatId:scope.chatId,nativeCopySuppressed:true,nativeCopySuppressedReason:'bounded_causal_observation'}});
   const before={local:fx.local.get(key)??null,server:await bridge.serverGet('plugin',key)};
   await bridge.createPluginStorageProxy(fx.backend).setItem(key,value);
   const after={local:fx.local.get(key)??null,server:await bridge.serverGet('plugin',key)};
   const row={persisted,mode:JSON.parse(JSON.stringify(mode)),before,after,expectedSerialized:value,requests:fx.requests};rows.push(row);
   assert.equal(mode.mode,'server_only');assert.equal(fx.requests.some(x=>x.url.includes('/scope-delete/')),false);
   assert.equal(after.server.exists,true,'shared registry write must reach the server selected by effective scope mode');assert.equal(after.server.value,value,'server readback preserves exact serialized registry bytes');
  }finally{await fx.cleanup();}
 }
 assert.equal(rows.length,2);
 console.log(JSON.stringify({passed:2,failed:0,exactReadback:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
