'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {clone,parent,branch,character}=require('./fixtures/native_branch_fixture.cjs');
const artifact=require('./fixtures/librarian_event_fixture.cjs');

(async()=>{
  const root=parent('root',5);
  root.message[1].data='Alice signed the root agreement.';
  const char=character([root]);
  let current=root;
  let calls=0;
  const host={
    getCurrentCharacterIndex:async()=>0,
    getCurrentChatIndex:async()=>char.chats.indexOf(current),
    getCharacter:async()=>clone(char),
    getCharacterFromIndex:async()=>clone(char),
    getChat:async()=>clone(current),
    getCurrentChat:async()=>clone(current),
    getChatFromIndex:async(_c,i)=>clone(char.chats[i]),
    getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db},
    runLLMModel:async options=>{
      if(JSON.stringify(options).includes('LIBRA STATE NARRATIVE OBSERVER'))return {type:'success',result:'{}'};
      calls++;return {type:'success',result:JSON.stringify(artifact('Alice signed the root agreement.','t1-a'))};
    }
  };
  const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
  try{
    const settings=await r.api.getLibraMemorySettings();
    await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
    const rootJob=await r.api.runManualColdStart();
    assert.equal(rootJob.completed,1,JSON.stringify(rootJob));

    const manifests=()=>[...r.values.entries()].filter(([k])=>k.startsWith('libra')&&k.endsWith(':manifest')).map(([key,raw])=>({key,raw,value:JSON.parse(raw)}));
    const byChat=id=>manifests().find(x=>x.value.chatId===id);
    const rootEntry=byChat('root');assert.ok(rootEntry);
    const rootMeta=rootEntry.value.worldlineMeta;
    assert.equal(rootMeta?.schema,'libra.worldline_meta.v1');
    assert.equal(rootMeta?.scopeKey,rootEntry.value.scopeKey);
    assert.ok(/^wl_[0-9a-f]{16}$/.test(rootMeta?.worldlineId||''),JSON.stringify(rootMeta));
    assert.equal(rootMeta?.parentWorldlineId,'');
    assert.equal(rootMeta?.forkTurn,0);
    assert.equal(rootMeta?.forkFingerprint,'');

    const rootRawBeforeChild=rootEntry.raw;
    const callsBeforeChild=calls;
    const child=branch(root,5,'child');char.chats.unshift(child);current=child;
    const childCopy=await r.api.debugNativeChatCopy({force:true});
    assert.equal(childCopy.result.ok,true,JSON.stringify(childCopy));
    assert.equal(calls,callsBeforeChild,'host branch inheritance must be non-generative');
    const childEntry=byChat('child');assert.ok(childEntry);
    const childMeta=childEntry.value.worldlineMeta;
    const childProof=await r.api.getHostLineageStatus();
    assert.equal(childProof.worldlineMeta?.schema,'libra.worldline_meta.v1');
    assert.equal(childProof.worldlineMeta?.worldlineId,childMeta.worldlineId);
    assert.equal(childProof.worldlineMeta?.parentWorldlineId,rootMeta.worldlineId);
    assert.equal(childMeta?.schema,'libra.worldline_meta.v1');
    assert.notEqual(childMeta?.worldlineId,rootMeta.worldlineId);
    assert.equal(childMeta?.parentWorldlineId,rootMeta.worldlineId);
    assert.equal(childMeta?.forkTurn,5);
    assert.equal(childMeta?.forkFingerprint,childProof.prefixDigest);
    assert.equal(r.values.get(rootEntry.key),rootRawBeforeChild,'child adoption must not mutate parent manifest');

    const childRawBeforeGrandchild=childEntry.raw;
    const grand=branch(child,5,'grandchild');char.chats.unshift(grand);current=grand;
    const grandCopy=await r.api.debugNativeChatCopy({force:true});
    assert.equal(grandCopy.result.ok,true,JSON.stringify(grandCopy));
    assert.equal(calls,callsBeforeChild,'nested host branch inheritance must be non-generative');
    const grandEntry=byChat('grandchild');assert.ok(grandEntry);
    const grandMeta=grandEntry.value.worldlineMeta;
    const grandProof=await r.api.getHostLineageStatus();
    assert.equal(grandMeta?.parentWorldlineId,childMeta.worldlineId,'nested branch must point to immediate parent worldline');
    assert.equal(grandMeta?.forkTurn,5);
    assert.equal(grandMeta?.forkFingerprint,grandProof.prefixDigest);
    assert.equal(r.values.get(childEntry.key),childRawBeforeGrandchild,'grandchild adoption must not mutate child source manifest');
    assert.equal(grandProof.pathVerified,true);
    assert.equal(JSON.stringify(grandProof.path),JSON.stringify(['root','child','grandchild']));

    // Portable backup/restore must preserve the branch-worldline binding as data,
    // while live Host Lineage remains the authority for future inheritance.
    const portable=r.context.__LIBRAPortableMemoryBackup;
    const backup=await portable.exportCurrentScope();
    const backupManifest=backup.records.find(row=>row.key===grandEntry.key);
    assert.ok(backupManifest,'portable backup must include current manifest');
    const backupManifestValue=typeof backupManifest.value==='string'?JSON.parse(backupManifest.value):backupManifest.value;
    assert.equal(backupManifestValue.worldlineMeta.parentWorldlineId,childMeta.worldlineId);
    const corrupted={...grandEntry.value,worldlineMeta:{...grandEntry.value.worldlineMeta,parentWorldlineId:'corrupted-parent',forkTurn:999}};
    r.values.set(grandEntry.key,JSON.stringify(corrupted));
    const restored=await portable.restoreCurrentScope(backup);
    assert.equal(restored.ok,true,JSON.stringify(restored));
    const restoredMeta=JSON.parse(r.values.get(grandEntry.key)).worldlineMeta;
    assert.equal(restoredMeta.parentWorldlineId,childMeta.worldlineId);
    assert.equal(restoredMeta.forkTurn,5);
    assert.equal(restoredMeta.forkFingerprint,grandProof.prefixDigest);

    console.log(JSON.stringify({test:'native_branch_libra_worldline_meta',passed:31}));
  }finally{await r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
