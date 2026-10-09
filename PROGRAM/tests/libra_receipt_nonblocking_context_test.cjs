'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');

const MARKER = 'TASK5_ONLY_IN_COMPLETED_ASSISTANT_4826';
const rows = local => [...local].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});

(async () => {
  const fx = await serverFixture({mode: 'plugin_only', args: {
    live_context_enabled: 'true', classic_live_tail_enabled: 'true', live_tail_max_turns: '4'}});
  try {
    const {f, local} = fx;
    f.chat.message[9].data += ` ${MARKER}`;
    await f.run();
    await f.r.api.saveLibraProviderConfig({responseFamily: 'libra', libraResponseMode: 'planner'});
    let providerInput = '';
    f.control.onCall = async args => { providerInput += JSON.stringify(args); return {type: 'success', result: 'BRIEF'}; };
    const request = [{role: 'user', content: 'Continue the scene'}];
    const before = await f.control.hooks.beforeRequest(request, 'model');
    assert.match(f.r.api.getLastLiveTail()?.transcript || '', new RegExp(MARKER), 'verified latest receipt reaches recent context');
    assert.equal(f.r.api.getLastResponseContext()?.receiptReadSet?.readSetDigest,
      f.r.api.getLastLiveTail()?.receiptReadSetDigest,
      'all response consumers share the same frozen receipt read-set identity');
    const key = rows(local).find(row => row.value.schema === 'libra.completed_turn_receipt.v1' && row.value.turn === 5).key;
    local.delete(key);
    f.character.lorebook = [{id:'missing-receipt-trigger',name:'Missing receipt trigger',
      content:'LORE_ACTIVATED_ONLY_BY_MISSING_RECEIPT_6732',keys:[MARKER],priority:100,
      enabled:true,constant:false,selective:false,excludeRecursion:false,preventRecursion:false}];
    providerInput = '';
    const after = await f.control.hooks.beforeRequest(request, 'model');
    const supplied = after.map(row => String(row.content || '')).join('\n');
    assert.doesNotMatch(providerInput, new RegExp(MARKER), 'missing receipt cannot reach planner provider from raw completed chat');
    // Prior claim refuted during 2026-10-02 recovery: this native character
    // lore has no receipt-source binding. The independent full-corpus ranker
    // may select it even when the missing dialogue supplies no activation.
    // An observed starting_frontier selection (BM25=0, lexical=0, fuzzy exact
    // signal=.84) was not evidence of raw-chat leakage. Check the actual
    // activation contract; do not prohibit legitimate native lore by body text.
    const missingReceiptLore = f.r.api.getLastResponseLore();
    assert.equal(missingReceiptLore?.candidateCount, 1);
    assert.equal(missingReceiptLore?.activeSignalCount, 0, 'missing receipt supplies no lore activation signal');
    assert.equal(missingReceiptLore?.hostSelectedCount, 0, 'missing receipt supplies no host-selected lore proof');
    assert.doesNotMatch(f.r.api.getLastLiveTail()?.transcript || '', new RegExp(MARKER), 'missing receipt cannot reach Live Tail');
    assert.doesNotMatch(supplied, new RegExp(MARKER));
    assert.equal(f.r.api.getLastLiveTail()?.completeRequestedCoverage, false);
    const partialContext=f.r.api.getLastResponseContext();
    assert.equal(partialContext?.receiptReadSet?.status,'partial');
    assert.deepEqual(Array.from(partialContext.receiptReadSet.gaps,gap=>gap.turn),[5]);
    console.log(JSON.stringify({test:'libra_receipt_nonblocking_context',
      route:'planner',receiptStatus:partialContext.receiptReadSet.status,
      verifiedTurns:partialContext.receiptReadSet.refs.map(ref=>ref.turn),
      gapTurns:partialContext.receiptReadSet.gaps.map(gap=>gap.turn),
      liveTurns:f.r.api.getLastLiveTail()?.sourcePairs?.map(pair=>pair.turn),
      liveChars:f.r.api.getLastLiveTail()?.chars,
      liveMaxChars:f.r.api.getLastLiveTail()?.maxChars}));
    assert.match(supplied, /Continue the scene/, 'main request continues with current user input');
    const readOnly = await f.r.api.getResponseContext({currentInput: 'Continue the scene'});
    assert.doesNotMatch(JSON.stringify(readOnly.values?.liveTail || null), new RegExp(MARKER), 'read-only context uses receipts');
    assert.doesNotMatch(String(readOnly.values?.terminalScene || ''), new RegExp(MARKER));
    const writer = await f.r.api.prepareInputWriterEvidence('Continue the scene');
    assert.doesNotMatch(JSON.stringify(writer), new RegExp(MARKER), 'Input Writer uses the same receipt projection');
    await f.r.api.saveLibraProviderConfig({responseFamily: 'libra', libraResponseMode: 'classic'});
    const classic = await f.control.hooks.beforeRequest(request, 'model');
    assert.doesNotMatch(classic.map(row => String(row.content || '')).join('\n'), new RegExp(MARKER),
      'Classic cannot restore a missing receipt from chat');
    assert.equal(f.r.api.getLastLiveTail()?.sourceMode, 'verified_completed_receipts');
    const canonical=await f.control.hooks.beforeRequest([{role:'user',content:'공연 허가자는 밝혀졌나?'}],'model');
    assert.match(canonical.map(row=>String(row.content||'')).join('\n'),
      /공연 허가자가 누구인지 아직 밝혀지지 않았다\./,
      'a ready Canonical fact remains available even though the latest receipt is missing');
    await f.r.api.saveLibraProviderConfig({responseFamily: 'gradia', gradiaWritingMode: 'rp'});
    providerInput = '';
    await f.control.hooks.beforeRequest(request, 'model');
    assert.ok(providerInput.length > 0, 'GRADIA fixture must enter a provider stage');
    assert.doesNotMatch(providerInput, new RegExp(MARKER), 'GRADIA cannot use missing completed dialogue');
    console.log('PASS nonblocking response excludes missing receipt and preserves current input');
  } finally { await fx.cleanup(); }
  const race = await serverFixture({mode:'plugin_only',args:{live_context_enabled:'true'}});
  try {
    race.f.chat.message[9].data += ` ${MARKER}`;
    await race.f.run();
    await race.f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'planner'});
    let changed=false;
    race.f.control.onCall = async () => {
      if (!changed) { race.f.chat.message[9].data += ' EDITED_AFTER_READ'; changed=true; }
      return {type:'success',result:`BRIEF ${MARKER}`};
    };
    const delivered = await race.f.control.hooks.beforeRequest([{role:'user',content:'Continue the scene'}], 'model');
    assert.equal(changed,true,'fixture edited the source while the Planner provider was awaited');
    assert.doesNotMatch(delivered.map(row=>String(row.content||'')).join('\n'),new RegExp(MARKER),
      'a late source edit rejects a stale derived response without blocking the main request');
  } finally { await race.cleanup(); }
  const classicRace = await serverFixture({mode:'plugin_only',args:{classic_live_tail_enabled:'true'}});
  try {
    classicRace.f.chat.message[9].data += ` ${MARKER}`;
    await classicRace.f.run();
    await classicRace.f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
    let changed=false;
    const originalGet=classicRace.backend.getItem;
    classicRace.backend.getItem=async key=>{
      if(!changed && classicRace.f.r.api.getLastLiveTail()?.sourceMode==='verified_completed_receipts'){
        classicRace.f.chat.message[9].data+=' EDITED_AFTER_READ';changed=true;
      }
      return originalGet(key);
    };
    const delivered=await classicRace.f.control.hooks.beforeRequest([{role:'user',content:'Continue the scene'}],'model');
    assert.equal(changed,true,'fixture edited source after receipt projection and before delivery');
    assert.doesNotMatch(delivered.map(row=>String(row.content||'')).join('\n'),new RegExp(MARKER),
      'Classic cannot inject a receipt from an invalidated source revision');
  } finally { await classicRace.cleanup(); }
  const delayed = await serverFixture({mode:'plugin_only',args:{classic_live_tail_enabled:'true'}});
  let releaseRead;
  try {
    delayed.f.chat.message[9].data += ` ${MARKER}`;
    await delayed.f.run();
    delayed.f.character.lorebook=[{id:'delayed-raw-trigger',name:'Delayed raw trigger',
      content:'LORE_FROM_TIMED_OUT_RAW_CHAT_9081',keys:[MARKER],priority:100,
      enabled:true,constant:false,selective:false}];
    await delayed.f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'planner'});
    let providerInput='';
    delayed.f.control.onCall=async args=>{providerInput+=JSON.stringify(args);return {type:'success',result:'BRIEF'};};
    const request=[{role:'user',content:'Continue the scene'}];
    await delayed.f.control.hooks.beforeRequest(request,'model');
    assert.equal(delayed.f.r.api.getLastLiveTail()?.available,true,'fixture establishes an earlier available context');
    providerInput='';
    let markHeld;
    const held=new Promise(resolve=>{markHeld=resolve;});
    const gate=new Promise(resolve=>{releaseRead=resolve;});
    const originalGet=delayed.backend.getItem;
    const delayedKey=rows(delayed.local).find(row=>row.value.schema==='libra.completed_turn_receipt.v1'
      && row.value.turn===5).key;
    let paused=false;
    delayed.backend.getItem=async key=>{
      if(!paused && key===delayedKey){
        paused=true;markHeld();await gate;
      }
      return originalGet(key);
    };
    const pending=delayed.f.control.hooks.beforeRequest(request,'model');
    await Promise.race([held,new Promise((_,reject)=>setTimeout(()=>reject(Error('receipt read not reached')),5000))]);
    const delivered=await pending;
    assert.match(delivered.map(row=>String(row.content||'')).join('\n'),/Continue the scene/);
    // Same corrected contract as above: native lore ranking is independent,
    // but the timed-out raw dialogue must supply neither text nor activation.
    assert.doesNotMatch(providerInput,new RegExp(MARKER),
      'timed-out receipt read must not reopen raw host dialogue');
    const timedOutReceiptLore=delayed.f.r.api.getLastResponseLore();
    assert.equal(timedOutReceiptLore?.candidateCount,1);
    assert.equal(timedOutReceiptLore?.activeSignalCount,0);
    assert.equal(timedOutReceiptLore?.hostSelectedCount,0);
    const partialTail=delayed.f.r.api.getLastLiveTail();
    assert.deepEqual(Array.from(partialTail?.sourcePairs||[],row=>row.turn),[2,3,4],
      'a slow latest receipt retains earlier verified recent dialogue');
    assert.doesNotMatch(partialTail.transcript,new RegExp(MARKER));
    const tailHash=partialTail.hash;
    releaseRead();
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(delayed.f.r.api.getLastLiveTail()?.hash,tailHash,
      'a late receipt read cannot replace the partial context after the request has moved on');
  } finally { releaseRead?.(); await delayed.cleanup(); }
  const newestSlow=await serverFixture({mode:'plugin_only',args:{classic_live_tail_enabled:'true'}});
  try {
    newestSlow.f.chat.message[9].data+=` ${MARKER}`;
    await newestSlow.f.run();
    await newestSlow.f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
    const slowKey=rows(newestSlow.local).find(row=>row.value.schema==='libra.completed_turn_receipt.v1'
      && row.value.turn===5).key;
    const originalGet=newestSlow.backend.getItem;
    const callWithSlowNewest=async call=>{
      let release,held=false;
      const gate=new Promise(resolve=>{release=resolve;});
      newestSlow.backend.getItem=async key=>{
        if(!held && key===slowKey){held=true;await gate;}
        return originalGet(key);
      };
      try {
        const result=await Promise.race([call(),new Promise((_,reject)=>setTimeout(()=>reject(Error('recent reader held caller past deadline')),3500))]);
        assert.equal(held,true,'fixture delayed newest receipt');
        return result;
      } finally {release();newestSlow.backend.getItem=originalGet;}
    };
    const input=[{role:'user',content:'Continue the scene'}];
    const prompt=await callWithSlowNewest(()=>newestSlow.f.control.hooks.beforeRequest(input,'model'));
    const partial=newestSlow.f.r.api.getLastResponseContext();
    assert.equal(partial?.receiptReadSet?.status,'partial','earlier ready receipts survive a late T5');
    assert.deepEqual(Array.from(partial.receiptReadSet.gaps,row=>row.turn),[5]);
    assert.deepEqual(Array.from(newestSlow.f.r.api.getLastLiveTail()?.sourcePairs||[],row=>row.turn),[2,3,4]);
    assert.match(prompt.map(row=>String(row.content||'')).join('\n'),/Continue the scene/);
    assert.doesNotMatch(prompt.map(row=>String(row.content||'')).join('\n'),new RegExp(MARKER));
    const readOnly=await callWithSlowNewest(()=>newestSlow.f.r.api.getResponseContext({currentInput:'Continue the scene'}));
    assert.equal(readOnly.receiptReadSet.status,'partial','read-only direct caller is bounded and partial');
    const writer=await callWithSlowNewest(()=>newestSlow.f.r.api.prepareInputWriterEvidence('Continue the scene'));
    assert.equal(writer.evidencePacket.receipt_read_set.status,'partial','Input Writer direct caller is bounded and partial');
  } finally {await newestSlow.cleanup();}
})().catch(error => { console.error(error); process.exitCode = 1; });
