'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');

const code=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8');
const context=vm.createContext({setTimeout,clearTimeout,Date,console});
vm.runInContext(code,context);

const unit={key:'1',start:1,end:1,digest:'new',sourceDigest:'new',rawDigest:'raw-new',originalDigest:'old',
  originalRawDigest:'raw-old',basis:'basis-new',identity:'pair-1',changed:true,current:false,changeKind:'source_changed'};
const reviewRow=(overrides={})=>({key:'1',currentValid:true,previousUnavailable:false,
  beforeText:'Alice <draft>signed</draft> the office agreement.',afterText:'Alice <draft>did not sign</draft> the office agreement.',...overrides});

function makeController(storage,{loadReview,metrics,writeControl={failWrites:0},completedTurns={ids:[]}}={}){
  return context.createMemorySuiteSourceEditConsent({owner:'libra',requestBoundary:true,
    read:async key=>storage.get(key)??null,
    write:async(key,value)=>{if(key==='chat'&&writeControl.failWrites>0){writeControl.failWrites--;return false;}storage.set(key,value);return true;},
    collect:async()=>({scopeKey:'chat',units:[{...unit}],completedTurnIds:[...completedTurns.ids]}),
    loadReview,
    execute:async(_task,permit)=>{await permit.assertCurrent();metrics.providerCalls++;metrics.embeddingCalls++;return{ok:true};}
  });
}

test('verified source review creates a bounded cause log that survives reload without repeating analysis',async()=>{
  const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0},reviewRows=[reviewRow()];let reviews=0;
  const loadReview=async(_tasks,scopeKey)=>{reviews++;return{scopeKey,rows:reviewRows};};
  const first=makeController(storage,{loadReview,metrics});
  try{
    await first.beforeRequest();
    const status=first.status(),task=status.tasks[0],event=status.events[0];
    assert.equal(reviews,1);
    assert.equal(task.cause.status,'available');
    assert.equal(task.cause.category,'source_content_changed');
    assert.equal(task.cause.ruleIdentifier,'source_projection:visible_content');
    assert.equal(task.cause.beforeExcerpt,'signed');
    assert.equal(task.cause.afterExcerpt,'did not sign');
    assert.equal(JSON.stringify(task.cause.exceptionRule),JSON.stringify({category:'ignoredTags',wrapper:{open:'<draft>',close:'</draft>'}}));
    assert.deepEqual(event.cause,task.cause);
    assert.ok(Array.from(task.cause.beforeExcerpt).length<=96);
    assert.ok(Array.from(task.cause.afterExcerpt).length<=96);
    assert.deepEqual(metrics,{providerCalls:1,embeddingCalls:1},'cause capture must not call analysis or embedding independently');
    first.afterRequest();
  }finally{first.dispose();}

  const reloaded=makeController(storage,{loadReview:async()=>{throw Error('existing revision must not be reviewed again');},metrics});
  try{
    await reloaded.beforeRequest();
    assert.equal(reloaded.status().events[0].cause.afterExcerpt,'did not sign');
    assert.equal(metrics.providerCalls,1);
    assert.equal(metrics.embeddingCalls,1);
  }finally{reloaded.dispose();}
});

test('review failure and missing old evidence are explicit and do not gate before-request automatic processing',async()=>{
  const cases=[
    {review:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow({previousUnavailable:true,beforeText:''})]}),reason:'previous_source_unavailable'},
    {review:async()=>{throw Error('SOURCE_REVIEW_STORAGE_UNAVAILABLE');},reason:'review_unavailable'}
  ];
  for(const item of cases){
    const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0};
    const controller=makeController(storage,{loadReview:item.review,metrics});
    try{
      await controller.beforeRequest();
      const cause=controller.status().events[0].cause;
      assert.equal(cause.status,'unavailable');
      assert.equal(cause.reason,item.reason);
      assert.equal(cause.diffAvailable,false);
      assert.equal('beforeExcerpt' in cause,false);
      assert.equal('afterExcerpt' in cause,false);
      assert.equal(controller.status().tasks[0].state,'applied');
      assert.deepEqual(metrics,{providerCalls:1,embeddingCalls:1});
    }finally{controller.dispose();}
  }
});

test('cause excerpts truncate each side at 96 Unicode code points without storing full source text',async()=>{
  const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0};
  const longBefore='한🧠'.repeat(70),longAfter='가🚀'.repeat(70);
  const controller=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow({beforeText:longBefore,afterText:longAfter})]}),metrics});
  try{
    await controller.beforeRequest();
    const cause=controller.status().events[0].cause;
    assert.equal(Array.from(cause.beforeExcerpt).length,96);
    assert.equal(Array.from(cause.afterExcerpt).length,96);
    assert.equal(cause.beforeTruncated,true);
    assert.equal(cause.afterTruncated,true);
    assert.equal(JSON.stringify(storage.get('chat')).includes(longBefore),false);
    assert.equal(JSON.stringify(storage.get('chat')).includes(longAfter),false);
  }finally{controller.dispose();}
});

test('body changes outside an unchanged tag remain a content exception and never suggest ignoring that tag',async()=>{
  const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0};
  const controller=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow({
    beforeText:'<draft>Alice signed.</draft> The office is open.',
    afterText:'<draft>Alice did not sign.</draft> The office is closed.'
  })]}),metrics});
  try{
    await controller.beforeRequest();
    const cause=controller.status().events[0].cause;
    assert.equal(cause.status,'available');
    assert.equal(cause.diffAvailable,true);
    assert.equal('exceptionRule' in cause,false,'an unrelated outside change survives projection and must not be masked by a tag rule');
    assert.equal(cause.afterExcerpt,'did not sign.</draft> The office is closed');
  }finally{controller.dispose();}
});

test('only exact wrappers found on both sides can suggest one proven existing taxonomy rule',async()=>{
  const examples=[
    {category:'ignoredTags',beforeText:'A <draft>signed</draft> the paper.',afterText:'A <draft>did not sign</draft> the paper.'},
    {category:'ignoredTags',beforeText:'> Alice <draft>signed</draft> the paper.',afterText:'> Alice <draft>did not sign</draft> the paper.'},
    {category:'ignoredTags',beforeText:'- Alice <draft>signed</draft> the paper.',afterText:'- Alice <draft>did not sign</draft> the paper.'},
    {category:'ignoredTags',beforeText:'10. Alice said the clause was\n    <draft>old</draft>.',afterText:'10. Alice said the clause was\n    <draft>new</draft>.'},
    {category:'ignoredTags',beforeText:'1. Alice said the clause was\n   <draft>old</draft>.',afterText:'1. Alice said the clause was\n   <draft>new</draft>.'},
    {category:'unwrapTags',beforeText:'The <mark>old</mark> clause.',afterText:'The old <mark>clause</mark>.'},
    {category:'sourceTags',beforeText:'[original]the source[/original] EN: one',afterText:'[original]the source[/original] EN: two'},
    {category:'ignoredTags',beforeText:'A [OPEN]old[CLOSE] clause.',afterText:'A [OPEN]new[CLOSE] clause.'}
  ];
  for(const example of examples){
    const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0};
    const controller=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow(example)]}),metrics});
    try{
      await controller.beforeRequest();
      const candidate=controller.status().events[0].cause.exceptionRule;
      assert.equal(candidate?.category,example.category,`${example.category} must be proven by full-text reprojection`);
      assert.ok(candidate.wrapper.open&&candidate.wrapper.close);
      assert.deepEqual(metrics,{providerCalls:1,embeddingCalls:1});
    }finally{controller.dispose();}
  }
});

test('ambiguous, one-sided, or oversized wrapper scans do not suggest a rule',async()=>{
  const examples=[
    {beforeText:'<outer><inner>old</inner></outer>',afterText:'<outer><inner>new</inner></outer>'},
    {beforeText:'<draft>a</draft>',afterText:'draft a'},
    {beforeText:'<hayaku_packet_contract>old</hayaku_packet_contract>',afterText:'<hayaku_packet_contract>new</hayaku_packet_contract>'},
    {beforeText:'<draft>a</draft>'+'x'.repeat(33000),afterText:'<draft>b</draft>'+'x'.repeat(33000)}
  ];
  for(const example of examples){
    const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0};
    const controller=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow(example)]}),metrics});
    try{
      await controller.beforeRequest();
      assert.equal(controller.status().events[0].cause.exceptionRule,undefined);
      assert.equal(controller.status().events[0].cause.diffAvailable,true);
      assert.ok(Array.from(controller.status().events[0].cause.beforeExcerpt).length<=96);
      assert.ok(Array.from(controller.status().events[0].cause.afterExcerpt).length<=96);
      assert.deepEqual(metrics,{providerCalls:1,embeddingCalls:1});
    }finally{controller.dispose();}
  }
});

test('literal tag examples inside Markdown and HTML code regions do not suggest exceptions',async()=>{
  const examples=[
    {beforeText:'The literal is `<draft>old</draft>` in this example.',afterText:'The literal is `<draft>new</draft>` in this example.'},
    {beforeText:'The literal is `\n<draft>old</draft>\n` in this example.',afterText:'The literal is `\n<draft>new</draft>\n` in this example.'},
    {beforeText:'```html\n<draft>old</draft>\n```',afterText:'```html\n<draft>new</draft>\n```'},
    {beforeText:'~~~html\n<draft>old</draft>\n~~~',afterText:'~~~html\n<draft>new</draft>\n~~~'},
    {beforeText:'<pre><code><draft>old</draft></code></pre>',afterText:'<pre><code><draft>new</draft></code></pre>'},
    {beforeText:'<code><draft>old</draft></code>',afterText:'<code><draft>new</draft></code>'},
    {beforeText:'> ~~~html\n> <draft>old</draft>\n> ~~~',afterText:'> ~~~html\n> <draft>new</draft>\n> ~~~'},
    {beforeText:'- ~~~html\n  <draft>old</draft>\n  ~~~',afterText:'- ~~~html\n  <draft>new</draft>\n  ~~~'},
    {beforeText:'    <draft>old</draft>',afterText:'    <draft>new</draft>'},
    {beforeText:'- > ~~~html\n  > <draft>old</draft>\n  > ~~~',afterText:'- > ~~~html\n  > <draft>new</draft>\n  > ~~~'},
    {beforeText:'- ```html\n  > <draft>old</draft>\n  > ```',afterText:'- ```html\n  > <draft>new</draft>\n  > ```'}
  ];
  for(const example of examples){
    const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0};
    const controller=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow(example)]}),metrics});
    try{
      await controller.beforeRequest();
      const cause=controller.status().events[0].cause;
      assert.equal(cause.diffAvailable,true,'literal example changes remain available as a diff');
      assert.equal(cause.exceptionRule,undefined,'literal markup in code must not become a verified wrapper rule');
      assert.deepEqual(metrics,{providerCalls:1,embeddingCalls:1});
    }finally{controller.dispose();}
  }
});

test('failed legacy-cause migration keeps recovery aligned and hides orphan excerpts until durable cleanup',async()=>{
  const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0},writeControl={failWrites:0};
  const first=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow()]}),metrics});
  let revisionId;
  try{await first.beforeRequest();revisionId=first.status().tasks[0].revisionId;}finally{first.dispose();}
  const legacy=JSON.parse(storage.get('chat'));legacy.events=[];storage.set('chat',JSON.stringify(legacy));
  const reloaded=makeController(storage,{metrics,writeControl});
  try{
    writeControl.failWrites=1;
    await assert.rejects(()=>reloaded.setException('chat','1',revisionId,true),/SOURCE_EDIT_JOURNAL_WRITE_REJECTED/);
    assert.equal('cause' in reloaded.status('chat').tasks[0],false,'status must not expose orphan cause data when migration persistence fails');
    assert.ok(JSON.parse(storage.get('chat')).tasks['1'].cause,'failed persistence leaves the legacy durable journal intact');
    const recovered=await reloaded.recoverScope('chat');
    assert.equal(recovered.ok,true,'rolling back the failed RAM migration must let recovery compare the durable journal');
    assert.equal('cause' in JSON.parse(storage.get('chat')).tasks['1'],false,'recovery must persist the orphan scrub before clearing the guard');
    assert.equal('cause' in reloaded.status('chat').tasks[0],false);
  }finally{reloaded.dispose();}
});

test('failed history deletion and TTL writes roll back RAM before recovery',async()=>{
  const create=async()=>{
    const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0},writeControl={failWrites:0};
    const controller=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow()]}),metrics,writeControl});
    await controller.beforeRequest();
    return {storage,controller,writeControl};
  };
  const deleted=await create();try{
    const event=deleted.controller.status().events[0];deleted.writeControl.failWrites=1;
    await assert.rejects(()=>deleted.controller.deleteEvent('chat',event.id),/SOURCE_EDIT_JOURNAL_WRITE_REJECTED/);
    assert.equal(deleted.controller.status('chat').events.length,1,'failed deletion must restore the event in RAM');
    assert.equal(deleted.controller.status('chat').tasks[0].cause.afterExcerpt,'did not sign');
    const deletionRecovery=await deleted.controller.recoverScope('chat');assert.equal(deletionRecovery.ok,true);
  }finally{deleted.controller.dispose();}

  const expired=await create();try{
    for(let n=1;n<10;n++)await expired.controller.recordCompletedTurn('chat',`turn-${n}`);
    expired.writeControl.failWrites=1;
    await assert.rejects(()=>expired.controller.recordCompletedTurn('chat','turn-10'),/SOURCE_EDIT_JOURNAL_WRITE_REJECTED/);
    assert.equal(expired.controller.status('chat').events.length,1,'failed TTL must restore the event in RAM');
    assert.equal(expired.controller.status('chat').tasks[0].cause.afterExcerpt,'did not sign');
    assert.equal((await expired.controller.recoverScope('chat')).ok,true);
    await expired.controller.recordCompletedTurn('chat','turn-10');
    assert.equal(expired.controller.status('chat').events.length,0);
    assert.equal('cause' in JSON.parse(expired.storage.get('chat')).tasks['1'],false);
  }finally{expired.controller.dispose();}
});

test('failed beforeRequest turn-pruning write restores event and excerpt until recovery rechecks the snapshot',async()=>{
  const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0},writeControl={failWrites:0},completedTurns={ids:[]};
  const controller=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow()]}),metrics,writeControl,completedTurns});
  try{
    await controller.beforeRequest();controller.afterRequest();
    completedTurns.ids.push(...Array.from({length:10},(_,index)=>`logical-${index+1}`));
    writeControl.failWrites=1;
    await controller.beforeRequest();controller.afterRequest();
    assert.equal(controller.status('chat').error,'SOURCE_EDIT_JOURNAL_WRITE_REJECTED');
    assert.equal(controller.status('chat').events.length,1,'failed beforeRequest TTL persistence must restore the event');
    assert.equal(controller.status('chat').tasks[0].cause.afterExcerpt,'did not sign');
    const ramTask=controller.status('chat').tasks[0],durableTask=JSON.parse(storage.get('chat')).tasks['1'];
    const differingFields=Object.keys(durableTask).filter(field=>JSON.stringify(ramTask[field])!==JSON.stringify(durableTask[field]));
    assert.deepEqual(differingFields,[],'failed TTL inspection must leave task guard fields equal to storage');
    const ramJournal=(await controller.loadScope('chat')).data,durableJournal=JSON.parse(storage.get('chat'));
    const guardSections=['tasks','exceptions','sourceRuleEpoch','sourceRuleBaseline','trackingEpoch','trackingBaseline'];
    const differingSections=guardSections.filter(section=>JSON.stringify(ramJournal[section])!==JSON.stringify(durableJournal[section]));
    assert.deepEqual(differingSections,[],'failed TTL inspection must leave every recovery-guard section aligned');
    const recovered=await controller.recoverScope('chat');
    assert.equal(recovered.ok,true,'recovery must compare aligned RAM and durable history before reinspecting turns');
    assert.equal(controller.status('chat').events.length,0,'recovery inspection must then apply the ten-turn expiry');
    assert.equal('cause' in JSON.parse(storage.get('chat')).tasks['1'],false);
  }finally{controller.dispose();}
});

test('failed legacy scrub of a running task recovers through interrupted and resumes automatic processing',async()=>{
  const storage=new Map(),metrics={providerCalls:0,embeddingCalls:0},writeControl={failWrites:0};
  const first=makeController(storage,{loadReview:async(_tasks,scopeKey)=>({scopeKey,rows:[reviewRow()]}),metrics});
  let revisionId;
  try{await first.beforeRequest();revisionId=first.status().tasks[0].revisionId;}finally{first.dispose();}
  const running=JSON.parse(storage.get('chat'));running.events=[];running.tasks['1'].state='running';storage.set('chat',JSON.stringify(running));
  const reloaded=makeController(storage,{metrics,writeControl});
  try{
    writeControl.failWrites=1;
    await assert.rejects(()=>reloaded.setException('chat','1',revisionId,true),/SOURCE_EDIT_JOURNAL_WRITE_REJECTED/);
    assert.equal('cause' in reloaded.status('chat').tasks[0],false,'orphaned cause remains hidden while durable scrub is rejected');
    assert.equal(reloaded.status('chat').tasks[0].state,'running','rollback must preserve the original durable running state for guard comparison');
    writeControl.failWrites=1;
    const failedRecovery=await reloaded.recoverScope('chat');
    assert.equal(failedRecovery.ok,false,'startup state normalization must remain guarded if its own persistence is rejected');
    assert.equal(reloaded.status('chat').tasks[0].state,'running','failed recovery normalization rolls RAM back to the durable running task');
    assert.equal(JSON.parse(storage.get('chat')).tasks['1'].state,'running');
    const recovered=await reloaded.recoverScope('chat');
    assert.equal(recovered.ok,true,'recovery compares the exact durable state, then commits the normal startup transition');
    assert.equal(reloaded.status('chat').tasks[0].state,'interrupted');
    assert.equal(JSON.parse(storage.get('chat')).tasks['1'].state,'interrupted','startup recovery transition must itself be durable');
    await reloaded.beforeRequest();
    assert.equal(reloaded.status('chat').tasks[0].state,'applied','a later request resumes the interrupted automatic task');
    assert.equal(metrics.providerCalls,2);
  }finally{reloaded.dispose();}
});
