'use strict';
// Input Writer preparation was removed. Its read-only authority boundary survives
// as the public request-local response context; no composer/send claim is made.
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
(async()=>{
 const kinds=[],f=await fixture({host:{async addRisuScriptHandler(kind){kinds.push(kind);return true;}}});
 try{
  assert.equal((await f.run()).completed,1);assert(!kinds.includes('input'));
  await f.r.api.getResponseContext();f.r.storageWrites.length=0;f.r.storageRemovals.length=0;
  const calls=f.control.calls.length,RealDate=Date;let clock=RealDate.parse('2026-10-01T00:00:00Z');
  f.r.context.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
  const get=()=>f.r.api.getResponseContext({currentInput:'keep the door closed'}),valid=x=>f.r.api.validateResponseContext(x);
  const first=await get();assert.equal(first.schema,'libra.response_context.v1');assert(first.scopeKey);assert(first.worldlineId);assert(first.contextDigest);assert(first.boundary.manifestDigest);assert(first.canonicalRefs[0].revision>0);assert.equal(first.persisted,false);
  clock+=60000;assert.equal((await valid(first)).current,true);
  assert.deepEqual((await get()).boundary,first.boundary,'time alone does not change authority identity');
  const record=f.getRecords('libra.continuity_state.v2')[0],head=JSON.parse(f.r.values.get(record.key));delete head.updatedAt;
  const legacyBytes=JSON.stringify(head);f.r.values.set(record.key,legacyBytes);
  const legacy=await get();clock+=60000;assert.equal((await valid(legacy)).current,true);assert.equal(f.r.values.get(record.key),legacyBytes);
  head.updatedAt=new RealDate(clock).toISOString();f.r.values.set(record.key,JSON.stringify(head));assert.equal((await valid(legacy)).current,false);
  const persisted=await get();clock+=60000;assert.equal((await valid(persisted)).current,true);
  head.updatedAt=new RealDate(clock).toISOString();f.r.values.set(record.key,JSON.stringify(head));assert.equal((await valid(persisted)).current,false);
  const before=await get();f.chat.message.push({role:'user',data:'new user',chatId:'new-u'},{role:'assistant',data:'new assistant',chatId:'new-a'});
  const stale=await valid(before);assert.equal(stale.current,false);assert.match(stale.reason,/AUTHORITY_CHANGED/);
  const copy=structuredClone(before);copy.worldlineId='tampered';assert.match((await valid(copy)).reason,/SEAL/);
  assert.deepEqual(f.r.storageWrites,[]);assert.deepEqual(f.r.storageRemovals,[]);assert.equal(f.control.calls.length,calls);
 }finally{await f.r.cleanup();}
 console.log('libra_input_writer_phase06_no_mutation_runtime_test: PASS (current read-only response authority)');
})().catch(e=>{console.error(e);process.exitCode=1;});
