'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {serverFixture,fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {candidateRowsFromPrompt}=require('./fixtures/libra_q04_thread_fixture.cjs');
const spans=(ref,quote)=>[{ref,quote}];
const people=target=>[{role:'owner',personTempRef:'jiho'},{role:'target',personTempRef:target}];
const thread=(id,subject,summary,status,target,ref,quote,extra={})=>({tempFactId:id,domain:'narrative',subjectTempRef:subject,claimKind:'thread',
 values:{thread:{summary,status,kind:'task',participants:people(target),...extra}},text:summary,
 certainty:'confirmed',temporalRole:'current_sequence',evidenceSpans:spans(ref,quote)});
const SCHOOL='민아의 학교에 전화해 등교 여부를 확인하는 일',BOOK='준호에게 책을 반환하는 일',SPEAKER='민아와 스피커로 통화하는 일';
async function test(mode,scenario){
 const server=mode==='plugin_only'?null:await serverFixture({mode});let f=server?.f||await fixture();
 try{
  const schoolQuote='지호는 민아의 학교에 전화해 등교 여부를 확인했다.';
  const bookQuote='지호는 준호에게 책을 반환하겠다고 약속했다.';
  f.chat.message[9].data+=' '+schoolQuote+' '+bookQuote;
  const first=f.control.artifact;first.schema='libra.canonical_artifact.v5';first.facts=first.facts.filter(f=>f.claimKind!=='thread');
  first.entities.push({tempId:'school_task',name:'학교 확인',type:'world',kind:'thread',evidenceSpans:spans('t5-a',schoolQuote)},
   {tempId:'book_task',name:'책 반환',type:'world',kind:'thread',evidenceSpans:spans('t5-a',bookQuote)});
  first.facts.push(thread('school_done','school_task',SCHOOL,'resolved','mina','t5-a',schoolQuote,{resolution:'completed'}),
   thread('book_open','book_task',BOOK,'open','junho','t5-a',bookQuote));
  assert.equal((await f.run()).completed,1);
  const oldClosed=JSON.stringify(f.getHead().narrative.closedThreads),oldBook=f.getHead().narrative.threads.find(t=>t.summary===BOOK).lifecycleId;
  const sealed=m=>JSON.stringify([m.canonicalArtifact,m.artifactDigest,m.sourceDigest,m.rawPacketRefs]);
  const oldMemory=sealed(f.getMemory());
  fiveMore(f);const next=f.control.artifact;next.schema='libra.canonical_artifact.v5';next.facts=next.facts.filter(f=>f.claimKind!=='thread');
  const quote=scenario==='link'?'지호는 준호에게 책을 반환하겠다는 약속을 다시 확인했다.':'지호는 민아와 스피커로 통화하기로 했다.';
  const summary=scenario==='duplicate'?SCHOOL:scenario==='link'?BOOK:SPEAKER,target=scenario==='link'?'junho':'mina';
  f.chat.message[19].data+=' '+quote;
  next.entities.push({tempId:'incoming',name:'통화 과제',type:'world',kind:'thread',evidenceSpans:spans('t10-a',quote)});
  let repairs=0,candidates=[];
  f.control.onCall=args=>{
   const messages=args[0].messages,sys=messages.find(m=>m.role==='system').content;
   if(sys.includes('[LIBRA THREAD LINK REPAIR]')){
    repairs++;const input=JSON.parse(messages.find(m=>m.role==='user').content),fact=input.facts.find(f=>f.factTempId==='incoming_fact');
    assert.ok(fact);assert.equal(fact.failedReason,'candidate_status_disallows_link');
    assert.equal(input.candidates.length,candidates.length,'repair sees every verified candidate');
    if(scenario==='failure')return {type:'error',result:'controlled repair failure'};
    if(scenario==='reanalyze'&&repairs===1)return {type:'success',result:JSON.stringify({repairs:[{factTempId:'incoming_fact',decision:'hold'}]})};
    if(scenario==='edit')f.chat.message[19].data+=' 원문이 바뀌었다.';
    const r={factTempId:'incoming_fact',decision:scenario==='link'||scenario==='bad-link'?'link':'new',evidenceRef:'t10-a',quote};
    if(r.decision==='link')r.linkCandidateAlias=candidates.find(c=>c.summary===BOOK).alias;
    if(scenario==='bad-quote')r.quote='없는 인용';
    return {type:'success',result:JSON.stringify({repairs:scenario==='duplicate-response'?[r,r]:[r]})};
   }
   candidates=candidateRowsFromPrompt(args[0]);const closed=candidates.find(c=>c.summary===SCHOOL);assert.ok(closed);
   const response=structuredClone(next);response.facts.push(thread('incoming_fact','incoming',summary,'open',target,'t10-a',quote,{link:'reaffirm',linkCandidateAlias:closed.alias}));
   return {type:'success',result:JSON.stringify(response)};
  };
  const result=await f.run();
  assert.equal(repairs,1,'at most one corrective call per batch');
  if(scenario==='edit'){
   assert.equal(result.completed,0);assert.equal(f.getMemory(6),null);assert.equal(sealed(f.getMemory()),oldMemory);return;
  }
  assert.equal(result.completed,1,JSON.stringify(result));
  const memory=f.getMemory(6),value=memory.canonicalArtifact.facts.find(f=>f.tempFactId==='incoming_fact').values.thread;
  assert.equal(JSON.stringify(f.getHead().narrative.closedThreads),oldClosed,'repair never reopens/changes the unrelated finished task');
  if(scenario==='new'||scenario==='link'){
   assert.equal(value.linkStatus,scenario==='new'?'new':'accepted');
   assert.ok(!value.linkPendingReason);assert.ok(!f.getHead().unifiedApplied.pending.some(p=>p.fact==='incoming_fact'));
   if(scenario==='new'){
    assert.equal(f.getHead().narrative.threads.filter(t=>t.summary===SPEAKER).length,1);
    assert.ok(!value.link&&!value.linkTarget);
   }else{
    assert.equal(f.getHead().narrative.threads.filter(t=>t.summary===BOOK).length,1);
    assert.equal(value.lifecycleId,oldBook);
   }
   assert.ok(memory.artifactValidation.admission.normalizedFields.some(r=>r.id==='incoming_fact'&&/^thread_link_repaired_/.test(r.reason)));
  }else assert.equal(value.linkStatus,'pending','unverified, duplicate, unavailable or mismatched repair must not be accepted');
  if(scenario==='reanalyze'){
   const inventory=await f.r.api.listReanalysisRanges({kind:'canonical'});
   const revised=await f.r.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.batchStart===6)});
   assert.equal(revised.ok,true,JSON.stringify(revised));
   assert.equal(f.getMemory(6).revision,memory.revision+1);
   assert.equal(f.getMemory(6).canonicalArtifact.facts.find(f=>f.tempFactId==='incoming_fact').values.thread.linkStatus,'new');
   assert.ok(!f.getHead().unifiedApplied.pending.some(p=>p.fact==='incoming_fact'));
   assert.equal(f.getHead().narrative.threads.filter(t=>t.summary===SPEAKER).length,1);
   assert.equal(JSON.stringify(f.getHead().narrative.closedThreads),oldClosed);
   assert.equal(repairs,2,'one review for each of the two analyses');
  }
  const reviewed=repairs;
  const before=JSON.stringify([f.getHead().narrative,f.getMemory(6).canonicalArtifact]);
  assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);
  assert.equal(JSON.stringify([f.getHead().narrative,f.getMemory(6).canonicalArtifact]),before,'sealed repair replays without a new model call');
  assert.equal(repairs,reviewed);
  if(server){f=await server.restart();assert.equal(JSON.stringify([f.getHead().narrative,f.getMemory(6).canonicalArtifact]),before);}
  else{const restart=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});try{assert.equal(JSON.stringify([restart.getHead().narrative,restart.getMemory(6).canonicalArtifact]),before);}finally{await restart.r.cleanup();}}
 }finally{if(server)await server.cleanup();else await f.r.cleanup();}
 console.log('PASS',mode,scenario);
}
(async()=>{
 for(const mode of ['plugin_only','mirror','server_only'])for(const scenario of ['new','link'])await test(mode,scenario);
 for(const scenario of ['duplicate','bad-link','bad-quote','duplicate-response','failure','edit','reanalyze'])await test('plugin_only',scenario);
})().catch(e=>{console.error(e);process.exitCode=1;});
