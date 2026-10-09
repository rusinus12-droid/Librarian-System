'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness,waitFor}=require('./fixtures/libra_vm_harness.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const waitRoot=async root=>{for(let i=0;i<500;i++){if(await root.ready())return;await new Promise(r=>setTimeout(r,5));}throw Error('source edit dialog timeout');};
(async()=>{
 const root=createRootBoundary(),chat={id:'edit-chat',chatId:'edit-chat',message:[],name:'Edit'},character={id:'edit-char',chaId:'edit-char',chatPage:0,chats:[chat],name:'Alice'};
 for(let n=1;n<=5;n++){chat.message.push({role:'user',chatId:'u'+n,data:'What happens '+n+'?'},{role:'assistant',chatId:'a'+n,data:n===1?'Alice signed the agreement.':'Alice waited in the office '+n+'.'});}chat.messages=chat.message;
 let calls=0,modelDelayMs=0;const hooks={};
 const host={addRisuReplacer:async(k,f)=>{hooks[k]=f;return true;},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getChar:async()=>character,getCharacterFromIndex:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[character],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},getRootDocument:async()=>root.root,
 runLLMModel:async()=>{calls++;if(modelDelayMs)await new Promise(resolve=>setTimeout(resolve,modelDelayMs));const quote=chat.message[1].data;return {type:'success',result:JSON.stringify(require('./fixtures/librarian_event_fixture.cjs')(quote,'t1-a'))}}};
 const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
 try{
  const api=r.api;
  const settings=await api.getLibraMemorySettings();await api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
  const initial=await api.runManualColdStart();
  assert.equal(initial.completed,1,JSON.stringify(initial));await r.api.retryPendingUnifiedVectors();
  const manifestKey=[...r.values.keys()].find(k=>k.endsWith(':manifest')&&k.startsWith('libra'));
  assert.ok(manifestKey,'canonical manifest created');const initialManifest=JSON.parse(r.values.get(manifestKey)),oldRef=initialManifest.memories['1'];const oldBytes=r.values.get(oldRef.key),initialCalls=calls;
  modelDelayMs=2100;
  chat.message[1].data='Alice did not sign the agreement.';
  chat.message.push({role:'user',data:'This completed pair has no stable user ID.'},{role:'assistant',chatId:'a6',data:'Alice answered an unstable-ID turn.'});
  chat.message.push({role:'user',chatId:'incomplete-u7',data:'This user turn has no assistant response yet.'});
  await hooks.beforeRequest([{role:'user',content:'Continue.'}],'model');
  assert.equal(await root.ready(),false,'source edit opens no confirmation dialog');
  assert.equal(calls,initialCalls,'beforeRequest must not run source reanalysis');
  await hooks.afterRequest('', 'model');
  const ticket=await api.previewSourceEdits(['1']);assert.equal(ticket.allowed,true,JSON.stringify(ticket));
  assert.equal(calls,initialCalls,'explicit preview is model-free');
  const result=await api.applySourceEdits(ticket);assert.equal(result.ok,true,JSON.stringify(result));
  assert.ok(calls>initialCalls,'explicit apply reuses the canonical pipeline');
  assert.equal((await api.applySourceEdits(ticket)).status,'blocked','consumed ticket cannot rerun');
  const updated=JSON.parse(r.values.get(manifestKey)),ref=updated.memories['1'];assert.equal(ref.status,'committed');assert.ok(ref.revision>oldRef.revision);assert.notEqual(ref.sourceDigest,oldRef.sourceDigest);
  const memory=JSON.parse(r.values.get(ref.key));assert.ok(memory.text.includes('did not sign'),'new source reflected in canonical');assert.equal(r.values.get(oldRef.key),oldBytes,'old version not deleted or rewritten');
  assert.equal(chat.message[1].data,'Alice did not sign the agreement.');
  assert.equal(api.getSourceEditSyncStatus().tasks[0].state,'applied');
  const journalKey=[...r.values.keys()].find(key=>key.includes(':source-edit-consent:v1'));
  assert.ok(journalKey,'automatic source tracking keeps its owner journal');
  const journal=JSON.parse(r.values.get(journalKey));
  assert.deepEqual(journal.seenTurnIds,['u1','u2','u3','u4','u5'],'completed IDs are stable user IDs only');
  assert.equal(journal.completedTurnSerial,5,'each completed logical U+A advances TTL once');
  assert.ok(journal.tasks['1'].rawDigest,'owner snapshot includes raw source digest separately from projected digest');
  assert.ok(journal.tasks['1'].originalRawDigest,'validated original raw evidence is included with the prior projected digest');
  assert.notEqual(journal.tasks['1'].rawDigest,journal.tasks['1'].originalRawDigest,'actual raw edit changes the raw digest');
  console.log(JSON.stringify({test:'source_edit_libra_runtime',passed:6}));
 }finally{await r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
