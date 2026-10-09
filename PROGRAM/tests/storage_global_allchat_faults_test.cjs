'use strict';
const assert=require('node:assert/strict');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const journalKey=ns=>`__memory_suite_internal_sync_job_v1__:${ns}`;
const tests=[];function test(name,fn){tests.push([name,fn]);}
test('same-mode legacy server verifies authoritative source without comparing retained stale backup',async v=>{
 const f=await fixture(v);try{await f.bridge.setGlobalMode('server_only');await f.proxy.setItem(v[0]+'.A','NEW_SERVER');
 const registry=JSON.parse(f.values.get(f.registryKey));registry.entries.A.origin='user_explicit';registry.entries.A.updatedAt++;f.values.set(f.registryKey,JSON.stringify(registry));
 const result=await f.bridge.setGlobalMode('server_only');assert.equal(result.completeKnownScopes,true);assert.equal(f.values.get(v[0]+'.A'),'A_SOURCE');assert.equal((await f.bridge.getScopeMode({scopeId:'A'})).explicit,false);
 }finally{await f.close();}
});
test('reverse covers inactive server-only values and preserves authoritative server',async v=>{
 const f=await fixture(v);try{await f.bridge.setGlobalMode('server_only');f.values.delete(v[0]+'.B');
 const result=await f.bridge.setGlobalMode('plugin_only');assert.equal(result.completeKnownScopes,true);assert.equal(f.values.get(v[0]+'.B'),'B_SOURCE');
 const before=f.calls.length;assert.equal(await f.proxy.getItem(v[0]+'.B'),'B_SOURCE');await new Promise(r=>setTimeout(r,20));assert.equal(f.calls.length,before,'plugin-only completion has no background reconnect');
 }finally{await f.close();}
});
test('source drift after preview rejects before payload or routing mutation',async v=>{
 const f=await fixture(v);try{const p=await f.bridge.previewGlobalMode('server_only');f.values.set(v[0]+'.B','CHANGED');const before=[...f.values];await assert.rejects(()=>f.bridge.setGlobalMode('server_only',{previewFingerprint:p.inventoryFingerprint}),e=>e.code==='MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED');assert.deepEqual([...f.values],before);}finally{await f.close();}
});
test('journal failure before copy leaves payload and routes intact',async v=>{
 const f=await fixture(v,{writeFault:async k=>{if(k===journalKey(v[0]))throw Error('synthetic_journal_fault');}});try{const before=[...f.values];await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');assert.deepEqual([...f.values],before);assert(!f.calls.some(c=>c.path==='/v1/kv/set'));}finally{await f.close();}
});
test('route-before-checkpoint crash resumes from another selected chat',async v=>{
 let injected=false;const f=await fixture(v,{writeFault:async(k,value)=>{if(k===journalKey(v[0])){const j=JSON.parse(value);if(!injected&&j.checkpoints?.A){injected=true;throw Error('synthetic_crash_after_route');}}}});
 let fresh;try{await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_JOURNAL_UNAVAILABLE');assert.equal(f.bridge.getSyncJob().status,'paused');assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');await f.bridge.dispose();
 fresh=await fixture(v,{app:f.app,values:f.values,current:'C'});const result=await fresh.bridge.setGlobalMode('server_only');assert.equal(result.completeKnownScopes,true);assert.equal(fresh.bridge.getSyncJob().status,'completed');assert.equal(f.values.get(v[0]+'.A'),'A_SOURCE');
 }finally{if(fresh)await fresh.close();await f.close();}
});
test('aggregate pending job blocks newly selected chat owner writes',async v=>{
 let injected=false;const f=await fixture(v,{writeFault:async(k,value)=>{if(k===journalKey(v[0])&&!injected&&JSON.parse(value).checkpoints?.A){injected=true;throw Error('synthetic_pause');}}});
 try{await assert.rejects(()=>f.bridge.setGlobalMode('server_only'));f.setCurrent('C');await assert.rejects(()=>f.proxy.setItem(v[0]+'.C','BAD_FALLBACK'),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');assert.equal(f.values.has(v[0]+'.C'),false);}finally{await f.close();}
});
test('denied null partial duplicate host catalog blocks read-only',async v=>{
 for(const catalog of [null,{}, {characters:[{chaId:'c'}]},{characters:[{chaId:'c',chats:[{id:'a'},{id:'a'}]}]}]){
  const f=await fixture(v,{catalogRead:async()=>clone(catalog)});try{const before=[...f.values];const result=await f.bridge.previewGlobalMode('server_only');assert.equal(result.completeKnownScopes,false);assert.deepEqual([...f.values],before);assert.equal(f.calls.length,0);}finally{await f.close();}
 }
});
test('remote duplicate pagination metadata is a blocker',async v=>{
 const f=await fixture(v,{transportFactory:base=>async(url,init)=>{const res=await base(url,init);if(String(url).includes('/v1/kv/keys')){const body=await res.json();body.result.keys=['duplicate','duplicate'];body.result.records=[];return new Response(JSON.stringify(body),{status:200});}return res;}});
 try{const before=[...f.values];const result=await f.bridge.previewGlobalMode('server_only');assert.equal(result.completeKnownScopes,false);assert(result.blockers.some(b=>/duplicate/.test(b.code)));assert.deepEqual([...f.values],before);}finally{await f.close();}
});
test('321-plus host catalog is complete without registry cap',async v=>{
 const catalog={characters:[{chaId:'large',chats:Array.from({length:337},(_,i)=>({id:'N'+i}))},{chaId:'one',chats:[{id:'A'}]},{chaId:'two',chats:[{id:'B'}]}]};
 const f=await fixture(v,{catalog});try{const p=await f.bridge.previewGlobalMode('plugin_only');assert.equal(p.completeKnownScopes,true);assert.equal(p.discoveredScopes,339);assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('copy-before-route crash preserves old global and resumes idempotently',async v=>{
 let fail=true;const f=await fixture(v,{writeFault:async(k,value)=>{if(fail&&k===`__memory_suite_internal_scope_routes_v1__:${v[0]}`){const r=JSON.parse(value);if(r.entries?.A?.globalMigrationJobId&&r.entries.A.mode==='server_only')throw Error('route_write_fault');}}});
 try{await assert.rejects(()=>f.bridge.setGlobalMode('server_only'));assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');assert.equal(f.values.get(v[0]+'.A'),'A_SOURCE');fail=false;const result=await f.bridge.setGlobalMode('server_only');assert.equal(result.completeKnownScopes,true);}finally{await f.close();}
});
test('global-local-commit before publication failure remains recoverable',async v=>{
 let rejectGlobal=true;const f=await fixture(v,{transportFactory:base=>async(url,init={})=>{const body=init.body?JSON.parse(init.body):{};if(rejectGlobal&&String(url).endsWith('/v1/kv/set')&&body.key===`__memory_suite_scope_routes_v1__:${v[0]}`)return new Response(JSON.stringify({ok:false,error:'synthetic_global_publication_failure'}),{status:503});return await base(url,init);}});
 try{await assert.rejects(()=>f.bridge.setGlobalMode('server_only'));assert.equal(f.bridge.getSyncJob().status,'paused');assert.equal(f.bridge.getSyncJob().phase,'commit_pending');await assert.rejects(()=>f.proxy.setItem(v[0]+'.C','BAD'),e=>e.code==='MEMORY_SUITE_STORAGE_TRANSITION_IN_PROGRESS');rejectGlobal=false;const result=await f.bridge.setGlobalMode('server_only');assert.equal(result.completeKnownScopes,true);}finally{await f.close();}
});
test('cancel-before-copy leaves source routes unchanged',async v=>{
 const f=await fixture(v);let requested=false;const stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.status==='queued'){requested=true;void f.bridge.pauseGlobalModeJob();}});
 try{const result=await f.bridge.setGlobalMode('server_only');assert.equal(result.status,'cancelled');assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');assert.equal(f.values.get(v[0]+'.A'),'A_SOURCE');assert(!f.calls.some(c=>c.path==='/v1/kv/set'));}finally{stop();await f.close();}
});
test('safe-point pause preserves actual migrated routes and resume data',async v=>{
 const f=await fixture(v);let requested=false;const stop=f.bridge.subscribeSyncJob(job=>{if(!requested&&job?.checkpoints?.A){requested=true;void f.bridge.pauseGlobalModeJob();}});
 try{const result=await f.bridge.setGlobalMode('server_only');assert.equal(result.status,'paused');assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');assert.equal((await f.bridge.getScopeMode({scopeId:'A'})).mode,'server_only');assert.equal((await f.bridge.getScopeMode({scopeId:'B'})).mode,'plugin_only');const completed=await f.bridge.setGlobalMode('server_only');assert.equal(completed.completeKnownScopes,true);}finally{stop();await f.close();}
});
test('malformed owner discovery and incomplete record coverage block',async v=>{
 const f=await fixture(v,{adapter:async()=>({scopes:[],records:[],blockers:[{code:'unknown_manifest_schema'}],completeKnownScopes:false})});try{const before=[...f.values];await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE');assert.deepEqual([...f.values],before);}finally{await f.close();}
});
test('credential and unrelated namespace records never enter migration',async v=>{
 const f=await fixture(v,{bridgeOptions:{excludedContains:['embedding_secret']}});try{f.values.set(v[0]+'.embedding_secret','SYNTHETIC_SECRET');f.values.set('other_namespace.payload','OTHER');const result=await f.bridge.setGlobalMode('server_only');assert.equal(result.completeKnownScopes,true);const rows=f.app.repositories[v[0]].database.prepare('SELECT key FROM kv').all();assert(!rows.some(r=>/embedding_secret|other_namespace/.test(r.key)));assert.equal(f.values.get('other_namespace.payload'),'OTHER');}finally{await f.close();}
});
test('unavailable remote source fails before changing global route',async v=>{
 const f=await fixture(v,{transport:async()=>{throw Error('synthetic_connection_unavailable');}});try{const before=[...f.values];await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE');assert.deepEqual([...f.values],before);}finally{await f.close();}
});
test('aggregate pin tampering and changed URL cannot silently resume',async v=>{
 let injected=false;const f=await fixture(v,{writeFault:async(k,value)=>{if(k===journalKey(v[0])&&!injected&&JSON.parse(value).checkpoints?.A){injected=true;throw Error('pause_pin_fixture');}}});
 try{await assert.rejects(()=>f.bridge.setGlobalMode('server_only'));await assert.rejects(()=>f.bridge.setGlobalMode('server_only',{url:'http://127.0.0.1:47632'}),e=>e.code==='MEMORY_SUITE_JOB_SERVER_PIN_CHANGED');const j=JSON.parse(f.values.get(journalKey(v[0])));j.globalPlan.scopes[0].sourceMode='server_only';f.values.set(journalKey(v[0]),JSON.stringify(j));await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_JOB_PIN_PERSIST_FAILED');}finally{await f.close();}
});
test('valid detached scope is migrated without selecting it',async v=>{
 const f=await fixture(v,{current:''});try{const reg=JSON.parse(f.values.get(f.registryKey));reg.entries.D={scopeId:'D',scopeKey:'D',characterId:'removed-character',chatId:'removed-chat',mode:'plugin_only',origin:'user_explicit'};f.values.set(f.registryKey,JSON.stringify(reg));f.values.set(v[0]+'.D','DETACHED');const result=await f.bridge.setGlobalMode('server_only');assert.equal(result.discoveredScopes,4);assert.equal(result.verifiedScopes,4);assert.equal((await f.bridge.getScopeMode({scopeId:'D'})).mode,'server_only');assert.equal(f.values.get(v[0]+'.D'),'DETACHED');}finally{await f.close();}
});
(async()=>{let passed=0;const failures=[];for(const v of variants)for(const [name,fn]of tests){try{await fn(v);passed++;console.log('PASS '+v[0]+' '+name);}catch(error){failures.push({owner:v[0],name,code:error.code,message:error.message,stack:error.stack});console.error('FAIL '+v[0]+' '+name+' '+error.message);}}console.log(JSON.stringify({passed,owners:3,scenariosPerOwner:tests.length,failures},null,2));if(failures.length)process.exitCode=1;})().catch(e=>{console.error(e);process.exitCode=1;});
