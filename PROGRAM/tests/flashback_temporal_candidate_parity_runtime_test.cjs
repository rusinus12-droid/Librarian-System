'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();try{const t=f.api._test;let cases=0;
for(const query of ['Unknown navigator','Snowfall at the observatory','현재 상황을 설명해','Past and current evidence','無名の航海者'])
for(const penalty of [0,.27,.28,.6,1]){
  const record={id:'old',sourceType:'response',text:'The earlier observation explains the subsequent change.',lifecycleStatus:'active'};
  const context={temporalIntent:t.classifyTemporalIntent(query)};
  const base={record,score:.9,components:{staleStatePenalty:penalty,currentStateEvidence:0}};
  const lexical=t.applyRecallTemporalHardGate([base],context),semantic=t.applyRecallTemporalHardGate([{...base,components:{...base.components,contextualSemantic:true}}],context);
  assert.equal(lexical.length,semantic.length,'backend changed eligibility for '+query);
  assert.equal(lexical.length,1,'inferred age score must not revoke evidence');
  assert.equal(lexical[0],base);cases++;
}
const inactive={id:'inactive',text:'Old branch',lifecycleStatus:'inactive_variant'};
assert.equal(t.applyRecallHardGates([inactive],{}).length,0,'authoritative branch gate stays active');
console.log(JSON.stringify({cases,backendEligibilityEqual:true,inferredAgeDoesNotDelete:true,branchGatePreserved:true}));
}finally{await f.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
