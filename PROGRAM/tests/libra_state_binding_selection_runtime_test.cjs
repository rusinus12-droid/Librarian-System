'use strict';
const assert=require('node:assert/strict');const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const results=[];
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
function addEarlier(f){const later=f.control.artifact.facts.find(x=>x.tempFactId==='f11'),earlier=f.clone(later);earlier.tempFactId='earlier_holder';earlier.values.holderRef='jiho';f.control.artifact.facts.push(earlier);return earlier;}
(async()=>{
 await test('one explicit final binding wins within the same row while historical facts survive',async f=>{
  addEarlier(f);await f.run();const h=f.getHead();assert.equal(h.status,'ready');assert.equal(h.world.find(x=>x.name==='은빛 열쇠').state.holderRef,h.characters.find(x=>x.name==='민아').id);assert.ok(f.getMemory().canonicalArtifact.facts.some(x=>x.tempFactId==='earlier_holder'));assert.ok(h.unifiedApplied.supersededFacts.includes('earlier_holder'));
  const bytes=JSON.stringify(f.getMemory());await f.r.api.rebuildWorldManagerState();assert.equal(f.getHead().status,'ready');assert.equal(JSON.stringify(f.getMemory()),bytes);assert.equal(f.control.calls.length,1);
 });
 for(const mode of ['none','both'])await test(mode+' explicit selections keep the conflicting field pending and unrelated knowledge visible',async f=>{
  addEarlier(f);if(mode==='none')f.control.artifact.stateBindings=f.control.artifact.stateBindings.filter(b=>b.factTempId!=='f11');else f.control.artifact.stateBindings.push({factTempId:'earlier_holder'});
  await f.run();const h=f.getHead();assert.equal(h.status,'partial');assert.equal(h.world.find(x=>x.name==='은빛 열쇠').state.holderRef,undefined);assert.deepEqual(h.characters.find(x=>x.name==='민아').state.knowledge,['상자의 암호']);assert.ok(h.unifiedApplied.pending.some(p=>p.reason==='same_source_order_conflict'));
 });
 await test('later source row is not suppressed by an earlier explicit selection',async f=>{
  f.control.artifact.stateBindings=f.control.artifact.stateBindings.filter(b=>b.factTempId!=='f11');await f.run();const h=f.getHead();assert.equal(h.world.find(x=>x.name==='은빛 열쇠').state.holderRef,h.characters.find(x=>x.name==='민아').id);
 });
 await test('an unbound independent knowledge acquisition is not discarded by another explicit acquisition',async f=>{
  const fact=f.clone(f.control.artifact.facts.find(x=>x.tempFactId==='f9'));fact.tempFactId='more_knowledge';fact.values.knowledge=['정숙 규칙'];f.control.artifact.facts.push(fact);await f.run();assert.deepEqual([...f.getHead().characters.find(x=>x.name==='민아').state.knowledge].sort(),['상자의 암호','정숙 규칙'].sort());
 });
 await test('array reversal never changes the selected final value',async f=>{
  addEarlier(f);f.control.artifact.facts.reverse();await f.run();const h=f.getHead();assert.equal(h.status,'ready');assert.equal(h.world.find(x=>x.name==='은빛 열쇠').state.holderRef,h.characters.find(x=>x.name==='민아').id);
 });
 console.log(JSON.stringify({test:'libra_state_binding_selection_runtime',passed:results.length,results,boundary:'full plugin, synthetic facts and KV readback; no live provider'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
