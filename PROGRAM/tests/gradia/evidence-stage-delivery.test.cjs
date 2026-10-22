'use strict';
// Per-call evidence delivery across the four draft stages: model-specific fitting,
// prompt-duplicate omission and shared-reference prompt caching with evidence attached.
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture:legacyFixture}=require('./evidence-bridge.test.cjs');
const scope={scopeKey:'bound-scope',characterId:'character-library',chatId:'chat-evening'};
const character={chaId:scope.characterId,name:'Archivist',desc:'The archivist keeps the blue door and the reading room. '.repeat(40),personality:'Calm and exact.',
 globalLore:[{key:'door',content:'The blue door opens only at dusk, and only for a reader holding the brass key. '.repeat(30),alwaysActive:true,comment:'door'}],chats:[{id:scope.chatId,localLore:[]}],chatPage:0};
const preset=(context,model='gpt-4o-mini-2024-07-18',url='https://api.openai.com/v1/chat/completions')=>({provider:'openai',url,key:'synthetic-only',model,request_format:'chat_completions',
 context_window:context,max_tokens:4096,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:1000,stream:false});
const ASSISTANT='The archivist waited beside the blue door while the lamplight settled over the empty reading tables and the long shelves.';
const conversation=()=>[{role:'user',messageId:'turn-u-101',content:'The archivist opened the door.'},{role:'assistant',messageId:'turn-a-102',generationInfo:{generationId:'generation-a-2'},content:ASSISTANT},{role:'user',messageId:'turn-u-103',content:'Continue the scene.'}];
async function stageFixture({items=[],presets={offline:preset(128000)},stagePresets={},bind=true,expectedUrl=/^https:\/\/api\.openai\.com\/v1\/chat\/completions$/}={}){
 const f=await legacyFixture({server:true,testGlobals:{crypto:crypto.webcrypto},expectedUrl,api:{getCharacter:async()=>character}});
 f.settings.presets=presets;f.settings.defaultPresetName='offline';f.settings.stagePresetNames=stagePresets;
 if(bind){
  const owners=[...new Set(items.map(item=>item.owner))];
  const client={schema:'memory-suite.memory-read-client.v1',pluginId:'serial_gradation_agents_for_rp',openReadSession:async(_scope,options)=>({source:String(options?.source||'unified_engine'),
   snapshot:{schema:'memory-suite.memory-read-session.v1',scope,readOnly:true,complete:true,owners,items:items.map(item=>({...item,source:{namespace:item.owner,revision:1}})),
    evidenceRevision:'b'.repeat(64),corpusBytes:items.reduce((sum,item)=>sum+Buffer.byteLength(item.content),0),maxCorpusBytes:options.maxCorpusBytes},
   assertCurrentSync:()=>true,assertCurrent:async()=>true})};
  f.host.plugin.bindLibReadOnlyClient(client,{scope});
 }
 return {...f,runConversation:()=>f.host.pipeline(conversation(),'model',f.settings)};
}
const userText=body=>body.messages.filter(message=>message.role==='user').map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
const systemText=body=>body.messages.filter(message=>message.role==='system').map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');

test('each stage fits the full packet to its own model instead of inheriting an earlier smaller fit',async()=>{
 const items=Array.from({length:40},(_,i)=>({owner:'libra',id:'i'+i,key:'k'+i,content:'ITEM_'+i+'_ '+('memory'+i+' ').repeat(300)}));
 const f=await stageFixture({items,presets:{offline:preset(128000),small:preset(20000)},stagePresets:{shadow_act:'small'}});
 const r=await f.runConversation();assert.equal(r.ok,true);assert.equal(f.prompts.length,4);
 const counts=f.prompts.map(body=>items.filter((_,i)=>userText(body).includes('ITEM_'+i+'_')).length);
 assert.ok(counts[0]>0);for(const count of counts.slice(1))assert.ok(count>counts[0],JSON.stringify(counts));
 r.closeEvidence();
});

test('an evidence item already present verbatim in the request is omitted from that call',async()=>{
 const duplicate={owner:'flashback',id:'fb-1',key:'fb-1',content:'Assistant:\n'+ASSISTANT};
 const partial={owner:'flashback',id:'fb-2',key:'fb-2',content:'User:\nPARTIAL_SENTINEL Where did the river take the key?\n\n---\n\nAssistant:\n'+ASSISTANT};
 const unique={owner:'libra',id:'libra-1',key:'libra-1',content:'UNIQUE_MEMORY_SENTINEL The archivist once lost the brass key in the river.'};
 const short={owner:'hayaku',id:'hy-1',key:'hy-1',content:'blue door'};
 const f=await stageFixture({items:[duplicate,partial,unique,short]});
 const r=await f.runConversation();assert.equal(r.ok,true);assert.equal(f.prompts.length,4);
 for(const body of f.prompts){
  const user=userText(body),evidence=user.slice(user.indexOf('GRADIA EXTERNAL EVIDENCE'));
  assert.ok(!evidence.includes('fb-1'),'fully duplicated item omitted');
  assert.ok(evidence.includes('PARTIAL_SENTINEL'),'an item with any text missing from the request is kept');
  assert.ok(evidence.includes('UNIQUE_MEMORY_SENTINEL'));assert.ok(evidence.includes('hy-1'),'a short item is never treated as a duplicate');
 }
 const selection=f.host.plugin.getLibReadOnlyStatus().modelSelection;
 assert.equal(selection.duplicateItems,1);assert.equal(selection.selectedItems,3);assert.equal(selection.omittedItems,0);
 r.closeEvidence();
});

test('a packet made only of prompt duplicates still runs with an empty evidence block',async()=>{
 const duplicate={owner:'flashback',id:'fb-1',key:'fb-1',content:'Assistant:\n'+ASSISTANT};
 const f=await stageFixture({items:[duplicate]});
 const r=await f.runConversation();assert.equal(r.ok,true);assert.equal(f.prompts.length,4);
 for(const body of f.prompts){const user=userText(body),evidence=user.slice(user.indexOf('GRADIA EXTERNAL EVIDENCE'));assert.ok(user.includes('GRADIA EXTERNAL EVIDENCE'));assert.ok(!evidence.includes('fb-1'));}
 assert.equal(f.host.plugin.getLibReadOnlyStatus().modelSelection.selectedItems,0);
 r.closeEvidence();
});

test('evidence runs keep the shared reference prefix cacheable while evidence stays in the user tail',async()=>{
 const items=[{owner:'libra',id:'a',key:'a',content:'UNIQUE_MEMORY_SENTINEL The archivist once lost the brass key in the river.'}];
 const f=await stageFixture({items,presets:{offline:preset(128000,'gpt-5.6')}});
 const r=await f.runConversation();assert.equal(r.ok,true);assert.equal(f.prompts.length,4);
 const keys=new Set(f.prompts.map(body=>body.prompt_cache_key));assert.equal(keys.size,1);assert.match([...keys][0],/^gradia:shared-reference:/);
 for(const body of f.prompts){
  assert.deepEqual(body.messages[0].content.at(-1).prompt_cache_breakpoint,{mode:'explicit'});
  assert.ok(!systemText(body).includes('UNIQUE_MEMORY_SENTINEL'));assert.equal(userText(body).split('UNIQUE_MEMORY_SENTINEL').length-1,1);
  assert.ok(body.messages.at(-1).role==='user'&&typeof body.messages.at(-1).content==='string');
 }
 r.closeEvidence();
});

test('evidence runs send no cache fields to a non-first-party endpoint',async()=>{
 const items=[{owner:'libra',id:'a',key:'a',content:'UNIQUE_MEMORY_SENTINEL The archivist once lost the brass key in the river.'}];
 const url='https://proxy.offline.invalid/v1/chat/completions';
 const f=await stageFixture({items,presets:{offline:preset(128000,'gpt-5.6',url)},expectedUrl:/^https:\/\/proxy\.offline\.invalid\//});
 const r=await f.runConversation();assert.equal(r.ok,true);assert.equal(f.prompts.length,4);
 for(const body of f.prompts){assert.equal(body.prompt_cache_key,undefined);assert.ok(!JSON.stringify(body).includes('prompt_cache_breakpoint'));}
 r.closeEvidence();
});

test('native lightweight runs cache a shared prefix that several stages reuse',async()=>{
 const f=await stageFixture({bind:false,presets:{offline:preset(128000,'gpt-5.6')}});
 const r=await f.runConversation();assert.equal(r.ok,true);assert.equal(f.prompts.length,4);
 for(const body of f.prompts)assert.match(body.prompt_cache_key||'',/^gradia:shared-reference:/);
});
