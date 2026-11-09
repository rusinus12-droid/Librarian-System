'use strict';
// 장소 연속성: 직전 장면이 특정 방에서 끝났다면 다음 전개는 그 방에서 이어져야 하고,
// 장소가 바뀌면 이동이 화면에서 수행되어야 한다. SHADOW ACT 초안과 세계 AIDE(분석·패치)
// 모두 이 조건을 받아야 한다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const draft='DERIVED_DRAFT_SENTINEL She stayed in the reading room and set the lamp down on the same table.';
const LOCATION='LOCATION AND STAGING CONTINUITY — HARD CONDITION:';
const ANCHORS=[
  'Treat the current place as state',
  'Never relocate a character without a performed transition',
  'Do not open somewhere else because the scene would be easier there',
  'a location change without a narrated transition is a defect'
];

async function pipelineFixture(){
  const prompts=[],h=await load({api:{nativeFetch:async(_url,init)=>{
    const body=JSON.parse(init.body);prompts.push(body);
    const system=body.messages.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
    const patch=system.match(/Return the compact (aide_\w+) patch JSON/),analysis=system.match(/Run (\w+) analysis now/);
    const content=patch?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:patch[1],ok:true,domain:{},analysis:{summary:'No changes necessary',constraints:[],risks:[]},edits:[]}):analysis?JSON.stringify({schema:'serial_gradation_agents_for_rp_analysis_v4',stage:analysis[1],ok:true,analysis:{summary:'Keep the room',constraints:['Stay in the reading room'],risks:[]},domain:{continuity:'The reading room persists.',story_author_plan:{scene_purpose:'Continue the scene',beats:Array.from({length:24},(_,i)=>'Beat '+i)},director_brief:{required_outcomes:['Keep current scene']}},rewrite_directives:['Stay in the reading room.']}):draft;
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
  }}});
  await h.plugin.saveProviderPreset('offline',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',key:'synthetic',model:'offline-model',context_window:128000,max_tokens:4096,timeout_ms:5000,stream:false});
  await h.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:'lightweight',
    failure_mode:'hard',lore_activation_mode:'off',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true});
  return {h,prompts};
}

test('location continuity reaches the first draft and every AIDE stage exactly once per call',async()=>{
  const f=await pipelineFixture();
  await f.h.hooks.beforeRequest([{role:'user',messageId:'u-current',content:'She looks at the same window she was standing beside.'}],'model');
  assert.equal(f.prompts.length,4,'lightweight: one draft, three AIDE calls');
  for(const [index,body] of f.prompts.entries()){
    const text=JSON.stringify(body);
    assert.equal(text.split(LOCATION).length-1,1,`call ${index} must carry the location contract once`);
    for(const anchor of ANCHORS)assert.ok(text.includes(anchor),`call ${index} missing: ${anchor}`);
    assert.ok(text.includes('exchanges govern location'),`call ${index} must rank live place above older notes`);
  }
});
