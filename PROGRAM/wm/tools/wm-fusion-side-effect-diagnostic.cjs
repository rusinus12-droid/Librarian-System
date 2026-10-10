'use strict';
// Characterize the inherited all-storage-write assertion without changing it.
// Uses real artifact functions and in-process synthetic transport/storage only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {runtime, provider, policy: storagePolicy} = require('./libra_typed_recall_queue_test.cjs');
const {memoryEntry} = require('./libra_recall_test_runtime.cjs');
const {record} = require('./libra_typed_recall_index_test.cjs');
function policy() {
 return {...storagePolicy, mode:'fixture', version:'task4-fixture-v1', maxCorpusUnits:512,
  storage:{...storagePolicy.storage,maxExpectedBytes:1048576},laneDepth:32,unionLimit:64,rrf:{k:60},
  calibration:Object.fromEntries(['memory','entity','world','narrative'].map(f=>[f,{scale:1,offset:0}])),
  admission:Object.fromEntries(['memory','entity','world','narrative'].map(f=>[f,{heuristicMinScore:.001,semanticMinScore:.8,semanticMinLexicalOverlap:0,semanticMinMargin:0}])),
  diversity:{maxItems:4,lambda:.8,crossRolePenalty:.2,arcPenalty:.03,maxPerArc:2,typeCaps:{}}};
}
async function fixture() {
 const r=await runtime();r.chat.localLore=Array.from({length:40},(_,i)=>memoryEntry(i+1,'pendant promise exact beacon anchor '+i,8));
 r.snapshot=r.snap({currentTurn:100});r.all=r.corpus.enumerate(r.snapshot).filter(u=>r.corpus.adapters[u.family].eligibility(u,r.snapshot).eligible);
 const p=policy(),h=await r.index.open(r.snapshot,provider(),p);
 assert.equal((await r.index.publish(h,r.all.map(u=>record(r,u,provider())),r.snapshot)).ok,true);
 const writes=[],set=r.storage.setItem;r.storage.setItem=async(key,value)=>{writes.push({key,bytes:Buffer.byteLength(String(value)),stack:new Error('synthetic storage observation').stack});return set(key,value);};
 return {r,p,writes};
}
const query='QUERY:pendant promise exact beacon anchor';
async function main() {
 const direct=await fixture();
 const lane=await direct.r.engine.search(query,direct.r.snapshot,provider(),{depth:32,policy:direct.p,maxScanUnits:512});
 assert.equal(lane.hits.length,32);assert.equal(direct.r.state.calls.filter(c=>c.role==='query').length,1);
 assert.equal(direct.r.state.calls.filter(c=>c.role==='document').length,0);assert.equal(direct.writes.length,0);
 const composed=await fixture();
 const first=await composed.r.context.__QUEUE_TEST__.dual.retrieve(query,composed.r.snapshot,provider(),composed.p);
 assert.equal(first.trace.lanes.semantic.returned,32);
 assert.equal(composed.r.state.calls.filter(c=>c.role==='query').length,1);
 assert.equal(composed.r.state.calls.filter(c=>c.role==='document').length,0);
 assert.equal(composed.writes.length,1);assert(composed.writes.every(w=>w.key.endsWith(':typed-graph')),'the single side effect belongs to persistent HME source graph, not canonical/vector storage');
 const coldWrites=composed.writes.slice();composed.writes.length=0;
 const second=await composed.r.context.__QUEUE_TEST__.dual.retrieve(query,composed.r.snapshot,provider(),composed.p);
 assert.equal(second.trace.lanes.semantic.returned,32);assert.equal(composed.writes.length,0);
 const report={scope:'diagnostic, not replacement of the failing legacy fusion assertion',
  directSemantic:{returned:lane.hits.length,queryCalls:1,documentCalls:0,storageWrites:0},
  coldCombined:{returned:first.trace.lanes.semantic.returned,queryCalls:1,documentCalls:0,storageWrites:coldWrites},
  warmCombined:{returned:second.trace.lanes.semantic.returned,storageWrites:0},
  existingAssertionChanged:false,contractDecision:'pending: total query writes forbidden versus typed HME cold-query persistence'};
 const out=path.join(process.env.WM_EVIDENCE_DIR||path.resolve(__dirname,'../evidence'),'FUSION-SIDE-EFFECTS.json');
 fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
