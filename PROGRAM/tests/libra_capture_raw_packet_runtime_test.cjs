'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),crypto=require('node:crypto');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const SHA=value=>crypto.createHash('sha256').update(Buffer.from(value,'utf8')).digest('hex');
const U='  사용자 원문 🗝️\r\n항목 A\t끝  ';
const A='  Mara placed 열쇠 🗝️ on the shelf.\r\n<lb-stage-marker>RAW_HIDDEN_원문😀</lb-stage-marker>\t끝  ';
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};
const enteredWithin=entry=>Promise.race([entry.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('raw storage gate not entered')),5000))]);
const microResult=args=>{
  const input=JSON.parse(args[0].messages[1].content),quote=input.assistant.text;
  return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
    micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'event',text:quote,actor:'',target:'',
      temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',
      evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};
};
for(const mode of ['plugin_only','mirror','server_only'])test(`lossless original U+A packet is physically verified before fixture analysis in ${mode}`,async()=>{
  let listener;const snapshot={chat:{id:'unified-chat',chatId:'unified-chat',name:'Exact original source',
    message:[{role:'user',chatId:'raw-original-u',data:U},{role:'assistant',chatId:'raw-original-a',data:A}]}};
  const fx=await serverFixture({mode,snapshot,host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;}}});
  try{
    const f=fx.f;f.chat.message=[{role:'user',chatId:'raw-original-u',data:U},{role:'assistant',chatId:'raw-original-a',data:A}];f.chat.messages=f.chat.message;
    let verifiedByFixture=false;
    f.control.onCall=async args=>{
      const input=JSON.parse(args[0].messages[1].content),raw=await f.r.api.debugReadActiveRawPacket(1);
      assert.equal(raw.status,'verified','analysis resolves the production verified reference rather than current host text');
      assert.equal(input.rawPacketRef.storageKey,raw.rawPacketRef.storageKey);
      assert.equal(input.rawPacketRef.packetDigest,raw.packet.packetDigest);
      assert.equal(raw.packet.user.segments[0].rawValue,U);assert.equal(raw.packet.assistant.segments[0].rawValue,A);
      assert.equal(JSON.stringify(args).includes('RAW_HIDDEN_'),false,'archival carrier bytes do not become analysis input');
      verifiedByFixture=true;return microResult(args);
    };
    assert.equal(listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1}),undefined);
    await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    assert.equal(verifiedByFixture,true);
    const raw=await f.r.api.debugReadActiveRawPacket(1),receipt=await f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(raw.status,'verified');assert.equal(raw.packet.schema,'libra.completed_turn_raw_packet.v1');
    assert.equal(raw.rawPacketRef.storageKey,receipt.receiptKey);assert.equal(raw.rawPacketRef.field,'rawSourcePacket');
    for(const [role,original] of [['user',U],['assistant',A]]){
      const segment=raw.packet[role].segments[0];assert.equal(segment.rawValue,original);
      assert.deepEqual([...Buffer.from(segment.rawValue,'utf8')],[...Buffer.from(original,'utf8')]);
      assert.equal(segment.utf8ByteLength,Buffer.byteLength(original,'utf8'));assert.equal(segment.utf8Sha256,SHA(original));
      assert.equal(segment.rawPayloadDigest,receipt.receipt[role].rawPayloadDigests[0]);
    }
    assert.equal(raw.packet.origin.scopeKey,receipt.receipt.scopeKey);assert.equal(raw.packet.origin.worldlineId,receipt.receipt.worldlineId);
    assert.equal(raw.packet.origin.sourceRevisionId,receipt.receipt.revisionId);assert.equal(raw.packet.origin.turn,1);
    assert.equal(f.r.api.getCaptureBackendState().lastOutputCapture.rawDurable,true);
    const saved=JSON.stringify(raw.packet);await fx.restart();const restarted=await fx.f.r.api.debugReadActiveRawPacket(1);
    assert.equal(restarted.status,'verified');assert.equal(JSON.stringify(restarted.packet),saved);assert.equal(fx.f.control.calls.length,0);
  }finally{await fx.cleanup();}
});

async function rawFixture(mode='plugin_only',message=[{role:'user',chatId:'raw-original-u',data:U},{role:'assistant',chatId:'raw-original-a',data:A}]){
  const out={listener:null};out.fx=await serverFixture({mode,snapshot:{chat:{id:'unified-chat',chatId:'unified-chat',name:'Raw source fixture',message}},
    host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')out.listener=fn;return true;}}});
  out.fx.f.control.onCall=async args=>microResult(args);
  out.event=()=>({char:out.fx.f.character,chat:out.fx.f.chat,characterIndex:0,chatIndex:0,messageIndex:out.fx.f.chat.message.length-1});
  return out;
}
test('JSON source payload is retained as its exact typed serialized original',async()=>{
  const payload=[{type:'text',text:'  Mara stored a key.\r\n',metadata:{label:'한글 😀',flags:[true,null,17]}},
    {type:'image_url',image_url:{url:'data:image/png;base64,RAW_IMAGE_PAYLOAD_732'}}];
  const {fx,listener,event}=await rawFixture('plugin_only',[{role:'user',chatId:'json-u',data:U},{role:'assistant',chatId:'json-a',data:payload}]);
  try{listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const raw=await fx.f.r.api.debugReadActiveRawPacket(1),segment=raw.packet.assistant.segments[0];
    assert.equal(segment.rawType,'json');assert.equal(segment.rawValue,JSON.stringify(payload));
    assert.deepEqual(JSON.parse(segment.rawValue),payload);assert.equal(segment.utf8Sha256,SHA(JSON.stringify(payload)));
    assert.equal(JSON.stringify(fx.f.control.calls).includes('RAW_IMAGE_PAYLOAD_732'),false);
  }finally{await fx.cleanup();}
});
for(const [label,payload] of [['undefined array member',[{type:'text',text:'Mara stored a key.'},undefined]],
  ['sparse array',[{type:'text',text:'Mara stored a key.'},,]],
  ['undefined object field',[{type:'text',text:'Mara stored a key.',originalExtra:undefined}]]])
  test(`non-lossless ${label} fails before durable acknowledgement or analysis`,async()=>{
    const {fx,listener,event}=await rawFixture('plugin_only',[{role:'user',chatId:'unsupported-u',data:U},{role:'assistant',chatId:'unsupported-a',data:payload}]);
    try{fx.f.chat.message[1].data=payload;listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus==='pending_reconciliation',5000);
      assert.notEqual(fx.f.r.api.getCaptureBackendState().lastOutputCapture.rawDurable,true);assert.equal(fx.f.control.calls.length,0);
      assert.equal([...fx.local.keys()].some(key=>key.includes(':source-receipt:')),false,'lossy JSON must not be represented as exact original raw');
    }finally{await fx.cleanup();}
  });
test('all grouped U+A source segments including a removed carrier retain their original bytes',async()=>{
  const rows=[{role:'user',chatId:'group-u1',data:'  First user 🐾\r\n'},
    {role:'user',chatId:'group-u2',data:'Second user\t '},{role:'assistant',chatId:'group-a1',data:'Mara stored a brass key.'},
    {role:'assistant',chatId:'group-hidden',data:'<lb-stage-marker>ONLY_HIDDEN_RAW_271</lb-stage-marker>'},
    {role:'assistant',chatId:'group-a2',data:'  The shelf remains dry.\r\n'}];
  const {fx,listener,event}=await rawFixture('plugin_only',rows);
  try{
    listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const raw=await fx.f.r.api.debugReadActiveRawPacket(1),receipt=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(raw.status,'verified');assert.deepEqual(Array.from(raw.packet.user.segments,x=>x.rawValue),rows.slice(0,2).map(x=>x.data));
    assert.deepEqual(Array.from(raw.packet.assistant.segments,x=>x.rawValue),rows.slice(2).map(x=>x.data));
    assert.equal(raw.packet.assistant.segments[1].contributesText,false);assert.equal(receipt.receipt.assistant.sourceMessageCount,2);
    assert.equal(JSON.stringify(fx.f.control.calls).includes('ONLY_HIDDEN_RAW_271'),false);
  }finally{await fx.cleanup();}
});
test('a carrier-only edit durably appends a new immutable original packet',async()=>{
  const rows=[{role:'user',chatId:'carrier-u',data:U},{role:'assistant',chatId:'carrier-a',data:'Mara stored a key.'},
    {role:'assistant',chatId:'carrier-only',data:'<lb-stage-marker>ORIGINAL_CARRIER_ONLY</lb-stage-marker>'},
    {role:'assistant',chatId:'carrier-last',data:'The shelf is dry.'}];
  const {fx,listener,event}=await rawFixture('plugin_only',rows);
  try{listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const original=await fx.f.r.api.debugReadActiveRawPacket(1),bytes=fx.local.get(original.rawPacketRef.storageKey);
    fx.f.chat.message[2].data='<lb-stage-marker>CHANGED_CARRIER_ONLY</lb-stage-marker>';listener(event());
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true
      &&fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawVariantId!==original.packet.packetDigest,5000);
    assert.equal(fx.f.r.api.getCaptureBackendState().lastOutputCapture.duplicate,false);
    assert.equal(fx.local.get(original.rawPacketRef.storageKey),bytes,'existing immutable raw remains unchanged');
    const current=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(current.status,'verified');
    assert.equal(current.packet.assistant.segments[1].rawValue,fx.f.chat.message[2].data);assert.equal(fx.f.control.calls.length,1);
  }finally{await fx.cleanup();}
});
test('duplicates reuse one immutable packet and a same-visible reroll preserves both byte variants',async()=>{
  const {fx,listener,event}=await rawFixture();
  try{
    listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const first=await fx.f.r.api.debugReadActiveRawPacket(1),firstJson=JSON.stringify(first.packet);
    for(let i=0;i<10;i++)listener(event());
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate===true,5000);
    assert.equal(fx.f.r.api.getCaptureBackendState().lastOutputCapture.rawDurable,true);
    assert.equal(fx.f.control.calls.length,1);
    fx.f.chat.message[1].data=A.replace('RAW_HIDDEN_원문😀','RAW_HIDDEN_second_🧭');listener(event());
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.revision===2
      &&fx.f.r.api.getCaptureBackendState().lastMicroPublication?.revisionId===fx.f.r.api.getCaptureBackendState().lastOutputCapture.receiptRevisionId,15000);
    const second=await fx.f.r.api.debugReadActiveRawPacket(1);
    assert.equal(second.status,'verified');assert.notEqual(second.packet.packetDigest,first.packet.packetDigest);
    assert.equal(second.packet.assistant.segments[0].rawValue,fx.f.chat.message[1].data);
    const saved=JSON.parse(fx.local.get(first.rawPacketRef.storageKey)).rawSourcePacket;
    assert.equal(JSON.stringify(saved),firstJson,'retired original packet is immutable, not overwritten by the current variant');
    assert.equal(fx.f.control.calls.length,2);
  }finally{await fx.cleanup();}
});
test('held packet-bearing receipt write never acknowledges RAM or starts analysis early',async()=>{
  const {fx,listener,event}=await rawFixture(),entered=gate(),release=gate();
  try{
    const set=fx.backend.setItem;fx.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')){
      assert.equal(JSON.parse(v).rawSourcePacket.assistant.segments[0].rawValue,A);entered.resolve();await release.promise;}return set(k,v);};
    listener(event());await enteredWithin(entered);
    assert.notEqual(fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable,true);
    assert.equal([...fx.local.keys()].some(k=>k.includes(':source-receipt-head:')),false);assert.equal(fx.f.control.calls.length,0);
    await assert.rejects(()=>fx.f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope(),error=>error.code==='LIBRA_WORLD_MANAGER_BUSY');
    release.resolve();await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true,5000);
    assert.equal((await fx.f.r.api.debugReadActiveRawPacket(1)).packet.assistant.segments[0].rawValue,A);
  }finally{release.resolve();await fx.cleanup();}
});
test('failed raw attempt consumes no analysis and retries the exact original packet',async()=>{
  const {fx,listener,event}=await rawFixture();
  try{
    const set=fx.backend.setItem;let attempts=0;
    fx.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')&&++attempts===1)return false;return set(k,v);};
    listener(event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus==='pending_reconciliation',5000);
    assert.notEqual(fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable,true);
    assert.equal(fx.f.control.calls.length,0,'failed raw attempt consumes no fixture analysis');
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const raw=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(raw.status,'verified');assert.equal(raw.packet.assistant.segments[0].rawValue,A);
    assert.equal(attempts,2);assert.equal(fx.f.control.calls.length,1);
  }finally{await fx.cleanup();}
});
for(const mode of ['plugin_only','server_only'])test(`native copy preserves all raw variants and rebinds the verified owner ref in ${mode}`,async()=>{
  const {clone,parent,branch,character}=require('./fixtures/native_branch_fixture.cjs');
  const root=parent(`raw-parent-${mode}`,1);root.message[0].data=U;root.message[1].data=A;
  root.message.splice(1,0,{role:'assistant',chatId:'copy-carrier',data:'<lb-stage-marker>ORIGINAL_COPY_VARIANT_735</lb-stage-marker>'});
  const char=character([root]);let current=root,listener,calls=0;
  const host={getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>char.chats.indexOf(current),
    getCharacter:async()=>clone(char),getCharacterFromIndex:async()=>clone(char),
    getChat:async()=>clone(current),getCurrentChat:async()=>clone(current),getChatFromIndex:async(_c,i)=>clone(char.chats[i]),
    getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};
      return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},
    addRisuChatListener:async(kind,fn)=>{if(kind==='output')listener=fn;return true;},
    runLLMModel:async(...args)=>{calls++;return microResult(args);}};
  const fx=await serverFixture({mode,host});
  try{
    listener({char,chat:root,characterIndex:0,chatIndex:0,messageIndex:root.message.length-1});
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const first=await fx.f.r.api.debugReadActiveRawPacket(1);
    root.message[1].data='<lb-stage-marker>SECOND_COPY_VARIANT_735</lb-stage-marker>';
    listener({char,chat:root,characterIndex:0,chatIndex:0,messageIndex:root.message.length-1});
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true
      &&fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawVariantId!==first.packet.packetDigest,5000);
    const original=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(original.status,'verified');
    const child=branch(root,2,`raw-child-${mode}`);char.chats.unshift(child);current=child;const before=calls;
    const copied=await fx.f.r.api.debugNativeChatCopy({force:true});assert.equal(copied.result?.ok,true,JSON.stringify(copied));
    const target=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(target.status,'verified','copied raw ref names the physical target owner');
    assert.equal(JSON.stringify(target.packet),JSON.stringify(original.packet),'origin bytes and provenance are immutable through transfer');
    assert.notEqual(target.rawPacketRef.storageKey,original.rawPacketRef.storageKey);assert.notEqual(target.rawPacketRef.scopeKey,original.rawPacketRef.scopeKey);
    const targetReceipt=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(JSON.stringify(targetReceipt.receipt.rawSourcePacket),JSON.stringify(first.packet),'copy retains the original inline raw packet too');
    assert.equal(calls,before,'copy does not analyze or regenerate archived raw');
    await fx.restart();assert.equal((await fx.f.r.api.debugReadActiveRawPacket(1)).status,'verified');assert.equal(calls,before);
  }finally{await fx.cleanup();}
});
test('corrupt physical raw packet blocks analysis even when sanitized receipt still matches source',async()=>{
  const {fx,listener,event}=await rawFixture(),entered=gate(),release=gate();
  try{
    const set=fx.backend.setItem;fx.backend.setItem=async(k,v)=>{if(k.includes(':person-span-inventory:')){entered.resolve();await release.promise;}return set(k,v);};
    listener(event());await enteredWithin(entered);
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true,5000);
    const active=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1),tampered=JSON.parse(fx.local.get(active.receiptKey));
    tampered.rawSourcePacket.assistant.segments[0].rawValue+='CORRUPT';fx.local.set(active.receiptKey,JSON.stringify(tampered));
    release.resolve();await waitFor(()=>fx.f.r.api.getCaptureBackendState().microQueuedJobs===0,15000);
    assert.equal((await fx.f.r.api.debugReadActiveRawPacket(1)).status,'pending_reconciliation');
    assert.match(fx.f.r.api.getCaptureBackendState().lastMicroPublication.reason,/raw_packet/);assert.equal(fx.f.control.calls.length,0);
  }finally{release.resolve();await fx.cleanup();}
});
test('a correctly rehashed packet with missing origin provenance still blocks analysis',async()=>{
  const {fx,listener,event}=await rawFixture(),entered=gate(),release=gate();
  try{
    const set=fx.backend.setItem;fx.backend.setItem=async(k,v)=>{if(k.includes(':person-span-inventory:')){entered.resolve();await release.promise;}return set(k,v);};
    listener(event());await enteredWithin(entered);await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true,5000);
    const active=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1),tampered=JSON.parse(fx.local.get(active.receiptKey));
    delete tampered.rawSourcePacket.origin.worldlineId;const {packetDigest,...body}=tampered.rawSourcePacket;
    tampered.rawSourcePacket.packetDigest=SHA(JSON.stringify(body));tampered.rawPacketRef.packetDigest=tampered.rawSourcePacket.packetDigest;
    fx.local.set(active.receiptKey,JSON.stringify(tampered));release.resolve();
    await waitFor(()=>fx.f.r.api.getCaptureBackendState().microQueuedJobs===0,15000);
    assert.equal((await fx.f.r.api.debugReadActiveRawPacket(1)).status,'pending_reconciliation');assert.equal(fx.f.control.calls.length,0);
  }finally{release.resolve();await fx.cleanup();}
});
test('legacy raw absence is explicit and an actual current callback attaches a sidecar without rewriting its receipt',async()=>{
  const out=await rawFixture(),{fx}=out;
  try{
    out.listener(out.event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified'
      &&fx.f.r.api.getCaptureBackendState().microQueuedJobs===0,15000);
    const active=await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1),legacy=JSON.parse(fx.local.get(active.receiptKey));
    delete legacy.rawSourcePacket;delete legacy.rawPacketRef;const legacyJson=JSON.stringify(legacy);
    fx.local.set(active.receiptKey,legacyJson);
    const captureKey=[...fx.local.keys()].find(k=>k.includes(':source-receipt-capture:')&&JSON.parse(fx.local.get(k)).receiptKey===active.receiptKey);
    const capture=JSON.parse(fx.local.get(captureKey));delete capture.rawPacketRef;delete capture.rawSourcePacket;
    fx.local.set(captureKey,JSON.stringify(capture));await fx.restart();
    const unavailable=await fx.f.r.api.debugReadActiveRawPacket(1);
    assert.equal(unavailable.status,'legacy_unavailable');assert.equal(unavailable.packet,null);
    assert.equal(fx.local.get(active.receiptKey),legacyJson,'read-only legacy diagnosis never fills missing raw from sanitized text');
    assert.equal(fx.f.control.calls.length,0);
    out.listener(out.event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true,5000);
    const attached=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(attached.status,'verified');
    assert.equal(attached.rawPacketRef.storageKey,captureKey);assert.equal(attached.rawPacketRef.field,'rawSourcePacket');
    assert.equal(attached.packet.assistant.segments[0].rawValue,A);assert.equal(attached.packet.user.segments[0].rawValue,U);
    assert.equal(fx.local.get(active.receiptKey),legacyJson,'the old immutable receipt remains byte-for-byte unchanged');
    assert.equal(fx.f.control.calls.length,0,'attaching known current raw is not an automatic analysis retry');
  }finally{await fx.cleanup();}
});
for(const mode of ['plugin_only','server_only'])test(`portable same-owner restore physically preserves the original packet in ${mode}`,async()=>{
  const fx=await serverFixture({mode});
  const retryBusy=async operation=>{for(let i=0;i<40;i++){try{return await operation();}catch(error){
    if(!/BUSY/.test(String(error.code||error.message))||i===39)throw error;await new Promise(r=>setTimeout(r,100));}}};
  try{
    fx.f.control.onCall=async args=>String(args[0]?.messages?.[0]?.content||'').includes('[LIBRA MICRO SOURCE CONTRACT]')
      ?microResult(args):{type:'success',result:JSON.stringify(fx.f.control.artifact)};
    assert.equal((await fx.f.run()).completed,1);
    const raw=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(raw.status,'verified');
    const portable=fx.f.r.context.__LIBRAPortableMemoryBackup,backup=await retryBusy(()=>portable.exportCurrentScope()),calls=fx.f.control.calls.length;
    const stored=backup.records.find(row=>row.key===raw.rawPacketRef.storageKey);assert.ok(stored);
    assert.equal(JSON.stringify(JSON.parse(stored.value).rawSourcePacket),JSON.stringify(raw.packet));
    await retryBusy(()=>portable.restoreCurrentScope(backup));
    const restored=await fx.f.r.api.debugReadActiveRawPacket(1);assert.equal(restored.status,'verified');
    assert.equal(JSON.stringify(restored.packet),JSON.stringify(raw.packet));assert.equal(fx.f.control.calls.length,calls);
    await fx.restart();assert.equal(JSON.stringify((await fx.f.r.api.debugReadActiveRawPacket(1)).packet),JSON.stringify(raw.packet));
    assert.equal(fx.f.control.calls.length,0);
  }finally{await fx.cleanup();}
});
