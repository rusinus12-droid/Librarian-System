'use strict';
// v1.6: same write-basis safety, exercised at the actual single-analyzer/local-applier boundary.
const assert=require('node:assert/strict');const{fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const results=[];async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
const parsed=v=>{try{return JSON.parse(v)}catch{return {}}};
(async()=>{
 await test('unchanged basis commits current domains with one model dispatch',async f=>{const r=await f.run();assert.equal(r.completed,1);assert.equal(f.getHead().status,'ready');assert.equal(f.control.calls.length,1);});
 for(const kind of ['head','registry'])await test(kind+' changed during analysis survives with no stale canonical activation',async f=>{
  let key,raw;f.control.onCall=async()=>{const scope=f.getManifest().scopeKey;key=`libra:v1:scope:${scope}:${kind==='head'?'continuity-state':'entity-registry:v2'}`;raw=JSON.stringify({schema:kind==='head'?'libra.continuity_state.v2':'libra.entity_registry.v2',scopeKey:scope,userEdited:'must-survive',entities:[]});f.r.values.set(key,raw);return{type:'success',result:JSON.stringify(f.control.artifact)}};
  await f.run();assert.equal(f.getMemory(),null);assert.equal(f.r.values.get(key),raw);assert.equal(f.control.calls.length,1);
 });
 await test('external Head write during prepared local transaction is never overwritten',async f=>{
  let hit=false,key,raw;const storage=f.r.context.risuai.pluginStorage,orig=storage.setItem;
  storage.setItem=async(k,v)=>{const out=await orig(k,v);if(!hit&&parsed(v).schema==='libra.unified_state_tx.v1'){hit=true;key=`libra:v1:scope:${f.getManifest().scopeKey}:continuity-state`;raw=JSON.stringify({schema:'libra.continuity_state.v2',scopeKey:f.getManifest().scopeKey,userEdited:'must-survive'});f.r.values.set(key,raw);}return out};
  const r=await f.run();storage.setItem=orig;assert.equal(r.completed,1);assert.equal(hit,true);assert.equal(f.r.values.get(key),raw);const m=f.getMemory();await f.r.api.retryPendingUnifiedState();assert.equal(f.r.values.get(key),raw);assert.equal(f.getMemory().artifactDigest,m.artifactDigest);assert.equal(f.control.calls.length,1);
 });
 await test('source change after prepared local transaction prevents stale Head without deleting canonical',async f=>{
  let hit=false;const storage=f.r.context.risuai.pluginStorage,orig=storage.setItem;
  storage.setItem=async(k,v)=>{if(!hit&&parsed(v).schema==='libra.unified_state_tx.v1'){hit=true;f.chat.message[0].data+=' changed source';}return orig(k,v)};
  const r=await f.run();storage.setItem=orig;assert.equal(hit,true);assert.equal(r.completed,1);const m=f.getMemory();assert.ok(m);assert.equal(f.getHead(),null);await f.r.api.retryPendingUnifiedState();assert.equal(f.getHead(),null);assert.equal(f.getMemory().artifactDigest,m.artifactDigest);assert.equal(f.control.calls.length,1);
 });
 await test('Head no-op write is pending and exact saved transaction recovers without model',async f=>{
  let hit=false;const storage=f.r.context.risuai.pluginStorage,orig=storage.setItem;
  storage.setItem=async(k,v)=>{if(!hit&&parsed(v).schema==='libra.continuity_state.v2'){hit=true;return true;}return orig(k,v)};
  const r=await f.run();storage.setItem=orig;assert.equal(hit,true);assert.equal(r.completed,1);assert.equal(f.getHead(),null);assert.ok(f.getRecords('libra.unified_state_tx.v1').length);const retry=await f.r.api.retryPendingUnifiedState();assert.equal(retry.recovered,1);assert.equal(f.getHead().status,'ready');assert.equal(f.control.calls.length,1);
 });
 console.log(JSON.stringify({test:'libra_state_write_basis_v2',passed:results.length,results,boundary:'actual deployed full JS; externally injected writes; not distributed CAS'}));
})().catch(e=>{console.error(e);process.exitCode=1});
