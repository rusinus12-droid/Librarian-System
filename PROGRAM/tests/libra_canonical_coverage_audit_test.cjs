'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
(async()=>{
 const f=await fixture();
 try {
  f.control.artifact.schema='libra.canonical_artifact.v5';
  const descriptions=Array.from({length:25},(_,i)=>`민아는 붉은 눈 특징${i}를 지녔다.`);
  const goal='그녀는 가족을 지켜야 했다.',habit='민아는 평소처럼 아침 식사를 준비했다.',manager='민아는 도서관을 운영한다.';
  const features='민아는 붉은 눈과 검은 머리카락을 지녔다.',rumor='민아가 떠나려 한다는 소문은 확인되지 않았다.';
  const eye='준호의 눈꺼풀이 열렸다. 빛이 그의 푸른 눈동자에 닿았다.',action='민아는 눈을 감았다.';
  const otherPerson='민아의 시선이 낯선 여자에게 옮겨갔다. 흰 머리를 땋은 젊은 엄마가 다가왔다.';
  f.chat.message[9].data+=' '+[...descriptions,features,'민아는 가족을 바라보았다.',goal,habit,manager,rumor,eye,action,otherPerson].join(' ');
  f.control.artifact.facts.push({tempFactId:'observation_as_goal',domain:'character',subjectTempRef:'mina',claimKind:'character_goal',values:{goal:action},text:action,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t5-a',quote:action}]});
  f.control.onSupplementCall=args=>{
   const sys=args[0].messages.find(m=>m.role==='system').content;
   if(!sys.includes('[LIBRA PREFERENCE AND BOUNDARY CHECK]'))return {type:'success',result:'{"arcs":[],"turningPoints":[],"motifs":[]}'};
   return {type:'success',result:JSON.stringify({items:[
    ...descriptions.map((quote,i)=>({personRef:'mina',category:'appearance',content:'붉은 눈 특징'+i,ref:'t5-a',quote,speakerQuote:quote})),
    ...['붉은 눈','검은 머리카락'].map(content=>({personRef:'mina',category:'appearance',content,ref:'t5-a',quote:features,speakerQuote:features})),
    {personRef:'mina',category:'goal',content:'가족 보호',ref:'t5-a',quote:goal,speakerQuote:goal},
    {personRef:'mina',category:'goal',content:'떠날 계획',ref:'t5-a',quote:rumor,speakerQuote:rumor,certainty:'uncertain'},
    {personRef:'mina',category:'goal',content:'민아는 눈을 감았다.',ref:'t5-a',quote:action,speakerQuote:action},
    {personRef:'mina',category:'habits',content:'평소 아침 식사 준비',ref:'t5-a',quote:habit,speakerQuote:habit},
    {personRef:'mina',category:'appearance',content:'없는 눈 색',ref:'t5-a',quote:'없는 근거',speakerQuote:goal}
   ],worldItems:[{worldRef:'library',personRef:'mina',category:'management',ref:'t5-a',quote:manager,speakerQuote:manager}]})};
  };
  assert.equal((await f.run()).completed,1);
  const h=f.getHead(),mina=h.characters.find(x=>x.name==='민아');
  assert.equal(mina.state.appearance.length,27,'the audit retains >12 items and distinct features sharing one quote');
  assert.equal(mina.state.goal,'가족 보호');
  assert.ok((h.narrative.events||[]).some(e=>e.text.includes('눈을 감았다')&&e.interpretation==='observed_action_not_goal'),JSON.stringify({goals:f.getMemory().canonicalArtifact.facts.filter(f=>f.claimKind==='character_goal'),pending:h.unifiedApplied.pending}));
  assert.ok(h.characters.find(r=>r.name==='준호').state.appearance.includes('푸른 눈동자'),'literal feature omitted by the provider is completed from source');
  assert.ok(!mina.state.appearance.some(x=>/흰 머리/.test(x)),'looking at another person does not transfer that person’s appearance');
  assert.ok(mina.state.habits.includes('평소 아침 식사 준비'));
  assert.equal(h.world.find(x=>x.name==='도서관').state.managerRef,mina.id);
  assert.ok(!JSON.stringify(mina.state).includes('없는 눈 색'));
  console.log('PASS audit keeps >12 source-bound profile results, goals/habits/management and rejects false quotes');
 }finally{await f.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
