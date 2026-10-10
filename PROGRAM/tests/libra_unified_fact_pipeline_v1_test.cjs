'use strict';
const assert=require('node:assert/strict');const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const results=[];
const context=args=>{
 const body=args[0].messages.map(m=>m.content).find(t=>t.includes('[CURRENT ARTIFACT '));
 const match=/\[CURRENT ARTIFACT ([^\]]+)\]\n([\s\S]*?)\n\[FACT DIGESTS\]\n([^\n]+)/.exec(body);
 assert.ok(match,'review uses actual previous artifact');
 return {base:JSON.parse(match[2]),digest:match[1],digests:JSON.parse(match[3])};
};
const success=value=>({type:'success',result:JSON.stringify(value)});
async function test(name,opts,fn){const f=await fixture(opts);try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
(async()=>{
 await test('single Librarian includes all domains with old reviewer switches retained but never executed',{mode:'serial_review',args:{enable_character_ito:true,enable_world_ito:true,enable_plot_ito:true}},async f=>{
   const result=await f.run();assert.equal(result.completed,1,JSON.stringify(result));assert.equal(f.control.calls.length,1);
   const m=f.getMemory(),h=f.getHead();assert.deepEqual(m.canonicalArtifact,f.control.artifact);assert.equal(m.text,f.r.api.debugRenderUnifiedArtifact(m.canonicalArtifact));
   assert.equal(m.engineVersion,'libra.unified.v2');assert.equal(h.status,'ready');assert.ok(h.characters.length);assert.ok(h.world.length);assert.ok(h.relationships.length);assert.ok(h.narrative.threads.length);
   const recall=await f.r.api.previewUnifiedMemoryRecall('민아 은빛 열쇠');assert.ok(recall.memories.some(r=>r.memory.artifactDigest===m.artifactDigest));assert.equal(f.control.calls.length,1);
 });
 await test('invalid Librarian evidence is quarantined while valid facts remain canonical',{},async f=>{f.control.artifact.facts[0].evidenceSpans[0].quote='원문에 없는 주장이므로 거절해야 한다';const r=await f.run();assert.equal(r.completed,1);assert.equal(f.getMemory().canonicalArtifact.facts.length,12);assert.ok(!f.getMemory().canonicalArtifact.facts.some(x=>x.tempFactId==='f1'));assert.equal(f.getMemory().pipeline.status,'partial');assert.equal(f.getHead().status,'partial');assert.equal(f.control.calls.length,1);});
 await test('reported fact can remain canonical but cannot become current State',{},async f=>{const fact=f.control.artifact.facts.find(x=>x.tempFactId==='f5');fact.temporalRole='reported';const r=await f.run();assert.equal(r.completed,1);assert.equal(f.getMemory().canonicalArtifact.facts.find(x=>x.tempFactId==='f5').temporalRole,'reported');assert.equal(f.getHead().characters.find(x=>x.name==='민아').state.locationRef,undefined);assert.equal(f.getHead().status,'partial');});
 await test('same-row conflict and cyclic containment do not reject unrelated knowledge',{},async f=>{
   const extra=f.clone(f.control.artifact.facts.find(x=>x.tempFactId==='f11'));extra.tempFactId='conflictHolder';extra.values.holderRef='jiho';extra.text='같은 행에서 소지자 해석이 충돌하는 시험 후보';f.control.artifact.facts.push(extra);f.control.artifact.stateBindings.push({factTempId:extra.tempFactId,typedValueField:'holderRef',stateDomain:'world',stateField:'holderRef'});
   const cycle=f.clone(f.control.artifact.facts[0]);cycle.tempFactId='cycle';cycle.subjectTempRef='library';cycle.values.parentRef='study';cycle.text='순환 포함관계 시험 후보';f.control.artifact.facts.push(cycle);f.control.artifact.stateBindings.push({factTempId:'cycle',typedValueField:'parentRef',stateDomain:'world',stateField:'parentRef'});
   const r=await f.run();assert.equal(r.completed,1);const h=f.getHead();assert.equal(h.status,'partial');assert.equal(h.world.find(x=>x.name==='은빛 열쇠').state.holderRef,undefined);assert.deepEqual(h.characters.find(x=>x.name==='민아').state.knowledge,['상자의 암호']);assert.ok(h.unifiedApplied.pending.some(x=>x.reason==='containment_cycle'));assert.ok(h.unifiedApplied.pending.some(x=>x.reason==='same_source_order_conflict'));
 });
 await test('missing redundant binding is derived from the validated typed fact',{},async f=>{
   f.control.artifact.stateBindings=f.control.artifact.stateBindings.filter(x=>x.factTempId!=='f6');const r=await f.run();assert.equal(r.completed,1);assert.equal(f.getHead().status,'ready');assert.equal(f.getHead().world.find(r=>r.name==='은빛 열쇠').state.ownerRef,f.getHead().characters.find(r=>r.name==='민아').id);assert.equal(f.getMemory().canonicalArtifact.facts.length,f.control.artifact.facts.length);assert.equal(r.stateWarnings.length,0);
 });
 await test('dependent State is held when upstream field conflicts; unrelated knowledge applies',{},async f=>{
   const c=f.clone(f.control.artifact.facts.find(x=>x.tempFactId==='f11'));c.tempFactId='secondHolder';c.values.holderRef='jiho';f.control.artifact.facts.push(c);f.control.artifact.stateBindings.push({factTempId:c.tempFactId,typedValueField:'holderRef',stateDomain:'world',stateField:'holderRef'});f.control.artifact.facts.find(x=>x.tempFactId==='f5').dependsOn=['f11'];
   const r=await f.run();assert.equal(r.completed,1);const h=f.getHead(),mina=h.characters.find(x=>x.name==='민아');assert.equal(mina.state.locationRef,undefined);assert.deepEqual(mina.state.knowledge,['상자의 암호']);assert.ok(h.unifiedApplied.pending.some(x=>x.fact==='f5'&&x.reason==='dependency_pending'));
 });
 console.log(JSON.stringify({test:'libra_unified_fact_pipeline_v1',passed:results.length,results,boundaries:'real deployed full JS and public jobs; provider output deliberately controlled, not semantic model proof'}));
})().catch(e=>{console.error(e);process.exitCode=1});
