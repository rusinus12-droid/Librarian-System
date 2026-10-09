'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const PAIR=(open,close)=>({open,close});
const RULES=(extra={})=>({version:1,ignoredTags:[],unwrapTags:[],sourceTags:[PAIR('<original>','</original>')],controls:[],...extra});
function replaceEvidenceQuotes(f,t1Quote=null){
 const artifact=f.clone(f.control.artifact);
 for(const row of [...artifact.entities,...artifact.facts])for(const span of row.evidenceSpans){
  const index=Number(String(span.ref).match(/^t(\d+)-a$/)?.[1]||0)*2-1;
  if(index>=0&&f.chat.message[index])span.quote=span.ref==='t1-a'&&t1Quote!==null?t1Quote:f.chat.message[index].data;
 }
 f.control.artifact=artifact;
}
async function setup(){
 const root=createRootBoundary(),f=await fixture({host:{getRootDocument:async()=>root.root}});
 f.chat.message[1].data='<original>Alice [wrapper]signed[/wrapper] [private]sensitive[/private] the agreement.</original> 번역문은 서명을 부인한다.';
 replaceEvidenceQuotes(f,false);
 await f.run();
 const manifest=f.getManifest(),ref=manifest.memories['1'],oldBytes=f.r.values.get(ref.key);
 await f.r.sourceEditBoundary(); // Establish a trustworthy raw/projected policy baseline.
 return {root,f,ref,oldBytes};
}
const journal=f=>{const key=[...f.r.values.keys()].find(k=>k.includes(':source-edit-consent:v1'));assert.ok(key,'owner source journal exists');return JSON.parse(f.r.values.get(key));};
async function boundary(f,root){await f.r.sourceEditBoundary();assert.equal(await root.ready(),false,'policy reconciliation must not open a source-edit dialog');}

(async()=>{
 {
  const {root,f,ref,oldBytes}=await setup();
  try{
   const calls=f.control.calls.length;
   await f.r.api.setSourceEditRules(RULES());
   const selected='Alice [wrapper]signed[/wrapper] [private]sensitive[/private] the agreement.';
   replaceEvidenceQuotes(f,selected);
   await boundary(f,root);
   const current=f.getManifest().memories['1'],task=journal(f).tasks['1'];
   assert.equal(f.control.calls.length,calls+1,'projection-changing rule update runs one automatic policy rebuild');
   assert.equal(task.state,'applied');assert.equal(task.changeKind,'projection_policy_changed');
   assert.equal(task.policyUncertain,false,'validated prior raw source separates policy edits from source edits');
   assert.equal(task.rawDigest,task.originalRawDigest,'raw U+A is identical across the rule-only change');
   assert.equal(task.sourceDigest,current.sourceDigest);assert.notEqual(current.sourceDigest,ref.sourceDigest);
   assert.equal(f.r.values.get(ref.key),oldBytes,'old policy projection remains immutable history');
   let request=JSON.stringify(f.control.calls.at(-1));
   assert.ok(request.includes(selected),'provider consumes the selected original text');
   assert.ok(!request.includes('번역문은 서명을 부인한다.'),'text outside sourceTags is excluded from analysis');

   const afterRebuildCalls=f.control.calls.length,appliedBytes=f.r.values.get(current.key);
   await f.r.api.setSourceEditRules(RULES({unwrapTags:[PAIR('[wrapper]','[/wrapper]')]}));
   const unwrapped='Alice signed [private]sensitive[/private] the agreement.';
   replaceEvidenceQuotes(f,unwrapped);
   await boundary(f,root);
   assert.equal(f.control.calls.length,afterRebuildCalls+1,'tag-only removal that changes projection performs a policy rebuild');
   const unwrappedTask=journal(f).tasks['1'];
   assert.equal(unwrappedTask.changeKind,'projection_policy_changed');assert.equal(unwrappedTask.rawDigest,unwrappedTask.originalRawDigest);
   assert.equal(f.r.values.get(current.key),appliedBytes,'old wrapper-preserving policy revision remains immutable');

   const beforeIgnoreCalls=f.control.calls.length,unwrappedRef=f.getManifest().memories['1'],unwrappedBytes=f.r.values.get(unwrappedRef.key);
   await f.r.api.setSourceEditRules(RULES({unwrapTags:[PAIR('[wrapper]','[/wrapper]')],ignoredTags:[PAIR('[private]','[/private]')]}));
   replaceEvidenceQuotes(f,'Alice signed the agreement.');
   await boundary(f,root);
   assert.equal(f.control.calls.length,beforeIgnoreCalls+1,'ignoring source-only tags that changes projection rebuilds once');
   const ignoredTask=journal(f).tasks['1'];
   assert.equal(ignoredTask.changeKind,'projection_policy_changed');assert.equal(ignoredTask.rawDigest,ignoredTask.originalRawDigest);
   assert.equal(f.r.values.get(unwrappedRef.key),unwrappedBytes,'previous projection remains immutable');

   const afterChangedRulesCalls=f.control.calls.length,appliedRef=f.getManifest().memories['1'],finalBytes=f.r.values.get(appliedRef.key);
   await f.r.api.setSourceEditRules(RULES({unwrapTags:[PAIR('[wrapper]','[/wrapper]'),PAIR('[absent]','[/absent]')],
     ignoredTags:[PAIR('[private]','[/private]')]}));
   await boundary(f,root);
   assert.equal(f.control.calls.length,afterChangedRulesCalls,'an epoch change with identical projection needs no provider call');
   assert.equal(f.r.values.get(appliedRef.key),finalBytes,'identical projection keeps the current canonical');
  }finally{await f.r.cleanup();}
 }
 {
  const {root,f,ref,oldBytes}=await setup();
  try{
   const evidenceKey=f.getMemory().sourceEvidenceRef.key;
   assert.ok(f.r.values.has(evidenceKey),'baseline raw evidence exists before simulating its loss');
   f.r.values.delete(evidenceKey);
   const calls=f.control.calls.length;
   await f.r.api.setSourceEditRules(RULES());
   replaceEvidenceQuotes(f,'Alice [wrapper]signed[/wrapper] [private]sensitive[/private] the agreement.');
   await boundary(f,root);
   const task=journal(f).tasks['1'];
   assert.equal(f.control.calls.length,calls+1,'changed projection is rebuilt even when old raw evidence is unavailable');
   assert.equal(task.changeKind,'projection_policy_changed','missing old raw is never mislabeled as a user source edit');
   assert.equal(task.policyUncertain,false,'same-identity SDK raw baseline still proves the current raw is unchanged');
   assert.equal(task.originalDigest,ref.sourceDigest,'the trusted prior projection digest protects the old canonical during rebuild');
   assert.equal(task.originalRawDigest,'','owner must not fabricate previous raw evidence bytes');
   assert.equal(task.originalEvidenceUnavailable,true,'missing owner evidence remains explicit even when a trusted hash baseline exists');
   assert.equal(task.state,'applied','a verified policy rebuild completes automatically without old evidence bytes');
   assert.equal(f.getManifest().memories['1'].sourceDigest,task.sourceDigest,'new canonical is durably installed before the task is applied');
   assert.equal(f.r.values.get(ref.key),oldBytes,'loss of comparison evidence does not mutate old canonical history');
  }finally{await f.r.cleanup();}
 }
 console.log(JSON.stringify({test:'libra_source_edit_policy_epoch_runtime',passed:2,checks:['validated raw separates policy-only from source edits','same projection skips provider','missing owner evidence preserves trusted digest provenance without inventing old text or diff']}));
})().catch(e=>{console.error(e);process.exitCode=1;});
