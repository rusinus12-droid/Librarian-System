'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture,fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {classifyCall}=require('./fixtures/libra_provider_call_kinds.cjs');
// Real product request handlers and on-disk SQLite; HTTP dispatch and RisuAI/LLM
// boundaries are controlled by the repository fixture (no network sockets).
for(const mode of ['server_only','mirror']) test(`${mode}: external writes inside TTL are fresh and stale canonical publication is blocked`,async t=>{
 const s=await serverFixture({mode,transformSource:source=>source.replace('    const stateDerivedWorldlineSuffix =','    globalThis.__cacheStorage = storage; globalThis.__cacheStats = state.verifiedReadCacheStats;\n    const stateDerivedWorldlineSuffix =')});
 t.after(()=>s.cleanup());const f=s.f,storage=f.r.context.__cacheStorage,scope={_cachedMode:mode};
 assert.equal((await f.run()).completed,1);
 const row=s.getRecords('libra.continuity_state.v2')[0];assert.ok(row);
 await storage.getVerifiedJson(row.key,scope);await storage.getVerifiedJson(row.key,scope);
 const stats=f.r.context.__cacheStats;assert.ok(stats);const before=stats.hits;
 const external={...row.value,externalMarker:'external-before-background-write'};
 await s.mutate(row.key,external);
 if(mode==='server_only') assert.equal((await storage.getVerifiedJson(row.key,scope)).externalMarker,external.externalMarker);
 else {
  await assert.rejects(()=>storage.getVerifiedJson(row.key,scope),/LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH/);
  // A fully replicated external writer restores equality before background work.
  s.local.set(row.key,JSON.stringify(external));
  assert.equal((await storage.getVerifiedJson(row.key,scope)).externalMarker,external.externalMarker);
 }
 assert.equal(stats.hits,before,'a changed server revision cannot reuse the prior cached body');
 fiveMore(f);let raced=false;
 f.control.onCall=async args=>{
  if(classifyCall(args)==='canonical'){
   raced=true;const latest={...external,externalMarker:'external-during-provider-wait'};
   await s.mutate(row.key,latest);if(mode==='mirror')s.local.set(row.key,JSON.stringify(latest));
  }
  return {type:'success',result:JSON.stringify(f.control.artifact)};
 };
 const result=await f.run();assert.ok(raced,'actual canonical provider boundary reached');
 assert.equal(result.completed,0,JSON.stringify(result));assert.ok(!s.getManifest().memories['6']);
 assert.equal(s.getHead().externalMarker,'external-during-provider-wait');
 // Read again from persisted rows through a new runtime/bridge, without the old cache.
 const restarted=await s.restart();
 assert.equal((await restarted.r.context.__cacheStorage.getVerifiedJson(row.key,scope)).externalMarker,'external-during-provider-wait');
});
