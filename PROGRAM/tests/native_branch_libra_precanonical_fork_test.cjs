'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {clone,parent,branch,character}=require('./fixtures/native_branch_fixture.cjs');
const artifact=require('./fixtures/librarian_event_fixture.cjs');
(async()=>{
  const root=parent('precanonical-root',3);
  for(let i=0;i<3;i++)root.message[i*2+1].data=`Alice completed root turn ${i+1}.`;
  const char=character([root]);let current=root,calls=0;
  const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>char.chats.indexOf(current),getCharacter:async()=>clone(char),getCharacterFromIndex:async()=>clone(char),getChat:async()=>clone(current),getCurrentChat:async()=>clone(current),getChatFromIndex:async(_c,i)=>clone(char.chats[i]),getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db},runLLMModel:async options=>{const __p=JSON.stringify(options);if(__p.includes('LIBRA STATE NARRATIVE OBSERVER')||__p.includes('LIBRA MICRO SOURCE CONTRACT'))return {type:'success',result:'{}'};calls++;return {type:'success',result:JSON.stringify(artifact('Alice completed child turn 5.','t5-a'))}}};
  const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
  try{
    const settings=await r.api.getLibraMemorySettings();await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
    const rootStatus=await r.api.getHostLineageStatus();
    assert.equal(rootStatus.worldlineMeta.parentWorldlineId,'');
    assert.equal([...r.values.keys()].some(k=>k.endsWith(':manifest')),false,'read-only root status must not create a manifest');

    const child=branch(root,3,'precanonical-child');
    child.message.push({role:'user',chatId:'cu4',data:'CHILD U4'},{role:'char',chatId:'ca4',data:'Alice completed child turn 4.'},{role:'user',chatId:'cu5',data:'CHILD U5'},{role:'char',chatId:'ca5',data:'Alice completed child turn 5.'});
    char.chats.unshift(child);current=child;
    const before=await r.api.getHostLineageStatus();
    assert.equal(before.status,'verified');
    assert.equal(before.commonPrefixPairs,3);
    assert.equal(before.worldlineMeta.parentWorldlineId,rootStatus.worldlineMeta.worldlineId,'live verified branch status exposes the intended parent before persistence');
    const copy=await r.api.debugNativeChatCopy({force:true});
    assert.notEqual(copy.result.ok,true,'there is intentionally no parent canonical to copy');
    assert.equal(copy.result.reason,'copy_source_not_found');
    const preCanonicalManifestEntry=[...r.values.entries()].find(([k,v])=>k.endsWith(':manifest')&&JSON.parse(v).chatId==='precanonical-child');
    assert.ok(preCanonicalManifestEntry,'verified branch metadata must persist even when there is no canonical to inherit');
    const preCanonicalMeta=JSON.parse(preCanonicalManifestEntry[1]).worldlineMeta;
    assert.equal(preCanonicalMeta.parentWorldlineId,rootStatus.worldlineMeta.worldlineId);
    assert.equal(preCanonicalMeta.forkTurn,3);
    assert.equal(preCanonicalMeta.forkFingerprint,before.prefixDigest);
    char.chats=char.chats.filter(chat=>chat.id!=='precanonical-root');
    const detached=await r.api.getHostLineageStatus();
    assert.equal(detached.status,'unverified');
    assert.equal(detached.worldlineMeta.parentWorldlineId,rootStatus.worldlineMeta.worldlineId,'stored lineage survives parent deletion');

    const childJob=await r.api.runManualColdStart();
    assert.equal(childJob.completed,1,JSON.stringify(childJob));
    assert.equal(calls,1);
    const childManifestEntry=[...r.values.entries()].find(([k,v])=>k.endsWith(':manifest')&&JSON.parse(v).chatId==='precanonical-child');
    assert.ok(childManifestEntry);
    const childManifest=JSON.parse(childManifestEntry[1]);
    assert.equal(childManifest.worldlineMeta.schema,'libra.worldline_meta.v1');
    assert.equal(childManifest.worldlineMeta.parentWorldlineId,rootStatus.worldlineMeta.worldlineId,'branch metadata must survive even when zero canonicals were inherited');
    assert.equal(childManifest.worldlineMeta.forkTurn,3);
    assert.equal(childManifest.worldlineMeta.forkFingerprint,before.prefixDigest);
    assert.deepEqual(Object.keys(childManifest.memories),['1']);
    console.log(JSON.stringify({test:'native_branch_libra_precanonical_fork',passed:22}));
  }finally{await r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
