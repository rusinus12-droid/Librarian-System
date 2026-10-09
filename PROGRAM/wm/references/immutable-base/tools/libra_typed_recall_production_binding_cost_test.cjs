'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');

test('production consumer revalidates exact bindings without rebuilding unrelated history at each gate',async()=>{
  const r=await runtime(null,{admittedHost:true,transformCode:code=>code.replace('const representation = adapter.representation(candidate, snapshot, policy.representation || {});','globalThis.__REPRESENTATION_COUNT__=(globalThis.__REPRESENTATION_COUNT__||0)+1; const representation = adapter.representation(candidate, snapshot, policy.representation || {});')});
  const a=r.context.__QUEUE_TEST__,p=a.rollout.begin().policy,u=r.all.find(x=>x.family==='memory'),world=r.all.find(x=>x.family==='world');
  const sample=r.chat.localLore.find(e=>e.key===u.entry.key);
  for(let i=0;i<400;i++)r.chat.localLore.push({...sample,key:'lmai_memory::cost-history-'+i,content:sample.content+' unrelated history '+i});
  const snapshot=r.snap(),com=a.consumers.compose({baseline:[{key:'current-world',text:'Current canonical world',required:true,bindings:[world]}],selection:[{identity:u.identity,unit:u}],snapshot,policy:p});
  r.context.__REPRESENTATION_COUNT__=0;
  const output=a.consumers.finalize({sections:com.sections,currentSnapshot:()=>r.snap(),policy:p,mode:'hybrid',budget:{maxTokens:20000,maxChars:80000}});
  assert.equal(output.ok,true);assert.equal(a.consumers.verified(output),true);assert.equal(output.directBlocks.length,2);
  assert.ok(r.context.__REPRESENTATION_COUNT__<60,'selected bindings should bound repeated representation work; actual='+r.context.__REPRESENTATION_COUNT__);
  const initialCount=r.context.__REPRESENTATION_COUNT__;
  r.chat.localLore.push({...sample});
  assert.equal(a.consumers.verified(output),false,'a later identity collision must still invalidate output');
  assert.ok(r.context.__REPRESENTATION_COUNT__-initialCount<10,'collision checking must not reconstruct unrelated records');
});

test('fresh bound resolution retains parent dependencies and independent formatter/final gates',async()=>{
  const r=await runtime(null,{admittedHost:true}),a=r.context.__QUEUE_TEST__,p=a.rollout.begin().policy,u=r.all.find(x=>x.family==='world'&&x.record.isActive===false);
  const snapshot=r.snap(),com=a.consumers.compose({selection:[{identity:u.identity,unit:u}],snapshot,policy:p});
  const original=r.corpus.adapters.world.formatter;
  r.corpus.adapters.world.formatter=(...args)=>{const blocks=original(...args),entry=r.chat.localLore.find(e=>e.comment==='lmai_world_graph'),graph=JSON.parse(entry.content);graph.nodes[0][1].rules.custom.oath='changed parent while formatting';entry.content=JSON.stringify(graph);return blocks;};
  try{const output=a.consumers.finalize({sections:com.sections,currentSnapshot:()=>r.snap(),policy:p,mode:'hybrid',budget:{maxTokens:20000,maxChars:80000}});assert.equal(output.directBlocks.length+output.projectionEntries.length,0);assert.ok(output.trace.drops.some(d=>d.reason==='stale_binding'));}finally{r.corpus.adapters.world.formatter=original;}
});
