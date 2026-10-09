const {test}=require('node:test');const assert=require('node:assert/strict');const {load}=require('./host.cjs');
const user=(id,data)=>({role:'user',chatId:id,data});const ai=(id,data,extra={})=>({role:'char',chatId:id,data,...extra});
function fixture(messages,extra={}){const chat={id:'chat-a',message:messages,...extra};const char={id:'char-a',chats:[chat],chatPage:0};const listeners={};return {chat,char,listeners,options:{api:{getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async()=>char,getChatFromIndex:async()=>chat,getCharacter:async()=>char,addRisuChatListener:async(k,fn)=>listeners[k]=fn,removeRisuChatListener:async k=>delete listeners[k]}}};}
test('historical stopped output closed by actual next user is visible history, not engine completion',async()=>{
 const f=fixture([user('u1','old'),ai('a1','stopped visible partial'),user('u2','new')]);const before=JSON.stringify(f.chat);
 const {plugin}=await load(f.options);assert.equal(typeof plugin.debugNativeRecentContext,'function');
 const result=await plugin.debugNativeRecentContext('new','u2',8);
 assert.equal(result.recentTurnCount,1);assert.equal(result.turnEligibility.selected[0].proofKind,'closed_conversation_boundary');
 assert.equal(result.turnEligibility.selected[0].assistant.messageId,'a1');assert.ok(result.turnEligibility.selected[0].assistant.contentHash);assert.equal(JSON.stringify(f.chat),before);
});
test('active stream, error, comment and disabled output never count as completed pairs',async()=>{
 for(const [extra,content,chatExtra] of [[{},'partial',{isStreaming:true}],[{},'failed\n```risuerror\nerror\n```',{}],[{isComment:true},'comment',{}],[{disabled:true},'disabled',{}],[{},'',{}]]){
 const f=fixture([user('u1','old'),ai('a1',content,extra)],chatExtra);const {plugin}=await load(f.options);
 const result=await plugin.debugNativeRecentContext('new','u2',8);assert.equal(result.recentTurnCount,0);assert.ok(result.turnEligibility.excluded.length>0);
 }
});
test('current input native identity resolves repeated text without consuming it twice',async()=>{
 const f=fixture([user('u1','again'),ai('a1','first'),user('u2','again'),ai('a2','second'),user('u3','again')]);const {plugin}=await load(f.options);
 const result=await plugin.debugNativeRecentContext('again','u3',8);assert.equal(result.recentTurnCount,2);assert.equal(result.currentUser.messageId,'u3');assert.equal(result.selectedCurrentInputCount,1);
});
test('trailing assistant without next user or matching output event is unknown, never guessed prefill',async()=>{
 const f=fixture([user('u1','old'),ai('a1','tail')]);const {plugin}=await load(f.options);
 const result=await plugin.debugNativeRecentContext('',null,8);assert.equal(result.recentTurnCount,0);assert.ok(result.turnEligibility.excluded.some(x=>x.reason==='unknown_trailing_completion'));
 const resolution=plugin.resolveCurrentUserInput([{role:'user',content:'old'},{role:'assistant',content:'tail'},{role:'user',content:'current'}]);assert.equal(resolution.text,'current');assert.equal(resolution.terminalPrefillIndex,-1);
});
test('output event proof binds scope, message, generation and exact raw-content hash',async()=>{
 const f=fixture([user('u1','old'),ai('a1','committed',{generationInfo:{generationId:'g1'}})]);const {plugin}=await load(f.options);assert.equal(typeof f.listeners.output,'function');
 await f.listeners.output({char:f.char,chat:structuredClone(f.chat),characterIndex:0,chatIndex:0,messageIndex:1});
 let result=await plugin.debugNativeRecentContext('',null,8);assert.equal(result.recentTurnCount,1);assert.equal(result.turnEligibility.selected[0].proofKind,'verified_completion');
 f.chat.message[1].data='replacement variant';result=await plugin.debugNativeRecentContext('',null,8);assert.equal(result.recentTurnCount,0);
 f.chat.message.push(user('u2','continue'));result=await plugin.debugNativeRecentContext('continue','u2',8);assert.equal(result.recentTurnCount,1);assert.equal(result.turnEligibility.selected[0].proofKind,'closed_conversation_boundary');
});
test('disabled all-before and a later invalid assistant cannot resurrect an earlier variant',async()=>{
 const f=fixture([user('u0','older'),ai('a0','older answer'),user('barrier','disabled',{disabled:'allBefore'}),user('u1','current'),ai('a1','old candidate'),ai('a2','failed\n```risuerror\nfailure\n```'),user('u2','next')]);
 f.chat.message[2].disabled='allBefore';const {plugin}=await load(f.options);const result=await plugin.debugNativeRecentContext('next','u2');assert.equal(result.recentTurnCount,0);
});
test('completion receipts cannot cross chat or generation identity',async()=>{
 const f=fixture([user('u1','old'),ai('a1','RAW_COMPLETED_TEXT',{generationInfo:{generationId:'g1'}})]);const {plugin}=await load(f.options);
 await f.listeners.output({char:f.char,chat:structuredClone(f.chat),messageIndex:1});
 f.chat.id='chat-b';let result=await plugin.debugNativeRecentContext('',null);assert.equal(result.recentTurnCount,0);
 f.chat.id='chat-a';f.chat.message[1].generationInfo.generationId='g2';result=await plugin.debugNativeRecentContext('',null);assert.equal(result.recentTurnCount,0);
});
test('legacy native history without IDs stays a closed-boundary tier without invented identities',async()=>{
 const f=fixture([{role:'user',data:'old'},{role:'char',data:'old answer'},{role:'user',data:'new'}]);const {plugin}=await load(f.options);const result=await plugin.debugNativeRecentContext('new',null);
 assert.equal(result.recentTurnCount,1);assert.equal(result.turnEligibility.selected[0].proofKind,'closed_conversation_boundary');assert.equal(result.turnEligibility.selected[0].assistant.messageId,null);
});
test('Input Writer retains verified terminal context without adopting an unsubmitted proposal',async()=>{
 const f=fixture([user('u1','old'),ai('a1','committed scene')]);const {plugin}=await load(f.options);
 await f.listeners.output({char:f.char,chat:structuredClone(f.chat),messageIndex:1});
 const before=JSON.stringify(f.chat);const messages=await plugin.debugInputAssistContextMessages('UNSUBMITTED_PROPOSAL');
 assert.ok(messages.some(m=>m.role==='assistant'&&m.content.includes('committed scene')));
 assert.ok(messages.some(m=>m.role==='user'&&m.content==='UNSUBMITTED_PROPOSAL'));
 const recent=plugin.debugBuildRecentChat(messages);assert.ok(recent.latestAssistant.includes('committed scene'));assert.equal(recent.recentTurnCount,0);assert.equal(JSON.stringify(f.chat),before);
});
test('Input Writer does not use an active stream as terminal scene or close it with a proposal',async()=>{
 const f=fixture([user('u1','old'),ai('a1','ACTIVE_PARTIAL')],{isStreaming:true});const {plugin}=await load(f.options);
 const messages=await plugin.debugInputAssistContextMessages('UNSUBMITTED_PROPOSAL');assert.ok(!JSON.stringify(messages).includes('ACTIVE_PARTIAL'));
});
test('completion receipts are bounded and listener denial keeps closed history available',async()=>{
 const f=fixture([user('u1','old'),ai('a1','original')]);const {plugin}=await load(f.options);
 await f.listeners.output({char:f.char,chat:structuredClone(f.chat),messageIndex:1});
 for(let i=0;i<256;i++){const chat={id:'chat-a',message:[user('u1','old'),ai(`event-${i}`,`completion ${i}`)]};await f.listeners.output({char:f.char,chat,messageIndex:1});}
 const trailing=await plugin.debugNativeRecentContext('',null);assert.equal(trailing.recentTurnCount,0);
 const denied=fixture([user('u1','old'),ai('a1','visible'),user('u2','new')]);denied.options.api.requestPluginPermission=async()=>false;
 const isolated=await load(denied.options);assert.equal(denied.listeners.output,undefined);const closed=await isolated.plugin.debugNativeRecentContext('new','u2');assert.equal(closed.recentTurnCount,1);assert.equal(closed.turnEligibility.selected[0].proofKind,'closed_conversation_boundary');
});
test('reroll-bound current native user excludes its replaced assistant variant from history',async()=>{
 const f=fixture([user('u1','prior'),ai('a1','prior answer'),user('u2','same text'),ai('a2','REPLACED_VARIANT')]);const {plugin}=await load(f.options);
 const result=await plugin.debugNativeRecentContext('same text','u2',8);assert.equal(result.recentTurnCount,1);assert.ok(!result.completeTurnsText.includes('REPLACED_VARIANT'));assert.equal(result.currentUser.messageId,'u2');
});
test('one group user turn retains all distinct native assistants and speakers in order',async()=>{
 const f=fixture([user('u1','question'),ai('a1','FIRST',{saying:'speaker-1'}),ai('a2','SECOND',{saying:'speaker-2'}),user('u2','next')]);const {plugin}=await load(f.options);
 const result=await plugin.debugNativeRecentContext('next','u2');assert.equal(result.recentTurnCount,1);assert.ok(result.completeTurnsText.indexOf('FIRST')<result.completeTurnsText.indexOf('SECOND'));
 const refs=result.turnEligibility.selected[0];assert.equal(refs.assistant,null);assert.deepEqual(Array.from(refs.assistants,x=>x.messageId),['a1','a2']);assert.deepEqual(Array.from(refs.assistants,x=>x.speakerId),['speaker-1','speaker-2']);
});
test('group completion requires all output receipts; one active or invalid member excludes group',async()=>{
 const f=fixture([user('u1','question'),ai('a1','FIRST'),ai('a2','SECOND')]);const {plugin}=await load(f.options);
 await f.listeners.output({char:f.char,chat:structuredClone(f.chat),messageIndex:2});let result=await plugin.debugNativeRecentContext('',null);assert.equal(result.recentTurnCount,0);
 await f.listeners.output({char:f.char,chat:structuredClone(f.chat),messageIndex:1});result=await plugin.debugNativeRecentContext('',null);assert.equal(result.recentTurnCount,1);assert.equal(result.turnEligibility.selected[0].proofKind,'verified_completion');
 f.chat.isStreaming=true;result=await plugin.debugNativeRecentContext('next','u2');assert.equal(result.recentTurnCount,0);
 f.chat.isStreaming=false;f.chat.message[2].data='```risuerror\nfailed\n```';result=await plugin.debugNativeRecentContext('next','u2');assert.equal(result.recentTurnCount,0);
});
test('duplicate native assistant identity follows only last selected snapshot record',async()=>{
 const f=fixture([user('u1','question'),ai('a1','OLD_VARIANT'),ai('a1','SELECTED_VARIANT'),user('u2','next')]);const {plugin}=await load(f.options);
 const result=await plugin.debugNativeRecentContext('next','u2');assert.equal(result.recentTurnCount,1);assert.ok(!result.completeTurnsText.includes('OLD_VARIANT'));assert.ok(result.completeTurnsText.includes('SELECTED_VARIANT'));
});
test('n-window omits only entire old groups and preserves selected scope references',async()=>{
 const f=fixture([user('u1','first'),ai('a1','first-1'),ai('a2','first-2'),user('u2','second'),ai('a3','second-1'),ai('a4','second-2'),user('u3','current')]);const {plugin}=await load(f.options);
 const result=await plugin.debugNativeRecentContext('current','u3',1);assert.equal(result.recentTurnCount,1);assert.equal(result.turnEligibility.omittedWholeTurnsForWindow,1);assert.equal(result.turnEligibility.partialTurnsIncluded,false);assert.ok(!result.completeTurnsText.includes('first-'));assert.ok(result.completeTurnsText.includes('second-1'));assert.ok(result.completeTurnsText.includes('second-2'));assert.equal(result.turnEligibility.selected[0].assistants[0].scope,JSON.stringify(['char-a','chat-a']));
});
test('group participant event receipts bind the owning group room at captured index',async()=>{
 const f=fixture([user('u1','question'),ai('a1','FIRST',{saying:'speaker-1'}),ai('a2','SECOND',{saying:'speaker-2'})]);
 f.char.id='room-a';f.char.type='group';f.char.characters=['speaker-1','speaker-2'];
 const before=JSON.stringify(f.chat);const {plugin}=await load(f.options);
 for(let i=1;i<=2;i++) await f.listeners.output({char:{chaId:`speaker-${i}`,type:'character'},chat:structuredClone(f.chat),characterIndex:0,chatIndex:0,messageIndex:i});
 const result=await plugin.debugNativeRecentContext('',null);assert.equal(result.recentTurnCount,1);assert.equal(result.turnEligibility.selected[0].proofKind,'verified_completion');
 assert.equal(result.turnEligibility.selected[0].assistants[0].scope,JSON.stringify(['room-a','chat-a']));
 const messages=await plugin.debugInputAssistContextMessages('PROPOSAL');assert.ok(messages.some(m=>m.role==='assistant'&&m.content.includes('SECOND')));assert.equal(JSON.stringify(f.chat),before);
});
test('different explicit current identity never binds a terminal same-text native user',async()=>{
 const f=fixture([user('u1','old'),ai('a1','answer'),user('u-terminal','again')]);const {plugin}=await load(f.options);
 const result=await plugin.debugNativeRecentContext('again','u-new');assert.equal(result.currentUser.messageId,'u-new');assert.equal(result.selectedCurrentInputCount,1);
});
test('request fallback does not revive a replaced assistant after empty selected variant',async()=>{
 const {plugin}=await load();const result=plugin.debugBuildRecentChat([{role:'user',memo:'u1',content:'past'},{role:'assistant',memo:'a1',content:'OLD_VARIANT'},{role:'assistant',memo:'a1',content:''},{role:'user',memo:'u2',content:'next'}]);
 assert.equal(result.recentTurnCount,0);assert.ok(!result.latestAssistant.includes('OLD_VARIANT'));
});
test('group receipt lookup rejects mismatched chat ownership and group membership',async()=>{
 for(const kind of ['wrong-chat','wrong-speaker','missing-chat']){
  const f=fixture([user('u1','question'),ai('a1','ANSWER',{saying:'speaker-1'})]);f.char.id='room-a';f.char.type='group';f.char.characters=['speaker-1'];
  const {plugin}=await load(f.options);
  // The captured lookup resolves to a mismatching owner; the native debug reader still sees the room.
  if(kind==='wrong-chat') f.char.chats=[{id:'other-chat',message:[]}];
  if(kind==='wrong-speaker') f.char.characters=['other-speaker'];
  if(kind==='missing-chat') f.char.chats=[];
  await f.listeners.output({char:{chaId:'speaker-1',type:'character'},chat:structuredClone(f.chat),characterIndex:0,chatIndex:0,messageIndex:1});
  f.char.chats=[f.chat];f.char.characters=['speaker-1'];const result=await plugin.debugNativeRecentContext('',null);assert.equal(result.recentTurnCount,0,kind);
 }
});
test('request fallback keeps blocking identity for selected metadata variants',async()=>{
 const {plugin}=await load();for(const content of ['<Others Info>meta</Others Info>','system: metadata']){
  const result=plugin.debugBuildRecentChat([{role:'user',memo:'u1',content:'past'},{role:'assistant',memo:'a1',content:'OLD_VARIANT'},{role:'assistant',memo:'a2',content:'OTHER_MEMBER'},{role:'assistant',memo:'a1',content,disabled:true},{role:'user',memo:'u2',content:'next'}]);
  assert.equal(result.recentTurnCount,0);assert.ok(!result.latestAssistant.includes('OLD_VARIANT'));
 }
});
