'use strict';
const assert=require('node:assert/strict');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
(async()=>{for(const v of variants){
 const f=await fixture(v,{adapter:async({hostScopes,records})=>({scopes:hostScopes.map(s=>({...s,scopeId:s.chatId,scopeKey:s.chatId})),records:records.map(r=>({...r,classification:r.logicalKey.endsWith('.CONTROL')?'control':r.logicalKey.endsWith('.SHARED')?'shared':'scope',scopeId:r.logicalKey.endsWith('.SHARED')?'':r.logicalKey.slice(v[0].length+1),dependencyScopeIds:r.logicalKey.endsWith('.SHARED')?['A']:[]})),blockers:[],completeKnownScopes:true}),bridgeOptions:{resolveKeyScope:async({key})=>key.endsWith('.SHARED')?{kind:'global'}:{kind:'scope',scopeId:key.slice(v[0].length+1)}}});
 try{f.values.set(v[0]+'.SHARED','OWNER_DEPENDENCY');f.values.set(v[0]+'.CONTROL','OLD_LOCAL_CONTROL');const preview=await f.bridge.previewGlobalMode('server_only');f.values.set(v[0]+'.CONTROL','NEW_LOCAL_CONTROL');const r=await f.bridge.setGlobalMode('server_only',{previewFingerprint:preview.inventoryFingerprint});assert.equal(r.completeKnownScopes,true,'validated owner adapter can supply known shared route absent from legacy resolver');console.log('PASS '+v[0]+' adapter-classified shared dependency');}finally{await f.close();}
 const remote=await fixture(v);try{
  await remote.bridge.setGlobalMode('server_only');await remote.proxy.setItem(v[0]+'.D','REMOTE_ONLY');const registry=JSON.parse(remote.values.get(remote.registryKey));registry.entries.__memory_suite_global__.mode='plugin_only';registry.entries.__memory_suite_global__.updatedAt=Date.now()+100;for(const row of Object.values(registry.entries))row.mode='plugin_only';remote.values.set(remote.registryKey,JSON.stringify(registry));
  const p=await remote.bridge.previewGlobalMode('plugin_only');assert.equal(p.completeKnownScopes,false,'remote-only source must not be certified as zero local records');assert(p.blockers.some(x=>x.code==='remote_source_route_unverified'));console.log('PASS '+v[0]+' remote-only source ambiguity');
 }finally{await remote.close();}
}})().catch(e=>{console.error(e);process.exitCode=1;});
