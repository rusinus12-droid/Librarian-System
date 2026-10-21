'use strict';
const assert = require('node:assert/strict');
const {fixture} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const {fiveMore, serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const profiles = {
  character_appearance: ['appearance', '짙은 갈색 눈'],
  character_background: ['background', '해안 마을에서 자람'],
  character_personality: ['personality', '꾸준하고 신중함'],
  character_speech: ['speech', '상대에게 존댓말을 사용함'],
  character_habit: ['habits', '매일 여행 일지를 씀'],
  character_ability: ['abilities', '배의 항로를 계산할 수 있음']
};
function add(f, kind, field, value, opts = {}) {
  const turn = opts.turn || 5;
  const text = opts.text || `민아의 ${field}: ${Array.isArray(value) ? value.join(', ') : value ?? '명시적으로 해제됨'}.`;
  f.chat.message[(turn - 1) * 2 + 1].data += ' ' + text;
  const fact = {tempFactId:'profile_'+f.control.artifact.facts.length, domain:'character', subjectTempRef:'mina',
    claimKind:kind, values:{[field]:value}, text, temporalRole:'current_sequence', certainty:'confirmed',
    evidenceSpans:[{ref:`t${turn}-a`,quote:text}], ...opts.fact};
  if (opts.effect) fact.effect = opts.effect;
  f.control.artifact.facts.push(fact);
  if (opts.bind !== false) f.control.artifact.stateBindings.push({factTempId:fact.tempFactId});
  return fact;
}
const person = f => f.getHead().characters.find(row=>row.name==='민아');
// Derived embedding retry status may change between runs; all canonical/source fields must not.
const memoryBytes = f => {const {embedding,...canonical}=f.getMemory();return JSON.stringify(canonical);};
async function complete(f) { const result=await f.run(); assert.equal(result.completed,1,JSON.stringify(result)); return result; }
const results=[];
async function test(name, fn) { const f=await fixture(); try {await fn(f);results.push(name);} finally {await f.r.cleanup();} }
(async()=>{
  await test('profile and goal reach canonical, current State, recall and a fresh runtime', async f=>{
    for (const [kind,[field,value]] of Object.entries(profiles)) add(f,kind,field,[value]);
    add(f,'character_goal','goal','등대에 지도 전달');
    add(f,'character_state','condition','잠시 긴장함');
    await complete(f);
    assert.equal(f.getHead().status,'ready');
    for (const [,[field,value]] of Object.entries(profiles)) assert.deepEqual(person(f).state[field],[value]);
    assert.equal(person(f).state.goal,'등대에 지도 전달');
    assert.equal(person(f).state.condition,'잠시 긴장함');
    const canonicalCalls=f.control.calls.filter(call=>classifyCall(call)==='canonical');
    assert.equal(canonicalCalls.length,1,'profile extraction submits exactly one Canonical request');
    const request=JSON.stringify(canonicalCalls[0]);
    assert.ok(request.includes('character_info'));
    assert.ok(!request.includes('Additional character-domain claimKind/values'));
    assert.match(request,/A single action, reaction, quotation or success/);
    assert.ok(request.includes('historical background, flashback, reported facts, hypotheticals and uncertain time'),
      'profile extraction keeps historical, reported and uncertain time roles explicit');
    const read=JSON.parse(JSON.stringify(f.r.api.getUnifiedStateReadProjection(f.getHead())));
    assert.deepEqual(read.characters.find(row=>row.name==='민아').state.abilities,['배의 항로를 계산할 수 있음']);
    const recall=await f.r.api.previewUnifiedMemoryRecall('민아 항로 여행 일지');
    assert.ok(recall.memories.some(row=>/여행 일지|항로/.test(String(row.excerpt))));
    const bytes=memoryBytes(f), state=JSON.stringify(person(f).state);
    const restarted=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});
    try {
      assert.equal(memoryBytes(restarted),bytes);
      const replay=await restarted.r.api.rebuildWorldManagerState();
      assert.equal(replay.ok,true,JSON.stringify(replay));
      assert.equal(JSON.stringify(person(restarted).state),state);
      assert.equal(memoryBytes(restarted),bytes);
      assert.equal(restarted.control.calls.length,0);
    } finally {await restarted.r.cleanup();}
    assert.equal(countCalls(f.control).canonical,1);
  });
  await test('independent items accumulate; missing profile and transient condition preserve traits', async f=>{
    add(f,'character_habit','habits',['매일 여행 일지를 씀']);
    add(f,'character_habit','habits',['일찍 잠자리에 듦']);
    add(f,'character_personality','personality',['꾸준하고 신중함']);
    await complete(f); const bytes=memoryBytes(f);
    fiveMore(f);
    add(f,'character_habit','habits',['매일 여행 일지를 씀','출발 전에 지도를 확인함'],{turn:10});
    add(f,'character_state','condition','갑작스런 소음에 화가 남',{turn:10});
    await complete(f);
    assert.deepEqual(person(f).state.habits,['매일 여행 일지를 씀','일찍 잠자리에 듦','출발 전에 지도를 확인함']);
    assert.deepEqual(person(f).state.personality,['꾸준하고 신중함']);
    assert.equal(memoryBytes(f),bytes,'earlier canonical/source fields are immutable');
  });
  await test('explicit removal and goal clear replay without deleting other profile axes', async f=>{
    add(f,'character_habit','habits',['일찍 잠자리에 듦','매일 여행 일지를 씀']);
    add(f,'character_ability','abilities',['항로 계산']);
    add(f,'character_goal','goal','등대에 지도 전달');
    await complete(f);const bytes=memoryBytes(f);fiveMore(f);
    add(f,'character_habit','habits',['일찍 잠자리에 듦'],{turn:10,effect:'remove',text:'민아는 일찍 잠자리에 드는 습관을 버렸다.'});
    add(f,'character_habit','habits',['매일 낮잠을 잠'],{turn:10});
    add(f,'character_goal','goal',null,{turn:10,effect:'clear',text:'민아는 등대에 지도를 전달하여 현재 목표를 완료했다.'});
    await complete(f);
    assert.deepEqual(person(f).state.habits,['매일 여행 일지를 씀','매일 낮잠을 잠']);
    assert.deepEqual(person(f).state.abilities,['항로 계산']);
    assert.equal(person(f).state.goal,undefined);assert.ok(person(f).clearedFieldEvidence.goal);
    const after=JSON.stringify(person(f).state);
    assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);
    assert.equal(JSON.stringify(person(f).state),after);assert.equal(memoryBytes(f),bytes);
  });
  await test('one malformed profile does not reject independent profile and memory facts', async f=>{
    const bad=add(f,'character_personality','personality',[{unsupported:'not text'}]);
    add(f,'character_ability','abilities',['항로 계산']);
    await complete(f);
    assert.ok(!f.getMemory().canonicalArtifact.facts.some(row=>row.tempFactId===bad.tempFactId));
    assert.equal(f.getMemory().artifactValidation.admission.rejectedFacts,1);
    assert.deepEqual(person(f).state.abilities,['항로 계산']);
    assert.ok(f.getMemory().canonicalArtifact.facts.some(row=>row.tempFactId==='f1'));
  });
  await test('reported and uncertain traits remain memory without becoming current personality', async f=>{
    add(f,'character_personality','personality',['성급함'],{bind:false,fact:{temporalRole:'reported'}});
    add(f,'character_background','background',['산골에서 자랐을 가능성'],{bind:false,fact:{certainty:'uncertain'}});
    await complete(f);
    assert.equal(person(f).state.personality,undefined);assert.equal(person(f).state.background,undefined);
    assert.equal(f.getMemory().canonicalArtifact.facts.length,15);
  });
  await test('opposite effects on one item stay pending without colliding with another axis', async f=>{
    add(f,'character_habit','habits',['여행 일지를 씀']);
    add(f,'character_habit','habits',['여행 일지를 씀'],{effect:'remove',text:'민아는 여행 일지를 쓰는 습관을 버렸다.'});
    add(f,'character_ability','abilities',['항로 계산']);
    await complete(f);assert.equal(person(f).state.habits,undefined);
    assert.ok(f.getHead().unifiedApplied.pending.some(row=>row.field==='habits'&&row.reason==='same_source_order_conflict'));
    assert.deepEqual(person(f).state.abilities,['항로 계산']);
  });
  await test('omitted bindings still preserve item-specific revocation in recall', async f=>{
    add(f,'character_habit','habits',['일찍 잠자리에 듦'],{turn:3,bind:false});
    add(f,'character_habit','habits',['일찍 잠자리에 듦'],{turn:4,bind:false,effect:'remove',text:'민아는 일찍 잠자리에 드는 습관을 버렸다.'});
    add(f,'character_habit','habits',['여행 일지를 씀'],{turn:5,bind:false});
    await complete(f);assert.deepEqual(person(f).state.habits,['여행 일지를 씀']);
    const recall=await f.r.api.previewUnifiedMemoryRecall('민아 일찍 잠자리에');
    assert.ok(recall.memories.some(row=>String(row.excerpt).includes('습관을 버렸다')));
  });
  await test('manual profile corrections validate types, replay and suspend', async f=>{
    add(f,'character_appearance','appearance',['갈색 눈']);await complete(f);const bytes=memoryBytes(f),id=person(f).id;
    const correction=await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id,set:{appearance:['푸른 눈'],goal:'도서관 방문'}}]}});
    assert.equal(correction.ok,true);assert.deepEqual(person(f).state.appearance,['푸른 눈']);
    assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal(person(f).state.goal,'도서관 방문');
    assert.equal((await f.r.api.setWorldManagerCorrectionStatus(correction.correctionId,'suspended')).ok,true);
    assert.deepEqual(person(f).state.appearance,['갈색 눈']);assert.equal(person(f).state.goal,undefined);
    await assert.rejects(f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id,set:{abilities:[{bad:'object'}]}}]}}),/UNIFIED_CHARACTER_PROFILE_INVALID/);
    assert.equal(memoryBytes(f),bytes);assert.equal(countCalls(f.control).canonical,1);
  });
  const s=await serverFixture();
  try {
    for(const [kind,[field,value]] of Object.entries(profiles))add(s.f,kind,field,[value]);
    add(s.f,'character_goal','goal','등대에 지도 전달');await complete(s.f);
    const state=JSON.stringify(person(s.f).state),bytes=memoryBytes(s.f);
    const restarted=await s.restart();await restarted.r.api.retryPendingUnifiedState();
    assert.equal(JSON.stringify(person(restarted).state),state);assert.equal(memoryBytes(restarted),bytes);
    assert.equal(restarted.control.calls.length,0);
    results.push('real HTTP/SQLite retains new profile and goal after runtime restart');
  } finally {await s.cleanup();}
  console.log(JSON.stringify({test:'libra_character_profile_runtime',passed:results.length,results,boundary:'full deployed plugin; synthetic source/model; KV and local HTTP/SQLite, not live RisuAI/provider'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
