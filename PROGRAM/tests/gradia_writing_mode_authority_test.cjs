'use strict';
// What each writing mode actually tells the stage model and the response model.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/gradia_input_writer_unified_fixture.cjs');
const systemOf=body=>body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
const textOf=body=>body.messages.map(m=>m.content).join('\n');
async function run(t,{writingMode,scope,input='민아에게 열쇠를 건넨다.'}){
 const f=await fixture(t,{writingMode,unified:false});
 f.controls.output='민아는 은빛 열쇠를 확인하고 문 앞에서 기다렸다. The grounded scene continued in the quiet room.';
 await f.host.plugin.saveRuntimeSettings({...await f.host.plugin.getRuntimeSettings(),mode:'lite',default_preset:'writer',input_assist_mode:'off',writing_mode:writingMode,multi_pipeline_mode:'lightweight',enable_shadow_act:true,enable_character_aide:false,enable_world_aide:false,enable_plot_aide:false,failure_mode:'hard',lore_activation_mode:'off',...(scope?{rp_impersonation_scope:scope}:{})});
 const messages=[...f.chat.message.map(row=>({role:row.role,content:row.data,chatId:row.chatId,messageId:row.chatId})),{role:'user',content:input,chatId:'u9',messageId:'u9'}];
 f.chat.message.push({role:'user',chatId:'u9',data:input});
 const output=await f.host.hooks.beforeRequest(messages,'model');
 assert.ok(f.prompts.length>=1,'the pipeline called the stage model');
 return {prompt:f.prompts[0],final:output.map(row=>String(row.content||'')).join('\n')};
}
test('persona only: the cast and development stay with the model, and lines count as impersonation',async t=>{
 const {prompt,final}=await run(t,{writingMode:'rp'});
 const system=systemOf(prompt);
 assert.match(system,/THE PERSONA MAY NOT BE INVENTED/);assert.match(system,/not one line of dialogue may be made up for the persona/);
 assert.match(system,/Other characters and development are yours/);assert.match(system,/NPC\/world/,'existing NPC autonomy stays');
 assert.match(final,/THE PERSONA MAY NOT BE INVENTED/,'the response model hears it too');
 assert.match(system,/END ON THE NEXT CHOICE/);assert.match(system,/has not been written yet: show it first/,'what the input states about others is shown');
 assert.doesNotMatch(system,/naturally completed model-owned beat|Natural model-owned closure is valid|closure\/transition is valid/,'an ending that closes everything is no longer offered');
});
test('scene staging: the user decides every character, the model stages them and moves the world',async t=>{
 const {prompt,final}=await run(t,{writingMode:'rp',scope:'persona_cast'});
 const system=systemOf(prompt);
 assert.match(system,/RP SCENE-STAGING MODE/);assert.match(system,/including what the persona does and says/);assert.match(system,/expression, gesture, tone, and breath/);assert.match(system,/END ON A SEED: finish on one change in the surroundings that moves no character/);assert.match(system,/not one line of dialogue may be made up/);
 assert.match(system,/Changes in the world are yours too/);assert.match(system,/outside the main situation of the persona and the other characters/);
 assert.doesNotMatch(system,/NPC\/world|model-owned|MODEL-OWNED AUTONOMY/,'no line hands NPCs back to the model');
 assert.match(final,/RP SCENE-STAGING MODE/);assert.doesNotMatch(final,/NPC\/world may act autonomously/);
});
test('prose mode: the model only writes out what the input states',async t=>{
 const {prompt,final}=await run(t,{writingMode:'rp',scope:'all'});
 const system=systemOf(prompt);
 assert.match(system,/RP PROSE MODE/);assert.match(system,/Add no action, reaction, decision, feeling, or development beyond it/);assert.match(system,/a short input gives a short response/);assert.match(system,/END ON A SEED: add no event/);
 assert.doesNotMatch(system,/Changes in the world are yours/);assert.doesNotMatch(system,/NPC\/world|model-owned/);
 assert.match(textOf(prompt),/적힌 내용을 빠짐없이, 적힌 순서대로 감각 묘사와 함께 문장으로 옮겨라/);
 assert.match(final,/RP PROSE MODE/);
});
for(const input of ['"열쇠는 네가 가져."','“열쇠는 네가 가져.” “나는 괜찮아.”','「열쇠는 네가 가져.」'])test('quoted speech alone is the persona speaking: '+input,async t=>{
 const {prompt}=await run(t,{writingMode:'rp',input});
 assert.match(textOf(prompt),/INPUT TYPE: the input is only quoted speech\. It is the persona's own spoken line/);
});
test('quotes inside a direction are not treated as persona speech alone',async t=>{
 const {prompt}=await run(t,{writingMode:'rp',input:'민아에게 "열쇠는 네가 가져."라고 말한다.'});
 assert.doesNotMatch(textOf(prompt),/INPUT TYPE: the input is only quoted speech/);
});
test('novel mode takes the input as a starting point and allows added development',async t=>{
 const {prompt,final}=await run(t,{writingMode:'novel'});
 const system=systemOf(prompt);
 assert.match(textOf(prompt),/FULL AUTONOMY: the input is a starting point, not a limit/);
 assert.match(system,/additional actions and story developments for anyone are allowed/);
 assert.match(textOf(prompt),/USER PERSONA IS MODEL-AUTHORABLE/);
 assert.match(textOf(prompt),/END ON A SEED: deepen the current scene and stop just before it resolves/,'a novel response leaves the next turn something to start from');
 assert.doesNotMatch(system,/not forward into a later scene|must not require a time skip|RP DETAIL MODE/);
 assert.doesNotMatch(final,/Expand inward, not forward|Do not append a sequel scene/);
 assert.match(final,/FULL AUTONOMY/,'the response model hears it too');
});
