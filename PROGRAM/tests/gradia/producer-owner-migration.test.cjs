'use strict';
// Semantic replacements for retired in-LIBRA producer workbenches. Run unchanged
// against the pre-redesign GRADIA baseline as well as the current owner.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {load}=require('./host.cjs');
test('NSFW guidance preserves all modes, internal phases and explicit disable',async()=>{
 const {plugin,getCalls}=await load();
 for(const phase of ['input_writer','analysis','writing','patch'])for(const mode of ['off','soft','direct','explicit']){
  const guidance=plugin.debugNsfwGuidance(mode,phase,true);
  if(mode==='off')assert.equal(guidance,'');else assert.match(guidance,new RegExp('NSFW GUIDANCE — '+mode.toUpperCase()));
  assert.equal(plugin.debugNsfwGuidance(mode,phase,false),'','disabled guidance must not enter prompts');
 }
 for(const writingMode of ['rp','novel'])for(const stage of ['shadow_act','aide_character','aide_world','aide_plot']){
  const soft=plugin.debugResolveCreativeDirection(stage,{}, {writingMode,nsfwMode:'soft',nsfwGuidanceEnabled:true});
  assert.match(soft,/NSFW GUIDANCE — SOFT/);
  assert.doesNotMatch(plugin.debugResolveCreativeDirection(stage,{}, {writingMode,nsfwMode:'soft',nsfwGuidanceEnabled:false}),/NSFW GUIDANCE/);
 }
 assert.equal(getCalls(),0);
});
test('NSFW input guidance treats choices as unsubmitted proposals under the active writing-mode authority',async()=>{
 const {plugin}=await load();
 const guidance=plugin.debugNsfwGuidance('soft','input_writer',true);
 assert.match(guidance,/proposed USER input choices/);assert.match(guidance,/unsubmitted candidates, not enacted events or an assistant response/);
 assert.match(guidance,/RP player-control or Novel author-direction contract/);
});
test('RP action advice and novel three-perspective direction retain distinct locked authorities',async()=>{
 const {plugin,getCalls}=await load();
 const rp=plugin.debugShadowDraftMode('author_directed'),novel=plugin.debugShadowDraftMode('input_inclusive');
 assert.match(rp.inputAssistContract,/PLAYER-CONTROLLED RP ACTION CHOICE ADVISER/);
 assert.match(rp.inputAssistContract,/alternative USER ACTION INPUTS/);
 assert.match(novel.inputAssistContract,/THREE-PERSPECTIVE AUTHOR-DIRECTION CHOICE ADVISER/);
 assert.match(novel.inputAssistContract,/EXACTLY 3 candidate AUTHOR INPUTS/);
 assert.notEqual(rp.contract,novel.contract);assert.equal(getCalls(),0);
});
test('headless RP and novel candidate pickers preserve original input without auto-adoption',async()=>{
 const {plugin,getCalls}=await load();
 for(const method of ['debugAuthorDirectedInputChoicePicker','debugNovelInputChoicePicker']){
  const result=await plugin[method]('ORIGINAL_OWNER_INPUT',[{id:'protagonist',brief:'UNAPPROVED_PROPOSAL'}]);
  assert.equal(result.action,'original');assert.equal(result.content,'ORIGINAL_OWNER_INPUT');assert.equal(result.choice,null);
 }
 assert.equal(getCalls(),0);
});
test('both writing modes hand off visible draft and exclude private stage analysis',async()=>{
 const {plugin,getCalls}=await load();
 const records=[{stage:'shadow_act',ok:true,draft:{rp_text:'VISIBLE_DRAFT'},analysis:{summary:'PRIVATE_ANALYSIS'}}],before=JSON.stringify(records);
 assert.equal(plugin.debugBuildInformationTransfer(records,'draft_and_analysis'),'');
 for(const writingMode of ['rp','novel']){
  const result=plugin.debugBuildFinalOverlayDetailed('VISIBLE_DRAFT',{latestUser:'USER_INPUT'}, {writingMode,informationTransferMode:'draft_and_analysis',outputMode:'risu_engine'});
  assert.equal(result.draftPreserved,true);assert.match(result.overlay,/VISIBLE_DRAFT/);assert.doesNotMatch(result.overlay,/PRIVATE_ANALYSIS/);
 }
 assert.equal(JSON.stringify(records),before);assert.equal(getCalls(),0);
});
