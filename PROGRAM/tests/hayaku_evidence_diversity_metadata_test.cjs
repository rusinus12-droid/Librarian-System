'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
test('bounded diversity uses public evidence rather than rendered provenance fields',async()=>{
 const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only',hayaku_packet_recovery:'false'}});
 try{
  const t=h.hayaku._test,settings={...h.hayaku.settings(),maxItemsPerAxis:4},query='What was established in the repository?';
  const texts=['location: repository / time: afternoon','summary: Maren cabinet holds a lapis latch.','summary: Ivo drawer contains an ochre bobbin.','summary: Vesna alcove keeps a silver spindle.'];
  const visibility={privacy:'',ownerEntityId:'',holderEntityIds:[],visibleToEntityIds:[],deniedToEntityIds:[],unresolvedEntityRefs:false};
  const rows=Array.from({length:20},(_,i)=>({id:'source-'+i,publicRef:'source-'+i,packetHash:'packet-'+i,axis:i===0?'world':i<4?'narrative':'planner',category:i===0?'current_state':i<4?'summary_memory':'continuity_lock',publicText:texts[i]||'summary: The custodian remains associated with the repository.',visibility,_localRecall:true,_recallDirectRank:i+1,score:1/(61+i),locator:{sourcePairIndex:i+1,worldlineOrdinal:i+1,messageIndex:2*i+1}}));
  const selected=t.prepareHayakuRecallRows(rows,query,settings,{worldlineHeadOrdinal:20},[],[]);
  const plan=t.selectHayakuEvidencePlan(selected,query,settings,1800);
  for(const text of texts.slice(1))assert.ok(plan.text.includes(text),'a distinct established fact survives the finite render budget');
  assert.ok(plan.text.length<=1800);assert.ok(plan.renderedEntries<=12);
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
 }finally{await h.dispose();}
});
