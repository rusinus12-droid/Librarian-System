'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');

// The standalone shared engine is the source of truth for all owners. Plugin
// embedded copies are intentionally not loaded here; HAYAKU's actual hook is
// covered by source_edit_hayaku_runtime_test.cjs and distribution sync follows
// after all owner changes are complete.
const context=vm.createContext({setTimeout,clearTimeout,Date,console});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8'),context);

for(const owner of ['libra','hayaku','flashback'])test(`${owner}: beforeRequest processes every changed unit with scope/revision guards`,async()=>{
  const storage=new Map();let prompts=0;const calls=[];
  const units=[
    {key:'6',start:6,end:6,digest:'six-v2',sourceDigest:'six-v2',originalDigest:'six-v1',rawDigest:'six-raw-v2',originalRawDigest:'six-raw-v1',identity:'pair-6',basis:'scope-policy',changed:true,current:false},
    {key:'11',start:11,end:11,digest:'eleven-v2',sourceDigest:'eleven-v2',originalDigest:'eleven-v1',rawDigest:'eleven-raw-v2',originalRawDigest:'eleven-raw-v1',identity:'pair-11',basis:'scope-policy',changed:true,current:false}
  ];
  const controller=context.createMemorySuiteSourceEditConsent({owner,requestBoundary:true,preserveUntilReplacement:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'owner-chat',units:units.map(unit=>({...unit})),completedTurnIds:['u6','u6','u11']}),
    prompt:async()=>{prompts++;return{decision:'approve',keys:['6']};},
    execute:async(task,permit)=>{await permit.assertCurrent();calls.push({key:task.key,scopeKey:permit.scopeKey,revisionId:task.revisionId});return{ok:true};}
  });
  try{
    await controller.beforeRequest();
    const state=controller.status();
    assert.deepEqual(calls.map(call=>call.key),['6','11']);
    assert.ok(calls.every(call=>call.scopeKey==='owner-chat'&&call.revisionId));
    assert.equal(prompts,0);
    assert.ok(state.tasks.every(task=>task.state==='applied'));
    assert.equal(state.events.length,2);

    const task=state.tasks.find(row=>row.key==='6');
    await assert.rejects(controller.setException('different-chat','6',task.revisionId,true),/SOURCE_EDIT_REVISION_CHANGED/);
    await assert.rejects(controller.setException('owner-chat','6','stale-revision',true),/SOURCE_EDIT_REVISION_CHANGED/);
    await controller.setException('owner-chat','6',task.revisionId,true);
    assert.equal(controller.blocks('owner-chat',6),true);
    assert.equal(controller.status().tasks.find(row=>row.key==='6').state,'applied','exception protects a revision without undoing its durable replacement');

    await controller.deleteEvent('owner-chat',state.events.find(row=>row.key==='6').id);
    assert.equal(controller.status().events.length,1,'deleting a recent event removes only display history');
    assert.equal(controller.blocks('owner-chat',6),true,'deleting history preserves the exception');
    assert.equal(controller.status().tasks.find(row=>row.key==='6').state,'applied');
  }finally{controller.dispose();}
});
