'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {clone,parent,branch,character}=require('./fixtures/native_branch_fixture.cjs');
const artifact=require('./fixtures/librarian_event_fixture.cjs');

(async()=>{
  const source=parent('parent',7);
  for(let i=0;i<7;i++) {
    source.message[i*2].data=`PARENT U${i+1}`;
    source.message[i*2+1].data=`Alice completed parent turn ${i+1}.`;
  }
  const char=character([source]);
  let current=source;
  let canonicalCalls=0;
  const canonicalRequests=[];
  const host={
    getCurrentCharacterIndex:async()=>0,
    getCurrentChatIndex:async()=>char.chats.indexOf(current),
    getCharacter:async()=>clone(char),
    getCharacterFromIndex:async()=>clone(char),
    getChat:async()=>clone(current),
    getCurrentChat:async()=>clone(current),
    getChatFromIndex:async(_c,i)=>clone(char.chats[i]),
    getDatabase:async fields=>{
      const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};
      return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;
    },
    runLLMModel:async(options)=>{
      const raw=JSON.stringify(options);
      if(raw.includes('LIBRA STATE NARRATIVE OBSERVER')) {
        return {type:'success',result:'{}'};
      }
      if(!raw.includes('LIBRA MICRO SOURCE CONTRACT')) canonicalCalls++;
      canonicalRequests.push(raw);
      const second=raw.includes('[t6-u]');
      const real=current.message.filter(m=>!m.disabled&&!m.isComment&&(m.role==='user'||m.role==='char'));
      const assistantIndex=(second?10:5)*2-1;
      const quote=real[assistantIndex]?.data;
      const ref=second?'t10-a':'t5-a';
      assert.ok(quote,`missing quote for ${ref}; real=${real.length}`);
      return {type:'success',result:JSON.stringify(artifact(quote,ref))};
    }
  };

  const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
  try{
    const settings=await r.api.getLibraMemorySettings();
    await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});

    const parentJob=await r.api.runManualColdStart();
    assert.equal(parentJob.completed,1,JSON.stringify(parentJob));
    assert.equal(canonicalCalls,1,'parent T1-5 should require exactly one canonical model call');

    const parentManifestKey=[...r.values.keys()].find(k=>k.startsWith('libra')&&k.endsWith(':manifest'));
    assert.ok(parentManifestKey);
    const parentManifestBefore=r.values.get(parentManifestKey);
    const parentManifest=JSON.parse(parentManifestBefore);
    assert.deepEqual(Object.keys(parentManifest.memories).sort(),['1']);
    const parentRef=parentManifest.memories['1'];
    const parentCanonicalBefore=r.values.get(parentRef.key);

    // Native branch exactly after T7. The marker remains inside the child transcript,
    // then the child continues independently to T10.
    const child=branch(source,7,'child-t7');
    current=child;
    char.chats.unshift(child);
    const adoption=await r.api.debugNativeChatCopy({force:true});
    assert.equal(adoption.result.ok,true,JSON.stringify(adoption));
    assert.equal(canonicalCalls,1,'branch adoption must be non-generative');

    // Once inheritance is durably verified the child is self-contained. Removing
    // the parent from the host list must not erase the copied prefix or block new
    // child canonicals; restoring the parent should restore live lineage proof.
    char.chats=char.chats.filter(chat=>chat.id!=='parent');
    const detachedProof=await r.api.getHostLineageStatus();
    assert.equal(detachedProof.status,'unverified');
    assert.equal(detachedProof.reason,'parent_unavailable');

    for(let turn=8;turn<=10;turn++) {
      child.message.push(
        {role:'user',chatId:`cu${turn}`,data:`CHILD U${turn}`},
        {role:'char',chatId:`ca${turn}`,data:`Alice completed child turn ${turn}.`}
      );
    }

    const childJob=await r.api.runManualColdStart();
    assert.equal(childJob.completed,1,JSON.stringify(childJob));
    assert.equal(canonicalCalls,2,'child T6-10 should add exactly one canonical model call');
    assert.equal(canonicalRequests.filter(x=>x.includes('[t6-u]')).length,1,'T6-10 must be analyzed exactly once');

    const manifests=[...r.values.entries()]
      .filter(([k])=>k.startsWith('libra')&&k.endsWith(':manifest'))
      .map(([k,v])=>({key:k,value:JSON.parse(v),raw:v}));
    const childEntry=manifests.find(x=>x.value.chatId==='child-t7');
    assert.ok(childEntry,JSON.stringify(manifests.map(x=>x.value.chatId)));
    const childManifest=childEntry.value;
    assert.deepEqual(Object.keys(childManifest.memories).sort(),['1','6']);
    assert.equal(childManifest.memories['1'].sourceDigest,parentRef.sourceDigest,'T1-5 must preserve parent canonical source identity');
    assert.notEqual(childManifest.memories['6'].sourceDigest,parentRef.sourceDigest,'T6-10 must be child-specific canonical source');
    const childCanonical=JSON.parse(r.values.get(childManifest.memories['6'].key));
    assert.equal(childCanonical.turnRange.start,6);
    assert.equal(childCanonical.turnRange.end,10);
    assert.equal(childCanonical.canonicalArtifact.facts[0].text,'Alice completed child turn 10.');

    char.chats.push(source);
    const reconnectedProof=await r.api.getHostLineageStatus();
    assert.equal(reconnectedProof.status,'verified');
    assert.equal(reconnectedProof.parentChatId,'parent');

    assert.equal(r.values.get(parentManifestKey),parentManifestBefore,'parent manifest must remain byte-identical after child adoption/progress');
    assert.equal(r.values.get(parentRef.key),parentCanonicalBefore,'parent canonical must remain byte-identical');

    console.log(JSON.stringify({test:'native_branch_libra_t7_continue',passed:16,canonicalCalls}));
  }finally{await r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
