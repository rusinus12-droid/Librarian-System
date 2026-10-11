'use strict';
// The retired automatic exception/suffix scheduler is replaced by explicit range
// selection. The surviving contracts are selected scope, immutable unselected
// history, bounded paid work, cancellation, and stale-result refusal.
const assert=require('node:assert/strict');
const {fixture,artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {selection,replace,quotedArtifact,noJournal,clone}=require('./fixtures/libra_selected_source_contract.cjs');
const {actualClassicPacket}=require('./fixtures/libra_actual_classic_request.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function addBatch(f,start){const rows=f.chat.message.slice(0,10);f.chat.message.push(...rows.map((row,i)=>({...row,chatId:`t${start+Math.floor(i/2)}-${i%2?'a':'u'}`})));f.control.artifact=artifact();for(const row of [...f.control.artifact.entities,...f.control.artifact.facts])for(const span of row.evidenceSpans)span.ref=span.ref.replace(/^t(\d+)/,(_,n)=>`t${Number(n)+start-1}`);}
(async()=>{
 const results=[];const f=await fixture();
 try{
  await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
  assert.equal((await f.run()).completed,1);for(const start of [6,11]){addBatch(f,start);assert.equal((await f.run()).completed,1);}await f.r.api.retryPendingUnifiedVectors();
  const before=clone(f.getManifest().memories),bytes=Object.fromEntries(Object.values(before).map(ref=>[ref.key,f.r.values.get(ref.key)]));
  f.chat.message[11].data+=' Explicitly selected source correction.';
  f.control.artifact=artifact();for(const row of [...f.control.artifact.entities,...f.control.artifact.facts])for(const span of row.evidenceSpans)span.ref=span.ref.replace(/^t(\d+)/,(_,n)=>`t${Number(n)+5}`);f.control.artifact=quotedArtifact(f);
  const calls=f.control.calls.length;await f.r.sourceEditBoundary();assert.equal(f.control.calls.length,calls,'ordinary requests never schedule direct or dependent analysis');
  const ticket=await selection(f,[6]);await replace(f,[6]);assert.equal(f.control.calls.length,calls+1,'only the selected middle batch pays for analysis');
  const after=f.getManifest().memories;assert.ok(after['6'].revision>before['6'].revision);
  for(const start of ['1','11']){assert.equal(after[start].key,before[start].key,'unselected prefix/suffix keeps its approved authority');assert.equal(after[start].revision,before[start].revision);}
  for(const [key,raw]of Object.entries(bytes))assert.equal(f.r.values.get(key),raw,'all previous canonical bytes remain immutable');
  const packet=await actualClassicPacket(f,'도서관에서 민아와 지호의 은빛 열쇠 약속은 어떻게 되었나요?',ticket.scopeKey);
  const refs=packet.actualClassic.context.canonicalRefs;assert.ok(refs.some(ref=>ref.key===after['6'].key));assert.ok(!refs.some(ref=>ref.key===before['6'].key),'request seals the replacement, never superseded revision');assert.equal(f.control.calls.length,calls+1);noJournal(f);
  results.push('one selected middle range preserves unselected prefix/suffix and replaces actual request authority');
 }finally{await f.r.cleanup();}
 for(const change of ['source','scope','cancel','overlap']){
  const f=await fixture(),entered=deferred(),gate=deferred();let work;
  try{
   assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();
   const old=clone(f.getManifest().memories['1']),oldBytes=f.r.values.get(old.key);
   f.chat.message[9].data+=' Selected correction.';f.control.artifact=quotedArtifact(f);const ticket=await selection(f),calls=f.control.calls.length;
   const response=JSON.stringify(f.control.artifact);f.control.onCall=async()=>{entered.resolve();await gate.promise;return {type:'success',result:response};};
   work=f.r.api.startSelectedCanonicalBatches(ticket);await entered.promise;
   assert.equal(f.control.calls.length,calls+1);assert.equal(f.getManifest().memories['1'].key,old.key,'in-flight provider cannot publish canonical');
   if(change==='scope'){f.chat.id='changed-scope';f.chat.chatId='changed-scope';}
   if(change==='source'||change==='overlap')f.chat.message[9].data+=' Changed again after dispatch.';
   if(change==='cancel'){const job=await f.r.api.getCanonicalJobStatus();await f.r.api.cancelCanonicalJob({jobId:job.jobId});}
   if(change==='overlap')await assert.rejects(()=>f.r.api.startSelectedCanonicalBatches(ticket),/selected_batch_busy/);
   gate.resolve();const result=await work;assert.equal(result.ok,false,JSON.stringify(result));
   assert.equal(f.r.values.get(old.key),oldBytes);assert.equal(f.getManifest().memories['1'].key,old.key);assert.equal(f.control.calls.length,calls+1,'refused work adds no retry/provider helper');
   if(change==='cancel')assert.equal(result.job.state,'cancelled');
   if(change==='overlap'){
    f.control.onCall=null;f.control.artifact=quotedArtifact(f);await replace(f);assert.equal(f.control.calls.length,calls+2,'fresh explicit action after stale refusal pays exactly once');assert.ok(f.getManifest().memories['1'].revision>old.revision);
   }
   noJournal(f);results.push(change+' rejects late replacement');
  }finally{gate.resolve();await work?.catch(()=>{});await f.r.cleanup();}
 }
 console.log(JSON.stringify({test:'libra_source_edit_exception_impact_runtime',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
