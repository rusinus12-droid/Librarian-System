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
    for(const request of fx.requests.slice(start)){
      if(!request.url.includes('/v1/kv/get?'))continue;
      const name=family(new URL(request.url).searchParams.get('key'));
      counts[name]=(counts[name]||0)+1;
    }
    assert.equal(status.receiptStages[0].status,'verified');
    assert.equal(status.microJobs[0].status,'succeeded',JSON.stringify(status.microJobs[0]));
    // Was 3 receipt bodies, 3 receipt heads and 2 work reads per turn.
    assert.deepEqual({receipt:counts['source-receipt'],head:counts['source-receipt-head'],work:counts['micro-work'],
      microHead:counts['micro-memory-head'],micro:counts['micro-memory']},{receipt:2,head:2,work:1,microHead:2,micro:1},JSON.stringify(counts));
  }finally{await fx.cleanup();}
});
