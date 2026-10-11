'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {test}=require('node:test');
const {createFlashback}=require('./raw_pending_159_diagnostic_harness.cjs');
const PROGRAM=path.resolve(__dirname,'../..');
const USER='I check the old brass key.';
const REPLY='The brass key opens the north library cabinet. A blue ribbon remains tied to its handle.';
const clone=value=>JSON.parse(JSON.stringify(value));
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('CONTROL_BARRIER_TIMEOUT:'+label)),10000))]);}finally{clearTimeout(timer);}}
async function prepare(controlRestore){
 const h=await createFlashback(PROGRAM,{controlObserver:true,controlRestore});
 try{
  const scope=await h.api.resolveCurrentScope(false);
  const cfg=h.api._test.normalizeSettings({embeddingEnabled:false,enableGui:false});
  await h.api.saveSettings({...cfg,captureAfterRequest:true});
  await h.api._selectionTest.beforeRequest([{role:'user',chatId:'copy-u1',content:USER}],'model');
  const chat=await h.host.getCurrentChat(),character=await h.host.getCharacter();
  chat.message=[{role:'user',chatId:'copy-u1',data:USER},{role:'assistant',chatId:'copy-a1',data:REPLY}];chat.messages=chat.message;
  await h.api._test.processRisuChatOutputEvent({char:character,chat,characterIndex:0,chatIndex:0,messageIndex:1});
  const original=clone((await h.api._test.loadScopeRecords(scope.scopeKey)).records[0]);
  const portable=h.context.__FlashbackPortableMemoryBackup;
  const backup=await portable.exportCurrentScope();
  const entered=await bounded(h.control.observerEntered,'actual250ms_observer_entry');
  assert.equal(entered.reason,'observer_initial_scope','control must originate in the genuine scheduled initial poll');
  const target={id:'raw-copy-target',chatId:'raw-copy-target',name:'Copy',message:clone(chat.message)};target.messages=target.message;
  character.chats.push(target);character.chatPage=1;
  h.host.getCurrentChatIndex=async()=>1;h.host.getCurrentChat=h.host.getChat=async()=>target;
  h.host.getChatFromIndex=async(_char,index)=>character.chats[index];
  const inspected=await portable.inspectRestoreOptions(backup);
  assert.equal(inspected.modes[portable.restoreModes.CHAT_COPY].allowed,true,'actual target must be empty before releasing scheduled adoption');
  return {h,scope,original,portable,backup};
 }catch(error){h.control.releaseObserver();h.control.releaseRestore();await h.cleanup();throw error;}
}
async function assertOriginalPreserved(f){const again=(await f.h.api._test.loadScopeRecords(f.scope.scopeKey)).records[0];assert.deepEqual(clone(again.embeddingWork),f.original.embeddingWork);assert.equal(again.text,f.original.text);assert.equal(f.h.networkCalls.length,0);}
function registerObserverControls(){
test('real scheduled observer adoption makes portable copy refuse the now nonempty target',async()=>{
 const f=await prepare(false);
 try{
  f.h.control.releaseObserver();const result=await bounded(f.h.control.observerCompleted,'genuine_adoption_completion');
  assert.equal(result.lastResult?.adopted,true,'genuine observer must actually adopt before the refusal control');
  assert(f.h.diagnostics.some(x=>x.event==='clone_scope_enter'&&x.lineage==='native_copy_observer:observer_initial_scope'));
  assert(f.h.diagnostics.some(x=>x.event==='physical_write'&&x.lineage==='native_copy_observer:observer_initial_scope'),'real physical writes must retain observer lineage');
  await assert.rejects(()=>f.portable.restoreCurrentScope(f.backup,{mode:f.portable.restoreModes.CHAT_COPY}),error=>error.code==='FLASHBACK_PORTABLE_CHAT_COPY_BLOCKED'&&error.message.includes('target_not_empty'));
  const targets=f.h.diagnostics.filter(x=>x.event==='portable_target_preflight');assert.equal(targets.at(-1).empty,false);assert(targets.at(-1).records>0);
  await assertOriginalPreserved(f);
 }finally{f.h.control.releaseObserver();f.h.control.releaseRestore();await f.h.cleanup();}
});
test('actual portable operation ownership blocks the genuine observer while copy restores',async()=>{
 const f=await prepare(true);let restore;
 try{
  restore=f.portable.restoreCurrentScope(f.backup,{mode:f.portable.restoreModes.CHAT_COPY});
  // Attach rejection observation immediately; the original promise still carries its result.
  restore.catch(()=>{});
  await bounded(f.h.control.restoreAcquired,'actual_restore_operation_acquisition');
  const before=f.h.diagnostics.length;f.h.control.releaseObserver();
  const result=await bounded(f.h.control.observerCompleted,'observer_completion_while_portable_owned');
  assert.equal(result.lastResult?.reason,'portable_memory_operation_active');assert.equal(result.lastResult?.adopted,false);
  assert.equal(f.h.diagnostics.slice(before).filter(x=>x.event==='physical_write'&&x.lineage.startsWith('native_copy_observer:')).length,0,'guarded real observer must not write target storage');
  f.h.control.releaseRestore();assert.equal((await bounded(restore,'restore_completion')).ok,true);
  const targetScope=await f.h.api.resolveCurrentScope(false),restored=(await f.h.api._test.loadScopeRecords(targetScope.scopeKey)).records[0];
  assert.equal(restored.text,f.original.text);assert.equal(restored.sourceHash,f.original.sourceHash);assert.equal(restored.embeddingWork.sourceRevision,f.original.embeddingWork.sourceRevision);
  assert.equal(restored.embeddingWork.scopeKey,targetScope.scopeKey);assert.notEqual(restored.embeddingWork.jobId,f.original.embeddingWork.jobId);
  await assertOriginalPreserved(f);
 }finally{f.h.control.releaseObserver();f.h.control.releaseRestore();if(restore)await restore.catch(()=>{});await f.h.cleanup();}
});

}
module.exports={registerObserverControls};
if(require.main===module)registerObserverControls();
