'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const {policy,budget,selection,output}=require('./libra_typed_recall_consumers_test.cjs');
test('consumer validation bindings omit large canonical parents while preserving fresh verification',async()=>{
 const r=await runtime(),p=policy(),world=r.all.find(x=>x.family==='world');assert(world);
 const inflated={...world,parentRecord:{...world.parentRecord,unconsumedFixturePadding:'z'.repeat(1000000)}};
 const baseline=Array.from({length:3},(_,i)=>({key:'control-'+i,text:'Current protected control '+i,bindings:[inflated],required:true}));
 const com=r.context.__QUEUE_TEST__.consumers.compose({baseline,selection:selection([inflated]),snapshot:r.snapshot,policy:p});
 assert(JSON.stringify(com.sections).length<20000,'receipts must carry bindings, not repeated whole source graphs');
 assert(!('parentRecord' in com.sections[0].bindings[0]));assert(!('entry' in com.sections[0].bindings[0]));
 const o=output(r,com,'hybrid',p,budget);assert.equal(o.ok,true);assert.equal(r.context.__QUEUE_TEST__.consumers.verified(o),true);
 const entry=r.chat.localLore.find(e=>e.key===world.entry.key),graph=JSON.parse(entry.content);
 graph.nodes[0][1].rules.custom.oath='changed source oath';entry.content=JSON.stringify(graph);
 assert.equal(r.context.__QUEUE_TEST__.consumers.verified(o),false,'current dependency must still be validated');
});
