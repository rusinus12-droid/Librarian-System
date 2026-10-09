'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
function instrumentPolicy(source){
  const anchor='function memorySuiteSourceTagKey(owner) {';
  assert.ok(source.includes(anchor));
  return source.replace(anchor,anchor+' globalThis.__capturePolicyReads = (globalThis.__capturePolicyReads || 0) + 1;');
}
test('one stable source-policy snapshot serves a whole synchronous pair validation pass',async()=>{
  const f=await fixture({transformSource:instrumentPolicy});
  try{
    const chat={id:'capture-cost-history',message:[]};
    for(let t=1;t<=2000;t++)chat.message.push({role:'user',chatId:`cost-${t}-u`,data:`Source user ${t}`},
      {role:'assistant',chatId:`cost-${t}-a`,data:`Source assistant ${t}`});
    const first=f.r.api.debugBuildPairs(chat,'capture-cost-history');assert.equal(first.length,2000);
    f.r.context.__capturePolicyReads=0;
    const warm=f.r.api.debugBuildPairs(chat,'capture-cost-history');
    assert.deepEqual(warm,first,'every exact source row still validates to the same turn/identity/digest');
    assert.ok(f.r.context.__capturePolicyReads<=2,
      `stable policy should be snapshotted once per synchronous pass, not once per row: ${f.r.context.__capturePolicyReads}`);
    chat.message[3999].data='Edited exact assistant 2000';
    const changed=f.r.api.debugBuildPairs(chat,'capture-cost-history');assert.equal(changed.at(-1).assistant.text,'Edited exact assistant 2000');
    assert.notDeepEqual(changed.at(-1).assistant.rawPayloadDigests,first.at(-1).assistant.rawPayloadDigests);
  }finally{await f.r.cleanup();}
});

test('unchanged validated pair snapshot reuses its exact prefix fence and edits invalidate it',async()=>{
  function instrumentFence(source){
    const start=source.indexOf('    const sourceDigest = batch => digest('),end=source.indexOf('    const completedTurnRevisionId =',start);
    assert.ok(start>=0&&end>start);
    const block=source.slice(start,end).replace('batch => digest(','batch => { if(batch.length===1000)globalThis.__captureFenceHashes=(globalThis.__captureFenceHashes||0)+1; return digest(')
      .replace(/\)\)\);\s*$/,'))); };\n');
    source=source.slice(0,start)+block+source.slice(end);
    const anchor='      debugReadActiveCompletedTurnReceipt: async turnValue => {';
    source=source.replace(anchor,"      debugCaptureFenceFixture: async () => { const context=await resolveContext(true),pairs=buildPairs(context.chat,context.scope.scopeKey); return captureReceiptRecoveryBoundary(context,pairs.at(-1)); },\n"+anchor);
    const root="    debugBuildPairs(chat = {}, cacheKey = '')";
    return source.replace(root,"    async debugCaptureFenceFixture() { return safeClone(await LibraMemoryCore.debugCaptureFenceFixture()); },\n"+root);
  }
  const f=await fixture({transformSource:instrumentFence});
  try{
    f.chat.message=[];f.chat.messages=f.chat.message;
    for(let t=1;t<=1000;t++)f.chat.message.push({role:'user',chatId:`fence-${t}-u`,data:`Fence user ${t}`},
      {role:'assistant',chatId:`fence-${t}-a`,data:`Fence assistant ${t}`});
    f.r.context.__captureFenceHashes=0;
    const first=await f.r.api.debugCaptureFenceFixture(),warm=await f.r.api.debugCaptureFenceFixture();
    assert.equal(warm.sourceFence,first.sourceFence,'same exact validated prefix retains the existing fence bytes');
    assert.equal(f.r.context.__captureFenceHashes,1,'unchanged validated snapshot hashes its full source prefix once');
    f.chat.message[1].data='Edited early source without an output callback';
    const changed=await f.r.api.debugCaptureFenceFixture();assert.notEqual(changed.sourceFence,first.sourceFence,'early unannounced edit invalidates the cached fence');
    assert.equal(f.r.context.__captureFenceHashes,2);
  }finally{await f.r.cleanup();}
});

test('same sanitized text with changed raw bytes refreshes receipt provenance',async()=>{
  const f=await fixture();
  try{
    const chat={id:'capture-carrier-revision',message:[{role:'user',chatId:'carrier-u',data:'Close the bronze door.'},
      {role:'assistant',chatId:'carrier-a',data:'Mara closed the bronze door.<lb-stage-marker>old</lb-stage-marker>'}]};
    const first=f.r.api.debugBuildPairs(chat,'capture-carrier-revision');
    chat.message[1].data='Mara closed the bronze door.<lb-stage-marker>new</lb-stage-marker>';
    const changed=f.r.api.debugBuildPairs(chat,'capture-carrier-revision');
    assert.equal(changed[0].assistant.text,first[0].assistant.text,'visible source is intentionally unchanged by carrier replacement');
    assert.notDeepEqual(changed[0].assistant.rawPayloadDigests,first[0].assistant.rawPayloadDigests,
      'receipt provenance must bind the current raw bytes even if sanitization returns the same visible text');
  }finally{await f.r.cleanup();}
});
