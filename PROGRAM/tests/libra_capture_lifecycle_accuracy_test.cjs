'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const microResult=args=>{const input=JSON.parse(args[0].messages[1].content),quote=input.assistant.text;
  return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
    micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'event',text:quote,actor:'',target:'',
      temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',
      evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};};
async function fixture(mode='server_only'){
  const out={listener:null};out.fx=await serverFixture({mode,host:{addRisuChatListener:async(kind,fn)=>{if(kind==='output')out.listener=fn;return true;}}});
  const f=out.fx.f;f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;f.control.onCall=async args=>microResult(args);
  out.event=()=>({char:out.fx.f.character,chat:out.fx.f.chat,characterIndex:0,chatIndex:0,messageIndex:1});
  return out;
}
test('streaming draft is not captured until the authoritative completed output callback',async()=>{
  const {fx,listener,event}=await fixture();
  try{
    const f=fx.f;f.chat.message[1].data='STREAM_DRAFT_2491';await sleep(50);
    assert.equal(fx.getRecords('libra.completed_turn_receipt.v1').length,0);assert.equal(f.control.calls.length,0);
    f.chat.message[1].data='FINAL_BYTES_2491: Mara closed the bronze door.';listener(event());
    await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const raw=fx.getRecords('libra.completed_turn_receipt.v1')[0].value,memory=await f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(raw.assistant.text,f.chat.message[1].data);assert.doesNotMatch(JSON.stringify(raw),/STREAM_DRAFT/);
    assert.equal(memory.record.claims[0].evidence.exactQuote,raw.assistant.text);
    assert.equal(memory.record.sourceRevisionId,raw.revisionId);assert.equal(memory.record.sourceDigest,raw.sourceDigest);
    assert.equal(memory.record.claims[0].evidence.messageId,raw.assistant.chatId);
  }finally{await fx.cleanup();}
});
test('reroll callback retires held source work and publishes only the new exact variant',async()=>{
  const {fx,listener,event}=await fixture('mirror'),entered=deferred(),release=deferred();
  try{
    const f=fx.f;f.chat.message[1].data='OLD_VARIANT_8051: Mara opened the east gate.';
    f.control.onCall=async args=>{if(f.control.calls.length===1){entered.resolve();await release.promise;}return microResult(args);};
    listener(event());await entered.promise;
    f.chat.message[1].data='NEW_VARIANT_8051: Mara locked the west gate.';listener(event());
    await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.revision===2,10000);release.resolve();
    await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified'
      && f.r.api.getCaptureBackendState().lastMicroPublication.revisionId===f.r.api.getCaptureBackendState().lastOutputCapture.receiptRevisionId,20000);
    const memory=await f.r.api.debugReadActiveMicroMemory(1),raw=await f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(memory.status,'verified');assert.equal(memory.record.claims[0].evidence.exactQuote,f.chat.message[1].data);
    assert.equal(memory.record.sourceRevisionId,raw.receipt.revisionId);assert.equal(memory.record.sourceDigest,raw.receipt.sourceDigest);
    assert.equal(fx.getRecords('libra.micro_memory.v1').some(x=>JSON.stringify(x.value).includes('OLD_VARIANT_8051')),false);
    assert.equal(fx.getRecords('libra.completed_turn_receipt.v1').length,2,'raw variant history remains immutable');
    for(const row of fx.getRecords('libra.completed_turn_receipt.v1'))assert.deepEqual(JSON.parse(fx.local.get(row.key)),row.value,'mirror raw bytes match');
  }finally{release.resolve();await fx.cleanup();}
});
for(const mutation of ['edit','delete','scope'])test(`${mutation} during held analysis rejects stale publication`,async()=>{
  const {fx,listener,event}=await fixture(),entered=deferred(),release=deferred();
  try{
    const f=fx.f;f.control.onCall=async args=>{entered.resolve();await release.promise;return microResult(args);};
    listener(event());await entered.promise;
    if(mutation==='edit')f.chat.message[1].data+=' EDITED_WITHOUT_OUTPUT_CALLBACK_4612';
    if(mutation==='delete')f.chat.message.splice(1,1);
    if(mutation==='scope'){f.chat.id='other-scope-chat';f.chat.chatId='other-scope-chat';}
    release.resolve();await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication,15000);
    assert.equal(fx.getRecords('libra.micro_memory_head.v1').length,0,'stale analysis cannot publish active memory');
    assert.equal(fx.getRecords('libra.completed_turn_receipt.v1').length,1,'original immutable raw remains retained');
    const active=await f.r.api.debugReadActiveMicroMemory(1);assert.notEqual(active.status,'verified');
    assert.equal(f.control.calls.length,1,'source invalidation never causes an unrequested second analysis');
  }finally{release.resolve();await fx.cleanup();}
});
test('fresh runtime reads the durable completed memory without re-analysis',async()=>{
  const out=await fixture('mirror'),{fx}=out;
  try{
    out.listener(out.event());await waitFor(()=>fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const first=await fx.f.r.api.debugReadActiveMicroMemory(1),before=JSON.stringify(first.record);
    await fx.restart();const fresh=await fx.f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(fresh.status,'verified');assert.equal(JSON.stringify(fresh.record),before);
    assert.equal(fx.f.control.calls.length,0,'restart is durable readback, not a new analysis');
    assert.equal(fresh.record.claims[0].evidence.exactQuote,fx.f.chat.message[1].data);
  }finally{await fx.cleanup();}
});
test('known raw write failure is visible and retries the exact original source once',async()=>{
  const {fx,listener,event}=await fixture('plugin_only');
  try{
    const f=fx.f,set=fx.backend.setItem;let attempts=0;
    fx.backend.setItem=async(k,v)=>{if(k.includes(':source-receipt:')&&++attempts===1)return false;return set(k,v);};
    listener(event());await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus==='pending_reconciliation',5000);
    assert.equal([...fx.local.values()].some(raw=>{try{return JSON.parse(raw).schema==='libra.completed_turn_receipt.v1';}catch{return false;}}),false,
      'failed acknowledgement does not claim RAM data durable');
    await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const raw=await f.r.api.debugReadActiveCompletedTurnReceipt(1),memory=await f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(raw.status,'verified');assert.equal(raw.receipt.assistant.text,f.chat.message[1].data);
    assert.equal(memory.record.sourceRevisionId,raw.receipt.revisionId);assert.equal(memory.record.claims[0].evidence.exactQuote,raw.receipt.assistant.text);
    assert.equal(attempts,2,'one failed write plus one admitted known-failure retry');assert.equal(f.control.calls.length,1);
  }finally{await fx.cleanup();}
});

test('authoritative same-visible-text raw variant publishes the current source provenance',async()=>{
  const {fx,listener,event}=await fixture();
  try{
    const f=fx.f;f.chat.message[1].data='Mara closed the bronze door.<lb-stage-marker>old</lb-stage-marker>';
    listener(event());await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified',15000);
    const first=await f.r.api.debugReadActiveMicroMemory(1);
    f.chat.message[1].data='Mara closed the bronze door.<lb-stage-marker>new</lb-stage-marker>';listener(event());
    await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.revision===2
      &&f.r.api.getCaptureBackendState().lastMicroPublication?.status==='verified'
      &&f.r.api.getCaptureBackendState().lastMicroPublication.revisionId===f.r.api.getCaptureBackendState().lastOutputCapture.receiptRevisionId,15000);
    const raw=await f.r.api.debugReadActiveCompletedTurnReceipt(1),memory=await f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(raw.receipt.assistant.text,'Mara closed the bronze door.');
    assert.notEqual(raw.receipt.revisionId,first.record.sourceRevisionId);assert.equal(memory.record.sourceRevisionId,raw.receipt.revisionId);
    assert.equal(memory.record.claims[0].evidence.exactQuote,raw.receipt.assistant.text);
    assert.equal(fx.getRecords('libra.completed_turn_receipt.v1').length,2);assert.equal(f.control.calls.length,2);
  }finally{await fx.cleanup();}
});
