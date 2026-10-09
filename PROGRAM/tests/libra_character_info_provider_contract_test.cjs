'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {classifyCall,countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const categories={appearance:'회색 눈',background:'해안 마을 출신',personality:'신중한 성격',speech:'항상 존댓말을 사용함',habits:'매일 일지를 씀',abilities:'항로를 계산함',goal:'등대에 지도 전달'};
const canonical=f=>{const {embedding,...memory}=f.getMemory();return JSON.stringify(memory);};
(async()=>{
 const f=await fixture();
 try {
  for(const [category,content] of Object.entries({...categories,unclassified:'미분류 프로필 근거'})){
   const quote=`민아의 ${category}: ${content}.`;
   f.chat.message[9].data+=' '+quote;
   f.control.artifact.facts.push({tempFactId:'provider_'+category,domain:'character',subjectTempRef:'mina',claimKind:'character_info',values:{category,content},text:quote,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t5-a',quote}]});
  }
  const result=await f.run();assert.equal(result.completed,1,JSON.stringify(result));
  const calls=f.control.calls.filter(call=>classifyCall(call)==='canonical');
  assert.equal(calls.length,1,'one canonical request supplies the profile facts');
  const system=calls[0][0].messages.find(m=>m.role==='system').content;
  // Inspect the actual model request, not the unexecuted source literals.
  const contract=system.split('\n').find(line=>line.startsWith('Optional character information'));
  assert.ok(contract,'character_info contract must reach the model');
  assert.match(contract,/claimKind:"character_info"/);
  assert.match(contract,/domain:"character"/);
  assert.match(contract,/values:\{category,content\}/);
  assert.match(contract,/appearance\|background\|personality\|speech\|habits\|abilities\|goal/);
  assert.match(contract,/content is one concise string/);
  assert.match(contract,/Unknown categories remain memory/);
  assert.ok(system.length<11800,'preserve the shared extraction prompt budget including adult continuity');
  const state=()=>f.getHead().characters.find(row=>row.name==='민아').state;
  for(const [category,content] of Object.entries(categories))assert.deepEqual(state()[category],category==='goal'?content:[content]);
  const note=f.getMemory().canonicalArtifact.facts.find(row=>row.tempFactId==='provider_unclassified');
  assert.equal(note.claimKind,'character_note');assert.equal(note.values.detail,'미분류 프로필 근거');
  assert.equal(state().unclassified,undefined);
  const memory=canonical(f),head=JSON.stringify(state());
  const restarted=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});
  try {
   assert.equal(canonical(restarted),memory);
   const replay=await restarted.r.api.rebuildWorldManagerState();assert.equal(replay.ok,true);
   assert.equal(JSON.stringify(restarted.getHead().characters.find(row=>row.name==='민아').state),head);
   assert.equal(canonical(restarted),memory);
   for(const content of [...Object.values(categories),'미분류 프로필 근거']){
    const recall=await restarted.r.api.previewUnifiedMemoryRecall('민아 '+content);
    assert.ok(recall.memories.some(row=>row.excerpt.text.includes(content)),'provider fact reaches recall: '+content);
   }
   assert.equal(restarted.control.calls.length,0,'readback/replay/recall must not reanalyze');
  }finally{await restarted.r.cleanup();}
  assert.equal(countCalls(f.control).canonical,1);
  console.log(JSON.stringify({test:'libra_character_info_provider_contract',categories:7,unknownCategoryPreserved:true,restartRecall:true,systemChars:system.length,externalModelCalls:0}));
 }finally{await f.r.cleanup();}
})().catch(error=>{console.error(error);process.exitCode=1;});
