'use strict';
// The Writer modal, clipboard/insert/send coordinator and choice regeneration
// were removed. Current memory reanalysis uses listReanalysisRanges + reanalyzeSelectedRanges
// while preserving prior revisions and authority fences; shared request-local recall
// must still avoid durable writes.
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');
const expose=source=>{
 const marker='      getUnifiedStorageStatus,';assert.equal(source.split(marker).length,2);
 return source.replace(marker,`      retainedReadOnlyRecall: async query => {
        const context=await resolveContext(), settings=await loadMemorySettings();
        const bundle=buildQueryBundle([{role:'user',content:query}],context,settings);
        bundle.requestLocalReadOnly=true;bundle.persistRecallCatalog=false;
        return recall(context,bundle);
      },\n`+marker).replace('    async getUnifiedStorageStatus() {','    retainedReadOnlyRecall: query => LibraMemoryCore.retainedReadOnlyRecall(query),\n    async getUnifiedStorageStatus() {');
};
(async()=>{
 const f=await fixture({transformSource:expose});try{
  assert.equal((await f.run()).completed,1);const original=f.getMemory(),ref=f.getManifest().memories['1'],before=f.r.values.get(ref.key);
  f.r.storageWrites.length=0;f.r.storageRemovals.length=0;const calls=f.control.calls.length;
  const recall=await f.r.api.retainedReadOnlyRecall('민아 지호 신뢰 은빛 열쇠');
  assert(recall.memories.some(x=>x.memory.memoryId===original.memoryId),'a real canonical ref must exercise the recall catalog');
  assert.deepEqual(f.r.storageWrites,[]);assert.deepEqual(f.r.storageRemovals,[]);assert.equal(f.control.calls.length,calls);
  await assert.rejects(()=>f.r.api.regenerateCanonicalMemory({startTurn:1}),/LIBRA_REANALYSIS_ENTRY_RETIRED|폐기/);
  const inv=await f.r.api.listReanalysisRanges();
  const reanalyzed=await f.r.api.reanalyzeSelectedRanges({...inv,ranges:inv.ranges.filter(r=>r.batchStart===1)});
  assert.equal(reanalyzed.ok,true,JSON.stringify(reanalyzed));
  assert.equal(f.r.values.get(ref.key),before,'prior canonical revision bytes remain intact');
  assert.equal(f.getMemory().revision,2);
  const delivered=await actualClassicPacket(f,'민아 지호 신뢰',f.getManifest().scopeKey);assert(delivered.actualClassic.deliveredRows.some(x=>x.revision===2));
  const staleInv=await f.r.api.listReanalysisRanges();
  const sample=await f.r.context.__LIBRA__?null:null;
  f.chat.message[1].chatId='changed-after-preview';
  const staleRes=await f.r.api.reanalyzeSelectedRanges({...staleInv,ranges:staleInv.ranges.filter(r=>r.batchStart===1)});
  assert.equal(staleRes.ok,false);
  assert.equal(f.getMemory().revision,2);
 }finally{await f.r.cleanup();}
 console.log('libra_input_writer_phase06_post_adoption_p1_test: PASS (memory reanalysis/readonly recall successor; Writer send lifecycle retired)');
})().catch(e=>{console.error(e);process.exitCode=1;});
