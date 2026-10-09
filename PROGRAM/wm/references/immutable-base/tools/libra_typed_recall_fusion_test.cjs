'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {runtime,provider,policy:storagePolicy,budget,flush}=require('./libra_typed_recall_queue_test.cjs');
const {memoryEntry}=require('./libra_recall_test_runtime.cjs');
const results=[],artifacts=[],clone=x=>JSON.parse(JSON.stringify(x));
const policy=()=>({...storagePolicy,mode:'fixture',version:'task4-fixture-v1',maxCorpusUnits:512,laneDepth:32,unionLimit:64,rrf:{k:60},calibration:Object.fromEntries(['memory','entity','world','narrative'].map(f=>[f,{scale:1,offset:0}])),admission:Object.fromEntries(['memory','entity','world','narrative'].map(f=>[f,{heuristicMinScore:.001,semanticMinScore:.8,semanticMinLexicalOverlap:0,semanticMinMargin:0}])),diversity:{maxItems:4,lambda:.8,crossRolePenalty:.2,arcPenalty:.03,maxPerArc:2,typeCaps:{}}});
async function check(name,fn){try{await fn();results.push({name,ok:true});console.log('PASS '+name);}catch(e){results.push({name,ok:false,error:e.stack});console.error('FAIL '+name+' '+e.message);}}
const dual=r=>r.context.__QUEUE_TEST__.dual;
async function many(r,n=48){r.chat.localLore=Array.from({length:n},(_,i)=>memoryEntry(i+1,'pendant promise exact beacon anchor '+i,8));r.snapshot=r.snap({currentTurn:100});r.all=r.corpus.enumerate(r.snapshot).filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);return r;}
async function main(){
 await check('task4_api_and_actual_pre_mmr_seam_exist',async()=>{const r=await runtime();assert.equal(typeof r.api.MemoryEngine.searchHeuristicCandidatesPreMmr,'function');for(const name of ['searchHeuristic','admit','fuseRrf','selectDiverse','retrieve'])assert.equal(typeof dual(r)?.[name],'function',name);});
 if(results.some(x=>!x.ok))return finish();
 await check('actual_returned_rank_only',async()=>{const r=await runtime(),d=dual(r),a=r.all[0],b=r.all[1],c=r.all[2];const h={hits:[{identity:a.identity,rank:999},{identity:b.identity,rank:1}]},s={hits:[{identity:c.identity,rank:99},{identity:a.identity,rank:1}]};const fused=d.fuseRrf(h,s,{k:60}),only=fused.find(x=>x.identity===c.identity);assert.equal(only.rrf,1/(60+1));assert.equal(only.ranks.heuristic,null);assert.equal(fused.find(x=>x.identity===a.identity).rrf,1/61+1/62);assert.equal(fused.find(x=>x.identity===b.identity).rrf,1/62);artifacts.push({case:'rank-only',h,s,fused});});
 await check('exact_typed_dedup_keeps_same_id_across_types',async()=>{const r=await runtime(),d=dual(r);const ids=['memory','entity','world','narrative'].map(f=>JSON.stringify([r.snapshot.scopeKey,f,'entry','shared-id']));const f=d.fuseRrf({hits:ids.map(identity=>({identity}))},{hits:[{identity:ids[0]},{identity:ids[0]}]},{k:60});assert.equal(f.length,4);assert.equal(f.find(x=>x.identity===ids[0]).rrf,2/61);});
  await check('pre_mmr_lists_32_32_and_union_64_not_final_four',async()=>{const r=await many(await runtime(),72),d=dual(r),p=policy();const h=await d.searchHeuristic('pendant promise exact beacon anchor',r.all,r.snapshot,p);assert.equal(h.hits.length,32);assert.ok(h.trace.memory.scoredCount>=72);assert.equal(h.trace.memory.stage,'pre_mmr');const hIds=new Set(h.hits.map(x=>x.identity));const s={hits:r.all.filter(u=>!hIds.has(u.identity)).slice(0,32).map((u,i)=>({identity:u.identity,score:1-i*.001}))};const f=d.fuseRrf(h,s,{k:60});assert.equal(f.length,64);assert.equal(f.find(x=>x.identity===s.hits[0].identity).rrf,1/61);const selected=d.selectDiverse(f.map(x=>({...x,unit:r.all.find(u=>u.identity===x.identity)})),p);assert.ok(selected.items.length<=4);artifacts.push({case:'32-32',h,s,fused:f,selection:selected});});
 await check('semantic_only_independent_admission',async()=>{const r=await runtime(),d=dual(r),u=r.all[0],p=policy();const admission=d.admit({lane:'semantic',identity:u.identity,score:.95,query:'semantically related without exact lexical match',margin:.1},u,r.snapshot,p);assert.equal(admission.ok,true);const fused=d.fuseRrf({hits:[]},{hits:[{identity:u.identity,evidence:admission.evidence}]},{k:60});assert.equal(fused[0].rrf,1/61);});
 await check('confirmed_exclusion_never_waived_by_semantic_score',async()=>{const r=await runtime(),d=dual(r),u=r.all[0],p=policy();p.exclusions={identities:[u.identity]};const a=d.admit({lane:'semantic',identity:u.identity,score:1,query:'promise'},u,r.snapshot,p);assert.equal(a.ok,false);assert.equal(a.reason,'user_exclusion');});
 await check('no_answer_rank_one_does_not_bypass_admission',async()=>{const r=await runtime(),d=dual(r),u=r.all[0],p=policy();assert.equal(d.admit({lane:'semantic',identity:u.identity,score:.1,rank:1,query:'lunar reactor password'},u,r.snapshot,p).ok,false);const h=await d.searchHeuristic('qzx lunar reactor password nonexistent',r.all,r.snapshot,p);assert.equal(h.hits.length,0);});
 await check('calibration_required_no_unconfigured_cross_type_average',async()=>{const r=await runtime(),p=policy();delete p.calibration.world;const lane=await dual(r).searchHeuristic('promise',r.all,r.snapshot,p);assert.equal(lane.status,'degraded');assert.equal(lane.reason,'calibration_missing:world');assert.equal(lane.hits.length,0);});
 await check('type_starvation_and_candidate_missing_reasons_are_traced',async()=>{const r=await runtime(),d=dual(r),p=policy();p.exclusions={identities:r.all.filter(u=>u.family==='world').map(u=>u.identity)};const result=await d.retrieve('pendant promise',r.snapshot,null,p);assert.equal(result.trace.byType.world.selected,0);assert.ok(result.trace.byType.world.causes.includes('user_exclusion'));assert.equal(result.productionEligible,false);assert.equal(result.mode,'fixture');artifacts.push({case:'starvation',result});});
 await check('same_event_distinct_roles_survive_role_aware_mmr',async()=>{const r=await runtime(),d=dual(r),p=policy();p.diversity.maxItems=3;const units=['memory','world','narrative'].map(f=>r.all.find(u=>u.family===f));const rows=units.map((unit,i)=>({identity:unit.identity,rrf:.02-i*.0001,unit:{...unit,text:'same pendant oath event repeated',eventKeys:['turn:4']}}));const selected=d.selectDiverse(rows,p);assert.equal(selected.items.length,3);assert.deepEqual(new Set(selected.items.map(x=>x.unit.family)),new Set(['memory','world','narrative']));assert.ok(selected.trace.steps[1].redundancy<1);artifacts.push({case:'distinct-roles',selected});});
 await check('pre_mmr_matches_real_legacy_scoring_before_selection',async()=>{const r=await many(await runtime(),40);const query='pendant promise exact beacon anchor';const lane=await r.api.MemoryEngine.searchHeuristicCandidatesPreMmr(query,r.chat.localLore,{currentTurn:100,scopeKey:r.snapshot.scopeKey},32);assert.equal(lane.hits.length,32);assert.equal(lane.trace.scoredCount,40);assert.equal(lane.trace.stage,'pre_mmr');assert.ok(lane.hits.every((x,i)=>x.rank===i+1&&x.evidence.legacyAccepted));assert.ok(lane.hits.every((x,i,a)=>!i||a[i-1].rawScore>=x.rawScore));assert.equal(r.state.calls.length,0);});
 await check('semantic_lane_full_corpus_32_no_document_or_storage_write',async()=>{const r=await many(await runtime(),40),p=policy();const h=await r.index.open(r.snapshot,provider(),{...p,storage:{...p.storage,maxExpectedBytes:1048576}});const {record}=require('./libra_typed_recall_index_test.cjs');assert.equal((await r.index.publish(h,r.all.map(u=>record(r,u,provider())),r.snapshot)).ok,true);let sets=0;const save=r.storage.setItem;r.storage.setItem=async(k,v)=>{sets++;return save(k,v);};const result=await dual(r).retrieve('QUERY:pendant promise exact beacon anchor',r.snapshot,provider(),{...p,storage:{...p.storage,maxExpectedBytes:1048576}});assert.equal(result.trace.lanes.semantic.returned,32);assert.equal(r.state.calls.filter(x=>x.role==='query').length,1);assert.equal(r.state.calls.filter(x=>x.role==='document').length,0);assert.equal(sets,0);assert.ok(result.trace.union<=64);artifacts.push({case:'semantic-runtime',result});});
 await check('domain_suppression_does_not_cancel_typed_other_lane',async()=>{const r=await runtime(),d=dual(r),p=policy();p.memoryContext={suppressionPlan:{version:'libra.query_scope_guard.v1',suppressMemoryRecall:true,reason:'fixture_memory_domain'}};const h=await d.searchHeuristic(r.all.find(u=>u.family==='world').text,r.all,r.snapshot,p);assert.ok(h.hits.some(x=>x.family==='world'));assert.equal(h.trace.memory.scoredCount,0);});
 await check('stale_scope_hash_and_partial_provenance_not_admitted',async()=>{const r=await runtime(),d=dual(r),u=r.all[0],p=policy();assert.equal(d.admit({lane:'semantic',identity:u.identity,score:1}, {...u,contentHash:'stale'},r.snapshot,p).ok,false);assert.equal(d.admit({lane:'semantic',identity:u.identity,score:1},{...u,scopeKey:'foreign'},r.snapshot,p).ok,false);});
 await check('policy_unfrozen_results_are_fixture_shadow_only',async()=>{const r=await runtime(),d=dual(r),p=policy();p.mode='production';const result=await d.retrieve('promise',r.snapshot,null,p);assert.equal(result.productionEligible,false);assert.equal(result.selection.length,0);assert.equal(result.trace.reason,'policy_not_frozen');});
 await check('lane_duplicates_are_removed_before_actual_rank_assignment',async()=>{const r=await runtime(),d=dual(r),p=policy();const lane=await d.searchHeuristic('promise',[...r.all,...r.all],r.snapshot,p);assert.equal(new Set(lane.hits.map(x=>x.identity)).size,lane.hits.length);assert.ok(lane.hits.every((x,i)=>x.rank===i+1));});
 await check('type_quota_drops_do_not_erase_union_or_rrf_contribution',async()=>{const r=await runtime(),d=dual(r),p=policy();p.diversity.typeCaps={memory:0};const u=r.all[0],f=d.fuseRrf({hits:[]},{hits:[{identity:u.identity}]},{k:60});const selected=d.selectDiverse(f.map(x=>({...x,unit:u})),p);assert.equal(f[0].rrf,1/61);assert.equal(selected.items.length,0);assert.ok(selected.trace.drops.some(x=>x.reason==='type_quota'));});
 await check('semantic_admission_before_32_cutoff_preserves_lower_eligible_type',async()=>{const r=await runtime(),world=clone(r.chat.localLore.find(x=>x.comment==='lmai_world_graph'));await many(r,40);r.chat.localLore.push(world);r.snapshot=r.snap({currentTurn:100});r.all=r.corpus.enumerate(r.snapshot).filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);const p=policy();p.storage.maxExpectedBytes=1048576;p.exclusions={identities:r.all.filter(u=>u.family==='memory').map(u=>u.identity)};const h=await r.index.open(r.snapshot,provider(),p);const {record}=require('./libra_typed_recall_index_test.cjs');assert.equal((await r.index.publish(h,r.all.map(u=>record(r,u,provider())),r.snapshot)).ok,true);const result=await dual(r).retrieve('QUERY:semantically retrieve world',r.snapshot,provider(),p);assert.equal(result.trace.lanes.semantic.returned,2);assert.ok(result.selection.every(x=>x.unit.family==='world'));artifacts.push({case:'semantic-prefilter-cutoff',result});});
 await check('coordinator_discards_heuristic_selection_after_midflight_generation_change',async()=>{const r=await runtime(),p=policy(),query='QUERY:'+r.all.find(u=>u.family==='world').text;await r.jobs.backfill(r.snapshot,provider(),p,{explicit:true,budget:budget()});r.state.blockQuery=true;const pending=dual(r).retrieve(query,r.snapshot,provider(),p);await flush();assert.equal(r.state.pending.length,1);await r.jobs.onPersist(r.snapshot,r.snap({currentTurn:11}),provider(),p);r.state.pending.splice(0).forEach(f=>f());const result=await pending;assert.equal(result.selection.length,0);assert.equal(result.trace.reason,'request_invalidated');});
 await check('canonical_locator_family_and_subtype_are_checked_at_admission',async()=>{const r=await runtime(),u=r.all.find(u=>u.family==='entity'),p=policy();assert.equal(dual(r).admit({identity:u.identity,lane:'semantic',score:1},{...u,locator:{...u.locator,id:'forged'}},r.snapshot,p).ok,false);});
 await check('pre_mmr_wrapper_never_embeds_even_when_context_requests_it',async()=>{const r=await many(await runtime(),40);const result=await r.api.MemoryEngine.searchHeuristicCandidatesPreMmr('pendant promise',r.chat.localLore,{currentTurn:100,embeddingAllowed:true},32);assert.equal(result.trace.stage,'pre_mmr');assert.equal(r.state.calls.length,0);});
 await check('typed_memory_admission_precedes_depth_32_and_keeps_rank_33',async()=>{
  const r=await many(await runtime(),40),d=dual(r),p=policy(),query='pendant promise exact beacon anchor';
  const initial=await r.api.MemoryEngine.searchHeuristicCandidatesPreMmr(query,r.chat.localLore,{currentTurn:100,scopeKey:r.snapshot.scopeKey},32);
  p.exclusions={identities:initial.hits.map(x=>r.all.find(u=>u.entry.key===x.entry.key).identity)};
  const byKey=new Map(r.all.map(u=>[u.entry.key,u]));
  const lane=await r.api.MemoryEngine.searchHeuristicCandidatesPreMmr(query,r.chat.localLore,{currentTurn:100,scopeKey:r.snapshot.scopeKey,
   __typedPreMmrAdmission:hit=>{const u=byKey.get(hit.entry.key);return d.admit({identity:u.identity,lane:'heuristic',score:hit.rawScore,evidence:hit.evidence,query},u,r.snapshot,p);}},32);
  assert.equal(lane.hits.length,8);assert.ok(lane.hits.every(x=>!p.exclusions.identities.includes(byKey.get(x.entry.key).identity)));
  assert.ok(lane.hits.every((x,i)=>x.rank===i+1));assert.equal(lane.trace.typedRejected.length,32);assert.equal(lane.trace.scoredCount,40);
  assert.equal(lane.trace.returnDepth,32);assert.ok(lane.trace.detailCandidateBound>=40);artifacts.push({case:'typed-memory-cutoff',initial,lane});
 });
 for(const field of ['text','locator'])await check('tampered_first_duplicate_'+field+'_does_not_hide_valid_canonical',async()=>{
  const r=await runtime(),p=policy(),u=r.all.find(x=>x.family==='entity'),bad={...u,[field]:field==='text'?'forged first text':{...u.locator,id:'forged'}};
  const h=await dual(r).searchHeuristic(u.text,[bad,u],r.snapshot,p);assert.equal(h.hits.length,1);assert.equal(h.hits[0].identity,u.identity);
  assert.equal(h.hits[0].rank,1);assert.ok(h.trace.drops.some(x=>x.reason==='stale_canonical'));artifacts.push({case:'duplicate-'+field,h});
 });
 await check('public_rrf_normalizes_duplicates_before_depth_and_contiguous_ranks',async()=>{
  const r=await runtime(),d=dual(r),a=r.all[0].identity,b=r.all[1].identity;
  for(const hits of [[{identity:a},{identity:a},{identity:b}],[...Array.from({length:33},()=>({identity:a})),{identity:b}]]){
   const f=d.fuseRrf({hits},{hits:[]},{k:60});assert.equal(f.length,2);assert.equal(f.find(x=>x.identity===b).ranks.heuristic,2);assert.equal(f.find(x=>x.identity===b).rrf,1/62);
  }
 });
 await check('semantic_positive_lexical_requirement_is_explicit_lane_violation',async()=>{
  const r=await runtime(),u=r.all[0],p=policy();p.admission[u.family].semanticMinLexicalOverlap=1;
  const verdict=dual(r).admit({lane:'semantic',identity:u.identity,score:1,query:u.text,margin:.1},u,r.snapshot,p);
  assert.equal(verdict.ok,false);assert.equal(verdict.reason,'semantic_lexical_gate_forbidden');
 });
 await check('semantic_lexical_zero_answer_needs_only_validity_cosine_margin',async()=>{
  const r=await runtime(),u=r.all[0],p=policy();delete p.admission[u.family].semanticMinLexicalOverlap;
  const candidate={lane:'semantic',identity:u.identity,score:.95,query:'qzx vvv untranslated counterpart',margin:.1};
  const verdict=dual(r).admit(candidate,u,r.snapshot,p);assert.equal(verdict.ok,true);assert.equal(verdict.evidence.lexicalOverlap,0);
  assert.equal(dual(r).admit({...candidate,score:.1},u,r.snapshot,p).reason,'semantic_threshold');
  p.admission[u.family].semanticMinMargin=.2;assert.equal(dual(r).admit(candidate,u,r.snapshot,p).reason,'semantic_margin');
 });
 await check('new_query_same_state_supersedes_old_selected_result_without_background_generation',async()=>{
  const r=await runtime(),p=policy(),q='QUERY:'+r.all.find(u=>u.family==='world').text;await r.jobs.backfill(r.snapshot,provider(),p,{explicit:true,budget:budget()});
  r.state.blockQuery=true;const a=dual(r).retrieve(q,r.snapshot,provider(),p);await flush();assert.equal(r.state.pending.length,1);
  const newer=r.snap();assert.equal(newer.corpusRevision,r.snapshot.corpusRevision);assert.equal(newer.currentTurn,r.snapshot.currentTurn);assert.ok(newer.requestGeneration>r.snapshot.requestGeneration);
  const b=dual(r).retrieve(q+' second request',newer,provider(),p);await flush();r.state.blockQuery=false;r.state.pending.splice(0).forEach(f=>f());
  const old=await a,fresh=await b;assert.equal(old.selection.length,0);assert.equal(old.trace.reason,'request_invalidated');assert.ok(fresh.selection.length>0);
  artifacts.push({case:'request-nonce',old,fresh});
 });
 await check('standalone_semantic_search_same_snapshot_new_query_discards_old_hits',async()=>{
  const r=await runtime();await r.jobs.backfill(r.snapshot,provider(),policy(),{explicit:true,budget:budget()});r.state.blockQuery=true;
  const a=r.engine.search('QUERY:first request',r.snapshot,provider(),{policy:policy()});await flush();
  const b=r.engine.search('QUERY:second request',r.snapshot,provider(),{policy:policy()});await flush();r.state.blockQuery=false;r.state.pending.splice(0).forEach(f=>f());
  assert.equal((await a).hits.length,0);assert.ok((await b).hits.length>0);
 });
 await check('canonical_recapture_is_not_new_query_or_background_cancellation',async()=>{
  const r=await runtime(),p=policy();await r.jobs.backfill(r.snapshot,provider(),p,{explicit:true,budget:budget()});r.state.blockQuery=true;
  const a=dual(r).retrieve('QUERY:'+r.all.find(u=>u.family==='world').text,r.snapshot,provider(),p);await flush();
  const refreshed=r.snap();const report=await r.jobs.onPersist(r.snapshot,refreshed,provider(),p);assert.equal(report.calls,0);assert.equal(report.written,0);
  r.state.blockQuery=false;r.state.pending.splice(0).forEach(f=>f());assert.ok((await a).selection.length>0);
 });
 await check('same_family_distinct_source_roles_keep_evidence_and_explicit_drop_trace',async()=>{
  const r=await runtime(),d=dual(r),p=policy(),base=r.all[0];p.diversity.maxItems=2;
  const rows=['past_evidence','current_action'].map((role,i)=>({identity:JSON.stringify([r.snapshot.scopeKey,'memory','entry','role-'+i]),rrf:.02-i*.0001,
   unit:{...base,identity:JSON.stringify([r.snapshot.scopeKey,'memory','entry','role-'+i]),text:'same promise event',roles:[role],sourceRefs:['source-'+i],record:{...base.record,arcKey:'same-event'}}}));
  const both=d.selectDiverse(rows,p);assert.equal(both.items.length,2);assert.equal(both.trace.steps[1].redundancy,.2);
  assert.deepEqual(Array.from(both.trace.steps,x=>Array.from(x.sourceRefs)),[['source-0'],['source-1']]);
  p.diversity.maxPerArc=1;const capped=d.selectDiverse(rows,p);assert.equal(capped.items.length,1);const drop=capped.trace.drops.find(x=>x.identity===rows[1].identity);
  assert.equal(drop.reason,'arc_quota');assert.deepEqual(Array.from(drop.roles),['current_action']);assert.deepEqual(Array.from(drop.sourceRefs),['source-1']);
  artifacts.push({case:'same-family-source-roles',both,capped});
 });
 await check('starting_queries_does_not_cancel_document_backfill',async()=>{
  const r=await runtime(),p=policy();r.state.blockDoc=true;
  const fill=r.jobs.backfill(r.snapshot,provider(),p,{explicit:true,budget:budget()});await flush();assert.equal(r.state.pending.length,1);
  await r.engine.search('QUERY:one',r.snapshot,provider(),{policy:p});await r.engine.search('QUERY:two',r.snapshot,provider(),{policy:p});
  r.state.blockDoc=false;r.state.pending.splice(0).forEach(f=>f());const report=await fill;assert.equal(report.ok,true);assert.equal(report.written,r.all.length);
 });
 await check('same_query_new_request_does_not_reuse_superseded_query_result',async()=>{
  const r=await runtime(),p=policy(),query='QUERY:'+r.all.find(u=>u.family==='world').text;await r.jobs.backfill(r.snapshot,provider(),p,{explicit:true,budget:budget()});r.state.blockQuery=true;
  const a=dual(r).retrieve(query,r.snapshot,provider(),p);await flush();const b=dual(r).retrieve(query,r.snapshot,provider(),p);await flush();
  r.state.blockQuery=false;r.state.pending.splice(0).forEach(f=>f());assert.equal((await a).selection.length,0);assert.ok((await b).selection.length>0);
  assert.equal(r.state.calls.filter(x=>x.role==='query').length,2);
 });
 finish();
}
function finish(){const out=path.resolve(__dirname,'../test-output/typed-recall/task4');fs.mkdirSync(out,{recursive:true});const summary={passed:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,results,realModelCalls:0};fs.writeFileSync(path.join(out,(process.env.RECALL_TEST_PHASE||'fusion')+'-results.json'),JSON.stringify(summary,null,2));fs.writeFileSync(path.join(out,(process.env.RECALL_TEST_PHASE||'fusion')+'-raw.json'),JSON.stringify(artifacts,null,2));console.log(JSON.stringify({passed:summary.passed,failed:summary.failed}));process.exitCode=summary.failed?1:0;}
main().catch(e=>{console.error(e);process.exitCode=1});
module.exports={policy};
