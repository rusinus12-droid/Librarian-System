const assert=require('node:assert/strict');const {generated,fixture,query,system,rows,threadArtifact,candidateRowsFromPrompt}=require('./fixtures/libra_q04_thread_fixture.cjs');
(async()=>{const f=await generated(undefined,' 은빛 열쇠 반환 약속 '.repeat(130));const snapshot={chat:f.clone(f.chat),values:[...f.r.values]};await f.r.cleanup();
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
   const a=threadArtifact({turn:15,threadEntityName:'오늘 열쇠 반환 약속',summary:'은빛 열쇠를 민아에게 돌려준 약속의 이행 이후 같은 반환 약속이 다시 열렸다 '+ '은빛 열쇠 반환 약속 '.repeat(130),status:'open',link:'reopen',alias:candidates[0]?.alias});
   return {type:'success',result:JSON.stringify(a)};
  };
  assert.equal((await reopened.run()).completed,1);
  const third=reopened.getMemory(11),fact=third.canonicalArtifact.facts[0];
  assert.equal(fact.values.thread.linkStatus,'accepted');
  assert.equal(fact.values.thread.link,'reopen');
  assert.equal(fact.values.thread.lifecycleId,reopened.getMemory(1).canonicalArtifact.facts[0].values.thread.lifecycleId);
  const text=system(await reopened.control.hooks.beforeRequest([{role:'user',content:reopened.getMemory(1).canonicalArtifact.facts[0].text+'에 관한 이후 기록은?'}],'model'));
  const runtime=reopened.r.api.getRuntime(),delivery=runtime.lastMemoryRecallViewer;
  assert.equal(delivery.closureFacts,2);
  assert.equal(delivery.closureInjectedFacts,1);
  assert.equal(delivery.closureDeliveryComplete,false);
  assert.ok(delivery.closureSkipReasons.includes('closure_evidence_char_budget'));
  assert.ok(text.includes(reopened.getMemory(6).canonicalArtifact.facts[0].text),'small historical fulfillment is delivered');
  assert.ok(!text.includes(fact.text),'large later reopen is omitted whole');
  assert.ok(text.includes('open, resolved, or closed statuses are last-known evidence only'),'omitted reopen qualifies prior fulfilled/closed evidence as well');
  assert.ok(text.includes('a later transition may be missing'));
  console.log('PASS omitted later reopen has status-neutral warning');
 } finally {await reopened.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
