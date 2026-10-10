'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}});try{
 const t=h.hayaku._test,s={...h.hayaku.settings(),maxItemsPerAxis:12,retrievalCurrentQuery:'quartzneedle720',hierarchicalEpisodeMemoryEnabled:false};
 const packets=Array.from({length:600},(_,i)=>{const p=createValidPacket({turn:i+1});p.world.world_rules=[{id:'record-'+i,summary:'Routine archived entry '+i}];return {raw:JSON.stringify(p),hash:'scale-source-'+i,messageIndex:i*2+1,worldlineOrdinal:i+1};});
 const change=(index,rule)=>{const p=JSON.parse(packets[index].raw);p.world.world_rules=[rule];packets[index].raw=JSON.stringify(p);};
 change(480,{id:'seed-id',summary:'quartzneedle720',causes:['remote-reference-420']});
 change(420,{id:'remote-reference-420',summary:'Independent cobalt detail'});
 change(350,{id:'context-id',summary:'fuchsia_anchor881'});
 change(210,{id:'later-id',summary:'heliotrope_reference990'});
 const original=JSON.stringify(packets),store={index:[],context:{}},began=Date.now();
 // Hold the plugin clock during this throughput-independent routing contract.
 // Production still has its 150 ms cap; the expired-deadline case below checks it.
 // A host-past deadline also proves the injected VM clock is the one the router reads.
 const originalDate=h.context.Date;const fixedNow=Date.now()-60000;
 h.context.Date=class extends Date { static now(){return fixedNow;} };
 let cold;try{cold=await t.localRecallPrepareSources(packets,store,{...s,retrievalRecentContext:{topics:['fuchsia_anchor881']}},'scale-scope',fixedNow+10000);}
 finally{if(originalDate===undefined)delete h.context.Date;else h.context.Date=originalDate;}
 const ids=store._recallSourceRows.map(r=>r.id);
 assert.ok(ids.includes('seed-id'),'First request prepares a hit far beyond the sequential parse cap');
 assert.ok(ids.includes('context-id'),'Recent context supplies a separate cold-source candidate');
 assert.ok(ids.includes('remote-reference-420'),'Unprepared declared target can consume reserved read capacity');
 assert.ok(cold.processedThisRequest<=64);assert.equal(cold.complete,false);
 assert.equal(cold.routing.scanned,packets.length,'the frozen-clock pass routes the full 600-source corpus');
 assert.equal(cold.routing.pending,0);assert.equal(cold.routing.complete,true);
 const candidates=t.localRecallCandidates(store,s.retrievalCurrentQuery,s);assert.ok(candidates.some(r=>r.id==='seed-id'));assert.ok(candidates.some(r=>r.id==='remote-reference-420'));
 const warm=await t.localRecallPrepareSources(packets,store,{...s,retrievalCurrentQuery:'heliotrope_reference990'},'scale-scope',Date.now()+10000);assert.ok(store._recallSourceRows.some(r=>r.id==='later-id'));
 const expired=await t.localRecallPrepareSources(packets,{index:[],context:{}},s,'expired-scope',0);assert.equal(expired.processedThisRequest,0);assert.equal(expired.routing.complete,false);assert.ok(expired.routing.pending>0);
 const fresh={index:[],context:{}};await t.localRecallPrepareSources([packets[210]],fresh,s,'scale-scope',Date.now()+1000);assert.ok(fresh._recallSourceRows.every(r=>r.packetHash===packets[210].hash),'Old routed packets cannot survive a new accepted list');
 const duplicateRows=Array.from({length:6},(_,i)=>({id:'duplicate-'+i,publicRef:'duplicate-'+i,packetHash:'copy-'+i,axis:'world',category:'world_rule',publicText:'The identical archive rule.',score:1,visibility:{privacy:'public'},locator:{sourcePairIndex:3,messageIndex:5}}));
 const plan=t.selectHayakuEvidencePlan(t.prepareHayakuRecallRows(duplicateRows,'archive',s,{},[],[]),'archive',s,8000);
 assert.equal(plan.renderedEntries,1);assert.equal(plan.deliveredSources.length,6);assert.equal((plan.text.match(/\[sources /g)||[]).length,1);
 for(let i=0;i<6;i++)assert.ok(plan.text.includes('copy-'+i));
 assert.equal(JSON.stringify(packets),original);assert.equal(h.llmCalls.length,0);
 console.log(JSON.stringify({test:'hayaku_source_routing_scale_runtime',packets:600,coldParsed:cold.processedThisRequest,routed:cold.routing.scanned,linkedReads:cold.linkedReads,warmParsed:warm.processedThisRequest,elapsedMs:Date.now()-began,mergedChars:plan.text.length,modelCalls:0}));
 }finally{h.dispose();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
