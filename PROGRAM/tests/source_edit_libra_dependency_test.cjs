'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
(async()=>{
 const root=createRootBoundary(),chat={id:'edit-chat',chatId:'edit-chat',message:[],name:'Edit'},character={id:'edit-char',chaId:'edit-char',chatPage:0,chats:[chat],name:'Alice'};
 for(let n=1;n<=10;n++){chat.message.push({role:'user',chatId:'u'+n,data:'What happens '+n+'?'},{role:'assistant',chatId:'a'+n,data:n===1?'Alice signed the agreement.':'Alice waited in the office '+n+'.'});}chat.messages=chat.message;
 let calls=0;
 const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getChar:async()=>character,getCharacterFromIndex:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[character],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},getRootDocument:async()=>root.root,
 runLLMModel:async(req)=>{calls++;const user=req.messages.at(-1).content,sys=req.messages[0].content;
 if(sys.includes('STATE NARRATIVE OBSERVER'))return{type:'success',result:JSON.stringify({schema:'libra.state_observation.v1',domain:'narrative',basis:{},reviews:[],patches:[],diagnostics:[]})};
 const range=user.match(/\[t(\d+)-u\]/);assert.ok(range,'native canonical request must name exact batch');const n=Number(range[1]),quote=chat.message[n*2-1].data,ref='t'+n+'-a';
 return {type:'success',result:JSON.stringify(require('./fixtures/librarian_event_fixture.cjs')(quote,ref))}}};
 const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
 try{
  const api=r.api;
  const settings=await api.getLibraMemorySettings();await api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
  const initial=await api.runManualColdStart();
  assert.equal(initial.completed,2,JSON.stringify(initial));await api.retryPendingUnifiedVectors();
  const manifestKey=[...r.values.keys()].find(k=>k.endsWith(':manifest')&&k.startsWith('libra'));
  assert.ok(manifestKey,'canonical manifest created');
  const initialManifest=JSON.parse(r.values.get(manifestKey)),oldOne=initialManifest.memories['1'],oldSix=initialManifest.memories['6'];
  const oldOneBytes=r.values.get(oldOne.key),oldSixBytes=r.values.get(oldSix.key),initialCalls=calls;
  chat.message[1].data='Alice did not sign the agreement.';
  // A completed pair without a stable user ID and an incomplete U both stay out
  // of the TTL list even while the real stable U+A pairs are deduplicated.
  chat.message.push({role:'user',data:'completed question without stable identity'},{role:'assistant',chatId:'a11',data:'answer without stable user identity'});
  chat.message.push({role:'user',chatId:'incomplete-u12',data:'unfinished question'});
  await r.sourceEditBoundary();
  assert.equal(await root.ready(),false,'source observation never opens a manual consent dialog');
  assert.equal(calls,initialCalls,'request does not dispatch direct or dependent reanalysis');const inventory=await api.listCanonicalBatchRanges();const result=await api.startSelectedCanonicalBatches({scopeKey:inventory.scopeKey,mode:'source_edit',ranges:inventory.ranges});assert.equal(result.ok,true,JSON.stringify(result));const updated=JSON.parse(r.values.get(manifestKey)),one=updated.memories['1'],six=updated.memories['6'];
  assert.ok(calls>=initialCalls+2,'explicitly selected direct and dependent canonical units both rebuild');
  assert.equal(one.status,'committed');assert.ok(one.revision>oldOne.revision);
  assert.notEqual(one.sourceDigest,oldOne.sourceDigest);
  assert.equal(six.status,'committed');assert.ok(six.revision>oldSix.revision,'downstream basis change rebuilds dependent canonical');
  assert.equal(r.values.get(oldOne.key),oldOneBytes,'prior direct canonical remains immutable history');
  assert.equal(r.values.get(oldSix.key),oldSixBytes,'prior dependent canonical remains immutable history');
  assert.equal(JSON.parse(r.values.get(one.key)).text.includes('did not sign'),true,'new source reflected in canonical');
  assert.equal(chat.message[1].data,'Alice did not sign the agreement.');
  assert.equal(result.job.completed,2,'both explicit canonical selections commit');assert.equal([...r.values.keys()].some(k=>k.includes(':source-edit-consent:v1')),false,'no retired automatic journal');
  console.log(JSON.stringify({test:'source_edit_libra_dependency',passed:10,callsBefore:initialCalls,callsAfter:calls,completed:result.job.completed}));
 }finally{await r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
