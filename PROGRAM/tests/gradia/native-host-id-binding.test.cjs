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

test('Current Input wrapper binds to the exact live user while preserving the prompt',async()=>{
  const f=await fixture((_chat,_character,input)=>{
    input[2]={role:'user',content:'<Current Input>\nWhere is the blue ledger?\n</Current Input>'};
  });
  const original=JSON.stringify(f.input),b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'Where is the blue ledger?');
  assert.equal(JSON.stringify(f.input),original);
  await b.assertCurrent();
  f.chat.message[2].data='A different current input.';
  await assert.rejects(()=>b.assertCurrent(),error=>error.code==='LIB_READ_NATIVE_CHANGED');
});

test('fenced Current Input transport keeps the live raw identity',async()=>{
  const f=await fixture((_chat,_character,input)=>{
    input[2]={role:'user',content:'<Current Input>\n```\nWhere is the blue ledger?\n```\n</Current Input>'};
  });
  const b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'Where is the blue ledger?');
  await b.assertCurrent();
});

// Short inputs ("계속", "…") recur across a chat. An earlier, answered turn with
// the same text must not make the current wrapped input unbindable.
test('wrapped input binds the latest live user when an answered turn repeats its text',async()=>{
  const f=await fixture((chat,_character,input)=>{
    chat.message[0].data='Where is the blue ledger?';
    input[0]={role:'user',content:'Where is the blue ledger?'};
    input[2]={role:'user',content:'<Current Input>\nWhere is the blue ledger?\n</Current Input>'};
  });
  const b=await f.bind();
  assert.equal(b.snapshot.currentInputRef.messageId,'native-2');
  assert.equal(b.snapshot.currentInput,'Where is the blue ledger?');
  await b.assertCurrent();
});

for(const kind of ['duplicate','partial','streaming','historical'])test(`wrapped input refuses ${kind} live identity`,async()=>{
  const f=await fixture((chat,_character,input)=>{
    input[2]={role:'user',content:'<Current Input>\nWhere is the blue ledger?\n</Current Input>'};
    if(kind==='duplicate')chat.message.push({...chat.message[2],chatId:'another-user'});
    if(kind==='partial')chat.message[2].data='Where is the blue ledger? Add unrelated instructions.';
    if(kind==='streaming')chat.message[2].isStreaming=true;
    if(kind==='historical')chat.message.push({role:'user',chatId:'newer-user',data:'A different pending request.'});
  });
  await assert.rejects(()=>f.bind(),error=>error.code==='LIB_READ_NATIVE_ID_UNAVAILABLE');
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
