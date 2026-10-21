'use strict';
// Retirement contract (commit 9c03c35): there is no separate Classic "closure" consumer any more.
// A lifecycle successor (resolve / reopen link) is an ordinary canonical memory delivered by the
// unified engine, or excluded when its stored bytes are missing/stale/tampered. This test pins that
// replacement behaviour on the same two-batch thread fixture.
const assert=require('node:assert/strict');
const {generated,fixture,query,system,rows,threadArtifact,candidateRowsFromPrompt}=require('./fixtures/libra_q04_thread_fixture.cjs');
const AUTHORITY='Current user input and the visible scene take priority';
const RETIRED_TEXT=['LATER CANONICAL CONTINUITY EVIDENCE','continuity coverage is incomplete','last-known evidence only','a later transition may be missing'];
const noRetired=(text,label)=>{for(const s of RETIRED_TEXT) assert.ok(!text.includes(s),label+': retired closure text absent: '+s);};
(async()=>{
 const f=await generated();
 let snapshot,originalText;
 try {
  const first=f.getMemory(1),successor=f.getMemory(6),fact=successor.canonicalArtifact.facts[0];
  assert.equal(fact.values.thread.linkStatus,'accepted');
  assert.equal(fact.values.thread.link,'resolve');
  originalText=first.canonicalArtifact.facts[0].text;
  snapshot={chat:f.clone(f.chat),values:[...f.r.values.entries()]};
  const text=system(await f.control.hooks.beforeRequest(query,'model'));
  assert.ok(text.includes(fact.text),'accepted successor reaches the final Classic prompt');
  assert.ok(text.includes(first.canonicalArtifact.facts[0].text),'original promise reaches the final Classic prompt');
  assert.ok(text.includes(AUTHORITY),'authority hierarchy retained');
  noRetired(text,'neutral query');
  const runtime=f.r.api.getRuntime(),d=runtime.lastMemoryRecallViewer;
  assert.equal(runtime.lastRecallContinuityClosure,undefined);
  assert.equal(d.servedEngine,'unified');
  assert.equal(d.rows.filter(r=>r.memoryId===successor.memoryId&&r.injected).length,1);
  assert.ok(d.rows.every(r=>!('closure' in r)));
  assert.equal(runtime.lastMemoryInjectionMeta.finalVerification.status,'verified');
  assert.ok(text.length<=20000);
  console.log('PASS neutral query delivers resolved lifecycle successor as an ordinary canonical unit');
 } finally {await f.r.cleanup();}
 for(const mode of ['restart','missing','stale','invalid','foreign']) {
  const snap=JSON.parse(JSON.stringify(snapshot));
  const values=new Map(snap.values);
  const manifestEntry=[...values].find(([k])=>k.endsWith(':manifest'));
  const manifest=JSON.parse(manifestEntry[1]),ref=manifest.memories['6'];
  const raw=values.get(ref.key), memory=JSON.parse(raw);
  if(mode==='missing') values.delete(ref.key);
  if(mode==='stale') {memory.revision+=1;values.set(ref.key,JSON.stringify(memory));}
  if(mode==='invalid') {memory.canonicalArtifact.facts[0].values.thread.linkStatus='pending';values.set(ref.key,JSON.stringify(memory));}
  if(mode==='foreign') {memory.canonicalArtifact.facts[0].values.thread.linkTarget.cursor.logicalWorldlineId='foreign';values.set(ref.key,JSON.stringify(memory));}
  snap.values=[...values];
  const fresh=await fixture({snapshot:snap});
  try {
   const messages=await fresh.control.hooks.beforeRequest(query,'model'),text=system(messages);
   const meta=fresh.r.api.getRuntime().lastMemoryInjectionMeta,successorText=memory.canonicalArtifact.facts[0].text;
   if(mode==='restart') {
    assert.ok(text.includes(successorText),'restart successor reaches final Classic');
    assert.equal(meta.finalVerification.status,'verified');
    assert.equal(fresh.r.values.get(ref.key),raw,'no canonical byte mutation');
   } else if(mode==='missing'||mode==='stale') {
    assert.ok(!text.includes(successorText),mode+' successor excluded');
    assert.ok(text.includes(originalText),'unaffected original promise still delivered');
    assert.equal(meta.injected,true);assert.equal(meta.finalVerification.status,'verified');
    assert.ok(fresh.r.api.getLastMemoryRecallViewer().rows.every(r=>r.memoryId!==memory.memoryId),mode+' successor has no viewer row');
   } else {
    // Tampered canonical bytes are not trusted: the whole request fails open, with no injection.
    assert.deepEqual(messages,query,mode+' tampered successor refuses the request');
    assert.equal(fresh.r.api.getLastMemoryRecallViewer().failOpen,true);
    assert.equal(meta.injected,false);
    assert.ok(!text.includes(successorText));
   }
   noRetired(text,mode);
   assert.equal(fresh.control.calls.length,0,'recall/restart never calls provider');
   console.log('PASS '+mode);
  }finally{await fresh.r.cleanup();}
 }
 for(const variant of ['invalid_alias','foreign_participants']) {
  const rejected=await generated('은빛 열쇠를 민아에게 돌려준 약속의 이행','',variant);
  try {
   const fact=rejected.getMemory(6).canonicalArtifact.facts[0];
   assert.equal(fact.values.thread.linkStatus,'pending','writer rejected '+variant);
   const text=system(await rejected.control.hooks.beforeRequest(query,'model'));
   const d=rejected.r.api.getRuntime().lastMemoryRecallViewer;
   assert.equal(rejected.r.api.getRuntime().lastRecallContinuityClosure,undefined);
   noRetired(text,variant);
   // The unaccepted link is not promoted: no lifecycle is reported as resolved/current by the evidence.
   assert.ok(!d.rows.some(r=>/resolved|fulfilled/i.test(String(r.lifecycleStatus))),'no row claims a resolved lifecycle for '+variant);
   assert.ok(d.rows.every(r=>r.lifecycleStatus==='active'),'rows keep lifecycleStatus active for '+variant);
   console.log('PASS writer-produced '+variant+' stays pending');
  }finally{await rejected.r.cleanup();}
 }
 const dedup=await fixture({snapshot});
 try {
  const first=dedup.getMemory(1),second=dedup.getMemory(6);
  const original=first.canonicalArtifact.facts[0].text,successor=second.canonicalArtifact.facts[0].text;
  const text=system(await dedup.control.hooks.beforeRequest([{role:'user',content:original+' '+successor+' 두 기록을 설명해 주세요.'}],'model'));
  const d=dedup.r.api.getRuntime().lastMemoryRecallViewer;
  assert.equal(d.selectedMemories,2,'both canonical memories selected');
  assert.equal(text.split(successor).length-1,1,'successor is not duplicated');
  assert.equal(text.split(original).length-1,1,'original is not duplicated');
  console.log('PASS both memories selected once each');
 }finally{await dedup.r.cleanup();}
 const override=await fixture({snapshot});
 try {
  const input='설정을 정정합니다. 그 반환은 없었고 약속은 다시 열려 있습니다.';
  const messages=await override.control.hooks.beforeRequest([{role:'user',content:input}],'model');
  assert.equal(messages.find(m=>m.role==='user').content,input);
  assert.ok(system(messages).includes(AUTHORITY));
  console.log('PASS current user retcon authority');
 }finally{await override.r.cleanup();}
 const reopened=await fixture({snapshot});
 try {
  for(let turn=11;turn<=15;turn++) {
   const pair=turn===15 ? ['민아는 지호에게 열쇠 반환 약속을 다시 요청했다.','은빛 열쇠를 민아에게 돌려준 약속의 이행 이후 오늘 열쇠 반환 약속이 다시 열렸다.']
     : ['민아와 지호는 도서관에 있었다.','두 사람은 은빛 열쇠 이야기를 이어갔다.'];
   for(const [i,role] of ['user','assistant'].entries()) {
    rows.push({turn,role,text:pair[i]});
    reopened.chat.message.push({role,chatId:`t${turn}-${i?'a':'u'}`,data:pair[i]});
   }
  }
  reopened.control.onCall=args=>{
   const candidates=candidateRowsFromPrompt(args[0]);
   const a=threadArtifact({turn:15,threadEntityName:'오늘 열쇠 반환 약속',summary:'은빛 열쇠를 민아에게 돌려준 약속의 이행 이후 같은 반환 약속이 다시 열렸다',status:'open',link:'reopen',alias:candidates[0]?.alias});
   return {type:'success',result:JSON.stringify(a)};
  };
  assert.equal((await reopened.run()).completed,1);
  const third=reopened.getMemory(11),fact=third.canonicalArtifact.facts[0];
  assert.equal(fact.values.thread.linkStatus,'accepted');
  assert.equal(fact.values.thread.link,'reopen');
  assert.equal(fact.values.thread.lifecycleId,reopened.getMemory(1).canonicalArtifact.facts[0].values.thread.lifecycleId);
  const text=system(await reopened.control.hooks.beforeRequest([{role:'user',content:reopened.getMemory(1).canonicalArtifact.facts[0].text+' 이후 기록은?'}],'model'));
  assert.ok(text.includes(fact.text),'accepted later reopen reaches final prompt');
  const secondText=reopened.getMemory(6).canonicalArtifact.facts[0].text;
  const d=reopened.r.api.getRuntime().lastMemoryRecallViewer;
  const canonicalIds=d.rows.filter(r=>r.family==='canonical').map(r=>r.memoryId);
  for(const n of [1,6,11]) assert.ok(canonicalIds.includes(reopened.getMemory(n).memoryId),'memory '+n+' delivered as canonical history');
  assert.ok(text.includes('[canonical:canonical_assertion] '+secondText),'fulfilment stays a historical canonical assertion');
  assert.ok(d.rows.some(r=>r.family==='state'&&r.semanticRole==='state_current'&&r.text.includes('다시 열렸다')),'current State reflects the reopen');
  noRetired(text,'reopen');
  console.log('PASS accepted later reopen stays canonical history with current State');
 } finally {await reopened.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
