'use strict';
// 비앙카 투입: 설정을 켜면 BIANCA 워크스페이스 페르소나 전문(§0~§11)이 첫 초안(SHADOW) 호출에 들어가고,
// AIDE 분석·패치 호출에는 성인 소재 계약(§9~§11)만 남는다. 최종 요청에는 어느 쪽도 들어가지 않는다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const draft='DERIVED_DRAFT_SENTINEL The archivist rested one hand on the door. “Come in,” he said. The lamplight spread over the quiet room, and the clock continued its measured ticking.';
const PERSONA_HEADER='BIANCA WORKSPACE PERSONA';
const PERSONA_ANCHORS=[
  '0. THE NOTE',                          // §0 — 인격 해석 규칙
  '8. CHECKS BEFORE COMMITTING A SCENE',  // §8 — 장면 점검
  '9. MATURE MATERIAL',                   // §9 — 성인 소재 계약
  'Level 3 — Direct, Explicit'            // §9 직접 묘사 등급
];
const CONTRACT_ANCHORS=['NSFW GUIDANCE — EXPLICIT:','Boundaries Are Facts','Descriptive Register — Level 3'];
async function pipelineFixture(runtime={}){
  const prompts=[],h=await load({api:{nativeFetch:async(_url,init)=>{
    const body=JSON.parse(init.body);prompts.push(body);
    const system=body.messages.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
    const patch=system.match(/Return the compact (aide_\w+) patch JSON/),analysis=system.match(/Run (\w+) analysis now/);
    const content=patch?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:patch[1],ok:true,domain:{},analysis:{summary:'No changes necessary',constraints:[],risks:[]},edits:[]}):analysis?JSON.stringify({schema:'serial_gradation_agents_for_rp_analysis_v4',stage:analysis[1],ok:true,analysis:{summary:'Preserve the scene',constraints:['Preserve door'],risks:[]},domain:{continuity:'The archivist waits.',story_author_plan:{scene_purpose:'Continue the scene',beats:Array.from({length:24},(_,i)=>'Beat '+i)},director_brief:{required_outcomes:['Keep current scene']}},rewrite_directives:['Continue the current scene.']}):draft;
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
  }}});
  await h.plugin.saveProviderPreset('offline',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',key:'synthetic',model:'offline-model',context_window:128000,max_tokens:4096,timeout_ms:5000,stream:false});
  await h.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:'lightweight',
    failure_mode:'hard',lore_activation_mode:'off',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true,...runtime});
  return {h,prompts,run:(messages=[{role:'user',messageId:'u-current',content:'Continue the scene.'}])=>h.hooks.beforeRequest(messages,'model')};
}
const countOf=(body,needle)=>JSON.stringify(body).split(needle).length-1;

test('비앙카 투입 is off by default and never leaks into prompts or the final handoff',async()=>{
  const f=await pipelineFixture();
  const settings=await f.h.plugin.getRuntimeSettings();
  assert.notEqual(settings.bianca_inject,'true','the switch must default to off');
  const out=await f.run();
  assert.equal(f.prompts.length,4);
  for(const body of f.prompts)assert.equal(countOf(body,PERSONA_HEADER),0,'switched off must not inject the persona');
  assert.equal(countOf(out,PERSONA_HEADER),0);
});

test('비앙카 투입 injects the whole persona into the first draft only and stays out of the final request',async()=>{
  const f=await pipelineFixture({bianca_inject:'true',nsfw_mode:'explicit',nsfw_guidance_enabled:'true'});
  const messages=[{role:'user',messageId:'u-current',content:'Continue the scene.'},{role:'assistant',content:'HOST_PREFILL_SENTINEL'}];
  const out=await f.run(messages);
  assert.equal(f.prompts.length,4);
  const counts=f.prompts.map(body=>countOf(body,PERSONA_HEADER));
  assert.equal(counts.reduce((a,b)=>a+b,0),1,'the persona belongs to the first draft call only');
  assert.equal(counts[0],1,'the SHADOW ACT call carries the persona');
  const personaPrompt=JSON.stringify(f.prompts[0]);
  for(const anchor of PERSONA_ANCHORS)assert.ok(personaPrompt.includes(anchor),`persona section missing: ${anchor}`);
  for(const body of f.prompts.slice(1)){
    assert.equal(countOf(body,PERSONA_HEADER),0,'AIDE calls must not repeat the whole persona');
    for(const anchor of CONTRACT_ANCHORS)assert.ok(JSON.stringify(body).includes(anchor),`AIDE calls keep the mature contract: ${anchor}`);
  }
  assert.equal(countOf(out,PERSONA_HEADER),0,'final request must not receive the persona');
  assert.ok(out.some(m=>m.content?.includes(draft)),'the real draft reached the final handoff');
  assert.deepEqual(JSON.parse(JSON.stringify(out.filter(m=>m.role==='assistant'))),messages.filter(m=>m.role==='assistant'));
});

test('비앙카 투입 adds one persona copy per turn, not one per stage call',async()=>{
  const runOnce=async bianca=>{
    const f=await pipelineFixture({bianca_inject:bianca?'true':'false',nsfw_mode:'explicit',nsfw_guidance_enabled:'true'});
    await f.run();
    return f.prompts.reduce((sum,body)=>sum+JSON.stringify(body).length,0);
  };
  const off=await runOnce(false),on=await runOnce(true);
  assert.ok(on>off,'turning the switch on must add the persona text');
  assert.ok(on-off<25000,`the persona must be injected once per turn (added ${on-off} chars)`);
});

test('비앙카 투입 round-trips through runtime settings',async()=>{
  const h=await load();
  assert.notEqual((await h.plugin.getRuntimeSettings()).bianca_inject,'true');
  await h.plugin.saveRuntimeSettings({bianca_inject:'true'});
  assert.equal((await h.plugin.getRuntimeSettings()).bianca_inject,'true');
  await h.plugin.saveRuntimeSettings({bianca_inject:'false'});
  assert.notEqual((await h.plugin.getRuntimeSettings()).bianca_inject,'true');
});
