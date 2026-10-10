'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runtime,flush}=require('./libra_typed_recall_queue_test.cjs');
const request=()=>({messages:[{role:'system',content:'Host scenario: A enters the city.'},{role:'user',content:'A asks about the pendant promise, the city oath and what happened.'}],maxContextTokens:128000,maxResponseTokens:4096});
const roll=r=>r.context.__QUEUE_TEST__.rollout;
const embed={enabled:true,provider:'ollama',url:'http://127.0.0.1:9999',model:'tiny-3',modelRevision:'rev1',dimension:3,key:'',timeout:120000};
async function prepare(settings={},args={}){const r=await runtime(null,{admittedHost:true,settings,args});r.chat.message=Array.from({length:10},(_,i)=>[{role:'user',data:'A asks about the pendant '+i},{role:'assistant',data:'A replies in the city '+i}]).flat();r.api.MemoryEngine.CONFIG.injectionUnknownHostCapTokens=8000;r.api.MemoryEngine.CONFIG.injectionBudgetMaxTokens=16000;return r;}
test('actual product startup defaults to production Dual and registered beforeRequest emits typed heuristic with no provider calls',async()=>{const r=await prepare();assert.equal(r.api.MemoryEngine.CONFIG.dualRecallMode,'dual');assert.equal(roll(r).inspect().productionEligible,true);assert.equal(roll(r).inspect().readiness.semanticReady,false);const output=await r.api.libraBeforeRequestReplacer(request(),'model'),trace=roll(r).inspect().last;assert.equal(trace.mode,'dual');assert.equal(trace.consumer.ok,true);assert.ok(trace.consumer.trace.blocks.some(b=>b.kind==='recall'));assert.ok(JSON.stringify(output).includes('Historical reference;'));assert.equal(r.state.calls.length,0);});
test('saved explicit legacy remains legacy through actual fresh startup and registered request',async()=>{const r=await prepare({dualRecallMode:'legacy'});assert.equal(r.api.MemoryEngine.CONFIG.dualRecallMode,'legacy');assert.equal(roll(r).begin(),null);await r.api.libraBeforeRequestReplacer(request(),'model');assert.equal(r.state.calls.length,0);});
test('saved shadow activates production observation and keeps legacy final payload',async()=>{const r=await prepare({dualRecallMode:'shadow'});assert.equal(r.api.MemoryEngine.CONFIG.dualRecallMode,'shadow');assert.equal(roll(r).inspect().productionEligible,true);const output=await r.api.libraBeforeRequestReplacer(request(),'model');assert.equal(roll(r).inspect().last.mode,'shadow');assert.ok(!JSON.stringify(output).includes('Historical reference;'));assert.equal(r.state.calls.length,0);});
test('nonempty runtime mode/depth/budget/RRF args override saved values in actual production handle',async()=>{const r=await prepare({dualRecallMode:'legacy',dualRecallHeuristicDepth:12,dualRecallSemanticDepth:13,dualRecallRrfK:60,dualRecallQueryBudgetMs:1500},{dual_recall_mode:'dual',dual_recall_heuristic_depth:'4',dual_recall_semantic_depth:'7',dual_recall_rrf_k:'20',dual_recall_query_budget_ms:'250'});assert.equal(r.api.MemoryEngine.CONFIG.dualRecallMode,'dual');const h=roll(r).begin();assert.ok(h);assert.equal(h.policy.heuristicDepth,4);assert.equal(h.policy.semanticDepth,7);assert.equal(h.policy.rrf.k,20);assert.equal(h.policy.queryBudgetMs,250);assert.equal(h.policy.mode,'production');assert.equal(h.policy.calibrationLabel,'uncalibrated operational default');});
test('valid saved strict provider reaches query-only registered consumer without configureFixture',async()=>{const r=await prepare({embed},{embedding_enabled:''});assert.equal(r.api.MemoryEngine.CONFIG.embed.dimension,3);assert.equal(r.api.MemoryEngine.CONFIG.embed.modelRevision,'rev1');const h=roll(r).begin();assert.ok(h);assert.equal(h.provider.dimension,3);assert.equal(h.provider.modelRevision,'rev1');assert.equal(h.provider.endpoint,'http://127.0.0.1:9999/api/embed');assert.equal(roll(r).inspect().readiness.semanticConfigured,true);assert.equal(roll(r).inspect().readiness.semanticReady,false);const snapshot=r.snap({viewerId:'main_request'});const filled=await r.jobs.backfill(snapshot,h.provider,h.policy,{explicit:true,budget:{maxCalls:16,maxRows:32,maxBytes:1048576,maxMillis:10000}});assert.equal(filled.ok,true);const docs=r.state.calls.length;r.host.nativeFetch=async(url,init)=>{r.state.calls.push({role:'query',url,body:JSON.parse(init.body)});return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})};};const output=await r.api.libraBeforeRequestReplacer(request(),'model'),trace=roll(r).inspect().last;assert.equal(trace.mode,'dual');assert.equal(trace.consumer.ok,true);assert.equal(r.state.calls.length,docs+1);assert.equal(trace.retrieval.trace.lanes.semantic.queryCalls,1);assert.equal(trace.retrieval.trace.lanes.semantic.documentCalls,0);for(const f of ['memory','entity','world','narrative'])assert.ok(trace.consumer.trace.blocks.some(b=>b.kind==='recall'&&b.family===f),f);assert.ok(JSON.stringify(output).includes('identity='));});
test('unknown dimension/revision and unsupported provider visibly degrade semantic work while heuristic chat remains active',async()=>{for(const profile of [{...embed,dimension:null},{...embed,modelRevision:''},{...embed,provider:'voyageai'}]){const r=await prepare({embed:profile},{embedding_enabled:''});assert.equal(r.api.MemoryEngine.CONFIG.dualRecallMode,'dual');const state=roll(r).inspect();assert.equal(state.productionEligible,true);assert.equal(state.readiness.semanticReady,false);assert.ok(state.readiness.reason);assert.equal(roll(r).begin().provider,null);await r.api.libraBeforeRequestReplacer(request(),'model');assert.equal(r.state.calls.length,0);assert.equal(roll(r).inspect().last.consumer.ok,true);}});
test('production semantic admission is independent of lexical evidence and still rejects explicit hard exclusions',async()=>{const r=await prepare({embed},{embedding_enabled:''}),handle=roll(r).begin();assert.ok(handle);const snapshot=r.snap(),unit=r.all.find(u=>u.family==='entity');const candidate={identity:unit.identity,lane:'semantic',query:'ZERO_LEXICAL_987654',score:.99,margin:.1};const accepted=r.context.__QUEUE_TEST__.dual.admit(candidate,unit,snapshot,handle.policy);assert.equal(accepted.ok,true);assert.equal(accepted.evidence.independentAdmission,true);assert.equal(accepted.evidence.lexicalOverlap,0);const denied=r.context.__QUEUE_TEST__.dual.admit(candidate,unit,{...snapshot,scopeKey:'foreign'},handle.policy);assert.equal(denied.ok,false);});

test('production independent semantic admission and user/scope hard gates apply to every family',async()=>{
  const r=await prepare({embed},{embedding_enabled:''}),h=roll(r).begin(),snapshot=r.snap(),dual=r.context.__QUEUE_TEST__.dual;
  for(const family of ['memory','entity','world','narrative']){
    const unit=r.all.find(u=>u.family===family),candidate={identity:unit.identity,lane:'semantic',query:'ZERO_LEXICAL_987654',score:.99,margin:.1};
    const p=JSON.parse(JSON.stringify(h.policy));p.admission[family].heuristicMinScore=10000;
    const accepted=dual.admit(candidate,unit,snapshot,p);assert.equal(accepted.ok,true,family);assert.equal(accepted.evidence.lexicalOverlap,0,family);
    assert.equal(dual.admit({...candidate,lane:'heuristic',score:0},unit,snapshot,p).ok,false,family+' soft heuristic gate');
    assert.equal(dual.admit(candidate,unit,snapshot,{...p,exclusions:{identities:[unit.identity]}}).ok,false,family+' user exclusion');
    assert.equal(dual.admit(candidate,unit,{...snapshot,scopeKey:'foreign'},p).ok,false,family+' scope');
  }
});

test('unsafe production policy is refused at both retrieval and consumer boundary',async()=>{
  const r=await prepare(),h=roll(r).begin(),snapshot=r.snap(),p={...h.policy,schema:'forged-production-policy'};
  const result=await r.context.__QUEUE_TEST__.dual.retrieve('pendant',snapshot,null,p);assert.equal(result.selection.length,0);assert.equal(result.trace.reason,'policy_not_frozen');
  assert.throws(()=>r.context.__QUEUE_TEST__.consumers.compose({snapshot,policy:p}),/consumer_policy_required/);assert.equal(r.state.calls.length,0);
});

test('invalid saved admission visibly keeps its configuration reason after registered heuristic request',async()=>{
  const r=await prepare({embed,dualRecallAdmission:{memory:{semanticMinScore:2}}},{embedding_enabled:''});
  assert.equal(roll(r).begin().provider,null);assert.equal(roll(r).inspect().readiness.reason,'invalid_admission');
  await r.api.libraBeforeRequestReplacer(request(),'model');assert.equal(roll(r).inspect().last.consumer.ok,true);assert.equal(r.state.calls.length,0);
  assert.equal(roll(r).inspect().readiness.reason,'invalid_admission');assert.equal(roll(r).inspect().readiness.semanticConfigured,false);
});

for(const change of ['key','modelRevision','url'])test('production reconfiguration discards held query for '+change+' without leaking credentials',async()=>{
  const r=await prepare({embed},{embedding_enabled:''}),h=roll(r).begin(),snapshot=r.snap();
  await r.jobs.backfill(snapshot,h.provider,h.policy,{explicit:true,budget:{maxCalls:16,maxRows:32,maxBytes:1048576,maxMillis:10000}});
  r.state.blockQuery=true;const pending=roll(r).retrieve(h,'QUERY:pendant',snapshot);await flush();assert.equal(r.state.pending.length,1);
  const signature=roll(r).inspect().signature,changed={...embed,[change]:change==='key'?'SYNTHETIC_PRIVATE_AUTH_2741':change==='url'?'http://127.0.0.1:9998':'rev2'};
  const next=roll(r).configureProduction({...r.api.MemoryEngine.CONFIG,embed:changed});assert.equal(next.ok,true);
  if(change==='key')assert.equal(next.signature,signature,'public signature excludes auth while private generation changes');
  r.state.blockQuery=false;r.state.pending.splice(0).forEach(f=>f());const old=await pending;
  assert.equal(old.selection.length,0);assert.equal(old.reason,'rollout_disabled');assert.equal(h.guard(),false);
  assert.ok(!JSON.stringify(roll(r).inspect()).includes('SYNTHETIC_PRIVATE_AUTH_2741'));
});

test('configured production query budget terminates held semantic work without documents on critical path',async()=>{
  const r=await prepare({embed,dualRecallQueryBudgetMs:250},{embedding_enabled:''}),h=roll(r).begin(),snapshot=r.snap();
  await r.jobs.backfill(snapshot,h.provider,h.policy,{explicit:true,budget:{maxCalls:16,maxRows:32,maxBytes:1048576,maxMillis:10000}});const calls=r.state.calls.length;
  r.state.blockQuery=true;const pending=roll(r).retrieve(h,'QUERY:pendant',snapshot);await flush();assert.equal(r.state.pending.length,1);
  await r.advance(251);const result=await pending;assert.equal(r.state.calls.length,calls+1);assert.equal(result.trace.lanes.semantic.documentCalls,0);
  assert.notEqual(result.trace.lanes.semantic.status,'ready');assert.ok(result.trace.lanes.semantic.reason);assert.equal(h.policy.queryBudgetMs,250);
  r.state.blockQuery=false;r.state.pending.splice(0).forEach(f=>f());await flush();
});

test('independent production lane depths reach actual retrieval bounds',async()=>{
  const r=await prepare({embed,dualRecallHeuristicDepth:1,dualRecallSemanticDepth:2},{embedding_enabled:''}),h=roll(r).begin(),snapshot=r.snap();
  await r.jobs.backfill(snapshot,h.provider,h.policy,{explicit:true,budget:{maxCalls:16,maxRows:32,maxBytes:1048576,maxMillis:10000}});
  const result=await roll(r).retrieve(h,'QUERY:pendant promise city oath happened',snapshot);
  assert.equal(result.trace.lanes.heuristic.returned,1);assert.equal(result.trace.lanes.semantic.returned,2);
  assert.equal(result.trace.lanes.semantic.queryCalls,1);assert.equal(result.trace.lanes.semantic.documentCalls,0);
});

test('registered production recall takes same-key owned canonical truth over conflicting host rows and leaves native references outside storage',async()=>{
 const r=await prepare();const key=r.api.LibraDataStorage.storageKeyFor(r.api.LibraDataStorage.scopeKeyFor(r.char,r.chat));
 const envelope=JSON.parse(r.store.get(key));
 for(const entry of envelope.entries.filter(e=>e.comment==='lmai_memory'))entry.content+=' CANONICAL_PROMISE_CURRENT pendant promise';
 r.store.set(key,JSON.stringify(envelope));
 for(const entry of r.chat.localLore.filter(e=>e.comment==='lmai_memory'))entry.content+=' HOST_CONFLICT_STALE pendant promise';
 r.chat.localLore.push({key:'native-reference',comment:'user-reference',content:'NATIVE_REFERENCE_PRESERVED'});
 const output=JSON.stringify(await r.api.libraBeforeRequestReplacer(request(),'model'));
 assert.ok(output.includes('CANONICAL_PROMISE_CURRENT'),'owned canonical text reaches final registered payload');
 assert.ok(!output.includes('HOST_CONFLICT_STALE'),'conflicting host row cannot emit');
 assert.ok(!r.store.get(key).includes('NATIVE_REFERENCE_PRESERVED'),'native references never copied into canonical');
 assert.ok(r.chat.localLore.some(e=>e.key==='native-reference'),'native host reference remains');
});
for(const change of ['content','deletion','reset','persona','identity','worldline','provider'])test('registered production held query rereads canonical and rejects stale '+change,async()=>{
 const r=await prepare({embed},{embedding_enabled:''}),h=roll(r).begin(),snapshot=r.snap({viewerId:'main_request'});
 const key=r.api.LibraDataStorage.storageKeyFor(r.api.LibraDataStorage.scopeKeyFor(r.char,r.chat));
 const envelope=JSON.parse(r.store.get(key));for(const entry of envelope.entries.filter(e=>e.comment==='lmai_memory'))entry.content+=' HELD_OLD_PROMISE pendant promise';
 r.store.set(key,JSON.stringify(envelope));r.chat.localLore=JSON.parse(JSON.stringify(envelope.entries));
 await r.jobs.backfill(r.snap({viewerId:'main_request'}),h.provider,h.policy,{explicit:true,budget:{maxCalls:16,maxRows:32,maxBytes:1048576,maxMillis:10000}});
 let release,started;const start=new Promise(resolve=>started=resolve);
 r.host.nativeFetch=async()=>{started();return new Promise(resolve=>release=()=>resolve({ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})}));};
 const pending=r.api.libraBeforeRequestReplacer(request(),'model');await start;
 const changed=JSON.parse(r.store.get(key));
 if(change==='content'){for(const entry of changed.entries.filter(e=>e.comment==='lmai_memory'))entry.content=entry.content.replace('HELD_OLD_PROMISE','HELD_NEW_PROMISE');r.store.set(key,JSON.stringify(changed));}
 if(change==='deletion'){changed.entries=changed.entries.filter(e=>e.comment!=='lmai_memory');r.store.set(key,JSON.stringify(changed));}
 if(change==='reset'){changed.entries=[];changed.resetGeneration=1;r.store.set(key,JSON.stringify(changed));}
 if(change==='persona')r.chat.bindedPersona='typed-persona-b';
 if(change==='identity')r.chat.id='another-chat';
 if(change==='worldline')await r.api.LibraTurnWorldline.observe(snapshot.worldlineScopeKey,[{pairIndex:1,userText:'changed',assistantText:'changed reroll'}]);
 if(change==='provider')roll(r).configureProduction({...r.api.MemoryEngine.CONFIG,embed:{...embed,modelRevision:'rev2'}});
 release();const output=JSON.stringify(await pending);
 assert.ok(!output.includes('HELD_OLD_PROMISE'),'stale held '+change+' memory cannot emit');
 assert.equal(r.state.calls.filter(c=>c.role==='document').length,envelope.entries.length>0?r.all.length:0,'no document embedding on request');
});

for(const family of ['entity','world','narrative'])test('owned canonical '+family+' text also governs required baseline with same-key host conflict',async()=>{
 const r=await prepare(),key=r.api.LibraDataStorage.storageKeyFor(r.api.LibraDataStorage.scopeKeyFor(r.char,r.chat)),env=JSON.parse(r.store.get(key));
 const comment={entity:'lmai_entity',world:'lmai_world_graph',narrative:'lmai_narrative'}[family],canonical=env.entries.find(e=>e.comment===comment),host=r.chat.localLore.find(e=>e.key===canonical.key);
 const modify=(entry,marker)=>{let row=JSON.parse(entry.content);
  if(family==='entity'){row.currentState={summary:marker+' pendant promise'};row=r.signed(row,'entity',row.name);}
  if(family==='world')row.nodes[0][1].rules.custom.oath=marker+' city oath pendant promise';
  if(family==='narrative'){row.storylines[0].continuityBrief=marker+' pendant promise';row=r.signed(row,'narrative','narrative_state');}
  entry.content=JSON.stringify(row);
 };
 modify(canonical,'OWNED_'+family.toUpperCase());modify(host,'HOST_STALE_'+family.toUpperCase());r.store.set(key,JSON.stringify(env));
 const output=JSON.stringify(await r.api.libraBeforeRequestReplacer(request(),'model'));
 assert.ok(output.includes('OWNED_'+family.toUpperCase()),'fresh canonical family visible');assert.ok(!output.includes('HOST_STALE_'+family.toUpperCase()),'stale required baseline rejected');
});
test('canonical mutation during the actual registered formatter is rejected after final asynchronous admission',async()=>{
 const r=await prepare(),key=r.api.LibraDataStorage.storageKeyFor(r.api.LibraDataStorage.scopeKeyFor(r.char,r.chat)),env=JSON.parse(r.store.get(key));
 for(const entry of env.entries.filter(e=>e.comment==='lmai_memory'))entry.content+=' FINAL_FORMATTER_OLD pendant promise';r.store.set(key,JSON.stringify(env));
 const original=r.corpus.adapters.memory.formatter;let changed=false;
 r.corpus.adapters.memory.formatter=(unit,snapshot,options)=>{const formatted=original(unit,snapshot,options);if(!changed){changed=true;const latest=JSON.parse(r.store.get(key));latest.entries=latest.entries.filter(e=>e.comment!=='lmai_memory');r.store.set(key,JSON.stringify(latest));}return formatted;};
 const output=JSON.stringify(await r.api.libraBeforeRequestReplacer(request(),'model'));assert.equal(changed,true);assert.ok(!output.includes('FINAL_FORMATTER_OLD'));
});
