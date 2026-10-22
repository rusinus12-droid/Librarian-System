'use strict';
// The draft pipeline continues from the latest stored scene, and leaves a request without a
// new user input (empty send, Continue, next group speaker) unchanged. Request messages carry
// no native IDs and no output receipts exist, as in RisuAI after a reload.
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture:legacyFixture}=require('./evidence-bridge.test.cjs');
const KO='등불이 서가를 비추고 기록은 조용히 움직였다. ';
const turnUser=t=>`TURN_${t}_USER 민아는 ${t}번째 질문을 던진다.`;
const turnReply=t=>`TURN_${t}_REPLY_HEAD 준호가 대답했다. `+KO.repeat(70)+` TURN_${t}_REPLY_TAIL`;
const CURRENT='CURRENT_INPUT 민아는 열쇠를 꺼낸다.';
function conversation({turns=8,current=CURRENT,extraStored=[],extraRequest=[],reroll=false}={}){
 const stored=[],request=[{role:'system',content:'You are the narrator.'}];
 for(let t=0;t<turns;t++){stored.push({role:'user',chatId:'u'+t,data:turnUser(t)},{role:'char',chatId:'a'+t,data:turnReply(t)});request.push({role:'user',content:turnUser(t)},{role:'assistant',content:turnReply(t)});}
 if(reroll){stored.pop();request.pop();}
 else if(current){stored.push({role:'user',chatId:'u'+turns,data:current});request.push({role:'user',content:current});}
 stored.push(...extraStored);request.push(...extraRequest);
 return {stored,request};
}
async function run(shape){
 const chat={id:'chat-evening',message:shape.stored};const character={chaId:'character-library',name:'준호',chats:[chat],chatPage:0};
 const f=await legacyFixture({server:true,unbound:true,testGlobals:{crypto:crypto.webcrypto},expectedUrl:/^https:\/\/api\.openai\.com\//,
  api:{getCharacter:async()=>character,getCharacterFromIndex:async()=>character,getChatFromIndex:async()=>chat,getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0}});
 await f.host.plugin.saveProviderPreset('offline',{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'gpt-4o-mini-2024-07-18',request_format:'chat_completions',context_window:128000,max_tokens:4096,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:1000,stream:false});
 await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',lore_activation_mode:'off'});
 const before=f.prompts.length,request=JSON.parse(JSON.stringify(shape.request));
 const out=await f.host.hooks.beforeRequest(request,'model');
 const prompts=f.prompts.slice(before);
 const user=index=>prompts[index]?.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n')||'';
 return {f,out,prompts,shadow:user(0),aide:user(1),request:shape.request};
}
const after=(body,label)=>{const i=body.indexOf(label);return i<0?'':body.slice(i+label.length);};

test('a normal send continues from the latest reply with the previous user input and the newest older turn',async()=>{
 const r=await run(conversation());assert.equal(r.prompts.length,4);
 const terminal=after(r.shadow,'[EXACT TERMINAL SCENE STATE');
 assert.ok(terminal.includes('TURN_7_REPLY_TAIL')&&!terminal.includes('TURN_6_REPLY'));
 assert.ok(r.shadow.includes('[직전 유저 입력')&&r.shadow.includes('TURN_7_USER'));
 assert.ok(r.aide.includes('[PREVIOUS USER INPUT')&&r.aide.includes('TURN_7_USER'));
 const older=r.shadow.slice(r.shadow.indexOf('[그보다 앞선 최근 완료 챗'),r.shadow.indexOf('[시스템 메시지]'));
 assert.ok(older.includes('TURN_6_REPLY_TAIL'),'newest older turn kept');assert.ok(!older.includes('TURN_0_USER'),'oldest turn dropped first');
});
test('an empty send, Continue or next group speaker is passed through without drafting',async()=>{
 for(const shape of [
  conversation({current:''}),
  conversation({current:'',extraStored:[{role:'char',chatId:'a8',saying:'s2',data:'SECOND_SPEAKER 수아가 끼어들었다.'}],extraRequest:[{role:'assistant',content:'SECOND_SPEAKER 수아가 끼어들었다.'}]})]){
  const r=await run(shape);
  assert.equal(r.prompts.length,0,'no draft stage ran');assert.deepEqual(JSON.parse(JSON.stringify(r.out)),r.request,'request unchanged');
  assert.equal(r.f.host.plugin.getRuntime().last.reason,'no_new_user_input_after_reply');
 }
});
test('a reroll and a preset prefill after a new input still draft',async()=>{
 const reroll=await run(conversation({reroll:true}));assert.equal(reroll.prompts.length,4);
 assert.ok(after(reroll.shadow,'[EXACT TERMINAL SCENE STATE').includes('TURN_6_REPLY_TAIL'));assert.ok(reroll.shadow.includes('TURN_7_USER'));
 const prefill=await run(conversation({extraRequest:[{role:'assistant',content:'Sure, the scene continues:'}]}));assert.equal(prefill.prompts.length,4);
 assert.ok(after(prefill.shadow,'[EXACT TERMINAL SCENE STATE').includes('TURN_7_REPLY_TAIL'));
});
