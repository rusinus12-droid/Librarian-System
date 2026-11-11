'use strict';
// The recall preset is the ceiling of recalled evidence: a small preset is never widened
// past its own budget, and a large one is filled when the engine selected evidence for it.
const test=require('node:test'),assert=require('node:assert/strict');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const visibility={privacy:'',ownerEntityId:'',holderEntityIds:[],visibleToEntityIds:[],deniedToEntityIds:[],unresolvedEntityRefs:false};
const names=['Maren','Ivo','Vesna','Corin','Hale','Odile','Tamsin','Reeve','Lysa','Brann','Edda','Joss'];
const things=['lapis latch','ochre bobbin','silver spindle','amber vial','iron sextant','jade comb','copper lantern','oak chest'];
const rowsFor=count=>Array.from({length:count},(_,i)=>({id:'source-'+i,publicRef:'source-'+i,packetHash:'packet-'+i,
  axis:['world','narrative','planner','entity'][i%4],category:['current_state','summary_memory','continuity_lock','profile'][i%4],
  publicText:`summary: In chapter ${i+1}, ${names[i%names.length]} moved the ${things[i%things.length]} from shelf ${i+3} of the repository to vault ${i*7+11}, and promised ${names[(i+5)%names.length]} to return it before the ${i+2}th bell of the harbor watch.`,
  visibility,_localRecall:true,_recallDirectRank:i+1,score:1/(61+i),locator:{sourcePairIndex:i+1,worldlineOrdinal:i+1,messageIndex:2*i+1}}));
test('recalled evidence follows the chosen preset budget',async()=>{
  const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only',hayaku_packet_recovery:'false'}});
  try{
    const t=h.hayaku._test,query='Where is each item of the repository now, and who promised to return it?';
    const measure=(recallPreset,count)=>{
      const settings={...h.hayaku.settings(),recallPreset,maxItemsPerAxis:undefined,totalRowLimit:undefined};
      const selected=t.prepareHayakuRecallRows(rowsFor(count),query,settings,{worldlineHeadOrdinal:count},[],[]);
      return t.buildAtomicPacketCoreBudgetPlan({settings,selected,query,capChars:60000}).recallDataBudget;
    };
    const light=measure('light',60),balanced=measure('balanced',60),heavy=measure('heavy',60),sparse=measure('balanced',3);
    console.log(JSON.stringify({test:'hayaku_preset_budget',light:[light.tier,light.targetChars,light.actualChars],
      balanced:[balanced.tier,balanced.targetChars,balanced.actualChars],heavy:[heavy.tier,heavy.targetChars,heavy.actualChars],sparse:[sparse.tier,sparse.actualChars]}));
    assert.ok(light.actualChars<=3000&&light.targetChars<=3000,'the light preset never exceeds its 3,000 budget');
    assert.ok(balanced.actualChars<=7500&&heavy.actualChars<=16000);
    assert.ok(balanced.actualChars>3375,'selected evidence that did not fit the first step moves on toward the preset budget: '+balanced.actualChars);
    assert.ok(balanced.actualChars>light.actualChars,'a larger preset delivers more of the same selected evidence');
    assert.equal(sparse.tier,'standard','little evidence stays on the first step instead of padding the budget');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  }finally{await h.dispose();}
});
