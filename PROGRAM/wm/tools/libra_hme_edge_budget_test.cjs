'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
async function fixture(){
 const r=await runtime(null,{transformCode:code=>{
  const seam='            searchHmeTypedGraphCandidates,';
  assert(code.includes(seam),'graph closure measurement seam exists');
  return code.replace(seam,'            __edgeBudget:{cross:buildHmeGraphCrossTypeEdges,compile:buildHmeGraphIndexFromScopeIndex,node:buildHmeGraphNodeFromRow,entity:buildHmeGraphEntityNode,preset:getHmeGraphPreset,scopeSchema:HME_SCOPE_INDEX_SCHEMA},\n'+seam);
 }});
 r.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 const g=r.api.MemoryEngine.__edgeBudget;
 const node=i=>g.node({id:'budget-memory-'+i,contentHash:'source-'+i,subjects:['BudgetHub'],entityRoles:{primary:['BudgetHub']},arcKey:'amber-transit-arc',openThreads:['amber transit rendezvous'],turn:i+1});
 const entity=g.entity({id:'budget-hub',name:'BudgetHub',meta:{created:1}});
 return {r,g,node,entity};
}
test('an explicit zero remaining budget grants no cross-type edges',async()=>{
 const {r,g,node,entity}=await fixture();
 assert(g.cross([node(0),entity]).length>0,'control must contain an actual association');
 assert.equal(g.cross([node(0),entity],{maxEdges:0}).length,0);
 assert.equal(r.state.calls.length,0);
});
test('positive cross-type budgets still retain valid associations within their limit',async()=>{
 const {r,g,node,entity}=await fixture(),nodes=[node(0),node(1),node(2),entity];
 assert.equal(g.cross(nodes,{maxEdges:1}).length,1);
 assert.equal(g.cross(nodes,{maxEdges:2}).length,2);
 assert.equal(g.cross(nodes,{maxEdges:-1}).length,0);
 assert.equal(r.state.calls.length,0);
});
test('a saturated full graph cannot append cross-type edges beyond its existing preset',async()=>{
 const {r,g,node,entity}=await fixture(),preset=g.preset(),nodes=Array.from({length:preset.maxNodes-1},(_,i)=>node(i));
 nodes.push(entity);
 const graph=g.compile({schema:g.scopeSchema,scopeKey:r.snapshot.scopeKey,digest:'bounded-source'},{scopeKey:r.snapshot.scopeKey,typedNodes:nodes});
 assert(graph.edges.length>0,'control must build graph edges');
 assert(graph.nodes.length<=preset.maxNodes);
 assert(graph.edges.length<=preset.maxEdges,'saturated graph must retain the preset edge cap');
 assert.equal(r.state.calls.length,0);
});
