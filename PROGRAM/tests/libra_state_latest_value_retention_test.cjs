'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
(async()=>{
 const f=await fixture();
 try {
  const oldText='민아는 앉아 있다.';
  const oldPressure='문이 잠겨 밖으로 나갈 수 없다.',newPressure='문이 열렸지만 바깥의 폭풍 때문에 나갈 수 없다.';
  f.chat.message[9].data+=' '+oldText+' '+oldPressure;
  f.control.artifact.schema='libra.canonical_artifact.v5';
  f.control.artifact.entities.push({tempId:'pressure_old',name:'문',type:'world',kind:'thread',evidenceSpans:[{ref:'t5-a',quote:oldPressure}]});
  f.control.artifact.facts.push({tempFactId:'old_pressure',domain:'narrative',subjectTempRef:'pressure_old',claimKind:'story_momentum',values:{momentum:{summary:oldPressure}},text:oldPressure,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t5-a',quote:oldPressure}]});
  f.control.artifact.facts.push({tempFactId:'old_condition',domain:'character',subjectTempRef:'mina',claimKind:'character_state',
   values:{condition:'앉아 있다'},text:oldText,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t5-a',quote:oldText}]});
  assert.equal((await f.run()).completed,1);
  const stableMemory=raw=>{const m=JSON.parse(raw);return JSON.stringify([m.canonicalArtifact,m.sourceDigest,m.artifactDigest,m.rawPacketRefs,m.sourceEvidenceRef]);};
  const oldMemory=f.getManifest().memories['1'].key,oldBytes=stableMemory(f.r.values.get(oldMemory));
  for(let t=6;t<=10;t++)f.chat.message.push({role:'user',chatId:`t${t}-u`,data:'민아의 상태를 확인한다.'},
   {role:'assistant',chatId:`t${t}-a`,data:t===10?'민아는 누워 있다. 민아는 일어나 서 있다.':'민아는 기다렸다.'});
  f.chat.messages=f.chat.message;
  f.chat.message[19].data+=' '+newPressure;
  const facts=[['earlier','누워 있다','민아는 누워 있다.'],['latest','서 있다','민아는 일어나 서 있다.']].map(([tempFactId,condition,text])=>({tempFactId,domain:'character',subjectTempRef:'mina',claimKind:'character_state',values:{condition},text,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t10-a',quote:text}]}));
  f.control.artifact={schema:'libra.canonical_artifact.v5',entities:[{tempId:'mina',name:'민아',type:'person',kind:'person',evidenceSpans:[{ref:'t10-a',quote:'민아는 일어나 서 있다.'}]},
   {tempId:'pressure_new',name:'폭풍',type:'world',kind:'thread',evidenceSpans:[{ref:'t10-a',quote:newPressure}]}],facts:[...facts].reverse().concat({tempFactId:'new_pressure',domain:'narrative',subjectTempRef:'pressure_new',claimKind:'story_momentum',values:{momentum:{summary:newPressure}},text:newPressure,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t10-a',quote:newPressure}]}),stateBindings:[]};
  assert.equal((await f.run()).completed,1);
  const check=h=>{
   const mina=h.characters.find(r=>r.name==='민아');assert.equal(mina.state.condition,'서 있다');
   assert.equal(h.narrative.momentum,newPressure);
   assert.ok(h.supersededState.some(r=>r.field==='momentum'&&r.value===oldPressure&&r.status==='pending'));
   for(const value of ['앉아 있다','누워 있다'])assert.ok(h.supersededState.some(r=>r.recordId===mina.id&&r.field==='condition'&&r.value===value&&r.status==='pending'&&r.evidence&&r.supersededBy));
  };
  check(f.getHead());check((await f.r.api.debugLoadContinuityStateForResponse()).head);
  assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);check(f.getHead());
  const futureKey=f.getManifest().memories['6'].key,futureBytes=stableMemory(f.r.values.get(futureKey));
  const rollback=await f.r.api.rollbackWorldManagerState({throughTurn:5});
  assert.equal(rollback.ok,true);
  assert.equal(rollback.head.characters.find(r=>r.name==='민아').state.condition,'앉아 있다');
  assert.equal(rollback.head.narrative.momentum,oldPressure);
  // The historical rollback view is distinct from response authority for the
  // still-unrolled host chat; assert the actually rebuilt and persisted State.
  assert.equal(f.getHead().characters.find(r=>r.name==='민아').state.condition,'앉아 있다');
  assert.equal(stableMemory(f.r.values.get(oldMemory)),oldBytes,'old canonical facts and original-source bindings remain intact');
  assert.equal(stableMemory(f.r.values.get(futureKey)),futureBytes,'rollback retains the later revision for restoration');
  console.log('PASS latest State wins; two prior values stay pending with provenance; replay and rollback restore the selected source chain');
 }finally{await f.r.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1});
