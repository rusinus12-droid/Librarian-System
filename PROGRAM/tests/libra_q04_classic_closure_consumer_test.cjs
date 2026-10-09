'use strict';
const assert=require('node:assert/strict');
const {generated,fixture,query,system,rows,threadArtifact,candidateRowsFromPrompt}=require('./fixtures/libra_q04_thread_fixture.cjs');
(async()=>{
 const f=await generated();
 let snapshot;
 try {
  const successor=f.getMemory(6),fact=successor.canonicalArtifact.facts[0];
  assert.equal(fact.values.thread.linkStatus,'accepted');
  snapshot={chat:f.clone(f.chat),values:[...f.r.values.entries()]};
  const messages=await f.control.hooks.beforeRequest(query,'model'), text=system(messages);
  assert.ok(text.includes(successor.memoryId)&&text.includes(fact.text),'accepted current closure reaches final Classic');
  assert.ok(text.includes(fact.evidenceSpans[0].ref)&&text.includes(fact.evidenceSpans[0].quote),'closure exact source quote and ref reach final Classic');
  const d=f.r.api.getRuntime().lastMemoryRecallViewer;
  assert.equal(d.closureInjectedFacts,1);
  assert.equal(d.closureApplied,true);
  assert.equal(d.closureDeliveryComplete,true);
  assert.equal(d.rows.filter(r=>r.closure&&r.injected).length,1);
  assert.ok(d.classicEvidenceChars<=d.evidenceCharCeiling);
  assert.ok(d.classicEvidenceTokens<=d.tokenCeiling);
  assert.ok(text.length<=20000);
  assert.ok(text.includes('current user input and latest visible scene state outrank older recalled state'),'authority hierarchy retained');
  assert.ok(text.includes('LATER CANONICAL CONTINUITY EVIDENCE'),'closure is labelled canonical evidence');
  console.log('PASS neutral query accepted final closure and source evidence');
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
   const text=system(await fresh.control.hooks.beforeRequest(query,'model'));
   const d=fresh.r.api.getRuntime().lastMemoryRecallViewer;
   if(mode==='restart') {
    assert.ok(text.includes(memory.memoryId)&&text.includes(memory.canonicalArtifact.facts[0].text),'restart closure reaches final Classic');
    assert.equal(d.closureInjectedFacts,1);
    assert.equal(fresh.r.values.get(ref.key),raw,'no canonical byte mutation');
   } else {
    assert.ok(!text.includes(memory.canonicalArtifact.facts[0].text),mode+' closure excluded');
    assert.equal(Number(d?.closureInjectedFacts||0),0);
    assert.equal(d?.closureApplied,false);
   }
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
   const runtime=rejected.r.api.getRuntime();
   assert.equal(runtime.lastRecallContinuityClosure.facts.length,0);
   assert.equal(runtime.lastMemoryRecallViewer.closureApplied,false);
   assert.ok(!text.includes(fact.text),'unaccepted '+variant+' cannot resolve selected promise');
   console.log('PASS writer-produced '+variant+' exclusion');
  }finally{await rejected.r.cleanup();}
 }
 const dedup=await fixture({snapshot});
 try {
  const settings=await dedup.r.api.getLibraMemorySettings();
  await dedup.r.api.saveLibraMemorySettings({...settings,recallMaxMemories:2});
  const first=dedup.getMemory(1),second=dedup.getMemory(6);
  const original=first.canonicalArtifact.facts[0].text,successor=second.canonicalArtifact.facts[0].text;
  const text=system(await dedup.control.hooks.beforeRequest([{role:'user',content:original+' '+successor+' 두 기록을 설명해 주세요.'}],'model'));
  const runtime=dedup.r.api.getRuntime();
  assert.equal(runtime.lastMemoryRecallViewer.selectedMemories,2,'both canonical memories selected');
  assert.equal(text.split(successor).length-1,1,'already-selected successor is not duplicated');
  assert.equal(runtime.lastRecallContinuityClosure.facts.length,0);
  console.log('PASS already-selected successor deduplication');
 }finally{await dedup.r.cleanup();}
 // A current user assertion remains unchanged and outranks recalled history.
 const override=await fixture({snapshot});
 try {
  const input='설정을 정정합니다. 그 반환은 없었고 약속은 다시 열려 있습니다.';
  const messages=await override.control.hooks.beforeRequest([{role:'user',content:input}],'model');
  assert.equal(messages.find(m=>m.role==='user').content,input);
  assert.ok(system(messages).includes('current user input and latest visible scene state outrank older recalled state'));
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
  const text=system(await reopened.control.hooks.beforeRequest(query,'model'));
  assert.ok(text.includes(third.memoryId)&&text.includes(fact.text),'accepted later reopen reaches final prompt');
  const secondId=reopened.getMemory(6).memoryId;
  if(text.includes(secondId)) assert.ok(text.indexOf(secondId)<text.indexOf(third.memoryId),'fulfillment stays historical before reopen');
  console.log('PASS accepted later reopen chronology');
 } finally {await reopened.r.cleanup();}
 // A source-backed closure larger than the evidence ceiling is not silently clipped.
 const big=await generated('은빛 열쇠를 민아에게 돌려준 약속의 이행. '+ '은빛 열쇠 반환 약속 '.repeat(130), ' 은빛 열쇠 반환 약속 '.repeat(130));
 try {
  const text=system(await big.control.hooks.beforeRequest([{role:'user',content:big.getMemory(1).canonicalArtifact.facts[0].text+'에 관한 이후 기록은?'}],'model'));
  const r=big.r.api.getRuntime(),d=r.lastMemoryRecallViewer;
  assert.ok(r.lastRecallContinuityClosure.facts.length>0,'large valid closure computed');
  assert.equal(d.closureApplied,false,'budget omission is not reported as applied');
  assert.equal(d.closureInjectedFacts,0);
  assert.equal(d.closureDeliveryComplete,false);
  assert.ok(d.closureSkipReasons.includes('closure_evidence_char_budget'));
  assert.equal(r.lastMemoryInjectionMeta.dynamicChars,d.classicEvidenceChars,'final metadata counts delivered evidence, not skipped prepared facts');
  assert.equal(r.lastMemoryInjectionMeta.fixedChars,text.length-d.classicEvidenceChars);
  assert.ok(text.includes('continuity coverage is incomplete'),'budget shortfall disclosed to actual consumer');
  assert.ok(!text.includes(big.getMemory(6).canonicalArtifact.facts[0].text),'no oversized closure');
  assert.ok(text.length<=20000);
  console.log('PASS budget shortfall honesty');
  console.log(JSON.stringify({test:'q04_budget_shortfall',sourceFactChars:big.getMemory(1).canonicalArtifact.facts[0].text.length,successorFactChars:big.getMemory(6).canonicalArtifact.facts[0].text.length,closureCurrentness:d.closureCurrentness,closureFacts:d.closureFacts,closureApplied:d.closureApplied,closureInjectedFacts:d.closureInjectedFacts,closureDeliveryComplete:d.closureDeliveryComplete,closureSkipReasons:d.closureSkipReasons,evidenceCharCeiling:d.evidenceCharCeiling,tokenCeiling:d.tokenCeiling,classicEvidenceChars:d.classicEvidenceChars,classicEvidenceTokens:d.classicEvidenceTokens,actualSystemChars:text.length}));
 }finally{await big.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
