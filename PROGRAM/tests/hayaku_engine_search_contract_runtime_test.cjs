'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}});try{
const t=h.hayaku._test,s={...h.hayaku.settings(),maxItemsPerAxis:12},p=createValidPacket({turn:7});
p.meta.speaker_boundaries=[{id:'boundary-x',summary:'Boundary marker quartz_only'}];p.meta.overpromotion_risks=[{id:'risk-x',summary:'Risk marker indigo_only'}];p.meta.consent_memory={limits:['Limit marker copper_only']};
p.world.world_rules=[{id:'rule-a',summary:'amber'},{id:'rule-b',summary:'violet',resolves:['rule-a'],relatedRefs:['rule-a'],fulfilled_by:['rule-a'],links:{causesRefs:['rule-a']}}];
const packet={hash:'contract-source',raw:JSON.stringify(p),messageIndex:13,worldlineOrdinal:7},original=JSON.stringify(packet),store=t.emptyStore();
t.ingestPacket(store,packet.raw,packet.hash,{messageIndex:13,worldlineOrdinal:7});t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+10000});
const engineRule=store.index.find(r=>r.id==='rule-b');await t.localRecallPrepareSources([packet],store,s,'contract-scope',Date.now()+10000);
for(const marker of ['quartz_only','indigo_only','copper_only']){
 assert.ok(store.index.some(r=>JSON.stringify(r).includes(marker)));
 assert.ok(store._recallSourceRows.some(r=>r.publicText.includes(marker)));
 const selected=await t.searchIndexCompositeRecall(store,marker,s);const plan=t.selectHayakuEvidencePlan(selected,marker,s,15000);
 assert.ok(plan.text.includes(marker),'Supported metadata reaches delivered evidence');
}
const rule=store._recallSourceRows.find(r=>r.id==='rule-b');
for(const field of ['resolvesRefs','relatedRefs','fulfilledByRefs','causesRefs'])assert.deepEqual(Array.from(rule.links[field]),Array.from(engineRule.links[field]));
const linked=t.localRecallExpand(store._recallSourceRows,[rule],{...s,hierarchicalEpisodeMemoryEnabled:false});assert.ok(linked.some(r=>r.id==='rule-a'));
assert.equal(rule.locator.sourcePairIndex,7);assert.equal(rule.locator.turnAnchor,p.meta.turn_anchor);
await t.localRecallPrepareSources([{...packet,worldlineOrdinal:9}],store,s,'contract-scope',Date.now()+10000);assert.equal(store._recallSourceRows.find(r=>r.id==='rule-b').locator.sourcePairIndex,9);
const unknown=t.localRecallRowsFromPacket({raw:packet.raw,messageIndex:13},'unknown').find(r=>r.id==='rule-b');assert.equal(unknown.locator.sourcePairIndex,null);
const unknownPlan=t.selectHayakuEvidencePlan(t.prepareHayakuRecallRows([unknown],'violet',s,{},[],[]),'violet',s,4000);assert.ok(unknownPlan.text.includes('"at":null'));assert.ok(unknownPlan.text.includes('"messageIndex":13'));
const camel=JSON.parse(packet.raw);camel.meta.speakerBoundaries=camel.meta.speaker_boundaries;delete camel.meta.speaker_boundaries;camel.meta.consentMemory=camel.meta.consent_memory;delete camel.meta.consent_memory;
const aliases=t.localRecallRowsFromPacket({raw:JSON.stringify(camel),targetPairIndex:5},'camel');assert.ok(aliases.some(r=>r.category==='speaker_boundary'));assert.ok(aliases.some(r=>r.category==='consent_memory'));
assert.equal(JSON.stringify(packet),original);assert.equal(h.llmCalls.length,0);console.log('hayaku_engine_search_contract_runtime_test: PASS');
}finally{h.dispose();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
