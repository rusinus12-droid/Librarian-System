'use strict';
// Deterministic selection audit. Synthetic host, no model/provider calls.
const path=require('node:path'),assert=require('node:assert/strict');
const {load}=require(path.join(process.env.PROGRAM_DIR||path.resolve(__dirname,'../..'),'tests/gradia/host.cjs'));
async function run(){
 const h=await load(),ids=['physical-conflict','quiet-interior-beat'];let checks=0;
 for(const writingMode of ['novel','rp'])for(const stage of ['shadow_act','aide_character','aide_world','aide_plot']){
  const empty=h.plugin.debugSkillSelectionForStage(stage,{writingMode});assert.match(empty.compiledExecution,/BASE QUALITY FLOOR/);assert.equal(empty.selected.length,0);
  assert.equal(empty.baselineIds.includes('user-agency-boundary'),writingMode==='rp');
  const selected=h.plugin.debugSkillSelectionForStage(stage,{writingMode,selections:{[stage]:ids}});
  assert.deepEqual(Array.from(selected.selected,s=>s.id),ids);assert.ok(selected.budget.fits);
  assert.ok(ids.every(id=>selected.compiledExecution.includes(`[COMPILED SKILL — ${id}]`)));checks++;
 }
 assert.equal(h.getCalls(),0);console.log(JSON.stringify({engine:'gradia_manual_skill_selection_v1',stageModeChecks:checks,passed:true,providerCalls:0}));
}
module.exports={run};
if(require.main===module)run().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
