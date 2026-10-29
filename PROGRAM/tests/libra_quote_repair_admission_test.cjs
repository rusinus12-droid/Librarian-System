'use strict';
// Exercise production admission and saved Head, not a copy of the matcher.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
async function run(t,source,quote){
 const f=await fixture();t.after(()=>f.r.cleanup());
 f.chat.message.find(row=>row.chatId==='t4-a').data=source;
 f.control.artifact.entities=f.control.artifact.entities.filter(row=>['mina','study'].includes(row.tempId));
 f.control.artifact.facts=f.control.artifact.facts.filter(row=>['f5','f9'].includes(row.tempFactId));
 f.control.artifact.stateBindings=f.control.artifact.stateBindings.filter(row=>['f5','f9'].includes(row.factTempId));
 f.control.artifact.facts.find(row=>row.tempFactId==='f9').evidenceSpans=[{ref:'t4-a',quote}];
 const result=await f.run();assert.equal(result.completed,1,JSON.stringify(result));
 return {f,memory:f.getMemory(),person:f.getHead()?.characters?.find(row=>row.name==='민아')};
}
for(const [label,source,quote] of [
 ['negation','민아는 도서관 동쪽에 있는 오래된 파란 캐비닛 옆에서 기록회 보관함의 비밀 암호를 듣지 않았다.','민아는 도서관 동쪽에 있는 오래된 파란 캐비닛 옆에서 기록회 보관함의 비밀 암호를 들었다.'],
 ['number','민아는 도서관 동쪽에 있는 오래된 파란 캐비닛 옆에서 보관함의 암호 2개를 들었다.','민아는 도서관 동쪽에 있는 오래된 파란 캐비닛 옆에서 보관함의 암호 3개를 들었다.']
])test(`approximate ${label} quote is quarantined without creating knowledge or blocking unrelated memory`,async t=>{
 const {memory,person}=await run(t,source,quote),admission=memory.artifactValidation.admission;
 assert(memory.canonicalArtifact.facts.some(row=>row.tempFactId==='f5'),'unrelated valid location fact survives');
 assert.equal(memory.canonicalArtifact.facts.some(row=>row.tempFactId==='f9'),false,'invented quote must not be repaired into an accepted fact');
 assert.equal(person?.state?.knowledge,undefined,'unverified fact never creates current knowledge');
 assert(admission.rejected.some(row=>row.id==='f9'));assert(admission.droppedFields.some(row=>row.reason==='source_quote_mismatch'));
 assert(admission.stateBlocks.some(row=>row.fact==='f9'),'rejected State field retains its quarantine fence');
});
test('exact source quote remains unchanged and populates verified knowledge',async t=>{
 const source='민아는 도서관에서 암호를 들었다.';
 const {memory,person}=await run(t,source,source),fact=memory.canonicalArtifact.facts.find(row=>row.tempFactId==='f9');
 assert.equal(fact.evidenceSpans[0].quote,source);assert.deepEqual(JSON.parse(JSON.stringify(person.state.knowledge)),['상자의 암호']);
});
test('existing whitespace normalization remains supported without changing quote content',async t=>{
 const {memory,person}=await run(t,'민아는 도서관에서\n\n암호를 들었다.','민아는 도서관에서 암호를 들었다.');
 assert.equal(memory.canonicalArtifact.facts.find(row=>row.tempFactId==='f9').evidenceSpans[0].quote,'민아는 도서관에서 암호를 들었다.');
 assert.deepEqual(JSON.parse(JSON.stringify(person.state.knowledge)),['상자의 암호']);
});
