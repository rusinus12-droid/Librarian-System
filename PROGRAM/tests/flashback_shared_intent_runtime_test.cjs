'use strict';
const assert=require('node:assert/strict');const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();try{const t=f.api._test,k=f.api._selectionTest.RecallKeywordFeatures;let count=0;
for(const q of ['Unknown navigator','Snowfall on the harbor','Compare the records','past and current','Tell me about "now"','현재와 과거','Describe the scene']){
const plan=k.compile(q),expected=['current','past','compare','timeline'].includes(plan.intent.temporal)?plan.intent.temporal:'unspecified';
assert.equal(t.classifyTemporalIntent(q,{queryPlan:plan}),expected,'temporal reclassification: '+q);
assert.equal(t.classifyTruthIntent(q,{queryPlan:plan}),plan.intent.disputed?'disputed':'normal');count++;
}
// The resolved request is authoritative even when a consumer receives a different text representation.
const bound=k.compile('Compare the records');assert.equal(t.classifyTemporalIntent('Unknown navigator',{queryPlan:bound}),'compare');
console.log(JSON.stringify({cases:count,boundPlanPreserved:true,secondaryTemporalClassifier:false}));
}finally{await f.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
