'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
test('Input Assist carries a whole long lore entry under the configured 12000-character cap',async()=>{
  const lore='The valve controls the library steam pipe. '+ 'x'.repeat(8800)+' LORE_TAIL_KEPT';
  const chat={id:'assist-cap-chat',message:[{role:'user',chatId:'u1',data:'Inspect the valve.'}]};
  const character={chaId:'assist-cap-character',name:'Archivist',globalLore:[{key:'valve',content:lore,alwaysActive:true,comment:'valve'}],chats:[chat],chatPage:0};
  const h=await load({captureInternals:true,transformSource:s=>s.replace('fullDraftStagePrompt, Runtime };','fullDraftStagePrompt, Runtime, buildShadowRisuContext, inputAssistLoreBlock };'),api:{
    getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,
    getCharacterFromIndex:async()=>character,getChatFromIndex:async()=>chat,getDatabase:async()=>({characters:[character]})
  }});
  const settings={activeStageName:'input_assist',quickProfile:'balanced',stageOptions:{input_assist:{max_chars:12000}},
    presets:{default:{provider:'ollama_cloud',model:'deepseek-v4.1-flash:1017-cloud',max_tokens:16384}},
    inputAssistLoreActivationMode:'unified',loreActivationMode:'unified'};
  const refs={authorNote:false,persona:false,characterDescription:false,characterLorebook:true,moduleLorebook:false};
  const build=()=>h.internals.buildShadowRisuContext([{role:'user',content:'Inspect the valve.'}],{
    latestUser:'Inspect the valve.',inputAssistTerminalOnly:true,inputAssistLoreQuery:'valve',messages:[]
  },settings,null,refs);
  const context=await build();
  assert.equal(context.referenceCapacity.profileCapChars,12000);
  assert.ok(context.block.includes('LORE_TAIL_KEPT'),'whole lore survives reference selection');
  assert.ok(h.internals.inputAssistLoreBlock(context.block,settings).includes('LORE_TAIL_KEPT'),'prompt assembly does not apply a second 6400-character cut');
  settings.stageOptions.input_assist.max_chars=6000;
  const smaller=await build();assert.equal(smaller.referenceCapacity.profileCapChars,6000);
  assert.ok(!smaller.block.includes('LORE_TAIL_KEPT'),'explicit smaller cap is respected');
  assert.equal(h.getCalls(),0);
});
