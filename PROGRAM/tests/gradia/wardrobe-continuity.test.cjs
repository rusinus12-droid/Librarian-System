'use strict';
// 복장 연속성: 겉옷을 벗은 장면 다음에 입은 상태로 등장하면 안 된다. SHADOW ACT 초안과
// 인물 AIDE(분석·패치) 모두 이 조건을 프롬프트에 받아야 하고, 대화 문맥과 현재 유저 입력의
// 우선순위도 함께 명시되어야 한다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const draft='DERIVED_DRAFT_SENTINEL She set the coat on the back of the chair and did not pick it up again.';
const WARDROBE='WARDROBE AND APPEARANCE CONTINUITY — HARD CONDITION:';
const ANCHORS=[
  'Treat every named garment, accessory, and item of footwear as state',
  'stays removed or open until the prose shows the physical action that reverses it',
  'Perform every change on the page',
  'a silently restored or newly invented garment is a defect'
];
const CONTEXT='CONVERSATION CONTEXT: the immediately preceding exchanges govern location, staging, wardrobe, mood, and commitments.';
const SUPREME='CURRENT USER INPUT IS SUPREME';

async function pipelineFixture(){
  const prompts=[],h=await load({api:{nativeFetch:async(_url,init)=>{
    const body=JSON.parse(init.body);prompts.push(body);
    const system=body.messages.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
    const patch=system.match(/Return the compact (aide_\w+) patch JSON/),analysis=system.match(/Run (\w+) analysis now/);
    const content=patch?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:patch[1],ok:true,domain:{},analysis:{summary:'No changes necessary',constraints:[],risks:[]},edits:[]}):analysis?JSON.stringify({schema:'serial_gradation_agents_for_rp_analysis_v4',stage:analysis[1],ok:true,analysis:{summary:'Keep the scene',constraints:['Keep the coat off'],risks:[]},domain:{continuity:'She has not put the coat back on.',story_author_plan:{scene_purpose:'Continue the scene',beats:Array.from({length:24},(_,i)=>'Beat '+i)},director_brief:{required_outcomes:['Keep current scene']}},rewrite_directives:['Keep the coat off.']}):draft;
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
  }}});
  await h.plugin.saveProviderPreset('offline',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',key:'synthetic',model:'offline-model',context_window:128000,max_tokens:4096,timeout_ms:5000,stream:false});
  await h.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:'lightweight',
    failure_mode:'hard',lore_activation_mode:'off',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true});
  return {h,prompts};
}
const bodyText=body=>JSON.stringify(body);

test('wardrobe continuity reaches the first draft and every AIDE stage exactly once per call',async()=>{
  const f=await pipelineFixture();
  await f.h.hooks.beforeRequest([{role:'user',messageId:'u-current',content:'She is still standing there without the coat.'}],'model');
  assert.equal(f.prompts.length,4,'lightweight: one draft, three AIDE calls');
  for(const [index,body] of f.prompts.entries()){
    const text=bodyText(body);
    assert.equal(text.split(WARDROBE).length-1,1,`call ${index} must carry the wardrobe contract once`);
    for(const anchor of ANCHORS)assert.ok(text.includes(anchor),`call ${index} missing: ${anchor}`);
    assert.ok(text.includes(SUPREME),`call ${index} must rank the current input above older evidence`);
  }
});

test('conversation context outranks older notes in the draft authority order',async()=>{
  const f=await pipelineFixture();
  await f.h.hooks.beforeRequest([{role:'user',messageId:'u-current',content:'She has not put the coat back on.'}],'model');
  const draft=bodyText(f.prompts[0]);
  assert.ok(draft.includes(CONTEXT),'recent conversation must outrank older notes');
  const supremeAt=draft.indexOf(SUPREME),noteRuleAt=draft.indexOf('A detail omitted from an agent note is not forbidden');
  assert.ok(supremeAt>=0,'the current input must be declared supreme');
  assert.ok(noteRuleAt>=0,'the ordinary-note rule must still exist');
  assert.ok(supremeAt<noteRuleAt,'the current input line must sit above the ordinary-note rule');
});
