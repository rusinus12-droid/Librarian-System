'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const corpus=require('./fixtures/hayaku_selection_policy_frozen_holdout.json');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
test('existing candidate slots preserve distinct facts, axis ceilings, character budgets and unique-turn temporal quotas',async()=>{
 const h=await createHayakuRuntime({autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{memory_suite_server_mode:'plugin_only',hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');}});
 try{
  const t=h.hayaku._test;
  for(const c of corpus.cases){
   const settings={...h.hayaku.settings(),mode:'auto',effectiveMode:'fast',maxItemsPerAxis:c.maxItemsPerAxis,...(c.temporal?{temporalRecallPolicy:c.temporal}:{})};
   const selected=t.prepareHayakuRecallRows(c.rows,corpus.query,settings,{worldlineHeadOrdinal:corpus.worldlineHeadOrdinal},[],[]);
   const result=t.selectHayakuEvidencePlan(selected,corpus.query,settings,c.capChars);
   assert(result.renderedEntries<=16,c.id);assert(result.text.length<=c.capChars,c.id);assert.equal(result.plan.temporalQuota.allowed,true,c.id);
   for(const axis of ['entity','world','narrative','planner']){
    const count=new Set(result.plan.units.filter(unit=>(unit.origins||[]).some(origin=>origin.axis===axis)).map(unit=>unit.id)).size;
    assert(count<=c.maxItemsPerAxis,c.id+'/'+axis);if(c.requiredAxes?.includes(axis))assert(count>0,c.id+'/'+axis);
   }
   for(const body of c.required||[])assert(result.text.includes(body),c.id+'/'+body);
   for(const lane of c.requiredLanes||[])assert(result.plan.temporalQuota.delivered[lane]>0,c.id+'/'+lane);
   if(c.expectedEntries!=null)assert.equal(result.renderedEntries,c.expectedEntries,c.id);
   if(c.expectedSources!=null)assert.equal(result.deliveredSources.length,c.expectedSources,c.id);
  }
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
 }finally{await h.dispose();}
});
