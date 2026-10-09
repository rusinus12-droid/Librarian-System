'use strict';
const assert=require('node:assert/strict');const {makePlan,runEvaluation}=require('../tools/evaluate_wm_semantics.cjs');const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');const source=require('./fixtures/unified_vertical_source.json');
const results=[];async function test(name,fn){await fn();results.push(name);console.log('PASS',name);}
(async()=>{
 const c={id:'WM-01',label:'runtime test only',selectedReview:'world_ito',sourceRows:source.sourceRows,previousState:null,referenceMaterial:[],expected:['RUBRIC_NOT_FOR_MODEL_742'],forbidden:['RUBRIC_NOT_FOR_MODEL_901']};
 await test('16 exact five-turn cases have predefined positive/negative rubrics and no manufactured scores',async()=>{assert.throws(()=>makePlan(undefined,['A','B','C']),/invalid_evaluation_arms/);const p=makePlan();assert.equal(p.caseIds.length,16);assert.equal(p.plannedProviderDispatches,16);assert.equal(p.modelEvaluation,'not_run');assert.equal(p.eligibleForDefault,false);assert.ok(p.cases.every(c=>c.expected.length&&c.forbidden.length));});
 await test('real model calls require explicit approval and bounded total request budget',async()=>{let called=0;const options={cases:[c],arms:['L'],endpoint:'https://example.invalid/v1/chat/completions',model:'model',apiKey:'test-token',maxRequests:1,fetchImpl:async()=>{called++;}};await assert.rejects(()=>runEvaluation(options),/approval_required/);await assert.rejects(()=>runEvaluation({...options,acknowledgePaidCalls:true,maxRequests:0}),/budget_required/);assert.equal(called,0);});
 await test('Librarian executes actual production source with one call, rubric withheld, missing usage stays unknown',async()=>{
  let calls=0;const response=await runEvaluation({cases:[c],endpoint:'https://example.invalid/v1/chat/completions',model:'controlled-model',apiKey:'test-token',maxRequests:1,acknowledgePaidCalls:true,transportBoundary:'controlled_test_transport_not_real_model',fetchImpl:async(_url,init)=>{
   const b=JSON.parse(init.body);assert.ok(b.messages.some(m=>m.content.includes('[EXACT FIVE U+A]')));assert.ok(b.messages.some(m=>/not the host chat worldline/i.test(m.content)));assert.ok(b.messages.some(m=>m.content.includes('Physical containment is not membership')));assert.ok(!JSON.stringify(b.messages).includes('RUBRIC_NOT_FOR_MODEL'));assert.equal(init.redirect,'error');calls++;
   const text=b.messages.map(m=>m.content).join('\n'),match=text.match(/\[CURRENT ARTIFACT ([^\]]+)\]/);const result=match?{schema:'libra.fact_revision_patch.v1',baseArtifactDigest:match[1],operations:[]}:artifact();
   return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}],model:'controlled-model'})};
  }});
  assert.equal(calls,1);assert.deepEqual(response.results.map(r=>r.physicalRequests),[1]);assert.ok(response.results.every(r=>r.outcome?.artifact?.schema==='libra.canonical_artifact.v4'),JSON.stringify(response.results));
  assert.equal(new Set(response.results.map(r=>r.sourceDigest)).size,1);assert.ok(response.results.every(r=>r.requests.every(q=>q.usage===null)));assert.equal(response.modelSemanticPass,false);assert.equal(response.humanAssessment,'pending');assert.equal(response.eligibleForDefault,false);assert.ok(!JSON.stringify(response).includes('test-token'));
 });
 console.log(JSON.stringify({test:'wm_semantic_evaluation_contract_v1',passed:results.length,results,externalModelTest:false}));
})().catch(e=>{console.error(e);process.exitCode=1;});
