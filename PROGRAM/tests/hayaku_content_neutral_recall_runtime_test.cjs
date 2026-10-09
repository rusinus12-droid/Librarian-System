'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
(async()=>{const h=await createHayakuRuntime({autoRepair:false,arguments:{memory_suite_server_mode:'plugin_only'}});try{
const t=h.hayaku._test,s={...h.hayaku.settings(),mode:'auto',effectiveMode:'balanced'};
const queries=['Where is the archive?','과거의 비밀과 약속을 비교해.','彼女の性格を説明して。','Continue.','opaque-8391'];
const messages=[{role:'user',content:'A record.'},{role:'assistant',content:'An answer.'}];
const packets=Array.from({length:80},(_,i)=>({hash:'p'+i,messageIndex:i,raw:JSON.stringify(createValidPacket({turn:i+1}))}));
const selection=q=>Array.from(t.selectPacketsForIngest(packets,q,s).packets,p=>[p.hash,p.lightweightIngest]);
const reference=selection(queries[0]),mode=t.resolvePerformanceMode(s,messages,queries[0]).mode;
for(const q of queries){assert.deepEqual(selection(q),reference,'Projection selection depends on chronology and limits, not story words');assert.equal(t.resolvePerformanceMode(s,messages,q).mode,mode);const sig=t.buildRetrievalQuerySignature(t.emptyStore(),q,s);assert.equal(sig.rawQuery,q);assert.deepEqual(Array.from(sig.conceptTokens),[]);assert.ok(Object.values(sig.axisWeights).every(v=>v===1));}
const row=(id,body)=>({id,publicRef:id,axis:'narrative',category:'active_event',publicText:body,packetHash:id,scene_id:'scene',links:{},retrieval:{},locator:{sourcePairIndex:1}});
const a=row('a','A promise was made at the bridge.'),b=row('b','The promise at the bridge was fulfilled because the mission ended.');
const original=JSON.stringify([a,b]);
const inferred=t.attachUnifiedMemoryAssociations([a,b],{turn:2},s);
const edges=rows=>Array.from(rows).flatMap(row=>Array.from(row.retrieval?.unifiedAssociations||[]));
assert.ok(edges(inferred).length>0,'Shared source scene is a navigation connection');assert.ok(edges(inferred).every(edge=>!edge.inferred&&!edge.typed));
const explicit=t.attachUnifiedMemoryAssociations([a,{...b,links:{resolvesRefs:['a']}}],{turn:2},s);
assert.ok(edges(explicit).some(edge=>edge.explicit&&edge.typedTypes.includes('RESOLVES')),'Stored resolution references survive');
assert.equal(JSON.stringify([a,b]),original);
const source=row('source','violet records'),store={...t.emptyStore(),index:[],_recallSourceRows:[source]};
const viaApi=t.searchIndexSparseHybrid(store,'violet',s);
assert.ok(viaApi.narrative.some(row=>row.id==='source'),'Compatibility search preserves the prepared source corpus');
assert.equal(h.llmCalls.length,0);console.log('hayaku_content_neutral_recall_runtime_test: PASS');
}finally{h.dispose();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});

