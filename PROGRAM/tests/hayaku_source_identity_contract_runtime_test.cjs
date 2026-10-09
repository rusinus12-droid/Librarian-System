'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}});let cases=0;
try{
 const t=h.hayaku._test,s={...h.hayaku.settings(),hierarchicalEpisodeMemoryEnabled:false,retrievalRecentContext:{topics:[]}};
 const variants=[{name:'Mira'},{name:'소연'},{name:'カナ'},{name:'Ilyan',id:'person-record'},
  {name:'Ren',ref:'entity.character.ren'},{name:'Nora',publicRef:'entity.character.nora'},
  {name:'Elan',_public:{ref:'entity.character.elan'}},{name:'Tarin',ref:'legacy-person-reference',id:'legacy-person-id'}];
 for(const [i,value] of variants.entries()){
  const p=createValidPacket({subject:value.name});
  p.entity.characters=[{...value,current_state:'wearing a tangerine coat'}, {name:'Other Person',current_state:'holding a ledger'}];
  const originalRaw=JSON.stringify(p); const engine=t.emptyStore();t.ingestPacket(engine,JSON.stringify(p),'initial-'+i,{messageIndex:1});t.rebuildIndex(engine,{settings:s,deadlineAt:Date.now()+1000});
  const canonical=engine.index.find(r=>r.category==='character'&&r.publicText.includes(value.name));assert.ok(canonical);
  const query='琥珀灯塔';p.world.world_rules=[{id:'link-'+i,summary:query,depends_on:[canonical.publicRef]}];
  for(const reversed of [false,true]){
   if(reversed)p.entity.characters.reverse();
   const packet={raw:JSON.stringify(p),messageIndex:1,targetPairIndex:1},before=JSON.stringify(packet);
   const rows=t.localRecallRowsFromPacket(packet,'source-'+i).concat(t.localRecallRowsFromPacket({raw:originalRaw,messageIndex:1,targetPairIndex:1},'initial-'+i)),target=rows.find(r=>r.category==='character'&&r.publicText.includes(value.name));
   assert.ok(rows.some(row=>row.publicText.includes(value.name)&&row._recallIdentityRefs?.includes(canonical.publicRef)),'Existing source references survive a reordered new revision without guessing anonymous identity');
   const candidates=t.localRecallCandidates({index:[],_recallSourceRows:rows},query,s);
   assert.ok(candidates.some(r=>r.category==='character'&&r.publicText.includes(value.name)));
   assert.ok(!candidates.some(r=>r.category==='character'&&r.publicText.includes('Other Person')),'Identity expansion cannot substitute another array member');
   const selected=t.prepareHayakuRecallRows(candidates,query,s,{},[],[]),plan=t.selectHayakuEvidencePlan(selected,query,s,15000);
   assert.ok(plan.text.includes('tangerine coat'),'Referenced character reaches final injection');
   assert.equal(JSON.stringify(packet),before,'Identity aliases do not rewrite source');cases++;
  }
 }
 // Explicit record IDs and public references remain alternate addresses, not replacements.
 const p=createValidPacket();p.world.world_rules=[{id:'rule-id',publicRef:'world.world_rule.rule-ref',summary:'first'},{id:'seed',summary:'second',depends_on:['rule-id','world.world_rule.rule-ref']}];
 const rows=t.localRecallRowsFromPacket({raw:JSON.stringify(p)},'refs'),seed=rows.find(r=>r.id==='seed');
 assert.equal(t.localRecallExpand(rows,[seed],s).filter(r=>r.id==='rule-id').length,1);cases++;
 const restricted=createValidPacket({subject:'Mira'});restricted.entity.characters[0].visibility='private';
 restricted.world.world_rules=[{id:'public-seed',summary:'琥珀灯塔',depends_on:['entity.character.mira']}];
 const restrictedRows=t.localRecallRowsFromPacket({raw:JSON.stringify(restricted)},'restricted');
 const publicCandidates=t.localRecallCandidates({index:[],_recallSourceRows:restrictedRows},'琥珀灯塔',s);
 assert.ok(!publicCandidates.some(r=>r.category==='character'),'Reference aliases cannot bypass knowledge visibility');cases++;
 assert.equal(h.llmCalls.length,0);console.log(JSON.stringify({test:'hayaku_source_identity_contract',passed:cases,modelCalls:0}));
}finally{h.dispose();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});

