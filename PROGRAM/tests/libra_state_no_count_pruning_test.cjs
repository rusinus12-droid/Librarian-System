'use strict';
// Exercise real Canonical admission, State accumulation, read normalization and replay.
const assert = require('node:assert/strict');
const {fixture} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const T = require('../server/authority/libra-typed-codec.cjs');
(async () => {
  const f = await fixture();
  try {
    const a = f.control.artifact;
    a.schema = 'libra.canonical_artifact.v5';
    // Existing fixture already has structure facts? Suppress supplemental discovery with
    // valid structures supplied below; no provider/network calls leave the fixture.
    const span = [{ref:'t5-a',quote:'오늘 열쇠를 반환하겠다는 약속은 이행되었다.'}];
    const add = (id, domain, subject, kind, values, text, evidenceSpans=span) => a.facts.push({tempFactId:id,domain,subjectTempRef:subject,
      claimKind:kind,values,text,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans});
    for (let i=0;i<145;i++) add('event_'+i,'event','mina','event',{detail:'확인된 사건 '+i},'확인된 사건 '+i);
    for (let i=0;i<40;i++) {
      const text='민아는 특징'+i+'를 지녔다.';
      f.chat.message[9].data+=' '+text;
      add('profile_'+i,'character','mina','character_appearance',{appearance:['특징'+i]},text,[{ref:'t5-a',quote:text}]);
    }
    // A single collection with >32 items also traverses plugin/server validation.
    const knowledge=Array.from({length:40},(_,i)=>'기억'+i);
    add('knowledge_many','character','mina','knowledge',{knowledge},'민아가 아는 기록');
    for (let i=0;i<30;i++) {
      const id='arc_'+i;
      a.entities.push({tempId:id,name:'흐름 '+i,type:'world',kind:'thread',evidenceSpans:span});
      add('arc_fact_'+i,'narrative',id,'story_arc',{arc:{summary:'사건 흐름 '+i,status:'active'}},'사건 흐름 '+i);
    }
    assert.equal((await f.run()).completed,1);
    const memory=f.getMemory(), head=f.getHead();
    assert.ok(memory.canonicalArtifact.facts.length>120);
    const serverValidation=T.validateUnifiedArtifact(memory.canonicalArtifact,Array.from({length:5},(_,i)=>({turn:i+1,
      user:{text:f.chat.message[i*2].data},assistant:{text:f.chat.message[i*2+1].data}})));
    assert.ok(serverValidation.ok, JSON.stringify(serverValidation.issues));
    const check = h => {
      const mina=h.characters.find(r=>r.name==='민아');
      assert.equal(mina.state.appearance.length,40);
      assert.equal(mina.state.knowledge.filter(x=>/^기억/.test(x)).length,40);
      assert.equal(h.narrative.events.filter(r=>r.text.startsWith('확인된 사건')).length,145);
      assert.equal(h.narrative.arcs.length,30);
    };
    check(head);
    check((await f.r.api.debugLoadContinuityStateForResponse()).head);
    assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);
    check(f.getHead());
    console.log('PASS >120 facts, 40 profile/knowledge items, 145 events and 30 arcs survive admission/read/replay');
  } finally {await f.r.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
