'use strict';
// 모델 컨텍스트를 넘기는 요청은 실패시키지 않고, 출력 예약 → 공유 참조 → 기억 증거 순서로
// 버리면서 진행한다. ①턴이 실제로 완주하는지 ②무엇을 버렸는지 기록되는지 ③줄어든 출력 예산이
// 실제 요청 본문에 반영되는지를 확인한다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ipcHost}=require('./ipc_connection_fixture.cjs');

const DRAFT='DEGRADED_DRAFT She stayed in the reading room and kept her voice low.';
const ROWS=[{chatId:'u1',role:'user',data:'그녀는 도서관에 서 있었다.'}];

function modelStub(prompts){
  return async (_url,init)=>{
    const body=JSON.parse(init.body);prompts.push(body);
    const system=(body.messages||[]).filter(m=>m.role==='system').map(m=>String(m.content)).join('\n');
    const patch=system.match(/Return the compact (aide_\w+) patch JSON/);
    const content=patch?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:patch[1],ok:true,domain:{},analysis:{summary:'no change',constraints:[],risks:[]},edits:[]}):DRAFT;
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};
  };
}

test('an oversized request is degraded and the loss is recorded instead of failing the turn',async t=>{
  const prompts=[];
  const f=await ipcHost(t,{chatMessages:ROWS,onModel:modelStub(prompts)});
  await f.host.plugin.saveProviderPreset('tight',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',key:'synthetic',
    model:'tight-model',context_window:16000,max_tokens:16384,timeout_ms:5000,stream:false});
  await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'tight',input_assist_mode:'off',multi_pipeline_mode:'lightweight',
    failure_mode:'hard',lore_activation_mode:'off',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true});
  await f.connect();
  assert.equal(f.status().connection.state,'connected');
  const out=await f.host.hooks.beforeRequest(ROWS.map(row=>({role:row.role,content:row.data,messageId:row.chatId,chatId:row.chatId})),'model');
  assert.equal(prompts.length,4,'the pipeline still runs all four calls');
  assert.ok(JSON.stringify(out).includes(DRAFT),'the degraded run still delivers a draft');
  const record=f.host.plugin.getRuntime().lastContextDegradation;
  assert.ok(record,'the degradation is recorded for the run results');
  assert.equal(record.stage,'shadow_act');
  assert.ok(record.dropped.includes('output_tokens'),`output reservation was not reduced: ${JSON.stringify(record.dropped)}`);
  assert.ok(record.outputAfter<record.outputBefore,'the output reservation shrank');
  assert.equal(record.contextLimit,16000);
  const draftBudget=Number(prompts[0].max_tokens||prompts[0].max_completion_tokens||0);
  assert.ok(draftBudget>0&&draftBudget<16384,`the request carried the reduced budget (got ${draftBudget})`);
  assert.ok(!JSON.stringify(prompts[0]).includes('memory:'),'no owner memory text is forced into the oversized draft');
});

test('a context too small for its own prompt still fails after the ladder and is recorded',async t=>{
  const prompts=[];
  const f=await ipcHost(t,{chatMessages:ROWS,onModel:modelStub(prompts)});
  await f.host.plugin.saveProviderPreset('micro',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',key:'synthetic',
    model:'micro-model',context_window:900,max_tokens:1024,timeout_ms:5000,stream:false});
  await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'micro',input_assist_mode:'off',multi_pipeline_mode:'lightweight',
    failure_mode:'soft',lore_activation_mode:'off',enable_shadow_act:true,enable_character_aide:false,enable_world_aide:false,enable_plot_aide:false});
  await f.connect();
  await f.host.hooks.beforeRequest(ROWS.map(row=>({role:row.role,content:row.data,messageId:row.chatId,chatId:row.chatId})),'model');
  const record=f.host.plugin.getRuntime().lastContextDegradation;
  assert.ok(record,'the failed attempt records the context it could not fit');
  assert.equal(record.contextLimit,900);
  assert.equal(prompts.length,0,'nothing is dispatched when no degradation can make it fit');
});

test('an unset context window uses the model heuristic instead of the ollama 32k default',async t=>{
  const prompts=[];
  const f=await ipcHost(t,{chatMessages:ROWS,onModel:modelStub(prompts)});
  await f.host.plugin.saveProviderPreset('hosted',{provider:'custom',url:'https://ollama.com/v1/chat/completions',key:'synthetic',
    model:'deepseek-v4.1-flash:1017-cloud',max_tokens:16384,timeout_ms:5000,stream:false});
  await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'hosted',input_assist_mode:'off',multi_pipeline_mode:'lightweight',
    failure_mode:'hard',lore_activation_mode:'off',enable_shadow_act:true,enable_character_aide:false,enable_world_aide:false,enable_plot_aide:false});
  await f.connect();
  assert.equal(f.status().connection.state,'connected');
  await f.host.hooks.beforeRequest(ROWS.map(row=>({role:row.role,content:row.data,messageId:row.chatId,chatId:row.chatId})),'model');
  const runtime=f.host.plugin.getRuntime();
  const budget=runtime.lastLibModelBudget;
  assert.ok(budget,'the evidence gate records which context it used');
  assert.equal(budget.limit,1000000,'the model heuristic wins over the 32,768 route fallback');
  assert.equal(budget.source,'model_heuristic');
  assert.ok(!runtime.lastContextDegradation,'nothing has to be dropped at the real model size');
});

// NPC 반응 경향성 adds a long block to every stage. On a small model it is condensed first (the
// fixed stances and the NPC list stay), then left out of that stage, and the turn never fails.
const FOUR_NPCS=[{name:'준호',level:'affection'},{name:'민아',level:'dislike'},{name:'세라',level:'like'},{name:'도윤',level:'acquaintance'}];
// The prompt's base size varies by a few hundred tokens between runs, so the drop case uses a cast
// whose condensed rows alone (16 NPCs with notes) cannot fit beside it on a 16k model.
const MANY_NPCS=Array.from({length:16},(_,i)=>({name:'인물'+i,level:'hostile',note:'페르소나를 오래전 사건의 원흉으로 여기며 공개적인 자리에서도 적의를 감추지 않는다 '.repeat(3).slice(0,190)}));
const dispositionRun=async(t,contextWindow,npcs=FOUR_NPCS)=>{
  const prompts=[];
  const f=await ipcHost(t,{chatMessages:ROWS,onModel:modelStub(prompts)});
  await f.host.plugin.saveProviderPreset('tight',{provider:'custom',url:'https://offline.invalid/v1/chat/completions',key:'synthetic',
    model:'tight-model',context_window:contextWindow,max_tokens:16384,timeout_ms:5000,stream:false});
  await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'tight',input_assist_mode:'off',multi_pipeline_mode:'lightweight',
    failure_mode:'hard',lore_activation_mode:'off',enable_shadow_act:true,enable_character_aide:true,enable_world_aide:true,enable_plot_aide:true});
  await f.connect();
  const send=()=>f.host.hooks.beforeRequest(ROWS.map(row=>({role:row.role,content:row.data,messageId:row.chatId,chatId:row.chatId})),'model');
  await send();
  const key=f.host.plugin.debugActiveScopeKey();
  await f.host.plugin.saveRuntimeSettings({...await f.host.plugin.getRuntimeSettings(),npc_disposition:JSON.stringify({[key]:{default:'hostile',npcs}})});
  prompts.length=0;
  const out=await send();
  return {f,prompts,out,record:f.host.plugin.getRuntime().contextDegradations.find(item=>item.stage==='shadow_act'&&String(item.dropped).includes('npc_disposition'))};
};

test('NPC disposition is condensed when the full block does not fit, keeping the stances',async t=>{
  const {prompts,out,record}=await dispositionRun(t,16600);
  assert.equal(prompts.length,4,'the turn runs');
  assert.ok(JSON.stringify(out).includes(DRAFT));
  assert.ok(record,'the disposition step is recorded');
  assert.ok(record.dropped.includes('npc_disposition_detail'));
  assert.ok(!record.dropped.includes('npc_disposition'),'the condensed block fits, so it is not dropped');
  const shadow=JSON.stringify(prompts[0]);
  assert.ok(shadow.includes('NPC DISPOSITION (반응 경향성)'),'the block header stays');
  assert.ok(shadow.includes('- 준호: affection (애정)'),'the stances stay');
  assert.ok(shadow.includes('it never drifts, and lore decides only how it shows'),'the condensed rule stays');
  assert.ok(!shadow.includes('LEVELS IN USE'),'the long explanation is gone');
});

test('NPC disposition is left out of a stage with no room rather than failing the turn',async t=>{
  const {prompts,out,record}=await dispositionRun(t,16000,MANY_NPCS);
  assert.equal(prompts.length,4,'the turn runs');
  assert.ok(JSON.stringify(out).includes(DRAFT));
  assert.ok(record&&record.dropped.includes('npc_disposition'),'the drop is recorded');
  assert.ok(!JSON.stringify(prompts[0]).includes('NPC DISPOSITION (반응 경향성)'),'the SHADOW request carries no disposition');
  assert.ok(JSON.stringify(out).includes('[NPC DISPOSITION GUARD]'),'the final pass keeps its own guard');
});
