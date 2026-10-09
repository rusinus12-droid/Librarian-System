'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./checksum-fixture.cjs');
for(const kind of ['mutable-diagnostics','replacement-adapter','adapter-getter','added-adapter'])test('custom '+kind+' retains mutable validation inputs and rejection',async()=>{
 const f=await fixture(4),manager=f.r.api.IntegrityMetaManager,validate=manager.validateIntegrityMeta;
 let currentSnapshot=f.snapshot,sections=f.com.sections,calls=0,hookCalls=0,observedFrozen=[];
 if(kind==='mutable-diagnostics'){
  const record=f.r.signed({...f.record,turnLog:[{worldSummary:'missing_identity'},...f.record.turnLog]},'world','world_state');
  f.r.chat.localLore=[f.r.entry('lmai_world_states','lmai_world_states::core',record)];currentSnapshot=f.r.snap({currentTurn:100});
  const units=f.r.corpus.enumerate(currentSnapshot);assert.equal(units.length,4);
  sections=f.c.compose({snapshot:currentSnapshot,policy:f.policy,baseline:[{key:'baseline',text:'BASELINE',bindings:units,required:true}]}).sections;
  const push=currentSnapshot.diagnostics.push;
  currentSnapshot.diagnostics.push=function(...args){hookCalls++;manager.validateIntegrityMeta=(record,context)=>{calls++;observedFrozen.push(Object.isFrozen(record));record.turnLog[1].worldSummary='CUSTOM_MUTATION';return validate(record,context);};return push.apply(this,args);};
 }else{
  const original=f.r.corpus.adapters.world,custom={...original,eligibility(unit,...args){calls++;observedFrozen.push(Object.isFrozen(unit.parentRecord));unit.parentRecord.turnLog[0].worldSummary='CUSTOM_MUTATION';return original.eligibility(unit,...args);}};
  if(kind==='adapter-getter')Object.defineProperty(f.r.corpus.adapters,'world',{configurable:true,enumerable:true,get(){hookCalls++;return custom;}});
  else if(kind==='added-adapter'){f.r.corpus.adapters.extra={};manager.validateIntegrityMeta=(record,context)=>{calls++;observedFrozen.push(Object.isFrozen(record));record.turnLog[0].worldSummary='CUSTOM_MUTATION';return validate(record,context);};}
  else f.r.corpus.adapters.world=custom;
 }
 const output=f.c.finalize({sections,currentSnapshot,mode:'hybrid',budget:{maxTokens:20000,maxChars:80000},policy:f.policy});
 assert.equal(output.ok,false);assert.equal(output.directBlocks.length,0);assert.match(output.protectedDrops[0].reason,/checksum_mismatch/);assert.deepEqual(observedFrozen,[false]);assert.equal(calls,1);if(kind==='mutable-diagnostics')assert.equal(hookCalls,1);assert.equal(f.r.state.calls.length,0);
 console.log('SAFE_CALLBACK '+JSON.stringify({kind,calls,hookCalls,observedFrozen,reason:output.protectedDrops[0].reason}));
});
test('preexisting diagnostics preserves mutable semantics and exact checksum reuse',async()=>{
 const f=await fixture(4);f.snapshot.diagnostics.push({reason:'prior_observation'});const output=f.finalize();assert.equal(output.ok,true);assert.equal(f.count(),3);assert.equal(output.directBlocks[0].text,'PUBLIC_WORLD_BASELINE');
});
