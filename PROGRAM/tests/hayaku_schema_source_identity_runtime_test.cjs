'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const h=await createHayakuRuntime({autoRepair:false});
try{
 const t=h.hayaku._test,s={...h.hayaku.settings(),hierarchicalEpisodeMemoryEnabled:false,retrievalRecentContext:{topics:[]}};
 const cases=[['entity','characters','character'],['entity','relations','relation'],
 ['world','active_events','active_event'],['world','historical_events','historical_event'],['world','world_rules','world_rule'],['world','factions','faction'],['world','regions','region'],['world','offscreen_threads','offscreen_thread'],
 ['narrative','conflict_traces','conflict_trace'],['narrative','scene_deltas','scene_delta'],['narrative','theme_motifs','theme_motif'],['narrative','critical_dialogue','critical_dialogue'],
 ['planner','continuity_locks','continuity_lock'],['planner','do_not_resolve_yet','do_not_resolve_yet'],['planner','consequence_ledger','consequence'],['planner','payoff_tracker','payoff'],['planner','open_invitations','open_invitation']];
 const aliasCases=[['entity','people','character'],['entity','character','character'],['entities','characters','character'],['entity','relationships','relation'],['world','worldRules','world_rule'],['world','activeEvents','active_event'],['narrative','sceneDeltas','scene_delta'],['planner','payoffTracker','payoff']];
 const results=[];
 for(const mode of ['id','anonymous','publicRef'])for(const [axis,field,category] of [...cases,...(mode==='id'?aliasCases:[])]){
  const marker='copper lantern stored underneath the staircase',query='琥珀灯台';
  const p=createValidPacket();
  for(const ax of ['entity','world','narrative','planner'])p[ax]={};
  const item={name:'AuditSubject',summary:marker,current_state:marker,text:marker,from:'AuditSubject',to:'OtherSubject'};
  if(mode==='id')item.id='row-identifier';
  if(mode==='publicRef')item.publicRef=axis+'.'+category+'.explicit-row';
  (p[axis]||=( {} ))[field]=[item];
  const engine=t.emptyStore();t.ingestPacket(engine,JSON.stringify(p),'engine-input',{messageIndex:1});t.rebuildIndex(engine,{settings:s,deadlineAt:Date.now()+2000});
  const canonical=engine.index.find(r=>r.category===category&&r.publicText.includes(marker));
  if(!canonical){results.push({axis,field,category,mode,engineAccepted:false});continue;}
  const seed=createValidPacket();for(const axis of ['entity','world','narrative','planner'])seed[axis]={}; seed.world.world_rules=[{id:'query-seed',summary:query,depends_on:[canonical.publicRef]}];
  const original=JSON.stringify(p),rows=t.localRecallRowsFromPacket({raw:original,messageIndex:1,targetPairIndex:1},'engine-input').concat(t.localRecallRowsFromPacket({raw:JSON.stringify(seed),messageIndex:3,targetPairIndex:2},'query-source'));
  const target=rows.find(r=>r.locator?.field===axis+'.'+field+'.0');
  const candidates=t.localRecallCandidates({index:[],_recallSourceRows:rows},query,s);
  const plan=t.selectHayakuEvidencePlan(t.prepareHayakuRecallRows(candidates,query,s,{},[],[]),query,s,15000);
  results.push({axis,field,category,mode,engineAccepted:true,engineId:canonical.id,engineRef:canonical.publicRef,sourceCategory:target?.category||null,sourceRefs:target?._recallIdentityRefs||[],sourceHasTarget:!!target,aliasResolved:!!target?._recallIdentityRefs?.includes(canonical.publicRef),candidateHasTarget:candidates.some(r=>r.publicText.includes(marker)),finalHasTarget:plan.text.includes(marker),sourceUnchanged:JSON.stringify(p)===original});
 }
 const report={total:results.length,accepted:results.filter(r=>r.engineAccepted).length,missingAliases:results.filter(r=>r.engineAccepted&&!r.aliasResolved).length,missingFinal:results.filter(r=>r.engineAccepted&&!r.finalHasTarget).length,modelCalls:h.llmCalls.length,results};
 assert.equal(report.missingAliases,0);assert.equal(report.missingFinal,0);assert.ok(report.results.every(r=>r.sourceUnchanged));console.log('hayaku_schema_source_identity_runtime_test: PASS');
}finally{h.dispose();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});

