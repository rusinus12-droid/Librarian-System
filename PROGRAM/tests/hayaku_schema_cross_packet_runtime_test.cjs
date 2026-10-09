'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const h=await createHayakuRuntime({autoRepair:false});try{
 const t=h.hayaku._test,s={...h.hayaku.settings(),hierarchicalEpisodeMemoryEnabled:true,retrievalRecentContext:{topics:[]}},results=[];
 const packet=(id,turn)=>{const p=createValidPacket({turn,scene:id});for(const axis of ['entity','world','narrative','planner'])p[axis]={};return p;};
 for(const [axis,field,category] of [['world','factions','faction'],['planner','payoff_tracker','payoff'],['entity','people','character'],['world','world_rules','world_rule']]){
  const marker='copper lantern stored underneath the staircase',query='琥珀灯台',p=packet('target',1);
  p[axis][field]=[{id:'target-row',name:'AuditSubject',summary:marker,current_state:marker}];
  const first=t.emptyStore();t.ingestPacket(first,JSON.stringify(p),'target',{messageIndex:1});t.rebuildIndex(first,{settings:s,deadlineAt:Date.now()+2000});
  const engineRow=first.index.find(r=>r.category===category&&r.publicText.includes(marker));
  const middle=packet('middle',2);middle.world.world_rules=Array.from({length:10},(_,i)=>({id:'unrelated-'+i,summary:'Separate notes from another scene '+i}));
  const latest=packet('latest',3);latest.world.world_rules=[{id:'seed',summary:query,depends_on:[engineRow.publicRef]}];
  const sources=[p,middle,latest].map((value,i)=>({raw:JSON.stringify(value),hash:'cross-'+field+'-'+i,messageIndex:i*2+1,targetPairIndex:i+1}));
  const store=t.emptyStore();for(const source of sources)t.ingestPacket(store,source.raw,source.hash,{messageIndex:source.messageIndex});
  t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+3000});
  const canonical=t.selectHayakuEvidencePlan(await t.searchIndexCompositeRecall(store,query,s),query,s,15000);
  const original=JSON.stringify(sources);await t.localRecallPrepareSources(sources,store,{...s,retrievalCurrentQuery:query},'cross-'+field,Date.now()+5000);
  const source=t.selectHayakuEvidencePlan(await t.searchIndexCompositeRecall(store,query,s),query,s,15000);
  results.push({axis,field,category,engineRef:engineRow.publicRef,hierarchicalExpansion:true,canonicalFinalHasTarget:canonical.text.includes(marker),sourceFinalHasTarget:source.text.includes(marker),coverage:store._recallSourceCoverage,packetsUnchanged:JSON.stringify(sources)===original});
 }
 const report={results,modelCalls:h.llmCalls.length};assert.ok(report.results.every(r=>r.canonicalFinalHasTarget&&r.sourceFinalHasTarget&&r.packetsUnchanged));console.log('hayaku_schema_cross_packet_runtime_test: PASS');
}finally{h.dispose();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
