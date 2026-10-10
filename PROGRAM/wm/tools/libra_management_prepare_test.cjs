'use strict';
const assert=require('node:assert/strict');
const {load,scope}=require('./libra_management_storage_verified_test.cjs');
const clone=value=>JSON.parse(JSON.stringify(value,(_,v)=>['[object Map]','[object Set]'].includes(Object.prototype.toString.call(v)) ? [...v] : v));
const qrow={id:'q1',domain:'entity',status:'blocked',reason:'review_required',payload:{success:true,entities:[{name:'Mira',status:{currentDate:'2024-01-02'},background:{occupation:'Archivist'}}],conversationText:'Mira is an archivist. Today is 2024-01-02.'}};
const quarantine=rows=>({key:'q-state',comment:'lmai_analysis_quarantine',content:JSON.stringify({schema:'libra.analysis_quarantine.v1',entries:rows})});
const checks=[];async function test(name,fn){try{await fn();checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,error:e.message});process.exitCode=1;}}
async function fixture({admit=true}={}){
 const f=await load({artifact:true,extraExports:'ManagementReviewCore:typeof ManagementReviewCore!=="undefined"?ManagementReviewCore:null,EntityManager,HierarchicalWorldManager,TimeEngine,EntityCandidateCore,QuarantineManager,IntegrityScanner,MemoryState,MemoryEngine,LibraLoreConsolidator,getChatRuntimeScopeKey',transformCode:code=>code.replace('        const invalidateEntityResolveCaches = () => {',`        globalThis.__entitySnapshot = () => ({entities:[...entityCache],relations:[...relationCache],identityState,entityCacheRevision,entityLookupIndexCache,entityResolveCache:[...entityResolveCache]});\n        const invalidateEntityResolveCaches = () => {`)});
 const a=f.api;assert(a.ManagementReviewCore,'management preparation core exists');
 const char={id:'fixture-char'},chat={id:'fixture-chat',bindedPersona:'persona-a'};
 if(admit){const admission=await a.LibraDataStorage.preparePersonaContext(char,chat);assert.equal(admission.ok,true);assert.equal(admission.scopeKey,scope);}
 a.MemoryState._activeScopeKey=a.getChatRuntimeScopeKey(chat,char);a.MemoryState._activeChatId='fixture-chat';
 a.MemoryEngine.CONFIG.useLLM=false;a.MemoryEngine.CONFIG.embeddingEnabled=false;
 a.TimeEngine.resetState({currentDate:'2000-01-01',notes:'original'});
 const seedLore=[{key:'original-entity',comment:'lmai_entity',content:JSON.stringify({id:'zahara',name:'Zahara Finch',meta:{aliases:['Zahara'],created:1,updated:1},background:{occupation:'Teacher'}})}];
 a.EntityManager.rebuildCache(seedLore);assert.equal(a.EntityManager.getEntityCache().size,1);a.EntityManager.resolveCanonicalName('Zahara',seedLore);a.HierarchicalWorldManager.loadWorldGraph([],true);
 a.QuarantineManager.loadState([quarantine([{...qrow,id:'original'}])]);a.IntegrityScanner.loadState([]);a.EntityCandidateCore.loadState([], {scopeKey:a.MemoryState._activeScopeKey,chatId:'fixture-chat'});
 f.snapshot=()=>clone({entity:f.testGlobals.__entitySnapshot(),relation:a.EntityManager.getRelationCache(),world:a.HierarchicalWorldManager.getProfile(),time:a.TimeEngine.getState(),candidate:a.EntityCandidateCore.getState(),quarantine:a.QuarantineManager.getState(),integrity:a.IntegrityScanner.getState()});
 f.identities=()=>[a.EntityManager.getEntityCache(),a.EntityManager.getRelationCache(),a.HierarchicalWorldManager.getProfile(),a.TimeEngine.getState(),a.EntityCandidateCore.getState(),a.QuarantineManager.getState(),a.IntegrityScanner.getState()];
 f.context={char,chat,scopeKey:scope,runtimeScopeKey:a.MemoryState._activeScopeKey};return f;
}
(async()=>{
 await test('unadmitted preparation target cannot sign entities or mutate manager state',async()=>{
  const f=await fixture({admit:false}),before=f.snapshot(),input=[quarantine([qrow])],original=clone(input);
  assert.throws(()=>f.api.ManagementReviewCore.prepare(input,{action:'quarantine-accept',id:'q1',context:f.context}),/entity_persistence_target_unverified/);
  assert.deepEqual(f.snapshot(),before);assert.deepEqual(clone(input),original);assert.equal(f.writes.length,0);
 });
 await test('accept preparation returns changed cloned lore and restores every runtime manager before a microtask',async()=>{
  const f=await fixture(),a=f.api,input=[quarantine([qrow])],before=f.snapshot(),identities=f.identities(),original=clone(input);let observed;
  const deferred=Promise.resolve().then(()=>{observed=f.snapshot()});
  const result=a.ManagementReviewCore.prepare(input,{action:'quarantine-accept',id:'q1',context:f.context});
  assert(!(result&&typeof result.then==='function'),'preparation must be synchronous');assert.equal(result.changed,true);
  assert.deepEqual(clone(input),original);assert.deepEqual(f.snapshot(),before);f.identities().forEach((value,index)=>assert.equal(value,identities[index]));
  const row=JSON.parse(result.lore.find(x=>x.comment==='lmai_analysis_quarantine').content).entries[0];assert.equal(row.status,'accepted');
  assert(result.lore.some(x=>x.comment==='lmai_entity'));assert.equal(f.writes.length,0);
  await deferred;assert.deepEqual(observed,before);
 });
 await test('zero-applied preparation remains rejected and fully restores managers',async()=>{
  const f=await fixture(),before=f.snapshot(),identities=f.identities();const rows=[quarantine([{...qrow,payload:{success:true,world:{irrelevant:'value'}}}])];
  assert.throws(()=>f.api.ManagementReviewCore.prepare(rows,{action:'quarantine-accept',id:'q1',context:f.context}),/no_changes_applied/);
  assert.deepEqual(f.snapshot(),before);f.identities().forEach((value,index)=>assert.equal(value,identities[index]));assert.equal(f.writes.length,0);
 });
 for(const action of ['quarantine-ignore','quarantine-resolve'])await test(`${action} changes only returned draft`,async()=>{
  const f=await fixture(),before=f.snapshot(),input=[quarantine([qrow])];const result=f.api.ManagementReviewCore.prepare(input,{action,id:'q1',context:f.context});
  assert.equal(result.changed,true);assert.deepEqual(f.snapshot(),before);assert.equal(JSON.parse(input[0].content).entries[0].status,'blocked');
 });
 await test('missing review ID and malformed review state fail without runtime mutation',async()=>{
  const f=await fixture(),before=f.snapshot();assert.throws(()=>f.api.ManagementReviewCore.prepare([quarantine([qrow])],{action:'quarantine-ignore',id:'missing',context:f.context}),/not_found/);
  const broken=quarantine([]);broken.content='{bad';assert.throws(()=>f.api.ManagementReviewCore.prepare([broken],{action:'scan',context:f.context}),/unreadable/);assert.deepEqual(f.snapshot(),before);
 });
 await test('stale shadow review rows do not reappear in explicit canonical preparation',async()=>{
  const f=await fixture(),a=f.api;await a.LibraDataStorage.save(f.context.char,f.context.chat,[quarantine([qrow])]);a.LibraDataStorage.setActiveScope(scope);
  assert.throws(()=>a.ManagementReviewCore.prepare([],{action:'quarantine-accept',id:'q1',context:f.context}),/not_found/);
 });
 await test('temporary preparation wrappers reject thenables and restore object identities',async()=>{
  const f=await fixture(),before=f.snapshot(),ids=f.identities();
  for(const manager of [f.api.EntityManager,f.api.HierarchicalWorldManager,f.api.TimeEngine,f.api.EntityCandidateCore,f.api.QuarantineManager,f.api.IntegrityScanner]){
   assert.throws(()=>manager.withTemporaryState(()=>Promise.resolve('invalid')),/must_be_synchronous/);
  }
  assert.deepEqual(f.snapshot(),before);f.identities().forEach((value,index)=>assert.equal(value,ids[index]));
 });
 await test('failed canonical write after preparation cannot expose staged manager state',async()=>{
  const f=await fixture(),before=f.snapshot();const draft=f.api.ManagementReviewCore.prepare([quarantine([qrow])],{action:'quarantine-accept',id:'q1',context:f.context});
  f.control.mode='reject';const result=await f.api.LibraDataStorage.saveVerified(scope,draft.lore,{expectedRaw:null,isCurrent:async()=>true});
  assert.equal(result.ok,false);assert.deepEqual(f.snapshot(),before);
 });
 await test('mismatched active runtime scope cannot sign or mutate a prepared payload',async()=>{
  const f=await fixture();f.api.MemoryState._activeScopeKey='other-active-scope';const before=f.snapshot();
  assert.throws(()=>f.api.ManagementReviewCore.prepare([quarantine([qrow])],{action:'quarantine-accept',id:'q1',context:f.context}),/management_scope_mismatch/);
  assert.deepEqual(f.snapshot(),before);assert.equal(f.writes.length,0);
 });
 await test('bounded scan explicitly reports partial when its four batches do not finish',async()=>{
  const f=await fixture();const rows=Array.from({length:500},(_,i)=>({key:'memory-'+i,comment:'lmai_memory',content:'[META:{"t":1}] fixture'}));
  const result=f.api.ManagementReviewCore.prepare(rows,{action:'scan',context:f.context});
  assert.equal(result.completed,false);assert.equal(result.result.done,false);
 });
 console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,checks},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
