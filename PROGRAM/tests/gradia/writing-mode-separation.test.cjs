'use strict';
// Novel and RP contracts stay separate in every draft-stage prompt and in the final injection.
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture:legacyFixture}=require('./evidence-bridge.test.cjs');
const RP=/PLAYER-CONTROLLED|USER AGENCY|USER-AGENCY FRONTIER|AGENCY LEDGER/;
const NOVEL=/NOVEL MODE|NOVEL \/ CLASSIC|NOVEL CLASSIC MODE|INPUT-INCLUSIVE|FULL-CAST/;
const KO='등불이 서가를 비추고 기록은 조용히 움직였다. ';
async function draft(writingMode,novelDraftMode,multiPipelineMode){
 const stored=[],request=[{role:'system',content:'You are the narrator.'}];
 for(let t=0;t<3;t++){stored.push({role:'user',chatId:'u'+t,data:`민아는 ${t}번째 질문을 던진다.`},{role:'char',chatId:'a'+t,data:'준호가 대답했다. '+KO.repeat(20)});request.push({role:'user',content:`민아는 ${t}번째 질문을 던진다.`},{role:'assistant',content:'준호가 대답했다. '+KO.repeat(20)});}
 stored.push({role:'user',chatId:'u3',data:'민아는 열쇠를 꺼낸다.'});request.push({role:'user',content:'민아는 열쇠를 꺼낸다.'});
 const chat={id:'chat-evening',message:stored},character={chaId:'character-library',name:'준호',chats:[chat],chatPage:0};
 const f=await legacyFixture({server:true,unbound:true,testGlobals:{crypto:crypto.webcrypto},expectedUrl:/^https:\/\/api\.openai\.com\//,
  api:{getCharacter:async()=>character,getCharacterFromIndex:async()=>character,getChatFromIndex:async()=>chat,getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0}});
 await f.host.plugin.saveProviderPreset('offline',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'gpt-4o-mini-2024-07-18',request_format:'chat_completions',context_window:128000,max_tokens:4096,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:1000,stream:false});
 await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',lore_activation_mode:'off',writing_mode:writingMode,
  shadow_draft_mode:writingMode==='rp'?'author_directed':novelDraftMode,novel_shadow_draft_mode:novelDraftMode,multi_pipeline_mode:multiPipelineMode});
 const before=f.prompts.length,out=await f.host.hooks.beforeRequest(request,'model');
 const prompts=f.prompts.slice(before).map(body=>body.messages.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n'));
 const injection=(out||[]).map(m=>typeof m.content==='string'?m.content:'').filter(c=>/FINAL RESPONSE DRAFT|scene blueprint|GRADIA/i.test(c)).join('\n');
 return {prompts,injection};
}
for(const multiPipelineMode of ['lightweight','heavyweight']){
 test(`novel prompts carry no RP contract (${multiPipelineMode})`,async()=>{
  for(const novelDraftMode of ['classic','input_inclusive']){
   const {prompts,injection}=await draft('novel',novelDraftMode,multiPipelineMode);
   assert.equal(prompts.length,multiPipelineMode==='heavyweight'?8:4);
   prompts.forEach((prompt,index)=>{assert.ok(!RP.test(prompt),`${novelDraftMode} call ${index}: ${(prompt.match(new RegExp('.{0,80}('+RP.source+').{0,40}'))||[''])[0]}`);assert.ok(NOVEL.test(prompt));});
   const variant=novelDraftMode==='classic'?/NOVEL \/ CLASSIC|NOVEL CLASSIC MODE/:/INPUT-INCLUSIVE/;
   prompts.forEach(prompt=>assert.ok(variant.test(prompt),novelDraftMode+' variant'));
   assert.ok(injection&&!RP.test(injection));
  }
 });
 test(`RP prompts carry no Novel contract (${multiPipelineMode})`,async()=>{
  const {prompts,injection}=await draft('rp','input_inclusive',multiPipelineMode);
  assert.equal(prompts.length,multiPipelineMode==='heavyweight'?8:4);
  prompts.forEach((prompt,index)=>{assert.ok(!NOVEL.test(prompt),'call '+index);assert.ok(RP.test(prompt));});
  assert.ok(injection&&RP.test(injection)&&!NOVEL.test(injection));
 });
}
