'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const choices=(preview,actions={})=>Object.fromEntries(preview.items.map(item=>[item.id,{action:actions[item.key]||'keep',fingerprint:item.fingerprint}]));
const dump=f=>JSON.stringify(f.app.repositories[f.bridge.namespace||f.ns].database.prepare('SELECT space,key,value_json,revision,digest,deleted FROM kv ORDER BY space,key').all());
async function setup(v){const f=await fixture(v);f.ns=v[0];await f.bridge.setGlobalMode('server_only');return f;}
for(const v of variants){
 test(`${v[0]}: review lists mismatches and excluded items do not block verified duplicates`,async()=>{
  const f=await setup(v),a=v[0]+'.A',b=v[0]+'.B';try{
   f.values.set(a,'LOCAL CHANGED');
   const before=dump(f),preview=await f.bridge.previewDuplicateCleanup();
   assert.equal(preview.ok,false);assert.equal(preview.items.find(row=>row.key===a).reason,'value_mismatch');
   assert.equal(preview.items.find(row=>row.key===b).reason,'matched');
   const events=[];
   const result=await f.bridge.globalDeletePluginStorageAfterVerification({selection:choices(preview,{[a]:'exclude',[b]:'delete'}),onProgress:event=>events.push(event)});
   assert.equal(result.deletedItems,1);assert.equal(result.excluded,1);assert.equal(f.values.get(a),'LOCAL CHANGED');assert.equal(f.values.has(b),false);
   assert.equal(dump(f),before,'review and local cleanup never mutate server memory');
   assert(events.some(event=>event.phase==='verify'));assert(events.some(event=>event.phase==='delete'));assert.equal(events.at(-1).phase,'complete');
  }finally{await f.close();}
 });
 test(`${v[0]}: unpreserved local deletion requires a fingerprint and explicit acknowledgement`,async()=>{
  const f=await setup(v),a=v[0]+'.A',b=v[0]+'.B';try{
   f.app.repositories[v[0]].database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',a);
   const preview=await f.bridge.previewDuplicateCleanup(),selection=choices(preview,{[a]:'delete'});
   assert.equal(preview.items.find(row=>row.key===a).reason,'server_missing');
   await assert.rejects(f.bridge.globalDeletePluginStorageAfterVerification({selection}),error=>error.code==='MEMORY_SUITE_CLEANUP_UNPRESERVED_CONFIRMATION_REQUIRED');
   assert(f.values.has(a));assert(f.values.has(b));
   const before=dump(f),result=await f.bridge.globalDeletePluginStorageAfterVerification({selection,allowUnpreserved:true});
   assert.equal(result.deletedItems,1);assert.equal(result.kept,1);assert(!f.values.has(a));assert(f.values.has(b));assert.equal(dump(f),before);
  }finally{await f.close();}
 });
 test(`${v[0]}: a stale choice cannot discard a changed local original`,async()=>{
  const f=await setup(v),a=v[0]+'.A',b=v[0]+'.B';try{
   const preview=await f.bridge.previewDuplicateCleanup(),selection=choices(preview,{[a]:'delete',[b]:'delete'});
   f.values.set(a,'CHANGED AFTER REVIEW');
   await assert.rejects(f.bridge.globalDeletePluginStorageAfterVerification({selection,allowUnpreserved:true}),error=>error.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED');
   assert.equal(f.values.get(a),'CHANGED AFTER REVIEW');assert(f.values.has(b));
  }finally{await f.close();}
 });
 test(`${v[0]}: unreadable items can be excluded, but cannot be forced into deletion`,async()=>{
  const f=await setup(v),a=v[0]+'.A',b=v[0]+'.B';try{
   const get=f.store.getItem;f.store.getItem=async key=>{if(key===a)throw Error('synthetic unreadable');return get(key);};
   const preview=await f.bridge.previewDuplicateCleanup(),item=preview.items.find(row=>row.key===a);
   assert.equal(item.reason,'local_unreadable');assert.equal(item.canDelete,false);
   await assert.rejects(f.bridge.globalDeletePluginStorageAfterVerification({selection:choices(preview,{[a]:'delete'}),allowUnpreserved:true}));
   const result=await f.bridge.globalDeletePluginStorageAfterVerification({selection:choices(preview,{[a]:'exclude',[b]:'delete'})});
   assert.equal(result.excluded,1);assert(f.values.has(a));assert(!f.values.has(b));
  }finally{await f.close();}
 });
 test(`${v[0]}: stop finishes only the current local item and preserves the remainder`,async()=>{
  const f=await setup(v),controller=new AbortController();try{
   const before=dump(f);
   await assert.rejects(f.bridge.globalDeletePluginStorageAfterVerification({signal:controller.signal,onProgress:event=>{if(event.phase==='delete')controller.abort();}}),error=>{
    assert.equal(error.code,'MEMORY_SUITE_CLEANUP_CANCELLED');assert.equal(error.result.deletedItems,1);return true;
   });
   assert(f.values.has(v[0]+'.B'));assert.equal(dump(f),before);
   assert.equal((await f.bridge.globalDeletePluginStorageAfterVerification()).deletedItems,1,'cancellation releases the writer barrier');
  }finally{await f.close();}
 });
 test(`${v[0]}: server cleanup requires a completed move, backs up once and leaves no new tombstones`,async()=>{
  const f=await setup(v),a=v[0]+'.A',b=v[0]+'.B';try{
   await assert.rejects(f.bridge.previewDuplicateCleanup({direction:'server'}),error=>error.code==='MEMORY_SUITE_DELETE_REQUIRES_PLUGIN_MODE');
   await f.bridge.globalDeletePluginStorageAfterVerification();assert(!f.values.has(a));
   await f.bridge.setGlobalMode('plugin_only');assert.equal(f.values.get(a),'A_SOURCE');assert.equal(f.values.get(b),'B_SOURCE');
   const result=await f.bridge.globalDeleteServerDuplicates();
   assert.equal(result.deletedItems,2);assert.equal(result.backupIds.length,1);
   for(const key of [a,b]){const remote=await f.bridge.serverGet('plugin',key);assert.equal(remote.exists,false);assert.equal(remote.tombstone,false);assert(f.values.has(key));}
   const backupDir=path.join(path.dirname(path.dirname(path.dirname(f.app.repositories[v[0]].filePath))),'backups','deleted-scopes',result.backupIds[0]);
   assert(fs.existsSync(path.join(backupDir,v[0]+'.sqlite')),'verified server backup is retained');
   assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
   await f.bridge.setGlobalMode('server_only');assert.equal((await f.bridge.serverGet('plugin',a)).value,'A_SOURCE','a later move cannot propagate a cleanup tombstone over the plugin source');
  }finally{await f.close();}
 });
 test(`${v[0]}: server purge is atomic if local data changes after verification`,async()=>{
  const f=await setup(v);try{
   await f.bridge.setGlobalMode('plugin_only');const before=dump(f);
   await assert.rejects(f.bridge.globalDeleteServerDuplicates({beforeDelete:async()=>f.values.set(v[0]+'.B','NEW LOCAL')}));
   assert.equal(dump(f),before,'no server key is purged when any destination proof changes');
  }finally{await f.close();}
 });
 test(`${v[0]}: server additions invalidate the complete namespace snapshot before purge`,async()=>{
  const f=await setup(v);try{
   await f.bridge.setGlobalMode('plugin_only');
   await assert.rejects(f.bridge.globalDeleteServerDuplicates({beforeDelete:async()=>{
    f.app.repositories[v[0]].database.prepare('INSERT INTO kv SELECT space,?,value_json,deleted,revision,digest,updated_at FROM kv WHERE space=? AND key=?').run(v[0]+'.NEW','plugin',v[0]+'.A');
   }}));
   for(const key of ['A','B','NEW'])assert.equal((await f.bridge.serverGet('plugin',v[0]+'.'+key)).exists,true);
  }finally{await f.close();}
 });
}
for(const v of variants)test(`${v[0]}: server data referenced by a retained scope is retained with it`,async()=>{
 const ns=v[0];
 const adapter=async({hostScopes,registries,records})=>{
  const map=new Map(hostScopes.map(scope=>[scope.chatId,{...scope,scopeId:scope.chatId,scopeKey:scope.chatId}]));
  for(const registry of registries)for(const row of Object.values(registry.entries||{}))if(row.scopeId!=='__memory_suite_global__'&&!row.removed)map.set(row.scopeId,{...map.get(row.scopeId),...row});
  const classified=records.map(row=>({...row,classification:'scope',scopeId:row.scopeId||row.logicalKey.slice(ns.length+1),...(row.logicalKey===ns+'.A'?{dependencyKeys:[ns+'.B'],dependencyScopeIds:['A','B']}:{})}));
  for(const row of classified)if(!map.has(row.scopeId))map.set(row.scopeId,{scopeId:row.scopeId,scopeKey:row.scopeId});
  return{scopes:[...map.values()],records:classified,blockers:[],completeKnownScopes:true};
 };
 const f=await fixture(v,{adapter});f.ns=ns;try{
  await f.bridge.setGlobalMode('server_only');await f.bridge.setGlobalMode('plugin_only');
  const preview=await f.bridge.previewDuplicateCleanup({direction:'server'}),before=dump(f);
  const kept=await f.bridge.globalDeleteServerDuplicates({selection:choices(preview,{[ns+'.B']:'delete'})});
  assert.equal(kept.deleted,0);assert.equal(kept.kept,2);assert.equal(dump(f),before);
  const all=await f.bridge.globalDeleteServerDuplicates({selection:choices(preview,{[ns+'.A']:'delete',[ns+'.B']:'delete'})});
  assert.equal(all.deletedItems,2,'both copies can be removed together once the complete dependency closure is selected');
 }finally{await f.close();}
});
test('an older server without the optional cleanup capability preserves all data and requests an update',async()=>{
 const f=await fixture(variants[0],{transportFactory:base=>async(url,init)=>{
  const response=await base(url,init);
  if(new URL(url).pathname!=='/bootstrap')return response;
  const payload=await response.json();delete payload.capabilities['duplicate-cleanup.v1'];
  return new Response(JSON.stringify(payload),{status:response.status,headers:response.headers});
 }});f.ns=variants[0][0];try{
  await f.bridge.setGlobalMode('server_only');await f.bridge.setGlobalMode('plugin_only');const before=dump(f);
  await assert.rejects(f.bridge.globalDeleteServerDuplicates(),error=>error.code==='MEMORY_SUITE_DUPLICATE_CLEANUP_SERVER_UPDATE_REQUIRED');
  assert.equal(dump(f),before);
 }finally{await f.close();}
});
test('server cleanup rejects cross-owner calls, tampered plans and replays exactly one committed purge',async()=>{
 const v=variants[0],captured=[];
 const f=await fixture(v,{transportFactory:base=>async(url,init)=>{
  if(new URL(url).pathname==='/v1/owner/duplicate-cleanup')captured.push({url,init:{...init,headers:{...init.headers}}});
  return base(url,init);
 }});f.ns=v[0];try{
  await f.bridge.setGlobalMode('server_only');await f.bridge.setGlobalMode('plugin_only');
  await f.bridge.globalDeleteServerDuplicates();assert.equal(captured.length,1,'all copies are purged in one namespace transaction');
  const {url,init}=captured[0],body=JSON.parse(init.body);
  const replay=await f.host.nativeFetch(url,init);assert.equal(replay.status,200);assert.equal((await replay.json()).result.replayed,true);
  const before=dump(f);
  const changed={...body,mutations:[{...body.mutations[0],expectedDigest:'a'.repeat(64)}]};
  assert.equal((await f.host.nativeFetch(url,{...init,body:JSON.stringify(changed)})).status,409);
  const foreignHeaders={...init.headers};for(const key of Object.keys(foreignHeaders))if(key.toLowerCase()==='x-memory-suite-plugin')foreignHeaders[key]='libra';
  assert.equal((await f.host.nativeFetch(url,{...init,headers:foreignHeaders})).status,403);
  assert.equal(dump(f),before);
 }finally{await f.close();}
});
test('a lost server cleanup response is resolved by the exact durable receipt without replaying deletion',async()=>{
 let dropped=false,commits=0;
 const f=await fixture(variants[0],{transportFactory:base=>async(url,init)=>{
  const response=await base(url,init);
  if(new URL(url).pathname==='/v1/owner/duplicate-cleanup'){
   commits++;if(!dropped){dropped=true;throw Error('synthetic response loss after atomic commit');}
  }
  return response;
 }});f.ns=variants[0][0];try{
  await f.bridge.setGlobalMode('server_only');await f.bridge.setGlobalMode('plugin_only');
  const result=await f.bridge.globalDeleteServerDuplicates();assert.equal(result.ok,true);assert.equal(result.deletedItems,2);assert.equal(commits,1);
  assert(f.values.has(f.ns+'.A'));assert(f.values.has(f.ns+'.B'));
 }finally{await f.close();}
});
for(const v of variants)test(`${v[0]}: discovered device vectors remain verifiable without an active wrapped device store`,async()=>{
 const values=new Map([[v[0]+'.A','DEVICE_VECTOR']]);
 const device={getItem:async key=>values.get(key)??null,setItem:async(key,value)=>{values.set(key,value);return true;},removeItem:async key=>{values.delete(key);return true;},keys:async()=>[...values.keys()]};
 const f=await fixture(v,{bridgeOptions:{localPrefixes:[v[0]+'.']}});f.ns=v[0];f.host.getLocalPluginStorage=async()=>device;
 try{
  await f.bridge.setGlobalMode('server_only');
  const preview=await f.bridge.previewDuplicateCleanup();assert(preview.items.some(row=>row.space==='local'&&row.key===v[0]+'.A'&&row.status==='matched'));
  await f.bridge.globalDeletePluginStorageAfterVerification();assert.equal(values.has(v[0]+'.A'),false);
  await f.bridge.setGlobalMode('plugin_only');assert.equal(values.get(v[0]+'.A'),'DEVICE_VECTOR');
  const result=await f.bridge.globalDeleteServerDuplicates();assert.equal(result.deletedItems,3);
  assert.equal(values.get(v[0]+'.A'),'DEVICE_VECTOR');assert.equal((await f.bridge.serverGet('local',v[0]+'.A')).exists,false);
 }finally{await f.close();}
});
