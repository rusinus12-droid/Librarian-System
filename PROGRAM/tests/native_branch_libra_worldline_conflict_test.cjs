'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {clone,parent,branch,character}=require('./fixtures/native_branch_fixture.cjs');
const artifact=require('./fixtures/librarian_event_fixture.cjs');
(async()=>{
  const root=parent('root-conflict',5);root.message[1].data='Alice signed the conflict fixture agreement.';
  const char=character([root]);let current=root,calls=0;
  const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>char.chats.indexOf(current),getCharacter:async()=>clone(char),getCharacterFromIndex:async()=>clone(char),getChat:async()=>clone(current),getCurrentChat:async()=>clone(current),getChatFromIndex:async(_c,i)=>clone(char.chats[i]),getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db},runLLMModel:async options=>{const __p=JSON.stringify(options);if(__p.includes('LIBRA STATE NARRATIVE OBSERVER')||__p.includes('LIBRA MICRO SOURCE CONTRACT'))return {type:'success',result:'{}'};calls++;return {type:'success',result:JSON.stringify(artifact(root.message[1].data,'t1-a'))}}};
  const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
  try{
    const settings=await r.api.getLibraMemorySettings();await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
    const job=await r.api.runManualColdStart();assert.equal(job.completed,1,JSON.stringify(job));
    const child=branch(root,5,'conflicting-child');char.chats.unshift(child);current=child;
    const live=await r.api.getHostLineageStatus();assert.equal(live.status,'verified');
    const manifestKey=`libra:v1:scope:${live.scopeKey}:manifest`;
    const now=new Date().toISOString();
    r.values.set(manifestKey,JSON.stringify({schema:'libra.manifest.v1',version:r.api.version,scopeKey:live.scopeKey,characterId:'character',chatId:'conflicting-child',batchSize:5,createdAt:now,updatedAt:now,frontiers:{observedTurn:5,committedTurn:0},branchGuard:{schema:'libra.branch_guard.v1',status:'ready',batchSignatures:[],verifiedStarts:[],observedTurns:0,completeBatches:0},memories:{},inheritedMemories:[],runIds:[],failedBatches:{},stats:{},worldlineMeta:{...live.worldlineMeta,parentWorldlineId:'wl_deadbeefdeadbeef',forkTurn:5,forkFingerprint:live.prefixDigest}}));
    const copied=await r.api.debugNativeChatCopy({force:true});
    assert.equal(copied.result.ok,false,JSON.stringify(copied));
    assert.equal(copied.result.reason,'native_branch_worldline_binding_conflict');
    assert.equal(calls,1,'conflict rejection must not call model');
    const stored=JSON.parse(r.values.get(manifestKey));
    assert.equal(stored.worldlineMeta.parentWorldlineId,'wl_deadbeefdeadbeef','conflicting stored binding must not be silently rewritten');
    assert.equal(Object.keys(stored.memories||{}).length,0,'conflict rejection must not copy canonical records');
    console.log(JSON.stringify({test:'native_branch_libra_worldline_conflict',passed:7}));
  }finally{await r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
