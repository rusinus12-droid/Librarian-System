'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const local=path.join(__dirname,'fixtures/lia_native_runtime_fixture.cjs');
const fixturePath=fs.existsSync(local)?local:path.join(process.env.LIB_BASE_PROGRAM||'', 'tests/fixtures/lia_native_runtime_fixture.cjs');
const {createFixture}=require(fixturePath);
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve}};
const expose=source=>source.replace('      getScopePersonaCatalog:',`      healthTestStorage: MemorySuiteStorageBridge,
      healthTestGenerated: (ctx,result) => upsertGeneratedPersona(ctx,result),
      getScopePersonaCatalog:`);
(async()=>{const f=await createFixture('official',{transformSource:expose});let release;
 try{
  const health=f.runtime.healthRecovery;assert(health);let writes=0;
  const set=f.api.pluginStorage.setItem,setDB=f.api.setDatabase,setChat=f.api.setChatToIndex;
  f.api.pluginStorage.setItem=async(...args)=>{writes++;return set(...args)};f.api.setDatabase=async(...args)=>{writes++;return setDB(...args)};f.api.setChatToIndex=async(...args)=>{writes++;return setChat(...args)};
  const state=()=>JSON.stringify({storage:[...f.values],personas:f.db.personas,selectedPersona:f.db.selectedPersona,chat:f.liveChat});
  const before=state();
  const report=await health.inspect();assert.equal(report.known,true);assert.equal(report.complete,false);
  // LIA keeps no per-scope RAM cache any more, so there is nothing a repair could invalidate.
  const ticket=await health.preview();assert.equal(ticket.allowed,false);assert.equal(writes,0);assert.equal(state(),before);
  // A corrupt proof store is reported, not repaired.
  f.values.set('liaPersonaRequestProofV1','[]');assert.equal((await health.inspect()).known,false);f.values.delete('liaPersonaRequestProofV1');
  assert.equal((await health.inspect()).known,true);
  // A normal owner writer keeps its return value and holds admission through the real host publication.
  const ctx={char:f.character,chat:f.liveChat,charIndex:0,chatIndex:0,personaInfo:{persona:f.db.personas[0]},generationMode:'classic'};
  const writeGate=deferred(),entered=deferred();release=writeGate.resolve;f.api.setDatabase=async(...args)=>{entered.resolve();await writeGate.promise;return setDB(...args)};
  const mutation=f.runtime.healthTestGenerated(ctx,{personaPrompt:'HEALTH',generationMode:'classic'});await entered.promise;
  assert.equal((await health.inspect()).known,false,'a running writer is not inspected as settled');writeGate.resolve();const saved=await mutation;assert.equal(saved.persona.personaPrompt,'HEALTH');f.api.setDatabase=setDB;
  assert.equal((await health.inspect()).known,true);await f.dispose();assert.equal((await health.inspect()).known,false);
  console.log('PASS full LIA VM: read-only inspection, corrupt proof report, no cache action, real host writer tail, unload');
 }finally{release?.();await f.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1});
