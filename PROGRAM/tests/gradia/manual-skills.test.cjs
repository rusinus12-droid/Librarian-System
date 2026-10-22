'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const stages=['shadow_act','aide_character','aide_world','aide_plot'];
const runtimeKey='serial_gradation_agents_for_rp:runtime_settings:v2';
const draft='DERIVED_DRAFT_SENTINEL The archivist rested one hand on the door. “Come in,” he said. The lamplight spread over the quiet room, and the clock continued its measured ticking.';
async function pipelineFixture(options={}){
 const prompts=[],h=await load({api:{nativeFetch:async(_url,init)=>{
  const body=JSON.parse(init.body);prompts.push(body);const system=body.messages.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
  const patch=system.match(/Return the compact (aide_\w+) patch JSON/),analysis=system.match(/Run (\w+) analysis now/);
  const content=patch?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:patch[1],ok:true,domain:{},analysis:{summary:'No changes necessary',constraints:[],risks:[]},edits:[]}):analysis?JSON.stringify({schema:'serial_gradation_agents_for_rp_analysis_v4',stage:analysis[1],ok:true,analysis:{summary:'Preserve the scene',constraints:['Preserve door'],risks:[]},domain:{continuity:'The archivist waits.',story_author_plan:{scene_purpose:'Continue the scene',beats:Array.from({length:24},(_,i)=>'Beat '+i)},director_brief:{required_outcomes:['Keep current scene']}},rewrite_directives:['Continue the current scene.']}):draft;
  if(options.contextFailure)throw Error('maximum context length is 8192 tokens; requested 30000 tokens');
  return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
 }}});
 await h.plugin.saveProviderPreset('offline',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',key:'synthetic',model:'offline-model',context_window:options.contextWindow??128000,max_tokens:4096,timeout_ms:5000,stream:false});
 await h.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:options.heavy?'heavyweight':'lightweight',
  failure_mode:'hard',lore_activation_mode:'off',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true,...options.runtime});
 return {h,prompts,run:(messages=[{role:'user',messageId:'u-current',content:'Continue the scene.'}])=>h.hooks.beforeRequest(messages,'model')};
}
for(const writingMode of ['novel','rp'])for(const heavy of [false,true])test(writingMode+' '+(heavy?'heavy':'light')+' NSFW guidance stays in internal model calls and preserves the host prefill at final handoff',async()=>{
 for(const [mode,enabled] of [['off',true],['soft',true],['explicit',false]]){
  const f=await pipelineFixture({heavy,runtime:{writing_mode:writingMode,nsfw_mode:mode,nsfw_guidance_enabled:String(enabled)}});
  const messages=[{role:'user',messageId:'u-current',content:'Continue the scene.'},{role:'assistant',content:'HOST_PREFILL_SENTINEL'}],original=JSON.stringify(messages);
  const out=await f.run(messages);assert.equal(f.prompts.length,heavy?8:4);assert.equal(JSON.stringify(messages),original);
  for(const body of f.prompts){
   assert.equal((JSON.stringify(body).match(/NSFW GUIDANCE —/g)||[]).length,mode!=='off'&&enabled?1:0);
  }
  assert.ok(out.some(m=>m.content?.includes(draft)),'the real draft reached the final handoff');
  assert.doesNotMatch(JSON.stringify(out),/NSFW GUIDANCE —|Activation gate: the selected mode|proposed USER input choices/);
  assert.deepEqual(JSON.parse(JSON.stringify(out.filter(m=>m.role==='assistant'))),messages.filter(m=>m.role==='assistant'));
 }
});
for(const writingMode of ['novel','rp'])test(writingMode+' nsfwInjectFinalRequest injects adult scene preservation guidance into final request',async()=>{
 for(const mode of ['soft','direct','explicit']){
  const f=await pipelineFixture({heavy:false,runtime:{writing_mode:writingMode,nsfw_mode:mode,nsfw_guidance_enabled:'true',nsfw_inject_final_request:'true'}});
  const messages=[{role:'user',messageId:'u-current',content:'Continue the scene.'},{role:'assistant',content:'HOST_PREFILL_SENTINEL'}];
  const out=await f.run(messages);
  const outStr=JSON.stringify(out);
  assert.ok(outStr.includes(`NSFW GUIDANCE — ${mode.toUpperCase()}:`), `final request must include ${mode} guidance`);
  assert.ok(outStr.includes('In final candidate finishing, preserve mature scenes and intimacy'), 'preservation instructions must be present in final request');
 }
});
test('debugNsfwGuidance covers all modes, phases, and injectFinal switch',async()=>{
 const h=await load();
 assert.equal(h.plugin.debugNsfwGuidance('off','writing',true,false),'');
 assert.equal(h.plugin.debugNsfwGuidance('off','final',true,true),'');
 assert.equal(h.plugin.debugNsfwGuidance('explicit','writing',false,false),'');
 assert.equal(h.plugin.debugNsfwGuidance('explicit','final',false,true),'');
 for(const mode of ['soft','direct','explicit']){
  const writingBlock=h.plugin.debugNsfwGuidance(mode,'writing',true,false);
  assert.ok(writingBlock.startsWith(`NSFW GUIDANCE — ${mode.toUpperCase()}:`));
  assert.ok(writingBlock.includes('Apply this mode to the actual prose only when supported'));
  assert.ok(!writingBlock.includes(`NSFW guidance is enabled in ${mode.toUpperCase()} mode`),'no redundant mode header line');
  const patchBlock=h.plugin.debugNsfwGuidance(mode,'patch',true,false);
  assert.ok(patchBlock.includes('Apply this mode only through domain-relevant edits to the current same-turn draft.'));
  const analysisBlock=h.plugin.debugNsfwGuidance(mode,'analysis',true,false);
  assert.ok(analysisBlock.includes('In private analysis, convert this mode into evidence-aware portrayal criteria'));
  assert.ok(!analysisBlock.includes('use aftermath or aftercare inside the current scene'),'analysis phase avoids prose drafting rules');
  const inputWriterBlock=h.plugin.debugNsfwGuidance(mode,'input_writer',true,false);
  assert.ok(inputWriterBlock.includes('Apply this mode only to proposed USER input choices supported by the current scene.'));
  assert.ok(!inputWriterBlock.includes('never script an unperformed player reaction'),'input_writer phase avoids conflicting prose-only player-reaction ban');
 }
 for(const mode of ['soft','direct','explicit']){
  assert.equal(h.plugin.debugNsfwGuidance(mode,'final',true,false),'');
 }
 for(const mode of ['soft','direct','explicit']){
  const block=h.plugin.debugNsfwGuidance(mode,'final',true,true);
  assert.ok(block.startsWith(`NSFW GUIDANCE — ${mode.toUpperCase()}:`));
  assert.ok(block.includes('In final candidate finishing, preserve mature scenes and intimacy already established'));
  assert.ok(!block.includes('use aftermath or aftercare inside the current scene'),'final guidance uses concise finishing rules instead of internal drafting rules');
 }
 const finalOverlayOff=h.plugin.debugBuildFinalOverlay('Candidate draft',{latestUser:'Continue.'},{writingMode:'novel',nsfwMode:'explicit',nsfwGuidanceEnabled:true,nsfwInjectFinalRequest:false});
 assert.ok(!finalOverlayOff.includes('NSFW GUIDANCE — EXPLICIT:'));
 const finalOverlayOn=h.plugin.debugBuildFinalOverlay('Candidate draft',{latestUser:'Continue.'},{writingMode:'novel',nsfwMode:'explicit',nsfwGuidanceEnabled:true,nsfwInjectFinalRequest:true});
 assert.ok(finalOverlayOn.includes('NSFW GUIDANCE — EXPLICIT:'));
});
test('NSFW runtime settings serialize, deserialize, and persist cleanly across GUI state roundtrips',async()=>{
 const probe={};
 const h=await load({
  testGlobals:{__nsfwGuiProbe:probe},
  transformSource:s=>s.replace('  const publicApi = Object.freeze({','  Object.assign(globalThis.__nsfwGuiProbe,{ensureGuiState,saveGuiState,settingsForGuiPreview,applyRecommendedSettingsToState,Gui});\n  const publicApi = Object.freeze({')
 });
 await h.plugin.saveRuntimeSettings({
  nsfw_mode:'direct',
  nsfw_guidance_enabled:'true',
  nsfw_inject_final_request:'true'
 });
 const stored=await h.plugin.getRuntimeSettings();
 assert.equal(stored.nsfw_mode,'direct');
 assert.equal(stored.nsfw_guidance_enabled,'true');
 assert.equal(stored.nsfw_inject_final_request,'true');
 const guiState=await probe.ensureGuiState(true);
 assert.equal(guiState.runtime.nsfwMode,'direct');
 assert.equal(guiState.runtime.nsfwGuidanceEnabled,true);
 assert.equal(guiState.runtime.nsfwInjectFinalRequest,true);
 await probe.saveGuiState();
 assert.equal(probe.Gui.state.runtime.nsfwInjectFinalRequest,true);
 assert.equal((await h.plugin.getRuntimeSettings()).nsfw_inject_final_request,'true');
 probe.Gui.state.runtime.nsfwInjectFinalRequest=false;
 assert.equal(probe.settingsForGuiPreview().nsfwInjectFinalRequest,false);
 probe.Gui.state.runtime.nsfwInjectFinalRequest=true;
 assert.equal(probe.settingsForGuiPreview().nsfwInjectFinalRequest,true);
 probe.applyRecommendedSettingsToState(probe.Gui.state);
 assert.equal(probe.Gui.state.runtime.nsfwInjectFinalRequest,false);
});
test('basic quality survives retired router flags and zero priorities in every stage and writing mode',async()=>{
 const h=await load();
 for(const writingMode of ['novel','rp'])for(const stage of stages){
  const r=h.plugin.debugSkillSelectionForStage(stage,{writingMode,enabled:false,priorities:{[stage]:{'scene-performance':0}}});
  assert.match(r.compiledExecution,/BASE QUALITY FLOOR/);assert.equal(r.baselineIds.length,writingMode==='rp'?7:6);
  assert.equal(r.baselineIds.includes('user-agency-boundary'),writingMode==='rp');assert.equal(r.selected.length,0);
  assert.ok(!r.compiledExecution.includes('[COMPILED SKILL'));assert.match(h.plugin.debugFinalQualityPreservation({writingMode}),/FINAL QUALITY PRESERVATION CONTRACT/);
 }
 assert.equal(h.getCalls(),0);assert.equal(h.plugin.debugRouteSkillsForStage,undefined);
});
test('explicit choices retain their order beyond the retired top-K and never duplicate baseline rules',async()=>{
 const h=await load(),ids=['physical-conflict','quiet-interior-beat','consequential-decision','information-exchange'];
 const r=h.plugin.debugSkillSelectionForStage('shadow_act',{selections:{shadow_act:[...ids,'scene-performance',ids[0]]},topK:1,enabled:false});
 assert.deepEqual(Array.from(r.selected,s=>s.id),ids);assert.equal(r.compiledExecution.includes('[COMPILED SKILL — scene-performance]'),false);
 assert.ok(ids.every((id,i)=>i===0||r.compiledExecution.indexOf('[COMPILED SKILL — '+id)>r.compiledExecution.indexOf('[COMPILED SKILL — '+ids[i-1])));
 assert.equal(h.plugin.debugSkillSelectionForStage('aide_world',{selections:{shadow_act:ids}}).selected.length,0);
});
test('reference documents require an explicit per-stage choice and stale references fail visibly',async()=>{
 const h=await load(),[id,skill]=Object.entries(h.plugin.getSkillLibrary()).find(([,s])=>!s.baseQuality&&s.references.length);
 const selections={shadow_act:[id]},without=h.plugin.debugSkillSelectionForStage('shadow_act',{selections});
 assert.equal(without.selected[0].references.length,0);assert.ok(!without.compiledExecution.includes('[MANUALLY SELECTED REFERENCE'));
 const ref=skill.references[0],r=h.plugin.debugSkillSelectionForStage('shadow_act',{selections,references:{shadow_act:{[id]:[ref.id]}}});
 assert.equal(r.selected[0].references[0].id,ref.id);assert.ok(r.compiledExecution.includes(ref.body));
 assert.throws(()=>h.plugin.debugSkillSelectionForStage('shadow_act',{selections,references:{shadow_act:{[id]:['missing-reference']}}}),/GRADIA_SKILL_REFERENCE_INVALID/);
});
test('old positive priorities never select skills and custom source text survives configuration loading',async()=>{
 const raw='---\nname: saved-custom\ndescription: Saved user procedure\n---\n# Keep this exact source\nSAVED_CUSTOM_BODY';
 const h=await load({storage:{[runtimeKey]:JSON.stringify({version:3,settings:{mode:'off',skill_router_enabled:'true',skill_router_top_k:3,skill_priority_overrides:{shadow_act:{'physical-conflict':200}},skill_custom_library:{saved:{id:'saved',raw}}}})}});
 await h.hooks.beforeRequest([{role:'user',content:'Explain the scene.'}],'model');
 const settings=h.plugin.getRuntime().settings;assert.ok(stages.every(stage=>settings.skillStageSelections[stage].length===0));
 assert.equal(settings.skillCustomLibrary.saved.raw,raw);assert.equal(settings.skillLegacyRouterSettings.skill_priority_overrides.shadow_act['physical-conflict'],200);
 assert.equal(h.getCalls(),0);
});
for(const heavy of [false,true])test((heavy?'heavy':'light')+' pipeline sends the selected procedures in every actual stage request with unchanged call counts',async()=>{
 const ids=['physical-conflict','quiet-interior-beat','consequential-decision','information-exchange'];
 const choices=Object.fromEntries(stages.map((stage,i)=>[stage,[ids[i]]]));
 const f=await pipelineFixture({heavy,runtime:{skill_stage_selections:choices,skill_router_enabled:'false'}});
 const out=await f.run();assert.equal(f.prompts.length,heavy?8:4);
 for(let i=0;i<f.prompts.length;i++){
  const text=JSON.stringify(f.prompts[i]),stage=stages[Math.floor(i/(heavy?2:1))];
  assert.ok(text.includes('BASE QUALITY FLOOR'));assert.ok(text.includes('[COMPILED SKILL — '+choices[stage][0]+']'),stage);
  assert.equal(text.split('BASE QUALITY FLOOR:').length-1,1);assert.equal(text.split('[COMPILED SKILL — '+choices[stage][0]+']').length-1,1);
  for(const id of ids.filter(id=>id!==choices[stage][0]))assert.ok(!text.includes('[COMPILED SKILL — '+id+']'));
 }
 assert.ok(out.some(row=>row.content?.includes(draft)));
 const trace=f.h.plugin.getRuntime().skillSelections;assert.deepEqual(Array.from(trace.aide_world.selected,s=>s.id),choices.aide_world);
 const usage=f.h.plugin.getLastRisuContext().stages.aide_world.materialsUsed;
 assert.equal(usage.counts.skills,1);assert.equal(usage.counts.baseQualityRules,6);assert.equal(usage.qualityRules.length,6);
});
test('a missing later-stage skill is rejected before any model call',async()=>{
 const f=await pipelineFixture({runtime:{skill_stage_selections:{aide_plot:['deleted-custom']}}});
 await assert.rejects(()=>f.run(),/GRADIA_SKILL_SELECTION_INVALID/);assert.equal(f.prompts.length,0);
});
test('a provider context error never retries a prompt with silently shortened manual procedures',async()=>{
 const f=await pipelineFixture({contextFailure:true,runtime:{skill_stage_selections:{shadow_act:['physical-conflict','quiet-interior-beat']}}});
 await assert.rejects(()=>f.run(),/선택한 Skill을 온전히 유지할 문맥/);assert.equal(f.prompts.length,1);
 for(const id of ['physical-conflict','quiet-interior-beat'])assert.ok(JSON.stringify(f.prompts[0]).includes(`[COMPILED SKILL — ${id}]`));
});
test('settings import retains explicit stage and reference choices without reinterpreting legacy priorities',async()=>{
 const h=await load(),raw='---\nname: saved\ndescription: Saved source\n---\nKeep the exact procedure.';
 const result=h.plugin.debugImportedRuntimeToGui({skill_stage_selections:{shadow_act:['saved']},skill_stage_references:{shadow_act:{saved:['child']}},skill_custom_library:{saved:{id:'saved',raw,references:[{id:'child',body:'Exact reference'}]}},skill_priority_overrides:{aide_world:{saved:200}}});
 assert.equal(result.skillStageSelections.shadow_act[0],'saved');assert.equal(result.skillStageReferences.shadow_act.saved[0],'child');assert.equal(result.skillCustomLibrary.saved.raw,raw);
 assert.equal(result.skillStageSelections.aide_world.length,0);
});
test('an unstructured user procedure retains its middle instead of silently applying the old truncation cap',async()=>{
 const h=await load(),raw='---\nname: complete\ndescription: Complete selected procedure\n---\n'+('begin '.repeat(1000))+'MIDDLE_MUST_SURVIVE'+(' tail'.repeat(1000));
 const r=h.plugin.debugSkillSelectionForStage('shadow_act',{selections:{shadow_act:['complete']},customSkills:{complete:{id:'complete',raw}}});
 assert.ok(r.compiledAnalysis.includes('MIDDLE_MUST_SURVIVE'));assert.ok(r.compiledExecution.includes('MIDDLE_MUST_SURVIVE'));assert.ok(!r.compiledExecution.includes('middle truncated'));
});
test('nine genre presets contain explicit stage and child-document choices and fit a 128k model in both modes',async()=>{
 const h=await load(),presets=h.plugin.getSkillGenrePresets(),library=h.plugin.getSkillLibrary();assert.equal(presets.length,9);
 for(const preset of presets)for(const writingMode of ['novel','rp'])for(const stage of stages){
  const selected=h.plugin.debugSkillSelectionForStage(stage,{writingMode,selections:preset.selections,references:preset.references,preset:{context_window:128000,max_tokens:4096}});
  assert.ok(selected.budget.fits,`${preset.id} ${writingMode} ${stage}: ${JSON.stringify(selected.budget)}`);
  assert.ok(selected.selected.length>0);assert.ok(selected.selected.every(s=>library[s.id]&&!library[s.id].baseQuality));
  if(preset.id!=='action'&&stage==='shadow_act')assert.equal(selected.selected[0].references.length,1);
 }
 assert.equal(h.getCalls(),0);
});
test('character admission charges full compiled procedures and child documents before any provider call',async()=>{
 const f=await pipelineFixture({runtime:{skill_stage_selections:{aide_plot:['physical-conflict','quiet-interior-beat','consequential-decision','information-exchange']}}});
 await assert.rejects(()=>f.run(),/추가 Skill.*한도/);assert.equal(f.prompts.length,0);
 const raw='---\nname: compact\ndescription: Compact source\n---\nKeep the current scene.';
 const customSkills=Object.fromEntries(['one','two','three','four','five'].map(id=>[id,{id,raw}]));
 const r=f.h.plugin.debugSkillSelectionForStage('shadow_act',{selections:{shadow_act:Object.keys(customSkills)},customSkills});
 assert.equal(r.selected.length,5);assert.ok(r.budget.fits,'the resource limit is characters, not the retired top-K');
 const refs=f.h.plugin.getSkillLibrary()['physical-conflict'].references;
 const withRefs=f.h.plugin.debugSkillSelectionForStage('shadow_act',{selections:{shadow_act:['physical-conflict']},references:{shadow_act:{'physical-conflict':refs.map(r=>r.id)}}});
 const noRefs=f.h.plugin.debugSkillSelectionForStage('shadow_act',{selections:{shadow_act:['physical-conflict']}});
 assert.ok(withRefs.budget.chars>=noRefs.budget.chars+refs.reduce((n,r)=>n+r.body.length,0));
});
test('the exact character ceiling fits and one extra source character rejects without truncation',async()=>{
 const h=await load(),preset={context_window:128000,max_tokens:4096};
 const options={preset,selections:{shadow_act:['sized']},customSkills:{sized:{id:'sized',raw:'---\nname: sized\ndescription: Sized source\n---\nX'}}};
 const initial=h.plugin.debugSkillSelectionForStage('shadow_act',options).budget;
 options.customSkills.sized.raw+='x'.repeat(initial.maxSkillChars-initial.chars);
 const exact=h.plugin.debugSkillPromptBudget('shadow_act',options);assert.equal(exact.chars,exact.maxSkillChars);
 options.customSkills.sized.raw+='x';assert.throws(()=>h.plugin.debugSkillPromptBudget('shadow_act',options),/한도/);
});
test('the complete input includes shared continuity, previous scene and analysis, with no space reclaimed from them',async()=>{
 const h=await load(),options={preset:{context_window:128000,max_tokens:4096},selections:{shadow_act:['physical-conflict']},shared:'LIBRA_CONTINUITY HAYAKU_CONTINUITY FLASHBACK_CONTINUITY LOREBOOK',system:'BASE_QUALITY SA_ANALYSIS AIDE_ANALYSIS PREVIOUS_TURN RECENT_N_TURNS'};
 const info=h.plugin.debugSkillPromptBudget('shadow_act',options);
 options.user='x'.repeat(info.maxInputChars-options.shared.length-options.system.length);
 assert.equal(h.plugin.debugSkillPromptBudget('shadow_act',options).inputChars,info.maxInputChars);
 const original={system:options.system,shared:options.shared,user:options.user};options.user+='x';
 assert.throws(()=>h.plugin.debugSkillPromptBudget('shadow_act',options),/전체 입력.*안전 입력 한도/);
 assert.equal(options.system,original.system);assert.equal(options.shared,original.shared);assert.equal(options.user,original.user+'x');
});
test('small or unknown model contexts cannot borrow core-data space to activate an oversized skill',async()=>{
 for(const contextWindow of [0,16000]){
  const f=await pipelineFixture({contextWindow,runtime:{skill_stage_selections:{shadow_act:['physical-conflict']}}});
  await assert.rejects(()=>f.run(),contextWindow?/한도/:/모델 문맥 크기/);assert.equal(f.prompts.length,0);
 }
});
test('actual heavyweight draft dispatch preserves all core source categories byte for byte when skills are enabled',async()=>{
 const probe={},sent=[],h=await load({testGlobals:{__skillProbe:probe},transformSource:s=>s.replace('  const publicApi = Object.freeze({','  Object.assign(globalThis.__skillProbe,{aideRewritePrompt,callLLMWithPreset,selectManualSkillsForStage});\n  const publicApi = Object.freeze({'),api:{nativeFetch:async(_url,init)=>{sent.push(JSON.parse(init.body));return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:draft},finish_reason:'stop'}]})};}}});
 const settings={activeStageName:'shadow_act',writingMode:'novel',shadowDraftMode:'story_author_directed',skillStageSelections:{shadow_act:['physical-conflict']},presets:{default:{provider:'custom',url:'https://synthetic.invalid/v1/chat/completions',key:'synthetic',model:'synthetic-model',context_window:128000,max_tokens:4096,stream:false}}};
 const markers=['EXACT_TERMINAL_SCENE','EXACT_RECENT_N_TURNS','EXACT_LIBRA_CONTINUITY','EXACT_HAYAKU_CONTINUITY','EXACT_FLASHBACK_CONTINUITY','EXACT_LOREBOOK','EXACT_SA_ANALYSIS','EXACT_AIDE_ANALYSIS'];
 const recent={latestUser:'Continue this scene.',terminalVisibleScene:markers[0],earlierTurnsText:markers[1],referencePacketBlock:markers.slice(2,6).join('\n'),skillSelection:probe.selectManualSkillsForStage('shadow_act',settings)};
 const analysis={analysis:{summary:markers[6],constraints:[markers[7]],risks:[]},domain:{},rewriteDirectives:[]};
 const prompts=probe.aideRewritePrompt('shadow_act',recent,null,settings,analysis,{});
 for(const marker of markers)assert.ok((prompts.system+prompts.user).includes(marker),marker);
 await probe.callLLMWithPreset(settings,'shadow_act',prompts.system,prompts.user,{promptPhase:'draft'});
 assert.equal(sent.length,1);const body=JSON.stringify(sent[0]);for(const marker of markers)assert.ok(body.includes(marker),marker);
 assert.ok(body.includes('[COMPILED SKILL — physical-conflict]'));
 const capacity=h.plugin.debugSkillPromptBudget('shadow_act',{preset:settings.presets.default,selections:settings.skillStageSelections});
 await assert.rejects(()=>probe.callLLMWithPreset(settings,'shadow_act',prompts.system,prompts.user+'x'.repeat(capacity.maxInputChars),{promptPhase:'draft'}),/전체 입력/);
 assert.equal(sent.length,1,'an over-limit complete request is refused before dispatch, not repacked');
});
test('custom skill currentness binds prompt contents rather than regenerated editor timestamps or retired priorities',async()=>{
 const probe={};await load({testGlobals:{__skillProbe:probe},transformSource:s=>s.replace('  const publicApi = Object.freeze({','  Object.assign(globalThis.__skillProbe,{requestSettingsSignature});\n  const publicApi = Object.freeze({')});
 const raw='---\nname: stable\ndescription: Stable source\n---\nKeep the scene.';
 const a={skillCustomLibrary:{stable:{raw,createdAt:1,updatedAt:2,defaultPriorities:{shadow_act:0}}}};
 const b={skillCustomLibrary:{stable:{raw,createdAt:3,updatedAt:4,defaultPriorities:{shadow_act:200}}}};
 assert.equal(probe.requestSettingsSignature(a),probe.requestSettingsSignature(b));
 b.skillCustomLibrary.stable.raw+=' Changed actual instructions.';
 assert.notEqual(probe.requestSettingsSignature(a),probe.requestSettingsSignature(b));
});
