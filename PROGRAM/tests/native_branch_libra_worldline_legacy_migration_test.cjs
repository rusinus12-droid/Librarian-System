'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {clone,parent,branch,character}=require('./fixtures/native_branch_fixture.cjs');
const artifact=require('./fixtures/librarian_event_fixture.cjs');
(async()=>{
  const root=parent('legacy-root',5);root.message[1].data='Alice preserved a legacy branch.';
  const char=character([root]);let current=root;
  const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>char.chats.indexOf(current),getCharacter:async()=>clone(char),getCharacterFromIndex:async()=>clone(char),getChat:async()=>clone(current),getCurrentChat:async()=>clone(current),getChatFromIndex:async(_c,i)=>clone(char.chats[i]),getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db},runLLMModel:async options=>JSON.stringify(options).includes('LIBRA STATE NARRATIVE OBSERVER')?{type:'success',result:'{}'}:{type:'success',result:JSON.stringify(artifact(root.message[1].data,'t1-a'))}};
  const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
  try{
    const settings=await r.api.getLibraMemorySettings();await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
    const job=await r.api.runManualColdStart();assert.equal(job.completed,1,JSON.stringify(job));
    const rootManifestEntry=[...r.values.entries()].find(([k,v])=>k.endsWith(':manifest')&&JSON.parse(v).chatId==='legacy-root');
    const rootMeta=JSON.parse(rootManifestEntry[1]).worldlineMeta;
    const child=branch(root,5,'legacy-child');char.chats.unshift(child);current=child;
    const copied=await r.api.debugNativeChatCopy({force:true});assert.equal(copied.result.ok,true,JSON.stringify(copied));
    const childManifestEntry=[...r.values.entries()].find(([k,v])=>k.endsWith(':manifest')&&JSON.parse(v).chatId==='legacy-child');
    const historical=JSON.parse(childManifestEntry[1]);
    assert.equal(historical.nativeChatCopy.durableVerified,true);
    // Simulate an existing 0.3.56 branch manifest: durable native-copy receipt exists,
    // but the new host-worldline metadata field does not yet exist.
    delete historical.worldlineMeta;
    r.values.set(childManifestEntry[0],JSON.stringify(historical));
    char.chats=char.chats.filter(chat=>chat.id!=='legacy-root');
    const status=await r.api.getHostLineageStatus();
    assert.equal(status.status,'unverified');
    assert.equal(status.reason,'parent_unavailable');
    assert.equal(status.worldlineMeta.schema,'libra.worldline_meta.v1');
    assert.equal(status.worldlineMeta.parentWorldlineId,rootMeta.worldlineId,'historical receipt may describe ancestry without authorizing a fresh copy');
    assert.equal(status.worldlineMeta.forkTurn,5);
    assert.equal(status.worldlineMeta.forkFingerprint,historical.nativeChatCopy.hostLineage.prefixDigest);
    assert.equal(JSON.parse(r.values.get(childManifestEntry[0])).worldlineMeta,undefined,'read-only migration view must not rewrite storage implicitly');
    console.log(JSON.stringify({test:'native_branch_libra_worldline_legacy_migration',passed:9}));
  }finally{await r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
