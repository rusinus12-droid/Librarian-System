'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const local=path.join(__dirname,'fixtures/lia_native_runtime_fixture.cjs');
const fixturePath=fs.existsSync(local)?local:path.join(process.env.LIB_BASE_PROGRAM||'', 'tests/fixtures/lia_native_runtime_fixture.cjs');
const {createFixture}=require(fixturePath);
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
const expose=source=>source.replace('      getLiveSyncCaptureState:',`      healthTestStorage: MemorySuiteStorageBridge,
      healthTestConfigure: async () => configureLivePersonaSync(await getLiveRuntimeContext(), 'id:source-persona'),
      healthTestReadBinding: () => readLivePersonaBindingByScopeKey('char:lia-char|chat:lia-chat'),
      healthTestCache: () => ({store:cachedLivePersonaStore,complete:cachedLivePersonaStoreComplete}),
      getLiveSyncCaptureState:`);
(async()=>{const f=await createFixture('official',{transformSource:expose});let release;
 try{
  const health=f.runtime.healthRecovery;assert(health);let writes=0;
  await f.runtime.healthTestReadBinding(); // Populate cache explicitly; startup is now read-free for Live state.
  const set=f.api.pluginStorage.setItem,setDB=f.api.setDatabase,setChat=f.api.setChatToIndex;
  f.api.pluginStorage.setItem=async(...args)=>{writes++;return set(...args)};f.api.setDatabase=async(...args)=>{writes++;return setDB(...args)};f.api.setChatToIndex=async(...args)=>{writes++;return setChat(...args)};
  const before=JSON.stringify({storage:[...f.values],personas:f.db.personas,selectedPersona:f.db.selectedPersona,chat:f.liveChat});
  const report=await health.inspect(),ticket=await health.preview();assert.equal(report.known,true);assert.equal(report.complete,false);assert.equal(ticket.allowed,true);assert.equal(writes,0);
  assert.equal(JSON.stringify({storage:[...f.values],personas:f.db.personas,selectedPersona:f.db.selectedPersona,chat:f.liveChat}),before);
  const held=deferred();release=held.resolve;const get=f.api.getDatabase;f.api.getDatabase=async(...args)=>{await held.promise;return get(...args)};
  const repair=health.repair(ticket);assert.equal(health.isBusy(),true);
  await assert.rejects(f.runtime.healthTestReadBinding(),/HEALTH_OPERATION_IN_PROGRESS/);
  await assert.rejects(f.runtime.healthTestStorage.startRestoreJob(),/HEALTH_OPERATION_IN_PROGRESS/);
  assert.equal(writes,0);held.resolve();const result=await repair;assert.equal(result.status,'cache_invalidated');f.api.getDatabase=get;
  assert.equal(f.runtime.healthTestCache().complete,false);assert.equal(f.runtime.healthTestCache().store?.bindings?.[f.scopeKey],undefined);
  assert.equal(JSON.stringify({storage:[...f.values],personas:f.db.personas,selectedPersona:f.db.selectedPersona,chat:f.liveChat}),before);assert.equal(writes,0);assert.equal((await health.repair(ticket)).status,'blocked');
  // A normal owner writer keeps its existing return value and holds admission
  // through the real host publication, not just through its preparatory reads.
  const writeGate=deferred(),entered=deferred();release=writeGate.resolve;f.api.setDatabase=async(...args)=>{entered.resolve();await writeGate.promise;return setDB(...args)};
  const mutation=f.runtime.healthTestConfigure();await entered.promise;
  assert.equal((await health.preview()).allowed,false);health.clear();assert.equal((await health.preview()).allowed,false);writeGate.resolve();await mutation;f.api.setDatabase=setDB;
  assert.equal((await health.preview()).allowed,true);await f.dispose();assert.equal((await health.preview()).allowed,false);
  console.log('PASS full LIA VM: read-only inspection/preview, canonical byte preservation, one-use cache action, read/restore exclusion, real host writer tail, unload');
 }finally{release?.();await f.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1});
