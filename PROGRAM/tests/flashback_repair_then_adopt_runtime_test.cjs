'use strict';
// Read-only inspection no longer performs implicit storage preparation. Keep
// strict missing-vector refusal, and prove an explicit model repair followed
// by strict adoption without fabricating source vectors or repairing on read.
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {syntheticFetch,configure}=require('./helpers/unload_recall_contract_fixture.cjs');
(async()=>{
 const f=await createFixture({chat:{message:[{role:'user',chatId:'u1',data:'Remember the key.'},{role:'assistant',chatId:'a1',data:'The silver key is in the library.'}]}});
 try{
  const a=f.api,t=a._test;let providerCalls=0;
  f.host.nativeFetch=(url,init)=>{providerCalls++;return syntheticFetch(url,init)};
  await configure(f,'configured');const cfg=await a.loadSettings();
  const target=await a.resolveCurrentScope(),sourceScope={...target,scopeKey:target.scopeKey+'|persona:former',personaId:'former'};
  const sources=t.collectLiveChatSourcesFromSnapshot({character:f.character,chat:f.currentChat,characterIndex:0,chatIndex:0});
  const built=await t.buildRecordsFromSources(sources,cfg,sourceScope);assert.equal(built.length,1);assert.equal(built[0].vector.length,3);
  await t.saveAllRecords(built,cfg,sourceScope);
  const persisted=await t.loadScopeRecords(sourceScope.scopeKey),vectorKey=persisted.records[0].vectorRef.storageKey;
  assert.ok(f.host.safeLocalStorage.values.has(vectorKey));await f.host.safeLocalStorage.removeItem(vectorKey);
  await assert.rejects(()=>t.cloneScopeStorage(sourceScope,target,cfg,{mode:'same_chat_persona_recovery'}),e=>e.code==='FLASHBACK_CLONE_SOURCE_VECTOR_INVALID');
  assert.notEqual((await t.loadScopeManifest(target)).copyAdoptedComplete,true);
  // Missing target authority is reported as incomplete, with no hidden donor
  // scan, adoption, provider probe, or repair writes during inspection.
  await t.retireExternalRecordsForScope(sourceScope.scopeKey);
  const beforeMap=new Map(f.pluginStorage.values),localMap=new Map(f.host.safeLocalStorage.values),calls=providerCalls;
  const changed=(prior,current)=>[...new Set([...prior.keys(),...current.keys()])].filter(k=>prior.get(k)!==current.get(k));
  const plan=await a.inspectMemoryMaintenance({scope:target,requestPermission:false,settings:cfg});
  assert.equal(plan.inspection.readOnly,true);assert.equal(plan.inspection.complete,false);
  assert.equal(plan.automatic.strategy,'storage_preparation_required');assert.equal(plan.automatic.blocked,true);
  assert.equal(providerCalls,calls);assert.deepEqual(changed(beforeMap,f.pluginStorage.values),[],'inspection leaves plugin storage unchanged');assert.deepEqual(changed(localMap,f.host.safeLocalStorage.values),[],'inspection leaves local storage unchanged');
  await assert.rejects(()=>a.runMemoryMaintenance('auto',{preflight:plan}));
  assert.equal(providerCalls,calls,'incomplete authority is refused before a provider probe');
  // A deliberate source rebuild produces genuine provider vectors and binding
  // metadata. The strict clone then reads physical sidecars before publication.
  const repairedCfg=t.normalizeSettings({...cfg,embeddingModel:'unload-repaired-v2'});await a.saveSettings(repairedCfg);
  const repaired=await t.buildRecordsFromSources(sources,repairedCfg,sourceScope,{reuseRecords:persisted.records});
  await t.saveAllRecords(repaired,repairedCfg,sourceScope);
  const donor=await t.loadScopeRecords(sourceScope.scopeKey);assert.equal(donor.records[0].text,persisted.records[0].text);assert.equal(donor.records[0].sourceHash,persisted.records[0].sourceHash);assert.ok(donor.records[0].vector.some(n=>n!==0));assert.ok(providerCalls>calls);
  const donorBytes=JSON.stringify(donor.records);
  const adopted=await t.cloneScopeStorage(sourceScope,target,repairedCfg,{mode:'same_chat_persona_recovery'});assert.equal(adopted.ok,true,JSON.stringify(adopted));
  const after=await t.loadScopeRecords(target.scopeKey);assert.equal(after.manifest.copyAdoptedComplete,true);assert.equal(after.records.length,1);assert.equal(after.records[0].text,donor.records[0].text);assert.deepEqual(Array.from(after.records[0].vector),Array.from(donor.records[0].vector));
  assert.equal(JSON.stringify((await t.loadScopeRecords(sourceScope.scopeKey)).records),donorBytes,'adoption leaves repaired donor immutable');
  console.log('flashback_repair_then_adopt_runtime_test: PASS (read-only refusal; explicit real-vector source repair; strict adoption)');
 }finally{await f.dispose()}
})().catch(e=>{console.error(e);process.exitCode=1});
