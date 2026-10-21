'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
let passed=0;const check=(v,m)=>{assert.ok(v,m);passed++;};
const msg=(role,id,data)=>({role,chatId:id,id,data});
const q='Alice opened the archive.\n\nShe found a blue ribbon.';
function envelope(){return {schema:'hayaku.native_repair_output.v1',packet:{meta:{summary_memory:{summary:'Alice found a ribbon.'}},entity:{characters:[{name:'Alice',state:'opened the archive',status:'active'}]},world:{regions:[{name:'archive',type:'region',status:'open'}]},narrative:{scene_deltas:[{summary:'She found a blue ribbon.'}]},planner:{},importance:{}},grounding:[{path:'meta.summary_memory.summary',source:'target',evidence:['Alice opened the archive. She found a blue ribbon.']},{path:'entity.characters[0]',source:'target',evidence:['Alice opened the archive.']},{path:'world.regions[0]',source:'target',evidence:['Alice opened the archive.']},{path:'narrative.scene_deltas[0]',source:'target',evidence:['She found a blue ribbon.']}]};}
(async()=>{// Detailed failed-analysis revisions are retained only with debug enabled (7843201).
const r=await createHayakuRuntime({autoRepair:false,arguments:{hayaku_debug:'true'},messages:[msg('user','u1','Visit the archive.'),msg('assistant','a1',q)]});try{
 const t=r.hayaku._test,e=envelope();
 check(t.validateNativeRepairGrounding(e,{targetText:q}).ok,'whitespace-only wrapping and known schema enum are not false grounding errors');
 const aliases=structuredClone(e);aliases.grounding[1].path='packet.entity.characters.0';check(t.validateNativeRepairGrounding(aliases,{targetText:q}).ok,'unambiguous packet prefix/dotted array index normalized');
 const invalid=structuredClone(e);invalid.grounding[1].path='entity..characters[0]';check(!t.validateNativeRepairGrounding(invalid,{targetText:q}).ok,'malformed path never skips a segment');
 const unsupported=structuredClone(e);unsupported.grounding[1].evidence=['Alice flew to the moon.'];check(!t.validateNativeRepairGrounding(unsupported,{targetText:q}).ok,'unsupported quote still fails');
 const changed=structuredClone(e);changed.packet.entity.characters[0].state='closed the archive';const derived=t.validateNativeRepairGrounding(changed,{targetText:q});check(derived.classification==='source_bound_derived'&&derived.derived.some(row=>row.field==='entity.characters[0].state'),'nonliteral claim is marked derived, never direct quoted fact; this local validator is not semantic inference');
 const omitted=structuredClone(e);omitted.grounding.pop();check(!t.validateNativeRepairGrounding(omitted,{targetText:q}).ok,'missing semantic grounding still fails');
 const quoteGap=structuredClone(e);quoteGap.grounding[0].evidence=['Alice opened a blue ribbon.'];check(!t.validateNativeRepairGrounding(quoteGap,{targetText:q}).ok,'disconnected fragments are never fused into a valid quote');
 const scope=await t.currentChatScope();const input={scopeKey:scope.key,kind:'incremental_recovery',flow:'native_repair',chunk:{turn:1,startTurn:1,endTurn:1,text:q},context:{scopeKey:scope.key,sourceEvidenceHash:'safe-evidence'},attempts:[{mode:'primary',rawResponse:'bad JSON'}],failure:{code:'INVALID_JSON',message:'bad JSON'}};
 const first=await t.saveFailedAnalysisArtifact(input);check(first.durable,'original incident durable');
 const again=await t.saveFailedAnalysisArtifact(input);check(again.durable&&again.deduplicated&&again.failureId===first.failureId,'identical failure reuses physical revision');
 let list=await t.listFailedAnalysisArtifacts(scope.key);check(list.entries.length===1&&list.cases.length===1&&list.cases[0].attemptCount===2,'repeat count retained without duplicate body');
 const second=await t.saveFailedAnalysisArtifact({...input,parentFailureId:first.failureId,state:'resolution_candidate',flow:'failed_analysis_manual_resolution',attempts:[{mode:'manual',rawResponse:'changed candidate'}],failure:{code:'MANUAL',message:'manual'},proposedCanonical:createValidPacket({turn:1,summary:'Alice opened the archive.'})});
 check(second.durable&&second.failureId!==first.failureId,'real edited candidate preserves a separate immutable revision');
 list=await t.listFailedAnalysisArtifacts(scope.key);check(list.entries.length===2&&list.cases.length===1&&list.cases[0].revisions.length===2,'two revisions in one incident');
 await t.updateFailedAnalysisManifest(scope.key,second.failureId,{state:'resolved',resolution:{canonical:true,durable:true}});
 list=await t.listFailedAnalysisArtifacts(scope.key);check(list.pending===0,'resolved incident no longer counted pending because old audit exists');
 const next=await t.saveFailedAnalysisArtifact({...input,chunk:{...input.chunk,text:'Alice left the archive.'},context:{scopeKey:scope.key,sourceEvidenceHash:'different'}});check(next.durable,'another source revision durable');
 list=await t.listFailedAnalysisArtifacts(scope.key);check(list.cases.length===2&&list.pending===1,'genuine different source revision not hidden by grouping');
 const old=await t.readFailedAnalysisArtifact(scope.key,first.failureId);check(old.payload.attempts[0].rawResponse==='bad JSON','original raw audit not rewritten');
 check(r.llmCalls.length===0,'local diagnosis/grouping adds no model calls');
 console.log(JSON.stringify({test:'hayaku_recovery_review_v349',passed}));
}finally{await r.dispose();}})().catch(e=>{console.error(e);process.exitCode=1});
