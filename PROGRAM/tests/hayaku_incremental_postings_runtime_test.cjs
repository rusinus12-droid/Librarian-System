'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const packet=turn=>({raw:JSON.stringify(createValidPacket({turn,summary:`aurora archive marker${turn}`})),hash:`source-${turn}`,messageIndex:turn*2-1,worldlineOrdinal:turn});
const pause=()=>new Promise(r=>setTimeout(r,20));
async function prepare(h,packets,scope){const store={index:[],context:{}};const settings={...h.hayaku.settings(),retrievalCurrentQuery:'aurora archive',retrievalRecentContext:{topics:[]}};
  const coverage=await h.hayaku._test.localRecallPrepareSources(packets,store,settings,scope,Date.now()+10000);return {coverage,store};}
async function settle(h,packets,scope){let out;for(let i=0;i<200;i++){out=await prepare(h,packets,scope);if(out.coverage.routing.index?.current||out.coverage.routing.index?.status==='unavailable')return out;await pause();}assert.fail('posting build did not settle');}
test('2000 sources preserve all lexical terms within compact durable dictionary budgets',async()=>{const h=await createHayakuRuntime({autoRepair:false,afterRequestAutoRepair:false});try{
  const scope=(await h.hayaku._test.currentChatScope()).key,packets=Array.from({length:2000},(_,i)=>packet(i+1));
  const out=await settle(h,packets,scope),index=out.coverage.routing.index;
  assert.equal(index.current,true,JSON.stringify(index));assert.equal(index.durable,true);
  assert.ok(index.postingBuildTerms>250000,'fixture reproduces the old repeated-membership quota');
  assert.ok(index.uniqueTerms<=250000);assert.ok(index.bytes<=4194304);assert.ok(index.pages<=128);
  assert.equal(index.documentMembershipStorage,'uint32_term_ids');
  assert.equal(index.documentMembershipBytes,index.postingBuildTerms*4);
  assert.equal(index.postingMembershipBytes,index.postingBuildTerms*2);
  assert.equal(index.encodedMembershipBytes,index.documentMembershipBytes+index.postingMembershipBytes);
  assert.ok(index.encodedMembershipBytes<=4194304);assert.ok(index.dictionaryChars<=8000000);
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
  console.log(JSON.stringify({control:'2000 compact dictionary',index}));
}finally{await h.dispose();}});
test('combined retained source and lookup memberships reject over-budget CJK corpus conservatively',async()=>{
  const h=await createHayakuRuntime({autoRepair:false,afterRequestAutoRepair:false});try{
    const scope=(await h.hayaku._test.currentChatScope()).key,cjk=Array.from({length:650},(_,i)=>String.fromCharCode(0x4e00+i)).join('');
    const packets=Array.from({length:1000},(_,i)=>({raw:JSON.stringify(createValidPacket({turn:i+1,summary:cjk})),hash:`cjk-${i}`,messageIndex:i*2+1,worldlineOrdinal:i+1}));
    const out=await settle(h,packets,scope),index=out.coverage.routing.index;
    assert.equal(index.current,false);assert.equal(index.durable,false);assert.equal(index.error,'recall_index_membership_budget');
    assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
    console.log(JSON.stringify({control:'combined retained membership limit',index}));
  }finally{await h.dispose();}
});
test('a one-source change serializes and writes only its stable source shards',async()=>{const h=await createHayakuRuntime({autoRepair:false,afterRequestAutoRepair:false});try{
  const scope=(await h.hayaku._test.currentChatScope()).key,packets=Array.from({length:100},(_,i)=>packet(i+1));
  await settle(h,packets,scope);packets.push(packet(101));const added=(await settle(h,packets,scope)).coverage.routing.index;
  assert.equal(added.builtSources,1);assert.ok(added.pageBuildSources<64,JSON.stringify(added));assert.ok(added.postingUpdateSources<=1);
  packets[5].raw=JSON.stringify(createValidPacket({turn:6,summary:'borealis replacement marker6'}));const edited=(await settle(h,packets,scope)).coverage.routing.index;
  assert.equal(edited.builtSources,1);assert.ok(edited.pageBuildSources<64);assert.ok(edited.postingUpdateSources<=2);
  assert.equal(h.llmCalls.length,0);console.log(JSON.stringify({control:'incremental add/edit',added,edited}));
}finally{await h.dispose();}});
test('registered warm consumer reuses owned exact raw digests while retaining current source scan',async()=>{const messages=[];for(let i=1;i<=10;i++){const p=createValidPacket({turn:i,summary:`aurora archive marker${i}`});messages.push({role:'user',chatId:`u${i}`,data:`turn ${i}`},{role:'assistant',chatId:`a${i}`,data:hiddenPacketMessage(`aurora archive marker${i}`,p)});}messages.push({role:'user',chatId:'q',data:'aurora archive'});
  const h=await createHayakuRuntime({messages,autoRepair:false,afterRequestAutoRepair:false});try{const request=()=>[{role:'system',content:'Continue the story.'},...messages];
    await h.callBeforeRequest(request());await pause();await h.callBeforeRequest(request());await pause();const rendered=await h.callBeforeRequest(request());
    const routing=h.hayaku.lastDebug().localRecallSourceIndex?.routing||h.hayaku.lastDebug().requestStore?._recallSourceCoverage?.routing;
    assert.ok(routing);assert.equal(routing.validationSources,10);assert.ok(routing.validationChars>1000);assert.equal(routing.validationHashChars,0,'warm owned raw revisions must avoid another full hash pass');
    assert.ok(JSON.stringify(rendered).includes('marker1'));assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);
    console.log(JSON.stringify({control:'registered owned exact proof warm',routing}));
  }finally{await h.dispose();}});
test('lexical rank reuses compiled eligible postings without re-tokenizing or scanning all terms',async()=>{const h=await createHayakuRuntime({autoRepair:false,afterRequestAutoRepair:false});try{
  const scope=(await h.hayaku._test.currentChatScope()).key,packets=Array.from({length:10},(_,i)=>packet(i+1));const {store}=await settle(h,packets,scope);
  const rows=store._recallSourceRows,t=h.hayaku._test;const first=t.localRecallRank(rows,['marker1']),second=t.localRecallRank(rows,['marker1']);
  assert.deepEqual(second.map(row=>row.recordKey),first.map(row=>row.recordKey));
  const metrics=h.hayaku.lastDebug().localRecallRank;
  assert.equal(metrics.compiledIndexHit,true);assert.equal(metrics.documentTokenizations,0);assert.equal(metrics.fullTermScans,0);
  const changed=rows.map(row=>({...row}));changed[0].publicText='borealis replacement';t.localRecallRank(changed,['borealis']);assert.equal(h.hayaku.lastDebug().localRecallRank.compiledIndexHit,false);
  assert.equal(h.llmCalls.length,0);console.log(JSON.stringify({control:'eligible lexical compiled index',metrics}));
}finally{await h.dispose();}});
