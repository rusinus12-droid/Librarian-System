'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const a=source.indexOf('    const unifiedContextLocation ='),b=source.indexOf('    const normalizeUnifiedContextPlaces =',a);
const ctx=vm.createContext({string:x=>String(x??''),asArray:x=>Array.isArray(x)?x:[]});
vm.runInContext(source.slice(a,b)+';globalThis.resolve=unifiedContextLocation;',ctx);
const place={id:'room',name:'좁은 방',type:'world',kind:'location',validated:true};
const registry={entities:[place]},head={characters:[{name:'민아',state:{locationRef:'room'}}]};
assert.equal(ctx.resolve('방','민아는 방에 그대로 있다.',registry,head).id,'room');
assert.equal(ctx.resolve('방','민아는 다른 방으로 옮겨졌다.',registry,head),null);
assert.equal(ctx.resolve('방','민아는 새 방에 들어왔다.',registry,head),null);
assert.equal(ctx.resolve('방','민아는 방에 있다.',{entities:[place,{...place,id:'other',name:'큰 방'}]},head),null);
assert.equal(ctx.resolve('방','방에 있다.',registry,head),null);
assert.equal(ctx.resolve('방','민아와 지호는 방에 있다.',registry,{characters:[...head.characters,{name:'지호',state:{locationRef:'other'}}]}),null);
assert.equal(ctx.resolve('방','민아는 바닥에 누워 있었다. 다리에 힘이 들어가지 않았다. 지호는 방을 나갔다.',registry,{characters:[...head.characters,{name:'지호',state:{locationRef:'other'}}]},['민아']).id,'room','another person leaving and a negative body-strength phrase do not move the occupant');
// Shared titles must be distinguishable without modifying State or canonical bytes.
const x=source.indexOf('  const BOOK_NARRATIVE_GROUPS ='),y=source.indexOf('  const bookNarrativeHistoryKey =',x);
const gui=vm.createContext({guiAsObject:x=>x||{},guiAsArray:x=>Array.isArray(x)?x:[],text:x=>String(x??''),compact:(x,n)=>String(x??'').slice(0,n)});
vm.runInContext(source.slice(x,y)+';globalThis.model=bookNarrativeModel',gui);
const view={narrative:{threads:[{id:'a',lifecycleId:'a',title:'오늘 밤',summary:'스피커로 통화하기',status:'open'}],closedThreads:[{id:'b',lifecycleId:'b',title:'오늘 밤',summary:'지정 장소 방문하기',status:'resolved'}]}};
const before=JSON.stringify(view),model=gui.model(view);
assert.notEqual(model.threads[0].title,model.closed[0].title);assert.equal(JSON.stringify(view),before);
const identical=gui.model({narrative:{threads:[{id:'tl_private_1',title:'약속',summary:'같은 요약'},{id:'tl_private_2',title:'약속',summary:'같은 요약'}]}});
assert.notEqual(identical.threads[0].title,identical.threads[1].title);
assert.ok(!identical.threads.some(row=>row.title.includes('tl_private')),'display fallback must not reveal lifecycle IDs');
async function main(){
 const f=await fixture();
 try{
  f.chat.message[3].data+=' 민아는 갈색 눈을 지녔다. 지호는 붉은 눈을 지녔다.';
  const ev=quote=>[{ref:'t2-a',quote}];
  const make=(id,items,quote)=>({tempFactId:id,domain:'character',subjectTempRef:'mina',claimKind:'character_appearance',values:{appearance:items},text:items.join(' · '),temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:ev(quote)});
  f.control.artifact.facts.push(make('own',['갈색 눈'],'민아는 갈색 눈을 지녔다.'));
  f.control.artifact.facts.push(make('borrowed',['붉은 눈'],'지호는 붉은 눈을 지녔다.'));
  f.control.artifact.facts.push(make('mixed',['갈색 눈','흰 머리'],'민아는 갈색 눈을 지녔다.'));
  const longHeld=['흰 머리 '+ '윤기나는 장식 '.repeat(100),'푸른 눈 '+ '환상적인 무늬 '.repeat(100),'녹색 피부 '+ '반짝이는 무늬 '.repeat(100)];
  f.control.artifact.facts.push({...make('many',longHeld,'민아는 갈색 눈을 지녔다.'),text:'근거가 없는 외형 제안'});
  assert.equal((await f.run()).completed,1);
  const facts=f.getMemory().canonicalArtifact.facts;
  assert.equal(facts.find(x=>x.tempFactId==='own').claimKind,'character_appearance');
  assert.equal(facts.find(x=>x.tempFactId==='borrowed').claimKind,'character_note');
  assert.deepEqual(facts.find(x=>x.tempFactId==='mixed').values.appearance,['갈색 눈']);
  assert.equal(facts.find(x=>x.tempFactId==='mixed_appearance_note').values.detail,'흰 머리');
  for(const detail of longHeld)assert.ok(facts.some(f=>f.claimKind==='character_note'&&f.values.detail===detail),'every held item remains in memory without a combined scalar overflow');
  assert.ok(!f.getHead().characters.find(c=>c.name==='민아').state.appearance.some(x=>/붉은|흰/.test(x)));
 }finally{await f.r.cleanup();}
 for(const mode of ['plugin_only','mirror','server_only']){
 const args={evidence_link_index_enabled:'true'};
 const server=mode==='plugin_only'?null:await require('./fixtures/libra_server_runtime_fixture.cjs').serverFixture({mode,args});const g=server?server.f:await fixture({args});
 try{
  // First establish a named room, then refer to that person's same room by a generic noun.
  g.chat.message[1].data+=' 민아는 좁은 방에 있다.';
  const art=g.control.artifact;
  art.entities.push({tempId:'room',name:'좁은 방',type:'world',kind:'location',evidenceSpans:[{ref:'t1-a',quote:'민아는 좁은 방에 있다.'}]});
  art.facts.push({tempFactId:'roomloc',domain:'character',subjectTempRef:'mina',claimKind:'location',values:{locationRef:'room'},text:'민아는 좁은 방에 있다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t1-a',quote:'민아는 좁은 방에 있다.'}]});
  // Make this the latest position in this batch.
  art.facts=art.facts.filter(f=>f.claimKind!=='location'||f.tempFactId==='roomloc');
  assert.equal((await g.run()).completed,1);
  const prior=g.getHead().characters.find(c=>c.name==='민아').state.locationRef;
  fiveMore(g);g.chat.message[19].data+=' 민아는 방에서 기다린다. 방은 어둡다.';
  g.chat.message[11].data+=' 민아는 방에 그대로 있다. 민아는 지호의 붉은 눈을 바라보았다.';
  g.control.onCall=async args=>{
    assert.match(JSON.stringify(args),/LIBRA MICRO SOURCE CONTRACT/);
    const {receipt}=await g.r.api.debugReadActiveCompletedTurnReceipt(6),body=receipt.assistant.text;
    const claim=(text,field,value)=>({changeKind:'person',text,actor:'민아',target:'',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'set',
      stateIntent:{domain:'character',target:{entityName:'민아'},field,operation:'set',value},
      evidence:{role:'assistant',messageId:receipt.assistant.chatId,startOffset:body.indexOf(text),endOffset:body.indexOf(text)+text.length,exactQuote:text}});
    return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',scopeKey:receipt.scopeKey,worldlineId:receipt.worldlineId,sessionEpoch:receipt.sessionEpoch,turn:6,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,
      claims:[claim('민아는 방에 그대로 있다.','locationRef','방'),claim('민아는 지호의 붉은 눈을 바라보았다.','appearance','붉은 눈')]}})};
  };
  const inventory=await g.r.api.listReanalysisRanges({kind:'micro'});
  assert.equal((await g.r.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.start===6)})).ok,true);
  const admission=await g.r.api.debugAdmitActiveMicroStateClaim(6,0);
  assert.equal(admission.status,'admitted',JSON.stringify(admission));
  assert.equal(admission.decision.patch.set.locationRef,prior,JSON.stringify(admission));
  const borrowed=await g.r.api.debugAdmitActiveMicroStateClaim(6,1);
  assert.equal(borrowed.reason,'appearance_attribute_not_bound_to_subject_quote',JSON.stringify(borrowed));
  g.control.onCall=null;
  const next=g.control.artifact;next.schema='libra.canonical_artifact.v5';
  next.entities.push({tempId:'room',name:'좁은 방',type:'world',kind:'location',evidenceSpans:[{ref:'t10-a',quote:'민아는 방에서 기다린다.'}]});
  next.facts=next.facts.filter(f=>f.claimKind!=='location');
  next.facts.push({tempFactId:'roomloc2',domain:'character',subjectTempRef:'mina',claimKind:'location',values:{locationRef:'room'},text:'민아는 방에서 기다린다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t10-a',quote:'민아는 방에서 기다린다.'}]});
  next.facts.push({tempFactId:'roomdesc',domain:'world',subjectTempRef:'room',claimKind:'world_description',values:{description:['방은 어둡다.']},text:'방은 어둡다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t10-a',quote:'방은 어둡다.'}]});
  const result=await g.run();assert.equal(result.completed,1,JSON.stringify(result));
  const memory=g.getMemory(6),after=g.getHead();
  assert.ok(memory.canonicalArtifact.facts.some(f=>f.tempFactId==='roomdesc'),'description survives name admission');
  assert.equal(after.characters.find(c=>c.name==='민아').state.locationRef,prior);
  assert.equal(after.world.filter(w=>/^(좁은 방|방)$/.test(w.name)).length,1,'same room retains its identity');
  const index=await g.r.api.getEvidenceLinkIndex({});
  const edge=index.links.entityPairs.find(p=>p.via==='location'&&JSON.stringify(p).includes('roomloc2'));
  assert.ok(edge,JSON.stringify(index.links.entityPairs.filter(p=>p.via==='location')));
  assert.equal(edge.to,prior,'history reader resolves this artifact mention to the same room');
  const beforeReplay=JSON.stringify([after.characters,after.world]);
  assert.equal((await g.r.api.rebuildWorldManagerState()).ok,true);
  assert.equal(JSON.stringify([g.getHead().characters,g.getHead().world]),beforeReplay,'replay retains contextual identity and its facts');
  if(server){
    const restarted=await server.restart();
    assert.equal(JSON.stringify([restarted.getHead().characters,restarted.getHead().world]),beforeReplay,'restart retains derived registry references');
  }else{
    const restarted=await fixture({snapshot:{chat:g.chat,values:[...g.r.values]}});
    try{assert.equal(JSON.stringify([restarted.getHead().characters,restarted.getHead().world]),beforeReplay,'local restart retains the same place');}finally{await restarted.r.cleanup();}
  }
 }finally{if(server)await server.cleanup();else await g.r.cleanup();}
 }
 const story=await fixture();
 try{
  story.chat.message[3].data+=' 오늘 밤 민아는 열쇠를 돌려주기로 약속했다.';
  story.chat.message[5].data+=' 오늘 밤 준호는 책을 돌려주기로 약속했다.';
  const a=story.control.artifact;a.schema='libra.canonical_artifact.v5';a.facts=a.facts.filter(f=>f.claimKind!=='thread');
  a.entities.push({tempId:'shared_title',name:'오늘 밤',type:'world',kind:'thread',evidenceSpans:[{ref:'t2-a',quote:'오늘 밤 민아는 열쇠를 돌려주기로 약속했다.'}]});
  const promise=(id,summary,ref,quote,extra={})=>({tempFactId:id,domain:'narrative',subjectTempRef:'shared_title',claimKind:'thread',values:{thread:{summary,status:'open',kind:'promise',...extra}},text:summary,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref,quote}]});
  a.facts.push(promise('key_promise','민아의 열쇠 반환 약속','t2-a','오늘 밤 민아는 열쇠를 돌려주기로 약속했다.'),promise('book_promise','준호의 책 반환 약속','t3-a','오늘 밤 준호는 책을 돌려주기로 약속했다.'));
  assert.equal((await story.run()).completed,1);
  const opened=story.getHead().narrative.threads;assert.equal(opened.length,2);assert.equal(new Set(opened.map(t=>t.lifecycleId)).size,2);
  fiveMore(story);story.chat.message[19].data+=' 민아는 열쇠를 돌려주겠다는 약속이 여전히 유효하다고 말했다.';
  const b=story.control.artifact;b.schema='libra.canonical_artifact.v5';b.facts=b.facts.filter(f=>f.claimKind!=='thread');
  b.entities.push({tempId:'shared_title',name:'오늘 밤',type:'world',kind:'thread',evidenceSpans:[{ref:'t10-a',quote:'민아는 열쇠를 돌려주겠다는 약속이 여전히 유효하다고 말했다.'}]});
  story.control.onCall=args=>{
    const rows=require('./fixtures/libra_q04_thread_fixture.cjs').candidateRowsFromPrompt(args[0]),candidate=rows.find(r=>r.summary==='민아의 열쇠 반환 약속');
    assert.ok(candidate);const next=structuredClone(b);next.facts.push(promise('again','민아의 열쇠 반환 약속','t10-a','민아는 열쇠를 돌려주겠다는 약속이 여전히 유효하다고 말했다.',{link:'reaffirm',linkCandidateAlias:candidate.alias}));
    return {type:'success',result:JSON.stringify(next)};
  };
  assert.equal((await story.run()).completed,1);assert.equal(story.getHead().narrative.threads.length,2,'reaffirmation does not create a third story');
  assert.deepEqual(story.getHead().narrative.threads.map(t=>t.lifecycleId).sort(),opened.map(t=>t.lifecycleId).sort());
 }finally{await story.r.cleanup();}
 console.log('PASS contextual location, ambiguous/movement negatives, title projection, per-person appearance evidence and partial-item preservation');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
