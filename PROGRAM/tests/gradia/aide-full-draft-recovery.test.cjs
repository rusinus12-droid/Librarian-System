'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const {fixture}=require('./evidence-bridge.test.cjs');
const BROKEN='The editor is preparing the response.\n\nA scene will be written later.\n\nThis paragraph is an editing plan.\n\nThe response is still pending.';
const SCENE='The archivist opened the cabinet and found the blue ledger.\n\nShe carried it to the doorway and stopped.';
const REFUSAL='I cannot help with that request because of safety policy.';
const summary='The entire candidate is an editing-status report rather than a scene; local paragraph fixes cannot supply a usable response.';
const envelope=(stage,hash,content=SCENE)=>({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage,ok:true,analysis:{summary,constraints:[],risks:[]},domain:{},edits:[{operation:'replace_draft',target:'draft',expected_hash:hash,content,reason:summary}]});
async function unit(){
 const h=await load({captureInternals:true,transformSource:source=>source.replace('clearStructuredSettings, fullDraftStagePrompt, Runtime };','clearStructuredSettings, fullDraftStagePrompt, Runtime, applyAidePatchWithRecovery };')});
 const document=h.plugin.debugBuildDraftPatchDocument(BROKEN);
 return {h,document,apply:(patch,input='')=>h.internals.applyAidePatchWithRecovery(document,patch,input),
   normalize:value=>h.plugin.debugNormalizeAidePatch('aide_plot',JSON.stringify(value))};
}
test('explicit whole replacement normalizes and applies atomically, preserving the source',async()=>{
 const f=await unit(),before=JSON.stringify(f.document),patch=f.normalize(envelope('aide_plot',f.document.sourceHash));
 assert.ok(patch);const result=f.apply(patch);
 assert.equal(result.draft,SCENE);assert.equal(result.recoveryMode,'full_draft_recovery');assert.equal(result.applied.length,1);
 assert.equal(result.blockCountBefore,4);assert.equal(result.blockCountAfter,2);assert.equal(JSON.stringify(f.document),before);assert.equal(f.h.getCalls(),0);
});
test('public schema and patch evaluation use the same full-recovery contract as runtime',async()=>{
 const f=await unit(),schema=f.h.plugin.debugAidePatchJsonSchema('aide_plot');
 assert.ok(schema.properties.edits.items.properties.operation.enum.includes('replace_draft'));
 const result=f.h.plugin.debugEvaluateAidePatch('aide_plot',BROKEN,envelope('aide_plot',f.document.sourceHash));
 assert.equal(result.issue,'');assert.equal(result.acceptedApplication,true);assert.equal(result.applied.draft,SCENE);
 const bad=f.h.plugin.debugEvaluateAidePatch('aide_plot',BROKEN,envelope('aide_plot','00000000'));
 assert.equal(bad.acceptedApplication,false);assert.equal(bad.applied.draft,BROKEN);
});
for(const kind of ['stale_hash','mixed','missing_diagnosis','oversized','marker','unchanged','non_text'])test('whole replacement rejects '+kind+' without partial deletion',async()=>{
 const f=await unit(),patch=f.normalize(envelope('aide_plot',f.document.sourceHash));
 if(kind==='stale_hash')patch.edits[0].expectedHash='00000000';
 if(kind==='mixed')patch.edits.push({operation:'delete',target:f.document.blocks[1].id,expectedHash:f.document.blocks[1].hash,content:'',reason:'delete'});
 if(kind==='missing_diagnosis')patch.edits[0].reason='bad';
 if(kind==='oversized')patch.edits[0].content='x'.repeat(80001);
 if(kind==='marker')patch.edits[0].content='<DRAFT_BLOCK>scene</DRAFT_BLOCK>';
 if(kind==='unchanged')patch.edits[0].content=BROKEN;
 if(kind==='non_text')patch.edits[0].content={text:SCENE};
 const before=JSON.stringify(f.document),result=f.apply(patch);
 assert.equal(result.ok,false);assert.equal(result.draft,BROKEN);assert.equal(result.applied.length,0);assert.equal(JSON.stringify(f.document),before);
});
test('a recovery candidate that is itself a refusal is not adopted',async()=>{
 const f=await unit(),patch=f.normalize(envelope('aide_plot',f.document.sourceHash,REFUSAL));
 const result=f.apply(patch);
 assert.equal(result.ok,true);assert.equal(result.recoveryRejected,'aide_full_recovery_candidate_refusal');
 assert.equal(result.draft,BROKEN);assert.equal(result.applied.length,0);
 assert.equal(result.skipped.length,1);assert.equal(result.skipped[0].skipReason,'candidate_refusal_not_adopted');
});
test('a stage that recovers into a refusal keeps the previous draft and records why',async()=>{
 const f=await fixture({server:true,unbound:true,modelContent:(n,body,normal)=>{
   if(n===1)return BROKEN;
   const system=body.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n');
   if(!system.includes('Return the compact aide_plot patch JSON'))return normal;
   const user=body.messages.filter(row=>row.role==='user').map(row=>row.content).join('\n');
   return JSON.stringify(envelope('aide_plot',user.match(/input_draft_hash:\s*([0-9a-f]{8})/)[1],REFUSAL));
 }});
 const result=await f.run();
 const trace=f.host.plugin.getRuntime().stageTrace.find(row=>row.stage==='aide_plot');
 assert.equal(trace.reason,'aide_full_recovery_candidate_refusal');assert.equal(trace.ok,false);
 assert.ok(result.injection.includes(BROKEN));assert.ok(!result.injection.includes('I cannot help'));
 result.closeEvidence();
});
test('a refusal source with no edits stays a plain no-change',async()=>{
 const f=await unit(),doc=f.h.plugin.debugBuildDraftPatchDocument(REFUSAL);
 const result=f.h.internals.applyAidePatchWithRecovery(doc,{edits:[]});
 assert.equal(result.ok,true);assert.equal(result.recoveryMode,undefined);
 assert.equal(result.draft,REFUSAL);assert.equal(result.applied.length,0);
});
for(const source of [
 'I cannot help but think of the closed cabinet as the archivist speaks.',
 'I can’t help but wonder what the ledger was hiding.',
 'I can\'t help smiling as I open the ledger.',
 'I cannot help noticing the dust on the ledger cover.',
 'I can’t help myself when the ledger is in reach.',
 '도와드릴 수 없는 처지였다. 그래서 그는 창가에 서 있었다.',
 '그는 답할 수 없었다. 그래서 문가에 섰다.'
])test('idiomatic or past-tense refusal wording stays editable: '+source,async()=>{
 const f=await unit(),doc=f.h.plugin.debugBuildDraftPatchDocument(source);
 const result=f.h.internals.applyAidePatchWithRecovery(doc,{edits:[{operation:'replace',target:doc.blocks[0].id,expectedHash:doc.blocks[0].hash,content:'The archivist crossed to the window.',reason:'Clarify the scene.'}]});
 assert.equal(result.ok,true);assert.equal(result.applied.length,1);
});
for(const source of [
 'I cannot help you," she said, "because of safety policy.',
 '도와드릴 수 없는 처지였다. 정책상 답할 수 없다.',
 "I'm not able to help with that request.",
 'I must decline this request.'
])test('narrated or reworded refusal cannot smuggle a refusal past the source guard: '+source,async()=>{
 const f=await unit(),doc=f.h.plugin.debugBuildDraftPatchDocument(source);
 const result=f.h.internals.applyAidePatchWithRecovery(doc,{edits:[{operation:'replace',target:doc.blocks[0].id,expectedHash:doc.blocks[0].hash,content:'The archivist crossed to the window.',reason:'Clarify the scene.'}]});
 assert.equal(result.ok,false);assert.equal(result.reason,'refusal_must_be_replaced_entirely');
});
test('a refusal hidden inside narration never reaches the injection',async()=>{
 const f=await fixture({server:true,unbound:true,modelContent:(n,body,normal)=>n===1?'I cannot help you," she said, "because of safety policy.':normal});
 const result=await f.run();
 assert.equal(result.ok,false);assert.equal(result.reason,'final_draft_refusal_suppressed');
 assert.equal(result.injection,'');
 result.closeEvidence();
});
test('a refusal that survives every stage is never injected',async()=>{
 const f=await fixture({server:true,unbound:true,modelContent:(n,body,normal)=>n===1?REFUSAL:normal});
 const result=await f.run();
 assert.equal(result.ok,false);assert.equal(result.reason,'final_draft_refusal_suppressed');
 assert.equal(result.injection,'');assert.equal(f.prompts.length,4);
 result.closeEvidence();
});
test('non-text full replacement is rejected by normalization rather than stringified',async()=>{
 const f=await unit(),value=envelope('aide_plot',f.document.sourceHash);value.edits[0].content={text:SCENE};
 assert.equal(f.normalize(value),null);
});
test('ordinary character dialogue containing a refusal remains editable',async()=>{
 const f=await unit(),source='The archivist shook her head. “I cannot help you find the blue ledger,” she said.';
 const doc=f.h.plugin.debugBuildDraftPatchDocument(source);
 const result=f.h.internals.applyAidePatchWithRecovery(doc,{edits:[{operation:'replace',target:doc.blocks[0].id,expectedHash:doc.blocks[0].hash,content:'The archivist shook her head and pointed toward the cabinet.',reason:'Clarify the scene.'}]});
 assert.equal(result.ok,true);assert.equal(result.applied.length,1);
});
test('full recovery reuses the current-input commitment guard before adoption',async()=>{
 const f=await unit(),patch=f.normalize(envelope('aide_plot',f.document.sourceHash,'The archivist destroyed the blue ledger.'));
 const result=f.apply(patch,'Keep the blue ledger intact.');
 assert.equal(result.ok,false);assert.equal(result.reason,'aide_full_recovery_commitment_conflict');assert.equal(result.draft,BROKEN);
});
for(const source of ['I can’t help with that request.','이 요청은 도와드릴 수는 없습니다.'])test('meta refusal draft is replaced only by an atomic whole replacement: '+source,async()=>{
 const f=await unit(),doc=f.h.plugin.debugBuildDraftPatchDocument(source),patch=f.normalize(envelope('aide_plot',doc.sourceHash));
 const applied=f.h.internals.applyAidePatchWithRecovery(doc,patch);
 assert.equal(applied.ok,true);assert.equal(applied.recoveryMode,'full_draft_recovery');assert.equal(applied.draft,SCENE);
 const paragraph={edits:[{operation:'replace',target:doc.blocks[0].id,expectedHash:doc.blocks[0].hash,content:SCENE,reason:summary}]};
 assert.equal(f.h.internals.applyAidePatchWithRecovery(doc,paragraph).reason,'refusal_must_be_replaced_entirely');
});
test('a policy explanation before the refusal blocks paragraph bypass but not whole replacement',async()=>{
 const f=await unit(),source='A safety policy applies to this request. I cannot provide that response.';
 const doc=f.h.plugin.debugBuildDraftPatchDocument(source),patch=f.normalize(envelope('aide_plot',doc.sourceHash));
 assert.equal(f.h.internals.applyAidePatchWithRecovery(doc,patch).draft,SCENE);
 const composed={edits:doc.blocks.map(block=>({operation:'delete',target:block.id,expectedHash:block.hash,content:'',reason:'delete meta block'}))};
 assert.equal(f.h.internals.applyAidePatchWithRecovery(doc,composed).reason,'refusal_must_be_replaced_entirely');
});
test('whole replacement cannot carry extra operations to bypass the refusal boundary',async()=>{
 const f=await unit(),source='I cannot help with that request because of safety policy.';
 const doc=f.h.plugin.debugBuildDraftPatchDocument(source),patch=f.normalize(envelope('aide_plot',doc.sourceHash));
 patch.edits.push({operation:'delete',target:'p002',expectedHash:'00000000',content:'',reason:'delete meta block'});
 const result=f.h.internals.applyAidePatchWithRecovery(doc,patch);
 assert.equal(result.ok,false);assert.equal(result.reason,'aide_full_recovery_mixed_operations');assert.equal(result.draft,source);
});
test('full candidates are never silently clipped to a paragraph limit',async()=>{
 const f=await unit(),body='The ledger remained on the shelf. '.repeat(300);
 const patch=f.normalize(envelope('aide_plot',f.document.sourceHash,body));assert.equal(patch.edits[0].content,body.trim());
 assert.equal(f.apply(patch).draft,body.trim());
});
for(const legacy of [false,true])test('refusal source boundary for '+(legacy?'legacy paragraph composition':'whole replacement'),async()=>{
 const f=await unit(),doc=f.h.plugin.debugBuildDraftPatchDocument(REFUSAL);
 const patch=legacy?{edits:[{operation:'replace',target:doc.blocks[0].id,expectedHash:doc.blocks[0].hash,content:SCENE,reason:summary}]}:f.normalize(envelope('aide_plot',doc.sourceHash));
 const result=f.h.internals.applyAidePatchWithRecovery(doc,patch,'Continue the scene.');
 if(legacy){assert.equal(result.reason,'refusal_must_be_replaced_entirely');assert.equal(result.draft,REFUSAL);assert.equal(result.applied.length,0);}
 else{assert.equal(result.ok,true);assert.equal(result.draft,SCENE);assert.equal(result.applied.length,1);}
});
for(const stage of ['aide_character','aide_world','aide_plot'])test(stage+' publishes a complete recovery through the real pipeline with no extra calls',async()=>{
 const f=await fixture({server:true,unbound:true,modelContent:(n,body,normal)=>{
   if(n===1)return BROKEN;
   const system=body.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n');
   const current=system.match(/Return the compact (aide_\w+) patch JSON/)?.[1];
   if(current!==stage)return normal;
   const user=body.messages.filter(row=>row.role==='user').map(row=>row.content).join('\n');
   const hash=user.match(/input_draft_hash:\s*([0-9a-f]{8})/)[1];
   return JSON.stringify(envelope(stage,hash));
 }});
 f.settings.writingMode='novel';const result=await f.run();
 assert.equal(result.ok,true);assert.equal(f.prompts.length,4);assert.ok(result.injection.includes(SCENE));
 const trace=f.host.plugin.getRuntime().stageTrace.find(row=>row.stage===stage);
 assert.equal(trace.parsed.patchMeta.mode,'full_draft_recovery');assert.equal(trace.parsed.draft_kind,'full_draft_recovery');
 assert.equal(trace.parsed.lineage.validation.reason,'full_draft_recovery_applied');result.closeEvidence();
});
test('real pipeline replaces a meta refusal draft through the atomic recovery route',async()=>{
 const f=await fixture({server:true,unbound:true,modelContent:(n,body,normal)=>{
   if(n===1)return REFUSAL;
   const system=body.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n');
   const stage=system.match(/Return the compact (aide_\w+) patch JSON/)?.[1];
   const user=body.messages.filter(row=>row.role==='user').map(row=>row.content).join('\n');
   return JSON.stringify(envelope(stage,user.match(/input_draft_hash:\s*([0-9a-f]{8})/)[1],SCENE+' ['+stage+']'));
 }});
 const result=await f.run();assert.equal(result.ok,true);assert.equal(f.prompts.length,4);
 assert.ok(result.injection.includes(SCENE));assert.ok(!result.injection.includes('I cannot help'));
 assert.ok(f.host.plugin.getRuntime().stageTrace.filter(row=>row.stage.startsWith('aide_')).every(row=>row.parsed.draft_kind==='full_draft_recovery'));result.closeEvidence();
});
test('analysis contract names meta drafts as unusable and forbids domain excuses',async()=>{
 const f=await fixture({server:true,unbound:true,modelContent:(n,body,normal)=>normal});
 const result=await f.run();assert.equal(result.ok,true);assert.equal(f.prompts.length,4);
 const systems=f.prompts.map(body=>body.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n'));
 assert.ok(systems.some(system=>system.includes('meta refusal or apology')&&system.includes('Do not return edits: [] merely because the defect looks outside your own domain')));
 assert.equal(systems.filter(system=>system.includes('meta refusal or apology')).length,3);
 result.closeEvidence();
});
test('real pipeline refuses a stale whole-source hash without a format retry or partial publication',async()=>{
 const f=await fixture({server:true,unbound:true,modelContent:(n,body,normal)=>{
   if(n===1)return BROKEN;
   const system=body.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n');
   if(!system.includes('Return the compact aide_character patch JSON'))return normal;
   return JSON.stringify(envelope('aide_character','00000000'));
 }});
 const result=await f.run();assert.equal(f.prompts.length,4);assert.ok(result.injection.includes(BROKEN));assert.ok(!result.injection.includes(SCENE));
 assert.equal(f.host.plugin.getRuntime().stageTrace.find(row=>row.stage==='aide_character').reason,'aide_full_recovery_source_mismatch');result.closeEvidence();
});
for(const mode of ['heavyweight','evidence_bound'])test(mode+' recovery keeps the existing call plan and delivery guards',async()=>{
 const heavy=mode==='heavyweight';
 const f=await fixture({server:heavy,unbound:heavy,mode:heavy?'heavyweight':'lightweight',modelContent:(n,body,normal)=>{
   if(n===(heavy?2:1))return BROKEN;
   const system=body.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n');
   const stage=system.match(/Return the compact (aide_\w+) patch JSON/)?.[1];
   if(stage!=='aide_character')return normal;
   const user=body.messages.filter(row=>row.role==='user').map(row=>row.content).join('\n');
   return JSON.stringify(envelope(stage,user.match(/input_draft_hash:\s*([0-9a-f]{8})/)[1]));
 }});
 const result=await f.run();assert.equal(result.ok,true);assert.ok(result.injection.includes(SCENE));
 assert.equal(f.prompts.length,heavy?8:4);if(!heavy){assert.equal(f.recalls,1);await result.finalizeHandoff();}
 if(heavy)assert.ok(f.prompts.some(body=>body.messages.some(row=>row.role==='system'&&row.content.includes('name the unusable class, the required scene beats, and the ending boundary'))));
 result.closeEvidence();
});
test('world recovery retains the character stage disclosure and viewpoint constraints',async()=>{
 const f=await fixture({server:true,unbound:true,modelContent:(n,body,normal)=>{
   if(n===1)return BROKEN;
   const system=body.messages.filter(row=>row.role==='system').map(row=>row.content).join('\n');
   const stage=system.match(/Return the compact (aide_\w+) patch JSON/)?.[1];
   if(stage==='aide_character'){const patch=JSON.parse(normal);patch.do_not_reveal=['Keep the cabinet code private.'];patch.pov_limits=['Use only the archivist viewpoint.'];return JSON.stringify(patch);}
   if(stage!=='aide_world')return normal;
   const user=body.messages.filter(row=>row.role==='user').map(row=>row.content).join('\n');
   return JSON.stringify(envelope(stage,user.match(/input_draft_hash:\s*([0-9a-f]{8})/)[1]));
 }});
 const result=await f.run(),trace=f.host.plugin.getRuntime().stageTrace.find(row=>row.stage==='aide_world');
 assert.ok(trace.parsed.draft.do_not_reveal.includes('Keep the cabinet code private.'));
 assert.ok(trace.parsed.draft.pov_limits.includes('Use only the archivist viewpoint.'));
 assert.ok(result.injection.includes(SCENE));assert.equal(f.prompts.length,4);result.closeEvidence();
});
