'use strict';
// Full shipped LIBRA in the repository VM harness. Synthetic, non-sensitive U+A.
// This preserves the original preservation cases under automatic beforeRequest
// reconciliation: no source-edit popup, immutable old revisions, and fail-closed
// handling when the replacement cannot be safely committed.
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));

async function fixture(){
 const root=createRootBoundary();
 const chat={id:'preserve-chat',chatId:'preserve-chat',name:'Safety fixture',message:[]};
 for(let n=1;n<=5;n++)chat.message.push({role:'user',chatId:'u'+n,data:'Please describe the office '+n+'.'},
 {role:'assistant',chatId:'a'+n,data:n===1?'Alice signed the office agreement.':'Alice waited in the office '+n+'.'});
 chat.messages=chat.message;
 const character={id:'preserve-char',chaId:'preserve-char',name:'Alice',chatPage:0,chats:[chat]};
 const control={calls:0,modelFails:false,onCall:null};
 const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getChar:async()=>character,
 getCharacterFromIndex:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,
 getRootDocument:async()=>root.root,
 getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[character],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},
 runLLMModel:async()=>{control.calls++;if(control.onCall)return control.onCall();if(control.modelFails)return {type:'error',result:'synthetic_provider_failure'};
 const quote=chat.message[1].data;return {type:'success',result:JSON.stringify(require('./fixtures/librarian_event_fixture.cjs')(quote,'t1-a'))};}};
 const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
 const settings=await r.api.getLibraMemorySettings();
 await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
 const first=await r.api.runManualColdStart();assert.equal(first.completed,1,JSON.stringify(first));await r.api.retryPendingUnifiedVectors();
 const manifestKey=[...r.values.keys()].find(k=>k.startsWith('libra')&&k.endsWith(':manifest'));
 assert.ok(manifestKey);
 const getManifest=()=>JSON.parse(r.values.get(manifestKey));
 const oldRef=clone(getManifest().memories['1']),oldBytes=r.values.get(oldRef.key),initialCalls=control.calls;
 return {r,root,chat,control,getManifest,manifestKey,oldRef,oldBytes,initialCalls};
}

const results=[];
async function scenario(name,fn){const f=await fixture();try{await fn(f);results.push({name,ok:true});}finally{await f.r.cleanup();}}
async function sourceEdit(f,value='Alice did not sign the office agreement.'){
 f.chat.message[1].data=value;
 const legacy=await f.r.api.reviewSourceEdits();
 assert.equal(legacy.reason,'automatic_before_request_only','legacy review API cannot open a consent popup');
 assert.equal(await f.root.ready(),false);
 await f.r.sourceEditBoundary();
 assert.equal(await f.root.ready(),false,'automatic repair must not open a confirmation dialog');
}

(async()=>{
 await scenario('before_request_automatically_replaces_source_and_keeps_old_revision',async f=>{
  await sourceEdit(f);
  const ref=f.getManifest().memories['1'],memory=JSON.parse(f.r.values.get(ref.key));
  assert.equal(ref.status,'committed');assert.ok(ref.revision>f.oldRef.revision);
  assert.ok(memory.text.includes('did not sign'));assert.notEqual(ref.sourceDigest,f.oldRef.sourceDigest);
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes,'replacement retains the byte-identical prior revision');
  assert.equal(f.control.calls,f.initialCalls+1,'beforeRequest runs exactly one replacement analysis');
  assert.equal(f.r.api.getSourceEditSyncStatus().tasks[0].state,'applied');
 });

 await scenario('provider_failure_keeps_the_old_canonical_and_bytes',async f=>{
  f.control.modelFails=true;await sourceEdit(f);
  assert.equal(f.getManifest().memories['1'].key,f.oldRef.key);
  assert.equal(f.getManifest().memories['1'].status,'committed');
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
  assert.equal(f.r.api.getSourceEditSyncStatus().tasks[0].state,'failed');
 });

 await scenario('candidate_write_failure_never_retires_the_original',async f=>{
  const storage=f.r.context.risuai.pluginStorage,originalSet=storage.setItem;let dropped=0;
  storage.setItem=async function(key,value){
   if(String(key).includes(':memory:1:r')&&String(key)!==f.oldRef.key){dropped++;return true;}
   return originalSet.call(this,key,value);
  };
  try{await sourceEdit(f);}finally{storage.setItem=originalSet;}
  assert.ok(dropped>0,'candidate persistence failure must be exercised');
  assert.equal(f.getManifest().memories['1'].key,f.oldRef.key);
  assert.equal(f.getManifest().memories['1'].status,'committed');
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
  assert.equal(f.r.api.getSourceEditSyncStatus().tasks[0].state,'failed');
 });

 await scenario('source_changed_during_provider_wait_cannot_commit_stale_result',async f=>{
  const previous=f.chat.message[1].data;
  f.control.onCall=async()=>{
   const result=require('./fixtures/librarian_event_fixture.cjs')('Alice did not sign the office agreement.','t1-a');
   f.chat.message[1].data='Alice signed, then withdrew the agreement.';
   return {type:'success',result:JSON.stringify(result)};
  };
  await sourceEdit(f,'Alice did not sign the office agreement.');
  assert.equal(f.getManifest().memories['1'].key,f.oldRef.key);
  assert.equal(f.getManifest().memories['1'].status,'committed');
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
  assert.equal(f.r.api.getSourceEditSyncStatus().tasks[0].state,'failed');
  assert.notEqual(f.chat.message[1].data,previous);
 });

 await scenario('assistant_identity_change_invalidates_instead_of_reusing_old_revision',async f=>{
  f.chat.message[1].chatId='different-assistant';f.chat.message[1].data='Alice did not sign the office agreement.';
  await f.r.sourceEditBoundary();
  assert.notEqual(f.getManifest().memories['1'].status,'committed');
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes,'inactive history is retained rather than deleted');
 });

 await scenario('unrelated_user_deleted_inactive_reason_is_never_auto_revived',async f=>{
  const manifest=f.getManifest();manifest.memories['1'].status='inactive';manifest.memories['1'].inactiveReason='user_deleted';
  f.r.values.set(f.manifestKey,JSON.stringify(manifest));
  await f.r.sourceEditBoundary();
  assert.notEqual(f.getManifest().memories['1'].status,'committed');
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
 });
 process.stdout.write(JSON.stringify({test:'libra_source_preservation_v1',passed:results.length,environment:'shipped LIBRA + synthetic host/model/storage',results})+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
