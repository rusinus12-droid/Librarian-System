'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {selection,replace,noJournal,clone}=require('./fixtures/libra_selected_source_contract.cjs');
const PAIR=(open,close)=>({open,close});
const RULES=(extra={})=>({version:1,ignoredTags:[],unwrapTags:[],sourceTags:[PAIR('<original>','</original>')],controls:[],...extra});
function quotes(f,text){const next=clone(f.control.artifact);for(const row of [...next.entities,...next.facts])for(const span of row.evidenceSpans)if(span.ref==='t1-a')span.quote=text;f.control.artifact=next;}
async function setup(){const f=await fixture(),base=f.chat.message[1].data;f.chat.message[1].data=`<original>[wrapper]${base}[/wrapper] [private]sensitive[/private]</original> 번역문은 서명을 부인한다.`;quotes(f,f.chat.message[1].data);assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();return {f,base};}
(async()=>{
 const results=[];
 for(const missing of [false,true]){
  const {f,base}=await setup();
  try{
   const original=f.getManifest().memories['1'],originalBytes=f.r.values.get(original.key),sourceKey=f.getMemory().sourceEvidenceRef.key,sourceBytes=f.r.values.get(sourceKey),rawChat=JSON.stringify(f.chat.message);
   if(missing)f.r.values.delete(sourceKey);
   const stages=[
    {rules:RULES(),expected:`[wrapper]${base}[/wrapper] [private]sensitive[/private]`},
    {rules:RULES({unwrapTags:[PAIR('[wrapper]','[/wrapper]')]}),expected:`${base} [private]sensitive[/private]`},
    {rules:RULES({unwrapTags:[PAIR('[wrapper]','[/wrapper]')],ignoredTags:[PAIR('[private]','[/private]')]}),expected:base}
   ];
   for(const stage of stages){
    const prior=f.getManifest().memories['1'],priorBytes=f.r.values.get(prior.key),calls=f.control.calls.length;
    await f.r.api.setSourceEditRules(stage.rules);quotes(f,stage.expected);await f.r.sourceEditBoundary();
    assert.equal(f.control.calls.length,calls,'saving or observing a projection policy never spends a provider call');
    assert.equal(f.getManifest().memories['1'].key,prior.key,'prior approved canonical remains selected');
    const ticket=await selection(f);assert.notEqual(ticket.ranges[0].sourceDigest,prior.sourceDigest,'selection sees changed projection');
    await replace(f);assert.equal(f.control.calls.length,calls+1,'explicit projection rebuild spends exactly one Canonical call');
    const current=f.getManifest().memories['1'];assert.ok(current.revision>prior.revision);assert.notEqual(current.sourceDigest,prior.sourceDigest);
    assert.equal(f.r.values.get(prior.key),priorBytes);assert.equal(JSON.stringify(f.chat.message),rawChat,'rules do not rewrite host source');
    const request=JSON.stringify(f.control.calls.at(-1));assert.ok(request.includes(stage.expected));assert.ok(!request.includes('번역문은 서명을 부인한다.'));
    const raw=JSON.parse(f.r.values.get(f.getMemory().sourceEvidenceRef.key));assert.equal(raw.rows[0].assistantText,stage.expected,'approved evidence binds the exact projection consumed by the canonical model');
   }
   const calls=f.control.calls.length,before=await selection(f),ref=f.getManifest().memories['1'],bytes=f.r.values.get(ref.key);
   await f.r.api.setSourceEditRules(RULES({unwrapTags:[PAIR('[wrapper]','[/wrapper]'),PAIR('[absent]','[/absent]')],ignoredTags:[PAIR('[private]','[/private]')]}));
   await f.r.sourceEditBoundary();const after=await selection(f);
   assert.equal(after.ranges[0].sourceDigest,before.ranges[0].sourceDigest,'policy change with identical projection preserves selected source digest');
   assert.equal(f.control.calls.length,calls);assert.equal(f.r.values.get(ref.key),bytes);assert.equal(f.r.values.get(original.key),originalBytes);
   assert.equal(f.r.values.get(sourceKey),missing?undefined:sourceBytes,'missing prior evidence is never invented');noJournal(f);
   results.push({missingPriorEvidence:missing,explicitRebuilds:3,automaticCalls:0});
  }finally{await f.r.cleanup();}
 }
 console.log(JSON.stringify({test:'libra_source_edit_policy_epoch_runtime',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
