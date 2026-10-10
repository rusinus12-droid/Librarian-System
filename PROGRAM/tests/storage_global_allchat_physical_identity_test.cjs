'use strict';
const assert=require('node:assert/strict');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
(async()=>{const failures=[];for(const v of variants){
 let failValidation=false;
 const adapter=async({hostScopes,records})=>({scopes:hostScopes.map(s=>({...s,scopeId:s.chatId,scopeKey:s.chatId,aliases:Array.from({length:31},(_,i)=>s.chatId+'_alias_'+i)})),records:records.map(r=>({...r,classification:'scope',scopeId:r.logicalKey.slice(v[0].length+1),...(r.value==='PHYSICAL_ENVELOPE'?{logicalValue:'A_SOURCE'}:{})})),blockers:[],completeKnownScopes:true});
 const f=await fixture(v,{adapter,bridgeOptions:{validateRestore:async ctx=>{if(failValidation&&ctx.phase==='complete')throw Error('INJECT_SEMANTIC_RESTORE_FAILURE');return {ok:true};}}});
 try{
  f.values.set(v[0]+'.A','PHYSICAL_ENVELOPE');await f.bridge.setGlobalMode('server_only');
  const row=JSON.parse(f.values.get(f.registryKey)).entries.A;
  assert.equal(row.aliases.length,31,'all owner-validated aliases survive durable routing');
  assert(!row.canonicalScopeId,'SDK does not invent an owner canonical identity');
  console.log('PASS '+v[0]+' strict owner identity and aliases');
 }catch(error){failures.push(v[0]+' identity: '+error.message);}
 try{
  failValidation=true;await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'));
  assert.equal(f.values.get(v[0]+'.A'),'PHYSICAL_ENVELOPE','rollback restores exact raw physical bytes, not logical hydration');
  console.log('PASS '+v[0]+' physical restore rollback');
 }catch(error){failures.push(v[0]+' rollback: '+error.message);}finally{await f.close();}
 const raw=await fixture(v,{adapter:async input=>{for(const registry of input.registries)for(const row of Object.values(registry.entries))assert(!row.canonicalScopeId,'raw discovery does not invent canonical IDs');return adapter(input);}});
 try{const p=await raw.bridge.previewGlobalMode('server_only');assert.equal(p.completeKnownScopes,true,JSON.stringify(p.blockers));console.log('PASS '+v[0]+' raw routing evidence');}catch(error){failures.push(v[0]+' raw: '+error.message);}finally{await raw.close();}
 for(const malformed of [{aliases:[{}]},{canonicalChatId:42}]){const bad=await fixture(v);try{const registry=JSON.parse(bad.values.get(bad.registryKey));Object.assign(registry.entries.A,malformed,{globalInventoryIdentity:'memory-suite.strict-owner-scope.v1'});bad.values.set(bad.registryKey,JSON.stringify(registry));const result=await bad.bridge.previewGlobalMode('plugin_only');assert.equal(result.completeKnownScopes,false);assert(result.blockers.some(row=>row.code==='routing_entry_identity_malformed'));console.log('PASS '+v[0]+' malformed identity blocked');}catch(error){failures.push(v[0]+' malformed: '+error.message);}finally{await bad.close();}}
 const alias=await fixture(v,{bridgeOptions:{resolveKeyScope:async({registry})=>Object.values(registry.entries).some(row=>row.aliases?.includes('stored-hash'))?{kind:'scope',scopeId:'A'}:{kind:'global'}}});try{const registry=JSON.parse(alias.values.get(alias.registryKey));registry.entries.A.storageHash='stored-hash';registry.entries.A.mode='server_only';delete registry.entries.A.aliases;alias.values.set(alias.registryKey,JSON.stringify(registry));const resolved=await alias.bridge.resolveScopeByAlias('stored-hash',{force:true,tryServer:false});assert.equal(resolved.scopeId,'A','cold route retains recorded storageHash alias');console.log('PASS '+v[0]+' explicit storageHash alias');}catch(error){failures.push(v[0]+' alias: '+error.message);}finally{await alias.close();}
}if(failures.length)throw Error(failures.join('\n'));})().catch(e=>{console.error(e);process.exitCode=1;});
