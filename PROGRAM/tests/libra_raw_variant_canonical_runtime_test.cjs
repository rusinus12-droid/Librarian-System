'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const micro=args=>{const x=JSON.parse(args[0].messages[1].content),q=x.assistant.text;
  return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
    micro:{schema:'libra.micro_memory.v1',...x.binding,claims:[{changeKind:'event',text:q,actor:'',target:'',temporalRole:'current',
      certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',evidence:{role:'assistant',messageId:x.assistant.messageId,startOffset:0,endOffset:q.length,exactQuote:q}}]}})};};
const rows=()=>[{role:'user',chatId:'variant-u',data:'  Where is the key?\r\n'},
  {role:'assistant',chatId:'variant-a',data:'Mara stored the brass key.'},
  {role:'assistant',chatId:'variant-carrier',data:'<lb-stage-marker>ORIGINAL_VARIANT_한글😀</lb-stage-marker>'},
  {role:'assistant',chatId:'variant-last',data:'The shelf stays dry.'}];
const localRecords=fx=>Array.from(fx.local).filter(([key])=>key.startsWith('libra:v1:scope:'))
  .map(([key,value])=>({key,value:typeof value==='string'?JSON.parse(value):value}));
for(const mode of ['plugin_only','mirror','server_only'])test(`carrier-only variants have distinct immutable physical refs without a second analysis in ${mode}`,async()=>{
  let listener;const snapshot={chat:{id:'unified-chat',chatId:'unified-chat',name:'Immutable raw variants',message:rows()}};
  const fx=await serverFixture({mode,snapshot,host:{addRisuChatListener:async(k,fn)=>{if(k==='output')listener=fn;return true;}}});
  try{const event=()=>({char:fx.f.character,chat:fx.f.chat,characterIndex:0,chatIndex:0,messageIndex:3});fx.f.control.onCall=async args=>micro(args);
    listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const first=await fx.f.r.api.debugReadActiveRawPacket(1),receipt=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1),firstBytes=JSON.stringify(first.packet);
    for(let i=1;i<=2;i++){
      const before=fx.f.r.api.getCaptureBackendState().lastOutputCapture.rawVariantId;
      fx.f.chat.message[2].data=`<lb-stage-marker>RAW_VARIANT_${i}_한글😀</lb-stage-marker>`;listener(event());
      await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true
        &&fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawVariantId!==before,5000);
      const active=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(active.status,'verified');
      assert.equal(active.packet.assistant.segments[1].rawValue,fx.f.chat.message[2].data);
      assert.equal(active.packet.origin.sourceRevisionId,first.packet.origin.sourceRevisionId,'sanitized revision authority remains unchanged');
      assert.notEqual(active.rawPacketRef.packetDigest,first.packet.packetDigest);
      assert.equal(fx.f.r.api.getCaptureBackendState().lastOutputCapture.duplicate,false,'exact raw variants are not falsely dropped as duplicates');
    }
    const source=(mode==='server_only'?fx.getRecords('libra.completed_turn_receipt.v1'):localRecords(fx)).find(x=>x.key===receipt.receiptKey);
    assert.equal(JSON.stringify(source.value.rawSourcePacket),firstBytes,'first inline packet remains immutable');
    const capture=(mode==='server_only'?fx.getRecords('libra.completed_turn_capture.v1'):localRecords(fx)).find(x=>x.value?.schema==='libra.completed_turn_capture.v1');
    assert.equal(Object.keys(capture.value.rawSourceVariants||{}).length,2);assert.equal(capture.value.rawVariantRefs.length,3);
    assert.equal(fx.f.control.calls.length,1);await fx.restart();
    // The fixture restart restores the original snapshot. Returning to original raw must select its old immutable ref.
    listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true,5000);
    assert.equal(JSON.stringify((await fx.f.r.api.debugReadActiveRawPacket(1)).packet),firstBytes);
    assert.equal(fx.f.control.calls.length,0,'raw variant selection does not infer an analysis retry after restart');
  }finally{await fx.cleanup();}
});
test('failed exact variant sidecar write preserves old bytes and public callbacks retry without another analysis',async()=>{
  let listener;const fx=await serverFixture({mode:'plugin_only',snapshot:{chat:{id:'unified-chat',chatId:'unified-chat',name:'Variant write failure',message:rows()}},
    host:{addRisuChatListener:async(k,fn)=>{if(k==='output')listener=fn;return true;}}});
  try{const event=()=>({char:fx.f.character,chat:fx.f.chat,characterIndex:0,chatIndex:0,messageIndex:3});fx.f.control.onCall=async args=>micro(args);
    listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const first=await fx.f.r.api.debugReadActiveRawPacket(1),original=fx.local.get(first.rawPacketRef.storageKey),set=fx.backend.setItem;
    let failed=0;fx.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt-capture:')){failed++;return false;}return set(k,v);};
    fx.f.chat.message[2].data='<lb-stage-marker>FAILED_THEN_RETRIED_RAW_734</lb-stage-marker>';listener(event());
    await waitFor(()=>failed>0 && fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===false,5000);
    assert.notEqual((await fx.f.r.api.debugReadActiveRawPacket(1)).status,'verified');assert.equal(fx.local.get(first.rawPacketRef.storageKey),original);
    fx.backend.setItem=set;
    for(let i=0;i<10 && fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable!==true;i++){
      listener(event());await new Promise(resolve=>setTimeout(resolve,200));
    }
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true,15000);
    assert.equal((await fx.f.r.api.debugReadActiveRawPacket(1)).packet.assistant.segments[1].rawValue,fx.f.chat.message[2].data);
    assert.equal(fx.f.control.calls.length,1);assert.equal(fx.local.get(first.rawPacketRef.storageKey),original);
  }finally{await fx.cleanup();}
});
test('lost receipt head repairs an exact carrier variant without replacing the original packet or repeating analysis',async()=>{
  let listener;const fx=await serverFixture({mode:'plugin_only',snapshot:{chat:{id:'unified-chat',chatId:'unified-chat',name:'Lost raw head',message:rows()}},
    host:{addRisuChatListener:async(k,fn)=>{if(k==='output')listener=fn;return true;}}});
  try{const event=()=>({char:fx.f.character,chat:fx.f.chat,characterIndex:0,chatIndex:0,messageIndex:3});fx.f.control.onCall=async args=>micro(args);
    listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const old=await fx.f.r.api.debugReadActiveRawPacket(1),active=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1),original=fx.local.get(active.receiptKey);
    fx.local.delete(active.headKey);fx.f.chat.message[2].data='<lb-stage-marker>LOST_HEAD_NEW_RAW_VARIANT</lb-stage-marker>';listener(event());
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true
      &&fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawVariantId!==old.packet.packetDigest,5000);
    const repaired=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(repaired.status,'verified');
    assert.equal(repaired.packet.assistant.segments[1].rawValue,fx.f.chat.message[2].data);
    assert.equal(fx.local.get(active.receiptKey),original,'original inline receipt bytes never change');assert.equal(fx.f.control.calls.length,1);
  }finally{await fx.cleanup();}
});
const seam=source=>source.replace("    const executeUnifiedStage = async (stageName,batch,previousStage=null,options={}) => {",
  "    const executeUnifiedStage = async (stageName,batch,previousStage=null,options={}) => {\n      await globalThis.__rawCanonicalTestHook?.(stageName,batch,options);");
for(const mode of ['plugin_only','mirror','server_only'])test(`canonical actual provider reads five verified raw refs and sanitized receipt inputs in ${mode}`,async()=>{
  const fx=await serverFixture({mode});
  try{fx.f.chat.message[1].data+='\r\n<lb-stage-marker>CANONICAL_HIDDEN_ORIGINAL_733</lb-stage-marker>';
    let verified=0;fx.f.control.onCall=async args=>{
      const prompt=String(args[0].messages[1].content),match=prompt.match(/\[VERIFIED ORIGINAL PACKET REFS\]\n([^\n]+)/);
      assert.ok(match,'canonical model input declares actual existing-owner raw references');const refs=JSON.parse(match[1]);assert.equal(refs.length,5);
      for(const ref of refs){const raw=await fx.f.r.api.debugReadActiveRawPacket(ref.turn);assert.equal(raw.status,'verified');
        assert.equal(ref.packetDigest,raw.rawPacketRef.packetDigest);assert.equal(ref.storageKey,raw.rawPacketRef.storageKey);}
      assert.equal(prompt.includes('CANONICAL_HIDDEN_ORIGINAL_733'),false);verified++;return {type:'success',result:JSON.stringify(fx.f.control.artifact)};
    };
    assert.equal((await fx.f.run()).completed,1);assert.equal(verified,1);
    const memory=mode==='plugin_only'?localRecords(fx).find(x=>x.value?.schema==='libra.canonical_memory.v1')?.value:fx.getMemory(1);assert.equal(memory.rawPacketRefs.length,5);
    assert.equal(fx.f.control.calls.length,1);assert.equal(fx.requests.filter(r=>!r.url.startsWith(fx.url+'/')).length,0);
  }finally{await fx.cleanup();}
});
for(const kind of ['corrupt','legacy_absent'])test(`canonical ${kind} original raw fails before provider submission`,async()=>{
  const fx=await serverFixture({mode:'plugin_only',transformSource:seam});
  try{fx.f.r.context.__rawCanonicalTestHook=async()=>{
      const active=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1),receipt=JSON.parse(fx.local.get(active.receiptKey));
      if(kind==='corrupt')receipt.rawSourcePacket.assistant.segments[0].rawValue+='CORRUPT';
      else{delete receipt.rawSourcePacket;delete receipt.rawPacketRef;
        for(const [key,value] of fx.local){if(key.includes(':source-receipt-capture:')){const record=JSON.parse(value);delete record.rawPacketRef;fx.local.set(key,JSON.stringify(record));}}}
      fx.local.set(active.receiptKey,JSON.stringify(receipt));
    };
    const result=await fx.f.run();assert.equal(result.completed,0);assert.equal(fx.f.control.calls.length,0);
    assert.equal(localRecords(fx).filter(x=>x.key.endsWith(':manifest')).some(x=>Object.keys(x.value?.memories||{}).length>0),false);
  }finally{await fx.cleanup();}
});
test('canonical original raw corruption after fixture analysis blocks final memory commit',async()=>{
  const fx=await serverFixture({mode:'plugin_only'});
  try{fx.f.control.onCall=async()=>{const active=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1),receipt=JSON.parse(fx.local.get(active.receiptKey));
      receipt.rawSourcePacket.assistant.segments[0].rawValue+='POST_ANALYSIS_CORRUPT';fx.local.set(active.receiptKey,JSON.stringify(receipt));
      return {type:'success',result:JSON.stringify(fx.f.control.artifact)};};
    assert.equal((await fx.f.run()).completed,0);assert.equal(fx.f.control.calls.length,1);
    assert.equal(localRecords(fx).filter(x=>x.key.endsWith(':manifest')).some(x=>Object.keys(x.value?.memories||{}).length>0),false);
  }finally{await fx.cleanup();}
});
test('canonical raw corruption during candidate write cannot activate the manifest',async()=>{
  const fx=await serverFixture({mode:'plugin_only'});
  try{const set=fx.backend.setItem;let corrupted=false;
    fx.backend.setItem=async(key,value)=>{const result=await set(key,value);let record;try{record=JSON.parse(value);}catch{return result;}
      if(!corrupted&&record?.schema==='libra.canonical_memory.v1'&&record.status==='candidate'){
        corrupted=true;const ref=record.rawPacketRefs[0],source=JSON.parse(fx.local.get(ref.storageKey));
        source.rawSourcePacket.assistant.segments[0].rawValue+='LATE_COMMIT_CORRUPT';fx.local.set(ref.storageKey,JSON.stringify(source));}
      return result;};
    assert.equal((await fx.f.run()).completed,0);assert.equal(corrupted,true);assert.equal(fx.f.control.calls.length,1);
    assert.equal(localRecords(fx).filter(x=>x.key.endsWith(':manifest')).some(x=>Object.keys(x.value?.memories||{}).length>0),false);
  }finally{await fx.cleanup();}
});
test('Micro original raw corruption after fixture analysis blocks final head publication',async()=>{
  let listener;const fx=await serverFixture({mode:'plugin_only',snapshot:{chat:{id:'unified-chat',chatId:'unified-chat',name:'Raw Micro gate',message:rows()}},
    host:{addRisuChatListener:async(k,fn)=>{if(k==='output')listener=fn;return true;}}});
  try{fx.f.control.onCall=async args=>{const active=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1),receipt=JSON.parse(fx.local.get(active.receiptKey));
      receipt.rawSourcePacket.assistant.segments[0].rawValue+='POST_MICRO_CORRUPT';fx.local.set(active.receiptKey,JSON.stringify(receipt));return micro(args);};
    listener({char:fx.f.character,chat:fx.f.chat,characterIndex:0,chatIndex:0,messageIndex:3});
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication,15000);
    assert.notEqual(fx.f.r.api.getCaptureBackendState().lastMicroPublication.status,'verified');assert.equal(fx.f.control.calls.length,1);
    assert.equal(localRecords(fx).some(x=>x.key.includes(':micro-memory-head:')),false);
  }finally{await fx.cleanup();}
});
for(const kind of ['native','portable'])test(`canonical ${kind} copy keeps analysis raw refs on the destination owner`,async()=>{
  const {clone,branch,character}=require('./fixtures/native_branch_fixture.cjs'),input=require('./fixtures/unified_vertical_source.json');
  const root={id:'raw-canonical-root-'+kind,chatId:'raw-canonical-root-'+kind,name:'Root',message:input.sourceRows.map(x=>({role:x.role,chatId:x.ref,data:x.text}))};
  const char=character([root]);let current=root;
  const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>char.chats.indexOf(current),
    getCharacter:async()=>clone(char),getCharacterFromIndex:async()=>clone(char),getChat:async()=>clone(current),getCurrentChat:async()=>clone(current),getChatFromIndex:async(_c,i)=>clone(char.chats[i]),
    getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;}};
  const fx=await serverFixture({mode:'plugin_only',host});
  try{fx.f.control.onCall=async()=>({type:'success',result:JSON.stringify(fx.f.control.artifact)});assert.equal((await fx.f.run()).completed,1);
    const original=localRecords(fx).find(x=>x.value?.schema==='libra.canonical_memory.v1')?.value;assert.equal(original.rawPacketRefs.length,5);
    let backup;if(kind==='portable')backup=await fx.f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope();
    const child=kind==='native'?branch(root,5,'raw-canonical-child-'+kind):{...clone(root),id:'raw-canonical-child-'+kind,chatId:'raw-canonical-child-'+kind};
    char.chats.unshift(child);current=child;
    if(kind==='native')assert.equal((await fx.f.r.api.debugNativeChatCopy({force:true})).result?.ok,true);
    else assert.equal((await fx.f.r.context.__LIBRAPortableMemoryBackup.reconstructCopiedChat(backup)).ok,true);
    const scope=(await fx.f.r.api.getHostLineageStatus()).scopeKey;
    const copied=localRecords(fx).find(x=>x.value?.schema==='libra.canonical_memory.v1'&&x.value.scopeKey===scope)?.value;
    assert.ok(copied);assert.equal(copied.rawPacketRefs.length,5);
    for(let i=0;i<5;i++){const ref=copied.rawPacketRefs[i];assert.equal(ref.scopeKey,scope);assert.equal(ref.packetDigest,original.rawPacketRefs[i].packetDigest);
      const physical=JSON.parse(fx.local.get(ref.storageKey));const packet=ref.field==='rawSourcePacket'?physical.rawSourcePacket:physical.rawSourceVariants[ref.packetDigest];
      assert.equal(packet.packetDigest,ref.packetDigest);}
    assert.equal(fx.f.control.calls.length,1,'copy does not create a second analysis');
  }finally{await fx.cleanup();}
});
