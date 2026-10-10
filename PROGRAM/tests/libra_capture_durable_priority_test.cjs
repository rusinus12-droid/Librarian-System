'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const enteredWithin=(gate,ms=3000)=>Promise.race([gate.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('fixture storage gate not entered')),ms))]);
const rows=fx=>fx.storedRows().map(row=>row.value);
const microResult=args=>{
  const input=JSON.parse(args[0].messages[1].content),quote=input.assistant.text;
  return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
    micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'event',text:quote,actor:'',target:'',
      temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',
      evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};
};
test('official output durably captures a new turn while previous canonical analysis is held',async()=>{
  let listener;
  const fx=await serverFixture({mode:'server_only',host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  const entered=deferred(),release=deferred();let work;
  try{
    const f=fx.f;
    f.control.onCall=async()=>{entered.resolve();await release.promise;return {type:'success',result:JSON.stringify(f.control.artifact)};};
    work=f.run();await entered.promise;
    f.chat.message.push({role:'user',chatId:'priority-t6-u',data:'Exact delta user 6'},
      {role:'assistant',chatId:'priority-t6-a',data:'Exact delta assistant 6. Durable marker CAPTURE_PRIORITY_7814.'});
    const event={char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:11};
    const start=performance.now();const returned=listener(event);
    assert.equal(returned,undefined,'registered listener does not await storage or analysis');
    let saved=false;
    try{await waitFor(()=>rows(fx).some(x=>x.schema==='libra.completed_turn_head.v1'&&x.turn===6),750);saved=true;}catch{}
    const addedMs=performance.now()-start;
    assert.equal(saved,true,'new immutable raw receipt and active head must acknowledge before the held canonical model returns');
    const raw=rows(fx).find(x=>x.schema==='libra.completed_turn_receipt.v1'&&x.turn===6);
    assert.equal(raw.user.text,'Exact delta user 6');
    assert.equal(raw.assistant.text,'Exact delta assistant 6. Durable marker CAPTURE_PRIORITY_7814.');
    assert.equal(raw.completionProvenance,'validated_completed_pair');
    assert.ok(raw.revisionId&&raw.sourceDigest,'durable receipt binds source hash and revision');
    assert.equal(f.control.calls.length,1,'held analysis remains the only fixture invocation before raw ack');
    console.log(JSON.stringify({case:'held_canonical_raw_ack',addedMs,rawAck:true,realModelCalls:0,storage:'real local SQLite server'}));
  }finally{release.resolve();await work?.catch(()=>null);await fx.cleanup();}
});

test('verified raw acknowledgement does not wait for optional person inventory',async()=>{
  let listener;
  const fx=await serverFixture({mode:'server_only',host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  const entered=deferred(),release=deferred();
  try{
    const f=fx.f;f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;
    fx.hooks.beforeServerRequest=async(url,init)=>{if(url.endsWith('/v1/kv/set')&&JSON.parse(init.body).key.includes(':person-span-inventory:')){entered.resolve();await release.promise;}};
    listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1});
    await enteredWithin(entered);
    let acknowledged=false;
    try{await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus==='verified',250);acknowledged=true;}catch{}
    assert.equal(acknowledged,true,'optional inventory must run after durable receipt acknowledgement');
    assert.equal(f.r.api.getCaptureBackendState().lastOutputCapture.inventoryStatus,'deferred');
    const physical=rows(fx).find(x=>x.schema==='libra.completed_turn_receipt.v1');
    assert.equal(physical.assistant.text,f.chat.message[1].data,'raw bytes are already read back from SQLite');
    assert.equal(f.control.calls.length,0,'background analysis waits for its optional inventory rather than blocking raw ack');
  }finally{release.resolve();await fx.cleanup();}
});

test('scope deletion drains admitted receipt writes and cannot resurrect raw state',async()=>{
  let listener;
  const fx=await serverFixture({mode:'plugin_only',host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  const entered=deferred(),release=deferred();let deletion;
  try{
    const f=fx.f;f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;
    const set=fx.backend.setItem;
    fx.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')){entered.resolve();await release.promise;}return set(k,v);};
    listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1});await enteredWithin(entered);
    let finished=false;deletion=f.r.api.deleteLibraScope().then(x=>{finished=true;return x;});
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(finished,false,'scope deletion waits for admitted receipt owner write');
    release.resolve();await deletion;
    assert.equal([...fx.local.keys()].filter(k=>k.includes(':source-receipt:')||k.includes(':source-receipt-head:')).length,0,
      'all immutable raw and active head rows remain deleted after the held write settles');
  }finally{release.resolve();await deletion?.catch(()=>null);await fx.cleanup();}
});

test('duplicate official callbacks join one admitted raw capture and do not rewrite provenance',async()=>{
  let listener;
  const fx=await serverFixture({mode:'server_only',host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  const entered=deferred(),release=deferred();
  try{
    const f=fx.f;f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;
    fx.hooks.beforeServerRequest=async(url,init)=>{if(url.endsWith('/v1/kv/set')&&JSON.parse(init.body).key.includes(':source-receipt:')){entered.resolve();await release.promise;}};
    const event={char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1};
    listener(event);await enteredWithin(entered);
    for(let i=0;i<20;i++)listener(event);
    await new Promise(resolve=>setTimeout(resolve,100));release.resolve();
    await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===1,15000);
    // All callbacks, including a settled duplicate, must prove the existing
    // physical receipt instead of making another provenance publication.
    listener(event);
    await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate===true,5000);
    await new Promise(resolve=>setTimeout(resolve,150));
    const raw=fx.getRecords('libra.completed_turn_receipt.v1'),capture=fx.getRecords('libra.completed_turn_capture.v1');
    assert.equal(raw.length,1);assert.equal(raw[0].revision,1,'immutable raw is written exactly once');
    assert.equal(capture.length,1);assert.equal(capture[0].revision,1,'identical capture provenance is never rewritten');
    assert.equal(f.control.calls.length,1,'callback storm produces one fixture analysis');
  }finally{release.resolve();await fx.cleanup();}
});

test('queued memory creation exposes its wait separately from durable raw acknowledgement',async()=>{
  let listener;
  const fx=await serverFixture({mode:'server_only',host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  const entered=deferred(),release=deferred();
  try{
    const f=fx.f;f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;
    f.control.onCall=async args=>{if(f.control.calls.length===1){entered.resolve();await release.promise;}return microResult(args);};
    listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1});await enteredWithin(entered);
    f.chat.message.push({role:'user',chatId:'queue-t2-u',data:'Put one brass key in the west alcove.'},
      {role:'assistant',chatId:'queue-t2-a',data:'Mara put one brass key in the west alcove.'});
    listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:3});
    await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.turn===2,5000);
    const capture=f.r.api.getCaptureBackendState().lastOutputCapture;
    assert.equal(capture.receiptStatus,'verified');
    assert.ok(capture.receiptMetrics?.verifiedAt>=capture.receiptMetrics?.startedAt,'ack is physical-readback completion');
    assert.equal(f.r.api.getCaptureBackendState().microQueuedJobs,2,'two jobs wait behind one held fixture analysis');
    await new Promise(resolve=>setTimeout(resolve,150));release.resolve();
    await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===2,15000);
    const publication=f.r.api.getCaptureBackendState().lastMicroPublication;
    assert.ok(publication.queueMetrics?.queueWaitMs>=150,'queued wait includes the held first job');
    assert.ok(publication.queueMetrics.finishedAt>=publication.queueMetrics.startedAt);
    const memory=await f.r.api.debugReadActiveMicroMemory(2);
    assert.equal(memory.status,'verified');
    assert.equal(memory.record.claims[0].evidence.exactQuote,'Mara put one brass key in the west alcove.');
    assert.equal(memory.record.sourceDigest,fx.getRecords('libra.completed_turn_receipt.v1').find(row=>row.value.turn===2).value.sourceDigest);
  }finally{release.resolve();await fx.cleanup();}
});

test('analysis queue saturation preserves durable never-started work for public retry',async()=>{
  let listener;
  const fx=await serverFixture({mode:'plugin_only',host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  const entered=deferred(),release=deferred();
  try{
    const f=fx.f;f.chat.message=[];f.chat.messages=f.chat.message;
    const settings=await f.r.api.getLibraMemorySettings();await f.r.api.saveLibraMemorySettings({...settings,autoAnalyze:false});
    f.control.onCall=async args=>{if(f.control.calls.length===1){entered.resolve();await release.promise;}return microResult(args);};
    for(let turn=1;turn<=65;turn++){
      f.chat.message.push({role:'user',chatId:`saturation-t${turn}-u`,data:`Record completed turn ${turn}.`},
        {role:'assistant',chatId:`saturation-t${turn}-a`,data:`Mara stored ledger item ${turn}.`});
      listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:f.chat.message.length-1});
      await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.turn===turn,10000);
      assert.equal(f.r.api.getCaptureBackendState().lastOutputCapture.receiptStatus,'verified');
      if(turn===1)await enteredWithin(entered);
    }
    const pressure=f.r.api.getCaptureBackendState();
    assert.ok(pressure.microQueuedJobs<=64,'bounded scheduler holds at most 64 active plus queued jobs');
    assert.equal(pressure.lastOutputCapture.microStatus,'deferred','saturated work is explicitly deferred');
    const active=await f.r.api.debugReadActiveCompletedTurnReceipt(65);
    assert.equal(active.status,'verified');
    const work=[...fx.local.values()].map(raw=>{try{return JSON.parse(raw);}catch{return null;}}).find(x=>x?.schema==='libra.micro_work.v1'&&x.turn===65);
    assert.equal(work.status,'reserved');assert.equal(work.phase,'planned');assert.equal(work.physicalAttemptsUsed,0);
    assert.equal(f.control.calls.length,1,'queued jobs do not consume physical fixture attempts');
    release.resolve();await waitFor(()=>f.r.api.getCaptureBackendState().microQueuedJobs===0,120000);
    const result=await f.r.api.resumeNeverStartedMicro({scope:{scopeKey:active.receipt.scopeKey,
      characterId:active.receipt.characterId,chatId:active.receipt.chatId},receiptRef:active.receiptKey,
      revision:active.receipt.revisionId,digest:active.receipt.sourceDigest,expectedGeneration:0});
    assert.equal(result.status,'verified','public retry resumes exactly the durable never-started work');
    assert.equal((await f.r.api.debugReadActiveMicroMemory(65)).record.claims[0].evidence.exactQuote,'Mara stored ledger item 65.');
    assert.equal(f.control.calls.length,65,'each source-bound job has exactly one fixture attempt');
  }finally{release.resolve();await fx.cleanup();}
});

for(const mode of ['plugin_only','mirror','server_only'])test(`scope deletion drains held background inventory in ${mode}`,async()=>{
  let listener;
  const fx=await serverFixture({mode,host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  const entered=deferred(),release=deferred();let deletion,mirrorDrainedRows;
  try{
    const f=fx.f;f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;
    if(mode==='server_only')fx.hooks.beforeServerRequest=async(url,init)=>{
      if(url.endsWith('/v1/kv/set')&&JSON.parse(init.body).key.includes(':person-span-inventory:')){entered.resolve();await release.promise;}
    };
    else{const set=fx.backend.setItem;fx.backend.setItem=async(k,v)=>{
      if(k.includes(':person-span-inventory:')){entered.resolve();await release.promise;}return set(k,v);
    };}
    if(mode==='mirror')fx.hooks.beforeServerRequest=async url=>{
      if(url.endsWith('/v1/owner/scope-delete/plan'))mirrorDrainedRows=[...fx.local.entries()]
        .filter(([k])=>/:(?:source-receipt|source-receipt-head|person-span-inventory|person-span-inventory-head|micro-memory|micro-memory-head):/.test(k));
    };
    listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1});await enteredWithin(entered);
    await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus==='verified',5000);
    let finished=false;deletion=f.r.api.deleteLibraScope().then(x=>{finished=true;return x;});
    await new Promise(resolve=>setTimeout(resolve,350));const finishedWhileHeld=finished;
    release.resolve();const deletionResult=await deletion;await waitFor(()=>f.r.api.getCaptureBackendState().microQueuedJobs===0,15000);
    const relevant=k=>/:(?:source-receipt|source-receipt-head|person-span-inventory|person-span-inventory-head|micro-memory|micro-memory-head):/.test(k);
    assert.equal(finishedWhileHeld,false,'deletion drains admitted background owner writes before deleting their records');
    assert.deepEqual(fx.storedRows().map(row=>row.key).filter(relevant),[],
      'no server owner raw, inventory or Micro record reappears after completed scope deletion');
    if(mode==='plugin_only')assert.deepEqual([...fx.local.keys()].filter(relevant),[],
      'plugin-only physical owner rows remain deleted');
    else{
      assert.equal(deletionResult.reloadRequired,true,'server owner deletion preserves the existing SDK reload fence');
      if(mode==='mirror'){
        assert.ok(mirrorDrainedRows?.length,'snapshot is taken after admitted writes drain and before the server deletion plan');
        assert.deepEqual([...fx.local.entries()].filter(([k])=>relevant(k)),mirrorDrainedRows,
          'retained mirror bytes are exactly the drained pre-deletion cache, without late publications');
      }
      await fx.restart();
      assert.equal((await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1)).status,'missing',
        'deleted server owner cannot admit the retained old mirror cache after reload');
      assert.equal((await fx.f.r.api.debugReadActiveMicroMemory(1)).status,'missing');
      assert.deepEqual(fx.storedRows().map(row=>row.key).filter(relevant),[],'reload never reuploads the old mirror copy');
    }
    assert.equal(f.control.calls.length,0,'deleting scope does not start fixture analysis after the held inventory settles');
  }finally{release.resolve();await deletion?.catch(()=>null);await fx.cleanup();}
});

test('portable backup and restore reject admitted held background inventory',async()=>{
  let listener;
  const fx=await serverFixture({mode:'plugin_only',host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  const entered=deferred(),release=deferred();
  try{
    const f=fx.f;assert.equal((await f.run()).completed,1,'public canonical fixture seeds a valid portable graph');
    await waitFor(()=>f.r.api.getCaptureBackendState().microQueuedJobs===0,15000);
    const portable=f.r.context.__LIBRAPortableMemoryBackup,envelope=await portable.exportCurrentScope();
    const callsBefore=f.control.calls.length;
    const set=fx.backend.setItem;fx.backend.setItem=async(k,v)=>{
      if(k.includes(':person-span-inventory:')){entered.resolve();await release.promise;}return set(k,v);
    };
    f.chat.message.push({role:'user',chatId:'portable-held-t6-u',data:'Record a sixth item.'},
      {role:'assistant',chatId:'portable-held-t6-a',data:'Mara stored the sixth item.'});
    listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:11});await enteredWithin(entered);
    await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus==='verified'
      &&f.r.api.getCaptureBackendState().lastOutputCapture?.turn===6,5000);
    for(const operation of [()=>portable.exportCurrentScope(),()=>portable.restoreCurrentScope(envelope)])
      await assert.rejects(operation,error=>error.code==='LIBRA_WORLD_MANAGER_BUSY','portable operations fence admitted Micro owner writes');
    assert.equal(f.control.calls.length,callsBefore,'held sixth turn does not start another analysis');
  }finally{release.resolve();await fx.cleanup();}
});
