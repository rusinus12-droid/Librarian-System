'use strict';
// Home status polling (getReceiptRecoveryStatus) verified each turn's receipt and
// Micro work, then readActiveMicroMemory fetched the same receipt and work again
// before its own closing re-check. In a live mirror session that was ~100 polls
// of 28 turns: 2,949 receipt reads (161 MB) in 2.5 hours. The poll now hands its
// verified receipt and work to the Micro reader; the closing re-reads remain.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {microReply,transformSource}=require('./fixtures/libra_reanalysis_kinds_fixture.cjs');
const family=storageKey=>(String(storageKey).match(/:(source-receipt-head|source-receipt|micro-work|micro-memory-head|micro-memory):/)||[])[1]||'other';

for(const mode of ['mirror','server_only'])test('status polling reads each verified receipt and work once before the closing re-check through '+mode,async()=>{
  const fx=await serverFixture({mode,transformSource});try{
    const f=fx.f;f.chat.message.splice(2);f.control.onCall=args=>microReply(args,'최초 미크로');
    const inventory=await f.r.api.listReanalysisRanges({kind:'micro'});
    assert.equal((await f.r.api.reanalyzeSelectedRanges(inventory)).ok,true);
    const published=await f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(published.status,'verified');
    assert.ok(published.head.workDigest,'the published head is bound to its work journal');
    const scope=(await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
    const pollScope={scopeKey:scope.scopeKey,characterId:scope.characterId,chatId:scope.chatId};
    // Let post-publication background reads settle, then measure one steady poll.
    await f.r.api.getReceiptRecoveryStatus({scope:pollScope});await new Promise(resolve=>setTimeout(resolve,300));
    const start=fx.requests.length;
    const status=await f.r.api.getReceiptRecoveryStatus({scope:pollScope});
    const counts={};
    // A read is one key, whether it travels alone (/v1/kv/get) or in a batch (/v1/kv/get-many).
    // A batch's continuation pages (cursor > 0) repeat its keys and are not new reads.
    const count=key=>{const name=family(key);counts[name]=(counts[name]||0)+1;};
    for(const request of fx.requests.slice(start)){
      const url=new URL(request.url);
      if(url.pathname==='/v1/kv/get')count(url.searchParams.get('key'));
      else if(url.pathname==='/v1/kv/get-many'){
        const body=JSON.parse(request.body||'{}');
        if(!Number(body.cursor||0))for(const key of body.keys||[])count(key);
      }
    }
    assert.equal(status.receiptStages[0].status,'verified');
    assert.equal(status.microJobs[0].status,'succeeded',JSON.stringify(status.microJobs[0]));
    // Was 3 receipt bodies, 3 receipt heads and 2 work reads per turn.
    assert.deepEqual({receipt:counts['source-receipt'],head:counts['source-receipt-head'],work:counts['micro-work'],
      microHead:counts['micro-memory-head'],micro:counts['micro-memory']},{receipt:2,head:2,work:1,microHead:2,micro:1},JSON.stringify(counts));
  }finally{await fx.cleanup();}
});

// The same poll also read the host once or twice per turn to re-check the open chat. The host
// returns a full copy of the character (every chat included) on each read, so a 150-turn chat
// cost about 300 full copies per poll (Android out-of-memory reports). The poll now reads the
// host once for the scan and once to close it, whatever the number of turns.
test('status polling reads the host a fixed number of times, not once per turn',async()=>{
  const fx=await serverFixture({mode:'server_only',transformSource});try{
    const f=fx.f,turns=Math.floor(f.chat.message.length/2);
    assert.ok(turns>=5,'the fixture chat has several turns');
    const first=await f.r.api.getReceiptRecoveryStatus();
    const scope={scopeKey:first.scopeKey,characterId:f.character.chaId,chatId:f.chat.id};
    await new Promise(resolve=>setTimeout(resolve,300));
    const poll=async()=>{const before={...f.control.hostReads};const status=await f.r.api.getReceiptRecoveryStatus({scope});
      return {status,character:f.control.hostReads.character-before.character,chat:f.control.hostReads.chat-before.chat};};
    const short=await poll();
    assert.equal(short.status.receiptStages.length,turns,'every turn is still reported');
    assert.ok(short.character<=2&&short.chat<=2,'scan read and closing read only: '+JSON.stringify({character:short.character,chat:short.chat}));
    for(let i=0;i<20;i++)f.chat.message.push({role:i%2?'char':'user',chatId:'extra-'+i,data:(i%2?'민아는 고개를 끄덕였다 ':'다음 방으로 간다 ')+i});
    const long=await poll();
    assert.equal(long.status.receiptStages.length,turns+10);
    assert.deepEqual({character:long.character,chat:long.chat},{character:short.character,chat:short.chat},'ten more turns add no host read');
  }finally{await fx.cleanup();}
});

// A turn with published Micro memory takes the longer path: the Micro reader re-checks the
// source itself. That check must share the scan's host read too, or the reads grow per turn
// again exactly where real chats have memory.
test('turns with published Micro memory add no host read either',async()=>{
  const fx=await serverFixture({mode:'server_only',transformSource});try{
    const f=fx.f;f.chat.message.splice(4);f.control.onCall=args=>microReply(args,'최초 미크로');
    assert.equal((await f.r.api.reanalyzeSelectedRanges(await f.r.api.listReanalysisRanges({kind:'micro'}))).ok,true);
    const receipt=(await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
    const scope={scopeKey:receipt.scopeKey,characterId:receipt.characterId,chatId:receipt.chatId};
    await f.r.api.getReceiptRecoveryStatus({scope});await new Promise(resolve=>setTimeout(resolve,300));
    const before={...f.control.hostReads};
    const status=await f.r.api.getReceiptRecoveryStatus({scope});
    const reads={character:f.control.hostReads.character-before.character,chat:f.control.hostReads.chat-before.chat};
    // The plugin runs in its own realm, so compare by value.
    assert.equal(Array.from(status.receiptStages,row=>row.status).join(),'verified,verified');
    assert.equal(Array.from(status.microJobs,row=>row.status).join(),'succeeded,succeeded',JSON.stringify(status.microJobs));
    assert.ok(reads.character<=2&&reads.chat<=2,'scan read and closing read only: '+JSON.stringify(reads));
  }finally{await fx.cleanup();}
});

// The closing read must notice every change the per-turn checks would have noticed. A
// whitespace-only edit changes the turn's revision but not its sanitized text.
for(const [name,edit] of [['a text edit',data=>data+' (수정됨)'],['a whitespace-only edit',data=>data+'  ']])
test(name+' during the scan is reported from the edited chat, not as verified',async()=>{
  const fx=await serverFixture({mode:'server_only',transformSource});try{
    const f=fx.f;f.chat.message.splice(2);f.control.onCall=args=>microReply(args,'최초 미크로');
    assert.equal((await f.r.api.reanalyzeSelectedRanges(await f.r.api.listReanalysisRanges({kind:'micro'}))).ok,true);
    const receipt=(await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt;
    const scope={scopeKey:receipt.scopeKey,characterId:receipt.characterId,chatId:receipt.chatId};
    assert.equal((await f.r.api.getReceiptRecoveryStatus({scope})).receiptStages[0].status,'verified');
    await new Promise(resolve=>setTimeout(resolve,300));
    // Edit the assistant message after the scan has read the host, while it is reading storage:
    // only the closing read can notice it.
    let edited=false;const readsAtStart=f.control.hostReads.chat;fx.hooks.beforeServerRequest=async()=>{if(edited||f.control.hostReads.chat<=readsAtStart)return;edited=true;f.chat.message[1]={...f.chat.message[1],data:edit(f.chat.message[1].data)};};
    const status=await f.r.api.getReceiptRecoveryStatus({scope});fx.hooks.beforeServerRequest=null;
    assert.equal(edited,true,'the poll read storage after its host read');
    assert.notEqual(status.receiptStages[0]?.status,'verified',JSON.stringify(status.receiptStages[0]));
    assert.equal(status.microJobs.length,0,'no Micro stage is reported for a receipt that no longer matches the chat');
  }finally{await fx.cleanup();}
});
