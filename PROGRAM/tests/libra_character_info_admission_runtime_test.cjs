'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const {fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
async function run(){
 const f=await fixture();
 try{
  let turn=5;
  const add=(id,category,content,quote=content,effect='set')=>{
   f.chat.message[turn*2-1].data+=' '+(content||quote);
   f.control.artifact.facts.push({tempFactId:id,domain:'character',subjectTempRef:'mina',claimKind:'character_info',values:{category,content},text:content||quote,effect,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:`t${turn}-a`,quote}]});
  };
  add('simple','appearance','민아의 눈은 갈색이다.');
  add('alias','습관','민아는 매일 일기를 쓴다.');
  add('typo','personallity','민아는 신중한 성격이다.');
  add('missing',undefined,'민아는 항해를 배운 적이 있다.');
  add('bad','abilities','민아는 항로를 계산한다.','원문에 전혀 없는 증거');
  const result=await f.run();assert.equal(result.completed,1,JSON.stringify(result));
  const memory=f.getMemory(), facts=memory.canonicalArtifact.facts;
  const state=f.getHead().characters.find(x=>x.name==='민아').state;
  assert.deepEqual(state.appearance,['민아의 눈은 갈색이다.']);
  assert.deepEqual(state.habits,['민아는 매일 일기를 쓴다.']);
  assert.equal(state.personality,undefined);
  assert.equal(facts.find(x=>x.tempFactId==='typo').claimKind,'character_note');
  assert.equal(facts.find(x=>x.tempFactId==='missing').values.detail,'민아는 항해를 배운 적이 있다.');
  assert.ok(!facts.some(x=>x.tempFactId==='bad'));
  assert.ok(facts.some(x=>x.tempFactId==='f1'));
  const recalled=await f.r.api.previewUnifiedMemoryRecall('민아 신중 항해');
  assert.ok(recalled.memories.some(x=>String(x.excerpt).includes('신중')),'unclassified character_note reaches recall: '+JSON.stringify(recalled.memories.map(x=>x.excerpt)));
  assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);
  assert.equal(countCalls(f.control).canonical,1);
  const restarted=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});
  try{assert.deepEqual(restarted.getMemory().canonicalArtifact,memory.canonicalArtifact);}finally{await restarted.r.cleanup();}
  fiveMore(f);turn=10;
  add('clear','appearance',null,'민아의 기존 외형 정보는 잘못된 것으로 확인되어 폐기되었다.','clear');
  add('remove','habits','민아는 매일 일기를 쓴다.',undefined,'remove');
  add('unknown_clear','goall',null,'민아는 기존 목표를 포기했다.','clear');
  assert.equal((await f.run()).completed,1);
  const next=f.getHead().characters.find(x=>x.name==='민아').state;
  assert.equal(next.appearance,undefined);
  assert.deepEqual(next.habits,[]);
  assert.equal(f.getMemory(6).canonicalArtifact.facts.find(y=>y.tempFactId==='unknown_clear').claimKind,'character_note');
  console.log('PASS common format, alias, unknown/missing category preservation, evidence rejection, recall, replay, restart and one model call');
 }finally{await f.r.cleanup();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
