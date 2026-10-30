'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const scope={characterId:'native-c',chatId:'native-h'};
const messages=()=>[{role:'user',content:'Open the cabinet.'},{role:'assistant',content:'The blue ledger rests on the upper shelf.'},{role:'user',content:'Where is the blue ledger?'}];
async function fixture(mutate,apiOverrides={},testGlobals={}){
  const chat={id:scope.chatId,message:messages().map((row,i)=>({role:row.role,chatId:'native-'+i,data:row.content}))};
  const character={chaId:scope.characterId,chats:[chat]};let selected=0;
  const host=await load({captureInternals:true,testGlobals,api:{getCurrentCharacterIndex:async()=>selected,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async()=>character,getChatFromIndex:async()=>chat,...apiOverrides},
    transformSource:source=>source.replace('clearStructuredSettings, fullDraftStagePrompt, Runtime };','clearStructuredSettings, fullDraftStagePrompt, Runtime, captureLibNativeReadSetFromHost, buildRecentChat };')});
  const api=host.internals,settings={...api.Runtime.settings},input=messages();
  mutate?.(chat,character,input);
  return {chat,character,input,settings,changeScope:()=>selected=1,bind:()=>api.captureLibNativeReadSetFromHost(input,settings,api.buildRecentChat(input,settings),scope)};
}
test('missing provider IDs bind to exact unique host messages without changing stage text',async()=>{
  const f=await fixture(),original=JSON.stringify(f.input),b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.ok(b.snapshot.turns.some(row=>row.ref.messageId==='native-1'));
  assert.equal(JSON.stringify(f.input),original);
  await b.assertCurrent();
  f.chat.message[1].data='The ledger has moved to the lower shelf.';
  await assert.rejects(()=>b.assertCurrent(),error=>error.code==='LIB_READ_NATIVE_CHANGED');
});
for(const kind of ['ambiguous','streaming','order','scope'])test(`host identity binding refuses ${kind}`,async()=>{
  const f=await fixture((chat,character)=>{
    if(kind==='ambiguous')chat.message.push({...chat.message[1],chatId:'different-a'});
    if(kind==='streaming')chat.message[1].isStreaming=true;
    if(kind==='order')chat.message=[chat.message[1],chat.message[0],chat.message[2]];
    if(kind==='scope')character.chaId='foreign-character';
  });
  await assert.rejects(()=>f.bind(),error=>/^LIB_READ_NATIVE_/.test(error.code));
});
test('host selection change revokes the mapping',async()=>{
  const f=await fixture(),b=await f.bind();f.changeScope();
  await assert.rejects(()=>b.assertCurrent(),error=>error.code==='LIB_READ_NATIVE_CHANGED');
});
test('unavailable selection cannot be coerced into character zero',async()=>{
  const f=await fixture(null,{getCurrentCharacterIndex:async()=>null});
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_NATIVE_SCOPE_CHANGED');
});
test('stuck native host lookup is bounded and cannot dispatch a model',async()=>{
  const f=await fixture(null,{getCurrentCharacterIndex:()=>new Promise(()=>{})},{setTimeout:(fn,ms)=>setTimeout(fn,ms===20000?5:ms)});
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_TIMEOUT');
});
