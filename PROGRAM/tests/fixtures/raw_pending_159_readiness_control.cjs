'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {test}=require('node:test');
const {createFlashback}=require('./raw_pending_portable_fixture.cjs');
const PROGRAM=path.resolve(__dirname,'../..');
const USER='I check the old brass key.';
const REPLY='The brass key opens the north library cabinet. A blue ribbon remains tied to its handle.';
const clone=value=>JSON.parse(JSON.stringify(value));
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('READINESS_BARRIER_TIMEOUT:'+label)),10000))]);}finally{clearTimeout(timer);}}
function registerReadinessControl(){test('manual portable target identity waits for the complete real observer identity callback',async()=>{
 const h=await createFlashback(PROGRAM,{holdNativeIdentity:true});let operation;
 try{
  const scope=await h.api.resolveCurrentScope(false),cfg=h.api._test.normalizeSettings({embeddingEnabled:false,enableGui:false});
  await h.api.saveSettings({...cfg,captureAfterRequest:true});
  await h.api._selectionTest.beforeRequest([{role:'user',chatId:'copy-u1',content:USER}],'model');
  const chat=await h.host.getCurrentChat(),character=await h.host.getCharacter();
  chat.message=[{role:'user',chatId:'copy-u1',data:USER},{role:'assistant',chatId:'copy-a1',data:REPLY}];chat.messages=chat.message;
  await h.api._test.processRisuChatOutputEvent({char:character,chat,characterIndex:0,chatIndex:0,messageIndex:1});
  const original=clone((await h.api._test.loadScopeRecords(scope.scopeKey)).records[0]);
  const portable=h.context.__FlashbackPortableMemoryBackup,backup=await portable.exportCurrentScope();
  await bounded(h.nativeFixture.identityEntered,'actual_native250ms_identity_phase');
  assert.equal(h.nativeFixture.state().tasks,1,'the real callback must already be issued, including held identity phase');
  let switched=false;
  operation=(async()=>{
   // Legacy probe executes the original export→target-switch boundary without an invented readiness helper.
   if(process.env.RAW_PENDING_OBSERVER_CONTROL_BOUNDARY!=='legacy')await h.closeNativeCopyObserver();
   const target={id:'raw-copy-target',chatId:'raw-copy-target',name:'Copy',message:clone(chat.message)};target.messages=target.message;
   character.chats.push(target);character.chatPage=1;
   h.host.getCurrentChatIndex=async()=>1;h.host.getCurrentChat=h.host.getChat=async()=>target;
   h.host.getChatFromIndex=async(_char,index)=>character.chats[index];switched=true;
   return portable.restoreCurrentScope(backup,{mode:portable.restoreModes.CHAT_COPY});
  })();operation.catch(()=>{});
  await Promise.resolve();
  assert.equal(await h.host.getCurrentChat(),chat,'manual target identity must remain unchanged while the actual observer identity callback is held');
  assert.equal(switched,false);
  assert.equal(h.nativeFixture.state().closed,true);
  assert.equal(h.nativeFixture.state().tasks,1);
  h.nativeFixture.releaseIdentity();assert.equal((await bounded(operation,'actual_full_callback_tail_then_restore')).ok,true);
  assert.deepEqual(h.nativeFixture.state(),{closed:true,handles:0,tasks:0});
  assert(h.nativeFixture.events.some(x=>x.event==='native_callback_settled'&&x.label==='initial'));
  assert(h.nativeFixture.events.some(x=>x.event==='native_admission_closed'),'actual issued poll tail must not admit rearm/followup producers after close');
  const restored=(await h.api._test.loadScopeRecords((await h.api.resolveCurrentScope(false)).scopeKey)).records[0];
  assert.equal(restored.text,original.text);assert.equal(restored.sourceHash,original.sourceHash);assert.equal(restored.embeddingWork.sourceRevision,original.embeddingWork.sourceRevision);
  assert.deepEqual(clone((await h.api._test.loadScopeRecords(scope.scopeKey)).records[0].embeddingWork),original.embeddingWork);assert.equal(h.networkCalls.length,0);
  console.log('READINESS159',JSON.stringify({boundary:process.env.RAW_PENDING_OBSERVER_CONTROL_BOUNDARY||'owned_close',state:h.nativeFixture.state(),events:h.nativeFixture.events}));
 }finally{h.nativeFixture.releaseIdentity();if(operation)await operation.catch(()=>{});console.log('READINESS159_FINAL',JSON.stringify({boundary:process.env.RAW_PENDING_OBSERVER_CONTROL_BOUNDARY||'owned_close',state:h.nativeFixture.state(),events:h.nativeFixture.events}));await h.cleanup();}
});}
module.exports={registerReadinessControl};if(require.main===module)registerReadinessControl();
