'use strict';
const assert=require('node:assert/strict');
async function retryHistoricalMicro(f,turns,options={expectedGeneration:0}){
  for(const turn of turns){
    const active=await f.r.api.debugReadActiveCompletedTurnReceipt(turn);
    assert.equal(active.status,'verified',`T${turn}: completed receipt must be durable`);
    const prior=await f.r.api.debugReadActiveMicroMemory(turn);
    assert.equal(prior.status,'missing',`T${turn}: historical Micro is not automatically replayed`);
    if(options.expectedGeneration!==undefined)assert.equal(Number(f.r.core.state.worldManagerRuntimeMetaGeneration||0),Number(options.expectedGeneration));
    const inventory=await f.r.api.listReanalysisRanges({kind:'micro'});
    const result=await f.r.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(row=>row.start===turn)});
    assert.equal(result.ok,true,`T${turn}: unified Micro reanalysis must publish: ${JSON.stringify(result)}`);
    const after=await f.r.api.debugReadActiveMicroMemory(turn);
    assert.equal(after.status,'verified',`T${turn}: Micro head readback`);
  }
}
async function retryCurrentMicro(f,turn){
  const active=await f.r.api.debugReadActiveCompletedTurnReceipt(turn);
  assert.equal(active.status,'verified',`T${turn}: receipt remains current for explicit reanalysis`);
  const inventory=await f.r.api.listReanalysisRanges({kind:'micro'});
  const result=await f.r.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(row=>row.start===turn)});
  assert.equal(result.ok,true,`T${turn}: reanalysis result`);
  const after=await f.r.api.debugReadActiveMicroMemory(turn);
  assert.equal(after.status,'verified',`T${turn}: retry head readback`);
  return after;
}
module.exports={retryHistoricalMicro,retryCurrentMicro};
