'use strict';
// Run the complete shipped owner, rather than slicing at a retired controller.
// Fault hooks pause only external journal/admission boundaries; real owner
// latches, router, authority checks and lifecycle remain unchanged.
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const original=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8');
const journalMarker='const persistMaintenanceJournal = async (patch = {}) => {';
const authorityMarker='const createMaintenanceLocalJournalAdmission = async scope => {';
assert.equal(original.split(journalMarker).length,2);
assert.equal(original.split(authorityMarker).length,2);
const source=original.replace(journalMarker,journalMarker+" if (patch.stage==='preflight' && globalThis.__journalStop) await globalThis.__journalStop(patch);")
 .replace(authorityMarker,authorityMarker+' if(globalThis.__authorityGate) await globalThis.__authorityGate;');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
async function setup(){
 const f=await createFixture({source,chat:{message:[{role:'user',chatId:'u1',data:'Where is the key?'},{role:'assistant',chatId:'a1',data:'The brass key is under the blue lamp.'}]}});
 await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
 return f;
}
test('physical latch blocks cache preview before its first awaited journal finishes',async()=>{
 const f=await setup(),entered=deferred(),release=deferred();
 try{
  await f.api.healthRecovery.preview();
  f.context.__journalStop=async()=>{entered.resolve();await release.promise;throw Error('fixture_stop_after_first_await')};
  const work=f.api.runMemoryMaintenance('sync');const observed=work.catch(e=>e);
  await entered.promise;
  assert.equal((await f.api.healthRecovery.preview()).allowed,false);
  release.resolve();assert.match((await observed).message,/fixture_stop/);
 }finally{release.resolve();await f.dispose()}
});
test('shared router action blocks physical start at its synchronous latch',async()=>{
 const f=await setup();
 try{
  const ticket=await f.api.previewSourceEdits(['1']);assert.equal(ticket.allowed,true);
  const running=f.api.applySourceEdits(ticket);
  await assert.rejects(()=>f.api.runMemoryMaintenance('sync'),/FLASHBACK_REPAIR_ACTION_BUSY/);
  const result=await running;assert.equal(result.ok,true,JSON.stringify(result));
 }finally{await f.dispose()}
});
test('concurrent maintenance cannot both cross awaited local authority gate',async()=>{
 const f=await setup(),authority=deferred(),entered=deferred(),release=deferred();let journalCalls=0;
 try{
  f.context.__authorityGate=authority.promise;
  f.context.__journalStop=async()=>{journalCalls++;entered.resolve();await release.promise;throw Error('fixture_stop_after_first_await')};
  const a=f.api.runMemoryMaintenance('sync').catch(e=>e),b=f.api.runMemoryMaintenance('sync').catch(e=>e);
  authority.resolve();await entered.promise;
  await new Promise(r=>setTimeout(r,20));assert.equal(journalCalls,1);
  release.resolve();const outcomes=await Promise.all([a,b]);
  assert.equal(outcomes.filter(e=>/FLASHBACK_MAINTENANCE_BUSY/.test(e.message)).length,1);
 }finally{authority.resolve();release.resolve();await f.dispose()}
});
