'use strict';
// Planner full-plan and SGA full-draft transfer were removed. Classic retains
// whole selected evidence units, including an oversized first unit, and never
// delivers private analysis or raw derived State as a response product.
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');
const expose=source=>{
 const marker='      getUnifiedStorageStatus,';assert.equal(source.split(marker).length,2);
 return source.replace(marker,'      retainedClassicRenderer: renderClassicBlock,\n'+marker).replace('    async getUnifiedStorageStatus() {','    retainedClassicRenderer: (packet,delivery) => LibraMemoryCore.retainedClassicRenderer(packet,delivery),\n    async getUnifiedStorageStatus() {');
};
(async()=>{
 const f=await fixture({transformSource:expose});try{
  const large='EVIDENCE_START\n'+'Complete factual sentence. '.repeat(1000)+'\nEVIDENCE_END';
  const row=(id,start,text)=>({kind:'canonical',memoryId:id,revision:1,sessionEpoch:0,turnRange:{start,end:start+4},selectedText:text,text,source:'TURN '+start});
  const first=row('large',1,large),second=row('later',6,'SECOND_UNIT_MUST_NOT_BE_PARTIAL'),delivery={rows:[first,second],closureDeliveryComplete:true};
  const block=f.r.api.retainedClassicRenderer({continuity_state_prompt:'RAW_STATE_FORBIDDEN',privateAnalysis:'PRIVATE_ANALYSIS_FORBIDDEN'},delivery);
  assert(block.includes(large));assert(block.length>20000);assert(block.includes('EVIDENCE_END'));assert(!block.includes(second.text));assert.doesNotMatch(block,/RAW_STATE_FORBIDDEN|PRIVATE_ANALYSIS_FORBIDDEN/);
  const small='WHOLE_SMALL_EVIDENCE';assert(f.r.api.retainedClassicRenderer({}, {rows:[row('small',1,small)],closureDeliveryComplete:true}).includes(small));assert.equal(f.r.api.retainedClassicRenderer({}, {rows:[]}), '');
  assert.equal((await f.run()).completed,1);const packet=await actualClassicPacket(f,'민아 지호 신뢰 은빛 열쇠',f.getManifest().scopeKey);
  for(const delivered of packet.actualClassic.deliveredRows)assert(packet.actualClassic.block.includes(delivered.selectedText||delivered.text));
  assert.doesNotMatch(packet.actualClassic.block,/SGA_PRIVATE_ANALYSIS|LIBRA_CURRENT_TURN_PLANNER|CURRENT STATE HEAD/);
 }finally{await f.r.cleanup();}
 console.log('libra_protected_product_transfer_test: PASS (Classic whole-evidence successor; Planner/SGA products retired)');
})().catch(e=>{console.error(e);process.exitCode=1;});
