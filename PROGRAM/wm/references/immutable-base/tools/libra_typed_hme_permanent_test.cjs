'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),crypto=require('node:crypto');
const {fixture,policy}=require('./libra_typed_graph_discovery_test.cjs');
const {runtime,provider}=require('./libra_typed_recall_queue_test.cjs');
const {record}=require('./libra_typed_recall_index_test.cjs');
const graphKeys=r=>[...r.store.keys()].filter(key=>key.endsWith(':typed-graph'));
const retrieve=r=>r.context.__QUEUE_TEST__.dual.retrieve('ORBITSEED',r.snap({viewerId:'main_request'}),null,policy());
test('typed HME persists once and unchanged warm requests reuse it without rebuilding nodes',async()=>{
 const r=await fixture('narrative'),first=await retrieve(r);
 assert(first.selection.some(x=>x.identity===r.target.identity));
 assert.equal(graphKeys(r).length,1,'canonical source graph must be stored outside lore');
 const stored=r.store.get(graphKeys(r)[0]),second=await retrieve(r),m=second.trace.lanes.heuristic.trace.graph.maintenance;
 assert.equal(m.mode,'reused');assert.equal(m.rebuiltNodes,0);assert.equal(r.store.get(graphKeys(r)[0]),stored);
 assert.equal(r.state.calls.length,0);
});
test('stored graph survives runtime restart; a same-ID source edit and deletion invalidate it',async()=>{
 const r=await fixture('entity');await retrieve(r);
 assert.equal(graphKeys(r).length,1);
 const restarted=await runtime({store:r.store,cache:r.cache,lore:r.chat.localLore},{admittedHost:true});
 restarted.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 const restored=await retrieve(restarted);assert.equal(restored.trace.lanes.heuristic.trace.graph.maintenance.mode,'restored');
 assert(restored.selection.some(x=>x.identity===r.target.identity));
 const e=restarted.chat.localLore.find(x=>x.comment==='lmai_entity'),obj=JSON.parse(e.content);
 obj.name='DifferentUnlinkedPerson';e.content=JSON.stringify(restarted.signed(obj,'entity','target'));
 const edited=await retrieve(restarted);assert(!edited.selection.some(x=>x.identity===r.target.identity));
 assert.equal(edited.trace.lanes.heuristic.trace.graph.maintenance.sourceChanges,1);
 assert.equal(edited.trace.lanes.heuristic.trace.graph.maintenance.rebuiltNodes,1,'unchanged memory node remains reused');
 restarted.chat.localLore=restarted.chat.localLore.filter(x=>x.comment!=='lmai_entity');
 const deleted=await retrieve(restarted);assert(!deleted.selection.some(x=>x.identity===r.target.identity));
 assert.equal(deleted.trace.lanes.heuristic.trace.graph.maintenance.removedNodes,1);
 assert.equal(deleted.trace.lanes.heuristic.trace.graph.maintenance.rebuiltNodes,0);
 assert.equal(restarted.state.calls.length,0);
});
test('warm source graph never borrows a previous exclusion or prompt visibility decision',async()=>{
 const r=await fixture('entity');await retrieve(r);const p=policy();p.exclusions={identities:[r.target.identity]};
 assert(!(await r.context.__QUEUE_TEST__.dual.retrieve('ORBITSEED',r.snap({viewerId:'main_request'}),null,p)).selection.some(x=>x.identity===r.target.identity));
 const e=r.chat.localLore.find(x=>x.comment==='lmai_entity'),obj=JSON.parse(e.content);obj.meta.hiddenFromPrompt=true;e.content=JSON.stringify(r.signed(obj,'entity','target'));
 assert(!(await retrieve(r)).selection.some(x=>x.identity===r.target.identity));
 assert.equal(r.state.calls.length,0);
});
test('invalid persisted graph checksum is rejected before restored graph navigation',async()=>{
 const r=await fixture('narrative');await retrieve(r);assert.equal(graphKeys(r).length,1);
 const key=graphKeys(r)[0],value=JSON.parse(r.store.get(key));value.checksum='forged';r.store.set(key,JSON.stringify(value));
 const fresh=await runtime({store:r.store,cache:r.cache,lore:r.chat.localLore},{admittedHost:true});fresh.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 const result=await retrieve(fresh),m=result.trace.lanes.heuristic.trace.graph.maintenance;
 assert.equal(m.persistedReject,'checksum');assert.notEqual(m.mode,'restored');assert.equal(fresh.state.calls.length,0);
});
test('validated semantic-only seed expands HME once and gives no third RRF vote',async()=>{
 const r=await fixture('narrative'),p=policy(),providerFixture=provider();
 for(const family of ['memory','entity','world','narrative'])Object.assign(p.admission[family],{semanticMinScore:.8,semanticMinMargin:.2});
 r.snapshot=r.snap({viewerId:'main_request'});r.all=r.corpus.enumerate(r.snapshot);
 const handle=await r.index.open(r.snapshot,providerFixture,p);
 const vectors=r.all.map(unit=>record(r,unit,providerFixture,unit.family==='memory'?[1,.25,-.5]:[-1,-.25,.5]));
 assert.equal((await r.index.publish(handle,vectors,r.snapshot)).ok,true);
 const result=await r.context.__QUEUE_TEST__.dual.retrieve('QUERY:ZEPHYRUNSEEN',r.snapshot,providerFixture,p);
 const target=result.trace.fused.find(x=>x.identity===r.target.identity);assert(target,JSON.stringify(result.trace));
 assert.equal(target.ranks.semantic,null);assert.equal(target.rrf,1/(p.rrf.k+target.ranks.heuristic));
 assert.equal(result.trace.lanes.heuristic.trace.graph.expansions,1);
 assert.equal(r.state.calls.filter(x=>x.role==='query').length,1,'one offline synthetic query transport only');
 assert.equal(r.state.calls.filter(x=>x.role==='document').length,0);
});
test('acknowledged canonical persistence maintains HME without a configured semantic provider',async()=>{
 const r=await fixture('narrative'),lore=JSON.parse(JSON.stringify(r.chat.localLore));assert.equal(graphKeys(r).length,0);
 assert.equal((await r.persist(r.chat,lore)).ok,true);
 assert.equal(graphKeys(r).length,1,'graph maintenance belongs to the source write lifecycle');
 const previous=r.store.get(graphKeys(r)[0]);
 const e=lore.find(x=>x.comment==='lmai_narrative'),value=JSON.parse(e.content);value.storylines[0].memoryRefs=[];
 e.content=JSON.stringify(r.signed(value,'narrative','narrative_state'));
 assert.equal((await r.persist(r.chat,lore)).ok,true);assert.notEqual(r.store.get(graphKeys(r)[0]),previous);
 assert.equal(r.state.calls.length,0);
});
for(const kind of ['node','edge'])test('even a valid checksum cannot authorize forged persisted '+kind+' hints',async()=>{
 const r=await fixture('narrative');await retrieve(r);const key=graphKeys(r)[0],saved=JSON.parse(r.store.get(key));
 if(kind==='node')saved.graph.nodes[0].entities=['UnrelatedAlteredEntity'];else saved.graph.edges[0].weight=.999;
 const {checksum,...payload}=saved;saved.checksum='sha256:'+crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');r.store.set(key,JSON.stringify(saved));
 const fresh=await runtime({store:r.store,cache:r.cache,lore:r.chat.localLore},{admittedHost:true});fresh.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 const result=await retrieve(fresh);assert.equal(result.trace.lanes.heuristic.trace.graph.maintenance.persistedReject,kind==='node'?'source_nodes':'source_edges');
 assert.equal(fresh.state.calls.length,0);
});
test('reset generation never adopts the preceding source graph as current',async()=>{
 const r=await fixture('narrative');await retrieve(r);const snapshot=r.snap({resetGeneration:1,viewerId:'main_request'});
 const result=await r.context.__QUEUE_TEST__.dual.retrieve('ORBITSEED',snapshot,null,policy());
 assert.equal(result.trace.lanes.heuristic.trace.graph.maintenance.mode,'built');
 const stored=JSON.parse(r.store.get(graphKeys(r)[0]));assert.equal(stored.binding.resetGeneration,1);assert.equal(r.state.calls.length,0);
});
test('changed secret knowledge blocks graph paths for main request and a character POV without changing source bytes',async()=>{
 const r=await runtime(null,{admittedHost:true,transformCode:code=>code.replace('globalThis.__QUEUE_TEST__={','globalThis.__QUEUE_TEST__={secret:SecretKnowledgeCore,')});
 const marker='UndisclosedAmberRoute',memory={key:'lmai_memory::seed',comment:'lmai_memory',content:'[META:{"t":4,"ttl":-1,"imp":7,"ent":["Mira"]}]\nORBITSEED'};
 const entity=r.entry('lmai_entity','lmai_entity::target',r.signed({id:'target',name:'Mira',identity:{summary:marker},meta:{created:2}},'entity','target'));
 r.chat.localLore=[memory,entity];r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 const before=await retrieve(r),target=before.selection.find(x=>x.unit.locator.id==='target');assert(target);
 const bytes=JSON.stringify(r.chat.localLore),secret=r.context.__QUEUE_TEST__.secret;
 secret.resetState({scopeKey:r.snapshot.scopeKey,secrets:[{id:'protected-route',title:'HiddenRoute',content:marker,owner:'user',knownBy:['user'],status:'active'}]});
 for(const viewerId of ['main_request','entity:Mira']){
  const result=await r.context.__QUEUE_TEST__.dual.retrieve('ORBITSEED',r.snap({viewerId}),null,policy());
  assert(!result.selection.some(x=>x.identity===target.identity));assert.equal(result.trace.lanes.heuristic.trace.graph.maintenance.mode,'reused');
 }
 assert.equal(JSON.stringify(r.chat.localLore),bytes);assert.equal(r.state.calls.length,0);
});

test('a checksum-valid omitted graph is rejected against the complete canonical node inventory',async()=>{
 const r=await fixture('narrative');await retrieve(r);
 const key=graphKeys(r)[0],saved=JSON.parse(r.store.get(key));saved.graph.nodes=[];saved.graph.edges=[];
 const {checksum,...payload}=saved;saved.checksum='sha256:'+crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');r.store.set(key,JSON.stringify(saved));
 const fresh=await runtime({store:r.store,cache:r.cache,lore:r.chat.localLore},{admittedHost:true});fresh.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 const result=await retrieve(fresh),m=result.trace.lanes.heuristic.trace.graph.maintenance;
 assert.equal(m.persistedReject,'source_nodes');assert.notEqual(m.mode,'restored');assert(result.selection.some(x=>x.identity===r.target.identity));assert.equal(fresh.state.calls.length,0);
});
test('viewer changes filter the query view without rewriting an unchanged canonical world source graph',async()=>{
 const r=await fixture('world');await retrieve(r);const key=graphKeys(r)[0],before=r.store.get(key);
 const result=await r.context.__QUEUE_TEST__.dual.retrieve('ORBITSEED',r.snap({viewerId:'entity:Mira'}),null,policy()),m=result.trace.lanes.heuristic.trace.graph.maintenance;
 assert.equal(m.mode,'reused');assert.equal(m.rebuiltNodes,0);assert.equal(r.store.get(key),before);assert.equal(r.state.calls.length,0);
});
test('request-local drift filtering cannot replace the permanent canonical narrative source graph',async()=>{
 const r=await fixture('narrative');await retrieve(r);const key=graphKeys(r)[0],before=r.store.get(key);
 const result=await r.context.__QUEUE_TEST__.dual.retrieve('ORBITSEED',r.snap({viewerId:'main_request',ephemeralDriftExclusion:{turns:[4]}}),null,policy()),m=result.trace.lanes.heuristic.trace.graph.maintenance;
 assert.equal(m.mode,'reused');assert.equal(m.rebuiltNodes,0);assert.equal(r.store.get(key),before);assert(!result.selection.some(x=>x.identity===r.target.identity));assert.equal(r.state.calls.length,0);
});
