'use strict';
const assert=require('node:assert/strict');
async function retryHistoricalMicro(f,turns,options={expectedGeneration:0}){
  const lineage=await f.r.api.getHostLineageStatus();
  const scope={scopeKey:lineage.scopeKey,scopeId:lineage.scopeKey,
    characterId:f.character.id,chatId:(typeof f.current==='function'?f.current():f.chat).id};
  for(const turn of turns){
    const active=await f.r.api.debugReadActiveCompletedTurnReceipt(turn);
    assert.equal(active.status,'verified',`T${turn}: completed receipt must be durable`);
    const prior=await f.r.api.debugReadActiveMicroMemory(turn);
    assert.equal(prior.status,'missing',`T${turn}: historical Micro is not automatically replayed`);
    const result=await f.r.api.retryMicroAnalysis({scope,receiptRef:active.receiptKey,
      revision:active.receipt.revisionId,digest:active.receipt.sourceDigest,
      ...(options.expectedGeneration===undefined?{}:{expectedGeneration:options.expectedGeneration})});
    assert.equal(result.status,'verified',`T${turn}: explicit Micro retry must publish: ${JSON.stringify(result)}`);
    const after=await f.r.api.debugReadActiveMicroMemory(turn);
    assert.equal(after.status,'verified',`T${turn}: Micro head readback`);
  }
}
async function retryCurrentMicro(f,turn){
  const lineage=await f.r.api.getHostLineageStatus();
  const scope={scopeKey:lineage.scopeKey,scopeId:lineage.scopeKey,
    characterId:f.character.id,chatId:f.chat.id};
  const active=await f.r.api.debugReadActiveCompletedTurnReceipt(turn);
  assert.equal(active.status,'verified',`T${turn}: receipt remains current for explicit retry`);
  // The desk API joins a completed manual action for 1500ms to absorb duplicate clicks.
  await new Promise(resolve=>setTimeout(resolve,1600));
  const result=await f.r.api.retryMicroAnalysis({scope,receiptRef:active.receiptKey,
    revision:active.receipt.revisionId,digest:active.receipt.sourceDigest});
  assert.equal(result.status,'verified',`T${turn}: retry result`);
  const after=await f.r.api.debugReadActiveMicroMemory(turn);
  assert.equal(after.status,'verified',`T${turn}: retry head readback`);
  return after;
}
module.exports={retryHistoricalMicro,retryCurrentMicro};
