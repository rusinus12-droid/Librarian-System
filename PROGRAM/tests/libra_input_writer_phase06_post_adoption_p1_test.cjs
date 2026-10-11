'use strict';
// The Writer modal, clipboard/insert/send coordinator and choice regeneration
// were removed. Current memory candidates retain preview/adopt/keep and final
// authority fences; shared request-local recall must still avoid durable writes.
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
  const job=await f.r.api.regenerateCanonicalMemory({startTurn:1});assert.equal(job.state,'awaiting_choice');assert.equal(f.r.values.get(ref.key),before);
  const kept=await f.r.api.resolveCanonicalCandidate({jobId:job.jobId,decision:'keep'});assert.notEqual(kept.state,'awaiting_choice');assert.equal(f.getMemory().revision,original.revision);
  const next=await f.r.api.regenerateCanonicalMemory({startTurn:1});assert.equal(next.state,'awaiting_choice');
  const callsBeforeAdopt=f.control.calls.length,adopted=await f.r.api.resolveCanonicalCandidate({jobId:next.jobId,decision:'adopt'});assert.match(adopted.state,/^completed/);assert.equal(f.getMemory().revision,2);assert.equal(f.control.calls.length,callsBeforeAdopt);
  const delivered=await actualClassicPacket(f,'민아 지호 신뢰',f.getManifest().scopeKey);assert(delivered.actualClassic.deliveredRows.some(x=>x.revision===2));
  const stale=await f.r.api.regenerateCanonicalMemory({startTurn:1});assert.equal(stale.state,'awaiting_choice');f.chat.message[1].data+=' changed after preview';
  await assert.rejects(()=>f.r.api.resolveCanonicalCandidate({jobId:stale.jobId,decision:'adopt'}),/source|precondition/i);assert.equal(f.getMemory().revision,2);
 }finally{await f.r.cleanup();}
 console.log('libra_input_writer_phase06_post_adoption_p1_test: PASS (memory candidate/readonly recall successor; Writer send lifecycle retired)');
})().catch(e=>{console.error(e);process.exitCode=1;});
