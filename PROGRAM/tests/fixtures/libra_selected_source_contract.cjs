'use strict';
const assert=require('node:assert/strict');
const clone=value=>JSON.parse(JSON.stringify(value));
async function selection(f,starts=[1]){
 const inventory=await f.r.api.listCanonicalBatchRanges();
 const ranges=inventory.ranges.filter(row=>starts.includes(row.startTurn));
 assert.equal(ranges.length,starts.length,'all and only requested complete source ranges exist');
 return {scopeKey:inventory.scopeKey,mode:'source_edit',ranges};
}
async function replace(f,starts=[1]){
 const result=await f.r.api.startSelectedCanonicalBatches(await selection(f,starts));
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.job.completed,starts.length);
 await f.r.api.retryPendingUnifiedVectors();return result;
}
function quotedArtifact(f){
 const next=clone(f.control.artifact);
 for(const row of [...next.entities,...next.facts])for(const span of row.evidenceSpans){
  const m=/^t(\d+)-([ua])$/.exec(span.ref);
  if(m)span.quote=f.chat.message[(Number(m[1])-1)*2+(m[2]==='a'?1:0)].data;
 }
 return next;
}
function noJournal(f){assert.equal(typeof f.r.api.getSourceEditSyncStatus,'undefined');assert.equal([...f.r.values.keys()].some(key=>key.includes(':source-edit-consent:v1')),false);}
module.exports={selection,replace,quotedArtifact,noJournal,clone};
