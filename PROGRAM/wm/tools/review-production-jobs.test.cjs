'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadGui,canonical}=require('./libra_management_gui_integration_test.cjs');
const embed={enabled:true,provider:'ollama',url:'http://127.0.0.1:9999',model:'tiny-3',dimension:3,modelRevision:'rev1',key:'',timeout:120000};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){for(let i=0;i<150;i++){if(fn())return;await sleep(10);}assert.fail('background lifecycle did not settle');}
async function setup(count=2,shared,options={}){
 const seed=await loadGui();const store=shared||seed.store,key=seed.key;seed.close();
 if(!shared)store.set(key,JSON.stringify({scopeKey:canonical,entries:Array.from({length:count},(_,i)=>({key:'lmai_memory::job-'+i,comment:'lmai_memory',content:'[META:'+JSON.stringify({t:i+1,ttl:-1,imp:8})+']\nJOB_MEMORY_'+i+' pendant promise'}))}));
 const activeEmbed={...embed,...options.embed};
 store.set('LMAI_Config',JSON.stringify({dualRecallMode:'dual',embed:activeEmbed}));
 const state={calls:[],pending:[],block:options.block===true,fail:options.fail===true};
 const f=await loadGui({store,nativeInitialization:true,args:{embedding_enabled:''},nativeFetch:async(url,init)=>{
  const body=JSON.parse(init.body);state.calls.push({url,body});
  const answer=()=>({ok:true,status:200,text:async()=>JSON.stringify({embeddings:[activeEmbed.dimension===3?[1,.25,-.5]:Array(activeEmbed.dimension).fill(.125)]})});
  if(state.fail)throw new Error('synthetic provider unavailable');
  if(state.block&&!String(body.input).includes('QUERY_NONBLOCKING'))return new Promise(resolve=>state.pending.push(()=>resolve(answer())));
  return answer();
 }});
 const roll=f.api.TypedRecallRollout,snapshot=()=>f.api.TypedRecallCorpus.refreshProduction({currentTurn:f.api.MemoryEngine.getCurrentTurn(),viewerId:'main_request'});
 const close=async()=>{roll.cancelAll?.();state.block=false;state.pending.splice(0).forEach(fn=>fn());await sleep(20);f.close();};
 return {...f,state,roll,snapshot,close};
}
test('actual native startup schedules missing canonical documents off chat and resumes bounded slices',async()=>{
 const f=await setup(35);try{try{await waitFor(()=>f.state.calls.length===35&&!f.roll.inspect().scheduler?.running);}finally{console.log("SCHEDULER_REVIEW "+JSON.stringify({calls:f.state.calls.length,scheduler:f.roll.inspect().scheduler}));}assert.equal(f.roll.inspect().scheduler.maxScopes,64);assert.equal(f.roll.inspect().scheduler.queueCap,64);assert.ok(f.roll.inspect().scheduler.scopes[0].slices>=3);assert.ok(f.roll.inspect().scheduler.scopes[0].last.calls<=16);assert.equal(f.roll.inspect().readiness.independentDurabilityRead,false);}finally{await f.close();}
});
test('registered beforeRequest completes while a startup document is held and starts zero inline documents',async()=>{
 const f=await setup(2,null,{block:true});try{await waitFor(()=>f.state.pending.length===1);const n=f.state.calls.length;let done=false;
  const pending=f.callbacks.beforeRequest({messages:[{role:'user',content:'QUERY_NONBLOCKING pendant promise'}],maxContextTokens:128000},'model').then(x=>{done=true;return x;});
  await waitFor(()=>done);assert.equal(f.state.calls.length,n+1,'only independent query call while background document remains held');assert.ok(f.state.pending.length===1);assert.ok(JSON.stringify(await pending).includes('Historical reference;'));assert.equal(f.roll.inspect().last.retrieval.trace.lanes.semantic.documentCalls,0);
 }finally{await f.close();}
});
test('production pending work coalesces to one running and one latest snapshot per scope',async()=>{
 const f=await setup(2,null,{block:true});try{await waitFor(()=>f.state.pending.length===1);const snap=await f.snapshot();for(let i=0;i<100;i++)assert.equal(f.roll.schedule({...snap,requestGeneration:snap.requestGeneration+i},'acknowledged_persist').ok,true);
  const s=f.roll.inspect().scheduler;assert.equal(s.running,1);assert.equal(s.queued,1);assert.equal(s.scopes.length,1);assert.equal(s.scopes[0].pending,true);assert.ok(s.scopes[0].coalesced>=99);
 }finally{await f.close();}
});
test('acknowledged actual persist schedules changed source and canonical or host rejection starts zero jobs',async()=>{
 const f=await setup(2);try{await waitFor(()=>f.state.calls.length===2&&!f.roll.inspect().scheduler?.running);const before=f.state.calls.length,entries=JSON.parse(f.store.get(f.key)).entries;
  const changed=JSON.parse(JSON.stringify(entries));changed[0].content+=' ACK_CHANGED_SOURCE';f.control.rejectWrites=true;
  assert.equal((await f.api.persistLoreToActiveChat(f.control.chat,changed)).ok,false);await sleep(50);assert.equal(f.state.calls.length,before);
  f.control.rejectWrites=false;f.control.rejectHostWrites=true;assert.equal((await f.api.persistLoreToActiveChat(f.control.chat,changed)).ok,false);await sleep(50);assert.equal(f.state.calls.length,before);
  f.control.rejectHostWrites=false;assert.equal((await f.api.persistLoreToActiveChat(f.control.chat,changed)).ok,true);await waitFor(()=>f.state.calls.length===before+1&&!f.roll.inspect().scheduler.running);
 }finally{await f.close();}
});
test('provider failure stops automatic retries and preserves usable heuristic chat',async()=>{
 const f=await setup(2,null,{fail:true});try{await waitFor(()=>f.state.calls.length>0&&!f.roll.inspect().scheduler?.running);const n=f.state.calls.length;await sleep(100);assert.equal(f.state.calls.length,n);await f.callbacks.beforeRequest({messages:[{role:'user',content:'pendant promise'}],maxContextTokens:128000},'model');assert.equal(f.roll.inspect().last.consumer.ok,true);assert.ok(f.roll.inspect().scheduler.scopes[0].last.diagnostics.length);}finally{await f.close();}
});
test('actual fresh startup reuses compatible acknowledged vectors without document calls',async()=>{
 const f=await setup(2);let next;try{await waitFor(()=>f.state.calls.length===2&&!f.roll.inspect().scheduler?.running);next=await setup(2,f.store);await waitFor(()=>next.roll.inspect().scheduler?.scopes[0]?.last?.complete);assert.equal(next.state.calls.length,0);assert.equal(next.roll.inspect().scheduler.scopes[0].last.reused,2);}finally{await next?.close();await f.close();}
});
test('actual fresh startup preserves unfinished attempt uncertainty without automatic retry',async()=>{
 const f=await setup(1,null,{block:true});let next;try{await waitFor(()=>f.state.pending.length===1);next=await setup(1,f.store);await waitFor(()=>next.roll.inspect().scheduler?.scopes[0]?.last);assert.equal(next.state.calls.length,0);assert.ok(next.roll.inspect().scheduler.scopes[0].last.diagnostics.some(d=>d.reason==='attempt_uncertain'));assert.ok([...next.store.keys()].some(k=>k.endsWith(':intent')));}finally{await next?.close();await f.close();}
});
for(const change of ['source','model','modelRevision','url','key','reset','persona','dimension','provider'])test('held production background '+change+' cannot publish old vector and history is retained',async()=>{
 const f=await setup(1,null,{block:true});try{await waitFor(()=>f.state.pending.length===1);const history=[...f.store.keys()].filter(k=>k.endsWith(':intent'));
  if(change==='source'){const env=JSON.parse(f.store.get(f.key));env.entries[0].content+=' NEW_SOURCE';f.store.set(f.key,JSON.stringify(env));}
  else if(change==='reset'){const env=JSON.parse(f.store.get(f.key));env.entries=[];env.resetGeneration=1;f.store.set(f.key,JSON.stringify(env));}
  else if(change==='persona')f.control.chat.bindedPersona='persona-b';
  else{const config=f.api.MemoryEngine.CONFIG;config.embed={...config.embed,[change]:change==='url'?'http://127.0.0.1:9998':change==='key'?'SYNTHETIC_AUTH_712':change==='model'?'new-tiny':change==='dimension'?5:change==='provider'?'openai':'rev2'};f.roll.configureProduction(config);}
  f.state.block=false;f.state.pending.splice(0).forEach(fn=>fn());await sleep(120);
  const rows=[...f.store].filter(([k])=>k.includes(':row:')).map(([,v])=>JSON.parse(v));
  if(['source','reset','persona','key','dimension','provider'].includes(change))assert.equal(rows.length,0);
  else assert.ok(rows.every(r=>r.provider[change==='url'?'endpoint':change]!== (change==='url'?'http://127.0.0.1:9999/api/embed':change==='model'?'tiny-3':'rev1')));
  for(const key of history)assert.ok(f.store.has(key),'old uncertain namespace remains');assert.ok(!JSON.stringify(f.roll.inspect()).includes('SYNTHETIC_AUTH_712'));
 }finally{await f.close();}
});
test('actual unload cancels scheduled and running background publication',async()=>{const f=await setup(1,null,{block:true});try{await waitFor(()=>f.state.pending.length===1);for(const callback of f.callbacks.unload)await callback();f.state.pending.splice(0).forEach(fn=>fn());await sleep(80);assert.equal([...f.store.keys()].filter(k=>k.includes(':row:')).length,0);assert.equal(f.roll.inspect().scheduler.queued,0);}finally{await f.close();}});
test('64 actually admitted scopes bound scheduler queue and a 65th scope cannot allocate work',async()=>{
 const f=await setup(1,null,{block:true});try{
  await waitFor(()=>f.state.pending.length===1);assert.equal(f.roll.schedule(await f.snapshot(),'bounded_resume').ok,true);
  for(let i=1;i<=64;i++){
   const chat={id:'bounded-'+i,bindedPersona:'persona-a',localLore:[],message:[],msgs:[]};f.control.chat=chat;f.control.char.chats[0]=chat;
   const scope='char:fixture-char|chat:bounded-'+i+'|persona:persona-a';f.store.set(f.api.LibraDataStorage.storageKeyFor(scope),JSON.stringify({scopeKey:scope,entries:[]}));
   const activation=await f.api.PersonaRuntimeCoordinator.activate({char:f.control.char,chat});assert.equal(activation.ok,true);
   const result=f.roll.schedule(await f.snapshot(),'scope_activation');assert.equal(result.ok,i<64);if(i===64)assert.equal(result.reason,'production_scope_bound');
  }
  const s=f.roll.inspect().scheduler;assert.equal(s.scopes.length,64);assert.equal(s.running,1);assert.equal(s.queued,64);assert.equal(f.state.calls.length,1,'no documents started for inactive queued scopes');
 }finally{await f.close();}
});

test('8192-dimensional native startup resumes work-byte bounded slices with unchanged vectors',async()=>{
 const f=await setup(5,null,{embed:{dimension:8192,model:'synthetic-8192'}});try{
  await waitFor(()=>f.state.calls.length===5&&!f.roll.inspect().scheduler?.running);
  const s=f.roll.inspect().scheduler;console.log('SCHEDULER_WORK_BOUND '+JSON.stringify({calls:f.state.calls.length,scheduler:s}));
  assert.equal(s.queued,0);assert.equal(s.scopes[0].slices,3);assert.equal(s.scopes[0].last.complete,true);assert.equal(s.scopes[0].last.canContinue,false);
  const rows=[...f.store].filter(([k])=>k.includes(':row:')).map(([,v])=>JSON.parse(v));assert.equal(rows.length,5);for(const row of rows){assert.equal(row.vector.length,8192);assert(row.vector.every(x=>x===.125));}
 }finally{await f.close();}
});
