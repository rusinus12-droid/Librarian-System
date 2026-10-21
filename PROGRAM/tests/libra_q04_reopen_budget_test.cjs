// Retirement contract (commit 9c03c35): the closure evidence-char budget (closure_evidence_char_budget,
// "a later transition may be missing" warning) is retired. A large lifecycle reopen is an ordinary canonical
// unit of the unified engine: delivered whole when selected, never clipped, within the common char budget,
// and with no retired closure warning/diagnostics.
const assert=require('node:assert/strict');const {generated,fixture,query,system,rows,threadArtifact,candidateRowsFromPrompt}=require('./fixtures/libra_q04_thread_fixture.cjs');
const PAD='은빛 열쇠 반환 약속 ';
(async()=>{const f=await generated(undefined,' '+PAD.repeat(130));const snapshot={chat:f.clone(f.chat),values:[...f.r.values]};await f.r.cleanup();
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
   const a=threadArtifact({turn:15,threadEntityName:'오늘 열쇠 반환 약속',summary:'은빛 열쇠를 민아에게 돌려준 약속의 이행 이후 같은 반환 약속이 다시 열렸다 '+PAD.repeat(130),status:'open',link:'reopen',alias:candidates[0]?.alias});
   return {type:'success',result:JSON.stringify(a)};
  };
  assert.equal((await reopened.run()).completed,1);
  const third=reopened.getMemory(11),fact=third.canonicalArtifact.facts[0];
  assert.equal(fact.values.thread.linkStatus,'accepted');
  assert.equal(fact.values.thread.link,'reopen');
  assert.equal(fact.values.thread.lifecycleId,reopened.getMemory(1).canonicalArtifact.facts[0].values.thread.lifecycleId);
  assert.ok(fact.text.length>1500,'reopen fact is large');
  const maxChars=(await reopened.r.api.getLibraMemorySettings()).recallMaxChars;
  const text=system(await reopened.control.hooks.beforeRequest([{role:'user',content:'같은 반환 약속이 다시 열렸다 '+PAD+reopened.getMemory(1).canonicalArtifact.facts[0].text.slice(0,30)}],'model'));
  const runtime=reopened.r.api.getRuntime(),d=runtime.lastMemoryRecallViewer;
  assert.equal(runtime.lastRecallContinuityClosure,undefined);
  assert.deepEqual(Object.keys(d).filter(k=>/^closure|ProjectionOmitted/.test(k)),[],'retired closure delivery diagnostics are gone');
  for(const s of ['closure_evidence_char_budget','continuity coverage is incomplete','last-known evidence only','a later transition may be missing']) assert.ok(!text.includes(s)&&!JSON.stringify(d).includes(s),'retired text absent: '+s);
  const row=d.rows.find(r=>r.memoryId===third.memoryId);
  assert.ok(row&&row.injected,'large reopen delivered');
  assert.equal(row.text,fact.text,'large reopen delivered whole, not clipped');
  assert.ok(text.includes(fact.text),'full reopen text is in the final prompt');
  assert.ok(text.includes('[canonical:canonical_assertion] '+reopened.getMemory(6).canonicalArtifact.facts[0].text),'small historical fulfilment is delivered too');
  assert.ok(text.length<=maxChars,'final packet stays within the common recallMaxChars budget');
  assert.equal(runtime.lastMemoryInjectionMeta.finalVerification.status,'verified');
  assert.equal(reopened.control.calls.length,1,'only the analysis call; recall made no provider call');
  console.log('PASS large reopen is delivered whole within the common budget, without retired closure warnings');
 } finally {await reopened.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
