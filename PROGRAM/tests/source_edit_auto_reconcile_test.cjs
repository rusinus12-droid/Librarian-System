'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');

const code=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8');
const context=vm.createContext({setTimeout,clearTimeout,Date,console});
vm.runInContext(code,context);


// Historical filename retained for the runner. Owner execution now requires an
// explicit selected-unit preview/apply; the request itself only detects edits.
async function explicitRequest(controller) {
  await controller.beforeRequest();controller.afterRequest();
  const keys=controller.status().tasks.filter(t=>!t.excluded&&!t.conflict&&!t.archived&&['awaiting_consent','declined','failed','interrupted'].includes(t.state)).map(t=>t.key);
  if(keys.length){const ticket=await controller.previewSelected(keys);if(ticket.allowed)await controller.applySelected(ticket);}
  return controller.status();
}

function fixture(options={}){
  const storage=options.storage||new Map();
  if(options.mode)storage.set('__source_tracking_preferences_v1__',JSON.stringify({mode:options.mode,epoch:0}));
  let calls=0,prompts=0;
  const completedTurnIds=['u1'];
  let unit={key:'1',start:1,end:1,digest:'new',sourceDigest:'new',originalDigest:'old',basis:'basis-new',identity:'pair-1',changed:true,current:false};
  const makeController=()=>context.createMemorySuiteSourceEditConsent({
    owner:'libra',requestBoundary:true,externalObserver:true,
    read:async key=>storage.get(key)??null,
    write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{...unit}],completedTurnIds:[...completedTurnIds]}),
    ...(options.withCause?{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[{key:'1',currentValid:true,previousUnavailable:false,beforeText:'private old excerpt',afterText:'private new excerpt'}]})}:{}),
    prompt:async()=>{prompts++;return{decision:'approve',keys:['1']};},
    execute:async(task,permit)=>{await permit.assertCurrent();calls++;unit={...unit,changed:false,current:true};return{ok:true};}
  });
  const controller=makeController();
  return {controller,makeController,storage,completedTurnIds,get calls(){return calls;},get prompts(){return prompts;}};
}

test('legacy notification modes retain detection compatibility while explicit off remains disabled',async()=>{
  for(const legacy of ['notify','silent']){
    const f=fixture({mode:legacy});
    try{
      await f.controller.ready();
      assert.equal(f.controller.status().mode,'auto');
      assert.equal(JSON.parse(f.storage.get('__source_tracking_preferences_v1__')).mode,'auto');
      await explicitRequest(f.controller);
      assert.equal(f.calls,1);
      assert.equal(f.prompts,0);
    }finally{f.controller.dispose();}
  }
  const off=fixture({mode:'off'});
  try{await off.controller.ready();assert.equal(off.controller.status().mode,'off');await explicitRequest(off.controller);assert.equal(off.calls,0);}
  finally{off.controller.dispose();}
});

test('explicit preview/apply reconciles one exact edited source without a legacy dialog',async()=>{
  const f=fixture();
  try{
    await explicitRequest(f.controller);
    assert.equal(f.calls,1);
    assert.equal(f.prompts,0);
    assert.equal(f.controller.status().tasks[0].state,'applied');
    f.controller.afterRequest();
    await explicitRequest(f.controller);
    assert.equal(f.calls,1,'the committed source revision must not be analyzed again');
  }finally{f.controller.dispose();}
});

test('empty manual selection and background detection never dispatch work',async()=>{
  const f=fixture();try{
    assert.match(f.controller.question,/감지만/);
    assert.match(f.controller.question,/직접 실행/);
    const observed=await f.controller.inspect({scopeKey:'chat',units:[{key:'1',start:1,end:1,digest:'new',sourceDigest:'new',originalDigest:'old',basis:'basis-new',identity:'pair-1',changed:true,current:false}],completedTurnIds:['u1']},{phase:'before'});
    assert.equal(observed.tasks.length,1);
    assert.equal(f.prompts,0);
    const manual=await f.controller.review();
    assert.equal(manual.reason,'explicit_selection_required');
    assert.equal(f.prompts,0);
    assert.equal(f.calls,0);
    f.controller.afterRequest();
    await explicitRequest(f.controller);
    assert.equal(f.calls,1);
    assert.equal(f.prompts,0);
  }finally{f.controller.dispose();}
});

test('a rule-only projection change is rebuilt as policy work, then later source edits remain distinct',async()=>{
  const storage=new Map();let rulesSaved=false,sourceEdited=false,calls=0;
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>{
      const digest=sourceEdited?'user-edit-v2':rulesSaved?'policy-v2':'policy-v1';
      const rawDigest=sourceEdited?'raw-v2':'raw-v1';
      const changed=rulesSaved||sourceEdited;
      return {scopeKey:'chat',units:[{key:'1',start:1,end:1,digest,sourceDigest:digest,rawDigest,originalDigest:'policy-v1',originalRawDigest:'raw-v1',basis:'b',identity:'i',changed,current:!changed}]};
    },
    execute:async(task,permit)=>{await permit.assertCurrent();calls++;return{ok:true};}
  });
  try{
    await controller.ready();
    await controller.setSourceRules({version:1,ignoredTags:[{open:'[private]',close:'[/private]'}],unwrapTags:[],sourceTags:[],controls:[]});
    rulesSaved=true;
    await explicitRequest(controller);
    assert.equal(calls,1,'a changed projection must be rebuilt once');
    assert.equal(controller.status().tasks[0].changeKind,'projection_policy_changed');
    assert.equal(controller.status().tasks[0].policyUncertain,false);
    controller.afterRequest();sourceEdited=true;
    await explicitRequest(controller);
    assert.equal(calls,2,'a later actual source revision is still reconciled');
    assert.equal(controller.status().tasks[0].changeKind,'source_changed');
    assert.equal(controller.status().tasks[0].state,'applied');
  }finally{controller.dispose();}
});

test('same projection on rule save advances policy without an unnecessary model call',async()=>{
  const storage=new Map();let rulesSaved=false,calls=0;
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{key:'1',start:1,end:1,digest:'same',sourceDigest:'same',rawDigest:'raw',originalDigest:'same',originalRawDigest:'raw',basis:'b',identity:'i',changed:false,current:true}]}),
    execute:async()=>{calls++;return{ok:true};}
  });
  try{await controller.setSourceRules({version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:['html-comment']});rulesSaved=true;await explicitRequest(controller);
    assert.equal(rulesSaved,true);assert.equal(calls,0);assert.equal(controller.status().tasks.length,0);
  }finally{controller.dispose();}
});

test('a verified same-identity journal raw baseline classifies simultaneous policy and source edits',async()=>{
  const storage=new Map();let revised=false,calls=0;
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{key:'1',start:1,end:1,digest:revised?'policy-v2':'policy-v1',sourceDigest:revised?'policy-v2':'policy-v1',
      rawDigest:revised?'raw-v2':'raw-v1',originalDigest:revised?'policy-v1':'',originalRawDigest:'',policyUncertain:revised,
      identity:'stable-pair',basis:'basis',changed:revised,current:!revised}]}),
    execute:async(task,permit)=>{await permit.assertCurrent();calls++;return{ok:true};}
  });
  try{
    await explicitRequest(controller);
    assert.equal(JSON.parse(storage.get('chat')).sourceRuleBaseline['1'].rawDigest,'raw-v1','the first request persists the validated prior raw hash');
    controller.afterRequest();
    await controller.setSourceRules({version:1,ignoredTags:[{open:'[private]',close:'[/private]'}],unwrapTags:[],sourceTags:[],controls:[]});
    revised=true;
    await explicitRequest(controller);
    const task=controller.status().tasks[0];
    assert.equal(calls,1);
    assert.equal(task.changeKind,'source_and_policy_changed');
    assert.equal(task.policyUncertain,false,'same-identity baseline raw evidence resolves owner-level missing-old-evidence uncertainty');
  }finally{controller.dispose();}
});

test('simultaneous source and rule change is labeled as combined and missing old raw is uncertain',async()=>{
  const make=async(originalRawDigest,rawDigest)=>{
    const storage=new Map();let calls=0;
    const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
      read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
      collect:async()=>({scopeKey:'chat',units:[{key:'1',start:1,end:1,digest:'after-policy',sourceDigest:'after-policy',rawDigest,originalDigest:'before-policy',originalRawDigest,basis:'b',identity:'i',changed:true,current:false}]}),
      execute:async(task,permit)=>{await permit.assertCurrent();calls++;return{ok:true};}
    });
    await controller.setSourceRules({version:1,ignoredTags:[{open:'[x]',close:'[/x]'}],unwrapTags:[],sourceTags:[],controls:[]});
    await explicitRequest(controller);return{controller,get calls(){return calls;}};
  };
  const combined=await make('raw-before','raw-after');try{
    assert.equal(combined.calls,1);assert.equal(combined.controller.status().tasks[0].changeKind,'source_and_policy_changed');
    assert.equal(combined.controller.status().tasks[0].policyUncertain,false);
  }finally{combined.controller.dispose();}
  const unknown=await make('','raw-after');try{
    assert.equal(unknown.calls,1);assert.equal(unknown.controller.status().tasks[0].changeKind,'projection_policy_changed');
    assert.equal(unknown.controller.status().tasks[0].policyUncertain,true);
  }finally{unknown.controller.dispose();}
});

test('a verified same-identity projection baseline protects rebuild when old evidence bytes are unavailable',async()=>{
  const storage=new Map();let policyChanged=false,calls=0;
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{key:'1',start:1,end:1,
      digest:policyChanged?'policy-v2':'policy-v1',sourceDigest:policyChanged?'policy-v2':'policy-v1',
      rawDigest:'raw-stable',originalDigest:'',originalRawDigest:'',policyUncertain:policyChanged,
      originalEvidenceUnavailable:policyChanged,basis:'b',identity:'stable-pair',changed:false,current:!policyChanged}]}),
    execute:async(task,permit)=>{await permit.assertCurrent();calls++;return{ok:true};}
  });
  try{
    await explicitRequest(controller);
    assert.equal(JSON.parse(storage.get('chat')).sourceRuleBaseline['1'].sourceDigest,'policy-v1');
    controller.afterRequest();
    await controller.setSourceRules({version:1,ignoredTags:[],unwrapTags:[],sourceTags:[{open:'<original>',close:'</original>'}],controls:[]});
    policyChanged=true;
    await explicitRequest(controller);
    const task=controller.status().tasks[0],event=controller.status().events[0];
    assert.equal(calls,1);
    assert.equal(task.originalDigest,'policy-v1','the validated old projection digest protects the existing canonical');
    assert.equal(task.changeKind,'projection_policy_changed');
    assert.equal(task.policyUncertain,false,'same-identity equal raw hashes prove policy-only change');
    assert.equal(task.originalEvidenceUnavailable,true,'missing owner evidence bytes remain explicit');
    assert.equal(event.originalEvidenceUnavailable,true);
    assert.equal('beforeText' in event,false);assert.equal('afterText' in event,false);
  }finally{controller.dispose();}
});

test('a stale model result is rejected when the source changes during selected explicit work',async()=>{
  const storage=new Map();let unit={key:'1',start:1,end:1,digest:'v2',sourceDigest:'v2',rawDigest:'raw-v2',originalDigest:'v1',originalRawDigest:'raw-v1',basis:'b',identity:'i',changed:true,current:false};
  let calls=0,releaseFirst,startedFirst;
  const started=new Promise(resolve=>{startedFirst=resolve;});
  const gate=new Promise(resolve=>{releaseFirst=resolve;});
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{...unit}]}),
    execute:async(task,permit)=>{calls++;if(calls===1){startedFirst();await gate;await permit.assertCurrent();}else await permit.assertCurrent();return{ok:true};}
  });
  try{
    const first=explicitRequest(controller);await started;
    unit={...unit,digest:'v3',sourceDigest:'v3',rawDigest:'raw-v3',changed:true,current:false};
    releaseFirst();await first;
    assert.equal(controller.status().tasks[0].state,'failed');
    assert.match(controller.status().tasks[0].error,/SOURCE_CHANGED/);
    controller.afterRequest();
    await explicitRequest(controller);
    assert.equal(calls,2);
    assert.equal(controller.status().tasks[0].sourceDigest,'v3');
    assert.equal(controller.status().tasks[0].state,'applied');
  }finally{controller.dispose();}
});

test('policy rebuild with missing raw evidence records uncertainty without inventing a diff',async()=>{
  const storage=new Map();let calls=0;
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{key:'1',start:1,end:1,digest:'new-projection',sourceDigest:'new-projection',rawDigest:'current-raw',originalDigest:'old-projection',originalRawDigest:'',policyUncertain:true,basis:'b',identity:'i',changed:false,current:false}]}),
    execute:async(task,permit)=>{await permit.assertCurrent();calls++;return{ok:true};}
  });
  try{
    await controller.setSourceRules({version:1,ignoredTags:[{open:'[private]',close:'[/private]'}],unwrapTags:[],sourceTags:[],controls:[]});
    await explicitRequest(controller);
    const state=controller.status(),task=state.tasks[0],event=state.events[0];
    assert.equal(calls,1);
    assert.equal(task.changeKind,'projection_policy_changed');
    assert.equal(task.policyUncertain,true);
    assert.equal(event.policyUncertain,true);
    assert.equal('beforeText' in event,false);
    assert.equal('afterText' in event,false);
  }finally{controller.dispose();}
});

test('policy epoch and explicit replacement survive restart and journal readback',async()=>{
  const storage=new Map();let calls=0,committed=false;
  const makeController=()=>context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{key:'1',start:1,end:1,digest:committed?'new-policy':'new-policy',sourceDigest:'new-policy',rawDigest:'raw',originalDigest:committed?'new-policy':'old-policy',originalRawDigest:'raw',basis:'b',identity:'i',changed:!committed,current:committed}]}),
    execute:async(task,permit)=>{await permit.assertCurrent();calls++;committed=true;return{ok:true};}
  });
  const first=makeController();
  try{
    await first.setSourceRules({version:1,ignoredTags:[{open:'[x]',close:'[/x]'}],unwrapTags:[],sourceTags:[],controls:[]});
    assert.equal(JSON.parse(storage.get('__source_tracking_preferences_v1__')).sourceRuleEpoch,1);
    await explicitRequest(first);
    assert.equal(calls,1);
    assert.equal(JSON.parse(storage.get('chat')).sourceRuleEpoch,1);
  }finally{first.dispose();}
  const restarted=makeController();
  try{await explicitRequest(restarted);assert.equal(calls,1);assert.equal(restarted.status().tasks[0].state,'applied');}
  finally{restarted.dispose();}
});

test('an excluded upstream prevents selected explicit work on dependent suffix units',async()=>{
  const storage=new Map();let calls=0,suffixChanged=false;
  let units=[
    {key:'6',start:6,end:6,digest:'six-new',sourceDigest:'six-new',originalDigest:'six-old',basis:'b',identity:'i6',changed:true,current:false},
    {key:'11',start:11,end:11,digest:'eleven-old',sourceDigest:'eleven-old',basis:'b',identity:'i11',changed:false,current:true}
  ];
  const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:units.map(u=>({...u}))}),
    execute:async(task,permit)=>{await permit.assertCurrent();calls++;return{ok:true};}
  });
  try{
    await explicitRequest(controller);
    const prefix=controller.status().tasks.find(t=>t.key==='6');
    await controller.setException('chat','6',prefix.revisionId,true);
    controller.afterRequest();
    suffixChanged=true;
    units=units.map(u=>u.key==='11'?{...u,digest:'eleven-new',sourceDigest:'eleven-new',originalDigest:'eleven-old',changed:true,current:false,changeKind:'dependency_affected'}:u);
    await explicitRequest(controller);
    assert.equal(suffixChanged,true);
    assert.equal(calls,1,'only the upstream task ran; a dependent suffix waits behind its exception');
    assert.equal(controller.status().tasks.find(t=>t.key==='11').state,'awaiting_consent');
    assert.equal(controller.blocks('chat',11),true);
  }finally{controller.dispose();}
});

test('an applied revision can be excluded without deleting its durable receipt',async()=>{
  const f=fixture();
  try{
    await explicitRequest(f.controller);
    const task=f.controller.status().tasks[0];
    assert.ok(task.revisionId);
    await f.controller.setException('chat','1',task.revisionId,true);
    assert.equal(f.controller.blocks('chat',1),true);
    assert.equal(f.controller.canWrite('chat','1','new'),false);
    assert.equal(f.controller.status().tasks[0].excluded,true);
    assert.equal(f.controller.status().tasks[0].state,'applied');
    assert.equal(f.calls,1);
  }finally{f.controller.dispose();}
});

test('undoing an exception rebuilds the current source before recall resumes',async()=>{
  const f=fixture();
  try{
    await explicitRequest(f.controller);
    const revision=f.controller.status().tasks[0].revisionId;
    await f.controller.setException('chat','1',revision,true);
    await f.controller.setException('chat','1',revision,false);
    assert.equal(f.controller.blocks('chat',1),true);
    f.controller.afterRequest();
    await explicitRequest(f.controller);
    assert.equal(f.calls,2);
    assert.equal(f.controller.status().tasks[0].state,'applied');
    assert.equal(f.controller.blocks('chat',1),false);
  }finally{f.controller.dispose();}
});

test('loading an event-less legacy task scrubs its stale cause before status can expose it',async()=>{
  const f=fixture({withCause:true});
  try{
    await explicitRequest(f.controller);
    const event=f.controller.status().events[0];
    await f.controller.setException('chat','1',event.revisionId,true);
    const legacy=JSON.parse(f.storage.get('chat'));
    legacy.events=[];
    f.storage.set('chat',JSON.stringify(legacy));
    f.controller.dispose();

    const reloaded=f.makeController();
    try{
      await reloaded.setException('chat','1',event.revisionId,true);
      const task=reloaded.status('chat').tasks[0];
      assert.equal(task.excluded,true);
      assert.equal(task.state,'applied');
      assert.equal('cause' in task,false,'legacy excerpt data must be removed before the loaded status is returned');
      assert.equal('cause' in JSON.parse(f.storage.get('chat')).tasks['1'],false,'the migration must durably remove the orphaned payload');
    }finally{reloaded.dispose();}
  }finally{f.controller.dispose();}
});

test('deleting detection history removes its cause from the task through reload but keeps the applied receipt and exclusion',async()=>{
  const f=fixture({withCause:true});
  try{
    await explicitRequest(f.controller);
    const event=f.controller.status().events[0];
    assert.ok(event.id);
    assert.ok(event.cause.beforeExcerpt,'the revision begins with a persisted before excerpt');
    assert.ok(event.cause.afterExcerpt,'the revision begins with a persisted after excerpt');
    await f.controller.setException('chat','1',event.revisionId,true);
    await f.controller.deleteEvent('chat',event.id);
    assert.equal(f.controller.status().events.length,0);
    assert.equal(f.controller.status().tasks[0].excluded,true);
    assert.equal(f.controller.status().tasks[0].state,'applied');
    const saved=JSON.parse(f.storage.get('chat'));
    assert.equal('cause' in saved.tasks['1'],false,'the deleted excerpts must not remain in the durable task receipt');
    f.controller.dispose();
    const reloaded=f.makeController();
    try{
      await explicitRequest(reloaded);
      const task=reloaded.status().tasks[0];
      assert.equal(reloaded.status().events.length,0);
      assert.equal(task.excluded,true);
      assert.equal(task.state,'applied');
      assert.equal('cause' in task,false,'the event-less fallback row must not resurrect deleted cause data');
      assert.equal(JSON.stringify(reloaded.status()).includes('private old excerpt'),false);
    }finally{reloaded.dispose();}
    assert.equal(f.calls,1);
  }finally{f.controller.dispose();}
});

test('history expires after ten new logical completed turns and removes the cause payload through reload',async()=>{
  const f=fixture({withCause:true});
  try{
    await explicitRequest(f.controller);
    assert.equal(f.controller.status().events.length,1);
    for(let n=1;n<10;n++)await f.controller.recordCompletedTurn('chat',`user-${n}`);
    await f.controller.recordCompletedTurn('chat','user-9');
    assert.equal(f.controller.status().events.length,1);
    await f.controller.recordCompletedTurn('chat','user-10');
    assert.equal(f.controller.status().events.length,0);
    assert.equal(f.controller.status().tasks[0].state,'applied');
    assert.equal('cause' in JSON.parse(f.storage.get('chat')).tasks['1'],false,'turn-count expiry removes the stored excerpt payload');
    f.controller.dispose();
    const reloaded=f.makeController();
    try{
      await explicitRequest(reloaded);
      assert.equal(reloaded.status().events.length,0);
      assert.equal('cause' in reloaded.status().tasks[0],false);
      assert.equal(JSON.stringify(reloaded.status()).includes('private old excerpt'),false);
    }finally{reloaded.dispose();}
  }finally{f.controller.dispose();}
});

test('beforeRequest completed-turn expiry removes the cause payload before the fallback status row',async()=>{
  const f=fixture({withCause:true});try{
    await explicitRequest(f.controller);f.controller.afterRequest();
    for(let n=2;n<=10;n++){
      f.completedTurnIds.push(`u${n}`);
      await explicitRequest(f.controller);f.controller.afterRequest();
    }
    assert.equal(f.controller.status().events.length,1);
    await explicitRequest(f.controller);f.controller.afterRequest();
    assert.equal(f.controller.status().events.length,1,'reroll of an existing user turn does not advance history');
    f.completedTurnIds.push('u11');
    await explicitRequest(f.controller);
    assert.equal(f.controller.status().events.length,0);
    assert.equal('cause' in f.controller.status().tasks[0],false);
    assert.equal('cause' in JSON.parse(f.storage.get('chat')).tasks['1'],false);
  }finally{f.controller.dispose();}
});

test('failed housekeeping write recovers only after durable reread and current-snapshot inspection',async()=>{
  const make=async()=>{
    const storage=new Map();let unit={key:'1',start:1,end:1,digest:'same',sourceDigest:'same',rawDigest:'raw-same',basis:'b',identity:'pair',changed:false,current:true};
    let completedTurnIds=['u1'],failWrites=0,failReads=false;
    const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
      read:async key=>{if(failReads)throw new Error('SOURCE_EDIT_READ_INTERRUPTED');return storage.get(key)??null;},
      write:async(key,value)=>{if(key==='chat'&&failWrites>0){failWrites--;return false;}storage.set(key,value);return true;},
      collect:async()=>({scopeKey:'chat',units:[{...unit}],completedTurnIds:[...completedTurnIds]}),
      execute:async(task,permit)=>{await permit.assertCurrent();unit={...unit,digest:task.sourceDigest,sourceDigest:task.sourceDigest,changed:false,current:true};return{ok:true};}
    });
    await explicitRequest(controller);controller.afterRequest();
    return {controller,storage,setUnit:value=>{unit=value;},addTurn:id=>completedTurnIds.push(id),failWrite:()=>{failWrites++;},failRead:on=>{failReads=on;}};
  };
  const housekeeping=await make();try{
    housekeeping.addTurn('u2');housekeeping.failWrite();
    await explicitRequest(housekeeping.controller);
    assert.equal(housekeeping.controller.status().error,'SOURCE_EDIT_JOURNAL_WRITE_REJECTED');
    assert.equal(housekeeping.controller.canWrite('chat','1','same'),false,'the write guard stays closed until storage is revalidated');
    housekeeping.failRead(true);
    const unreadable=await housekeeping.controller.recoverScope('chat');
    assert.equal(unreadable.ok,false,'a failed durable reread cannot clear the error');
    assert.equal(housekeeping.controller.canWrite('chat','1','same'),false);
    housekeeping.failRead(false);
    const recovered=await housekeeping.controller.recoverScope('chat');
    assert.equal(recovered.ok,true);assert.equal(recovered.recovered,true);
    assert.equal(housekeeping.controller.status().error,'');
    assert.equal(housekeeping.controller.canWrite('chat','1','same'),true,'same durable policy plus a fresh unchanged snapshot permits the ordinary capture retry');
    const journal=JSON.parse(housekeeping.storage.get('chat'));
    assert.deepEqual(journal.seenTurnIds,['u1','u2'],'the failed completed-turn receipt is re-inspected and durably recorded');
  }finally{housekeeping.controller.dispose();}

  const changedDuringRecovery=await make();try{
    changedDuringRecovery.addTurn('u2');changedDuringRecovery.failWrite();
    await explicitRequest(changedDuringRecovery.controller);
    assert.equal(changedDuringRecovery.controller.status().error,'SOURCE_EDIT_JOURNAL_WRITE_REJECTED');
    changedDuringRecovery.setUnit({key:'1',start:1,end:1,digest:'edited',sourceDigest:'edited',rawDigest:'raw-edited',originalDigest:'same',originalRawDigest:'raw-same',basis:'b',identity:'pair',changed:true,current:false});
    const recovered=await changedDuringRecovery.controller.recoverScope('chat');
    assert.equal(recovered.ok,true,'durable journal matched; current source was then inspected');
    assert.equal(changedDuringRecovery.controller.status().tasks[0].changeKind,'source_changed');
    assert.equal(changedDuringRecovery.controller.canWrite('chat','1','edited'),false,'a freshly detected real edit remains blocked until replacement completes');
  }finally{changedDuringRecovery.controller.dispose();}
});

test('recovery refuses an unpersisted task, exception, or source-rule baseline',async()=>{
  const make=async({changed=false,execute=null}={})=>{
    const storage=new Map();let failWrites=0,unit={key:'1',start:1,end:1,digest:changed?'edited':'same',sourceDigest:changed?'edited':'same',rawDigest:changed?'raw-edited':'raw-same',originalDigest:changed?'same':'',originalRawDigest:changed?'raw-same':'',basis:'b',identity:'pair',changed,current:!changed};
    const controller=context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
      read:async key=>storage.get(key)??null,
      write:async(key,value)=>{if(key==='chat'&&failWrites>0){failWrites--;return false;}storage.set(key,value);return true;},
      collect:async()=>({scopeKey:'chat',units:[{...unit}],completedTurnIds:[]}),
      execute:async(task,permit)=>{await permit.assertCurrent();if(execute)await execute();unit={...unit,digest:task.sourceDigest,sourceDigest:task.sourceDigest,changed:false,current:true};return{ok:true};}
    });
    await explicitRequest(controller);controller.afterRequest();
    return {controller,storage,setUnit:value=>{unit=value;},failWrite:()=>{failWrites++;}};
  };
  const task=await make();try{
    task.setUnit({key:'1',start:1,end:1,digest:'edited',sourceDigest:'edited',rawDigest:'raw-edited',originalDigest:'same',originalRawDigest:'raw-same',basis:'b',identity:'pair',changed:true,current:false});
    task.failWrite();
    await explicitRequest(task.controller);
    assert.equal(task.controller.status().error,'SOURCE_EDIT_JOURNAL_WRITE_REJECTED');
    const recovered=await task.controller.recoverScope('chat');
    assert.equal(recovered.ok,false,'a task missing from durable storage cannot be forgotten');
    assert.equal(task.controller.canWrite('chat','1','edited'),false);
  }finally{task.controller.dispose();}

  const exception=await make({changed:true});try{
    const task=exception.controller.status().tasks[0];assert.equal(task.state,'applied');
    exception.failWrite();
    await assert.rejects(()=>exception.controller.setException('chat','1',task.revisionId,true),/SOURCE_EDIT_JOURNAL_WRITE_REJECTED/);
    const recovered=await exception.controller.recoverScope('chat');
    assert.equal(recovered.ok,false,'an exception not present in the durable journal remains fail-closed');
    assert.equal(exception.controller.canWrite('chat','1','edited'),false);
  }finally{exception.controller.dispose();}

  const policy=await make();try{
    await policy.controller.setSourceRules({version:1,ignoredTags:[{open:'[private]',close:'[/private]'}],unwrapTags:[],sourceTags:[],controls:[]});
    policy.failWrite();
    await explicitRequest(policy.controller);
    assert.equal(policy.controller.status().error,'SOURCE_EDIT_JOURNAL_WRITE_REJECTED');
    const recovered=await policy.controller.recoverScope('chat');
    assert.equal(recovered.ok,false,'an unpersisted policy epoch/baseline transition cannot be discarded');
    assert.equal(policy.controller.status().error,'SOURCE_EDIT_JOURNAL_RECOVERY_DIVERGED');
  }finally{policy.controller.dispose();}
});
