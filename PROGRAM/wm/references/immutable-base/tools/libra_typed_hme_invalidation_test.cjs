'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,policy}=require('./libra_typed_graph_discovery_test.cjs');
const {runtime,flush}=require('./libra_typed_recall_queue_test.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const maintain=r=>r.api.MemoryEngine.maintainHmeTypedSourceGraph(r.snap({viewerId:'main_request'}));
const key=r=>[...r.store.keys()].find(k=>k.endsWith(':typed-graph'));
function hold(r,kind){let enter,release,held=false;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
 const original=r.storage[kind];r.storage[kind]=async(...args)=>{if(args[0].endsWith(':typed-graph')&&!held){held=true;enter();await gate;}return original(...args);};
 return {entered,release};
}
for(const action of ['clear','reset'])test(action+' clears typed RAM state and subsequent maintenance validates persisted data',async()=>{
 const r=await fixture('narrative');assert.equal((await maintain(r)).maintenance.mode,'built');
 if(action==='clear'){const cleared=r.api.MemoryEngine.clearDerivedCaches();assert(cleared.clearedEntries>0,'typed state must be included in clear accounting');}
 else r.api.MemoryState.reset();
 assert.equal((await maintain(r)).maintenance.mode,'restored');assert.equal(r.state.calls.length,0);
});
for(const action of ['clear','reset'])test(action+' invalidates maintenance suspended before storage write',async()=>{
 const r=await fixture('narrative'),gate=hold(r,'getItem');
 const work=maintain(r).then(value=>({value}),error=>({error}));await gate.entered;
 if(action==='clear')r.api.MemoryEngine.clearDerivedCaches();else r.api.MemoryState.reset();
 gate.release();const outcome=await work;
 assert(outcome.error,'invalidated queued work must reject');assert.match(outcome.error.message,/graph_source_invalidated/);
 assert.equal(key(r),undefined,'a clear before write prevents persistent publication');
 assert.equal((await maintain(r)).maintenance.mode,'built');assert.equal(r.state.calls.length,0);
});
test('clear during an already issued write prevents RAM installation and preserves ordered new work',async()=>{
 const r=await fixture('entity'),gate=hold(r,'setItem');
 const old=maintain(r).then(value=>({value}),error=>({error}));await gate.entered;
 r.api.MemoryEngine.clearDerivedCaches();gate.release();
 assert((await old).error,'the completed storage call cannot revive the cleared RAM state');
 const fresh=await maintain(r);assert.equal(fresh.maintenance.mode,'restored','the disk bytes are revalidated, not reused from old RAM');
 assert.equal(fresh.maintenance.independentDurabilityRead,false);assert.equal(r.state.calls.length,0);
});
test('a completed verified source reset invalidates old graph maintenance without relying on GUI reset',async()=>{
 const r=await fixture('narrative'),gate=hold(r,'getItem'),ds=r.api.LibraDataStorage;
 const old=maintain(r).then(value=>({value}),error=>({error}));await gate.entered;
 const canonicalScope=ds.scopeKeyFor(r.char,r.chat);
 assert.equal((await ds.resetVerified(canonicalScope,{expectedGeneration:0,isCurrent:async()=>true})).ok,true);
 gate.release();assert((await old).error);assert.equal(key(r),undefined);assert.equal((await ds.readVerified(canonicalScope)).resetGeneration,1);assert.equal(r.state.calls.length,0);
});
test('a newer queued source snapshot invalidates older maintenance before its physical write',async()=>{
 const r=await fixture('entity'),gate=hold(r,'getItem');let writes=0;const set=r.storage.setItem;
 r.storage.setItem=async(k,v)=>{if(k.endsWith(':typed-graph'))writes++;return set(k,v);};
 const old=maintain(r).then(value=>({value}),error=>({error}));await gate.entered;
 const entry=r.chat.localLore.find(e=>e.comment==='lmai_entity'),body=JSON.parse(entry.content);body.identity={...(body.identity||{}),summary:'Changed queued source'};
 entry.content=JSON.stringify(r.signed(body,'entity','target'));
 const newer=maintain(r);await flush();gate.release();
 assert((await old).error,'older maintenance cannot commit after newer source observation');
 const result=await newer;assert.equal(result.maintenance.mode,'built');assert.equal(writes,1);
 assert.equal((await maintain(r)).maintenance.mode,'reused');assert.equal(r.state.calls.length,0);
});
test('new source work waits for an invalidated in-flight physical write and remains the final stored version',async()=>{
 const r=await fixture('entity'),gate=hold(r,'setItem');let writes=0;const set=r.storage.setItem;
 r.storage.setItem=async(k,v)=>{if(k.endsWith(':typed-graph'))writes++;return set(k,v);};
 const old=maintain(r).then(value=>({value}),error=>({error}));await gate.entered;r.api.MemoryEngine.clearDerivedCaches();
 const entry=r.chat.localLore.find(e=>e.comment==='lmai_entity'),body=JSON.parse(entry.content);body.identity.summary='Final source after clear';entry.content=JSON.stringify(r.signed(body,'entity','target'));
 const newer=maintain(r);await flush();assert.equal(writes,1,'new physical write waits for the old issued call');gate.release();
 assert((await old).error);const current=await newer;assert.equal(current.maintenance.readbackVerified,true);assert.equal(writes,2);
 const raw=r.store.get(key(r));assert.equal((await maintain(r)).maintenance.mode,'reused');assert.equal(r.store.get(key(r)),raw);assert.equal(r.state.calls.length,0);
});
test('production Dual passes its request guard into graph maintenance while storage is delayed',async()=>{
 const r=await fixture('narrative'),gate=hold(r,'getItem');let writes=0;const set=r.storage.setItem;
 r.storage.setItem=async(k,v)=>{if(k.endsWith(':typed-graph'))writes++;return set(k,v);};
 const production=r.context.__QUEUE_TEST__.rollout.buildProductionRecallConfiguration(r.api.MemoryEngine.CONFIG).policy;
 const retrieve=()=>r.context.__QUEUE_TEST__.dual.retrieve('ORBITSEED',r.snap({viewerId:'main_request'}),null,production);
 const old=retrieve();await Promise.race([gate.entered,old.then(value=>{throw Error('production graph gate was not reached: '+value.trace.reason);})]);
 const entry=r.chat.localLore.find(e=>e.comment==='lmai_narrative'),body=JSON.parse(entry.content);body.storylines[0].continuityBrief='New query source observation';
 entry.content=JSON.stringify(r.signed(body,'narrative','narrative_state'));
 const newer=retrieve();await flush();gate.release();
 assert.equal((await old).trace.reason,'request_invalidated');assert((await newer).selection.length>0);assert.equal(writes,1);
 assert.equal(r.state.calls.length,0);
});
test('production request invalidation alone prevents internal graph writes before the outer return guard',async()=>{
 const r=await fixture('narrative'),gate=hold(r,'getItem');
 const production=r.context.__QUEUE_TEST__.rollout.buildProductionRecallConfiguration(r.api.MemoryEngine.CONFIG).policy;
 const work=r.context.__QUEUE_TEST__.dual.retrieve('ORBITSEED',r.snap({viewerId:'main_request'}),null,production);
 await Promise.race([gate.entered,work.then(value=>{throw Error('production graph gate was not reached: '+value.trace.reason);})]);r.api.MemoryState._activeScopeKey='another-active-chat';gate.release();
 assert.equal((await work).trace.reason,'request_invalidated');assert.equal(key(r),undefined,'outer rejection alone cannot authorize a stale internal persistent write');assert.equal(r.state.calls.length,0);
});
test('failed derived persistence is not reported durable and the next unchanged request retries',async()=>{
 const r=await fixture('narrative'),set=r.storage.setItem;let reject=true,writes=0;
 r.storage.setItem=async(k,v)=>{if(k.endsWith(':typed-graph')){writes++;if(reject)return false;}return set(k,v);};
 const first=await maintain(r);assert.equal(first.maintenance.readbackVerified,false);assert.equal(first.maintenance.independentDurabilityRead,false);assert.equal(key(r),undefined);
 reject=false;const second=await maintain(r);assert.equal(second.maintenance.readbackVerified,true);assert.equal(second.maintenance.rebuiltNodes,0);assert.equal(writes,2);
 assert(key(r));assert.equal((await maintain(r)).maintenance.mode,'reused');assert.equal(writes,2);
 const restarted=await runtime({store:r.store,cache:r.cache,lore:clone(r.chat.localLore)},{admittedHost:true});restarted.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 assert.equal((await maintain(restarted)).maintenance.mode,'restored');assert.equal(r.state.calls.length+restarted.state.calls.length,0);
});
test('a restart after an unacknowledged failed graph write rebuilds from current source',async()=>{
 const r=await fixture('narrative'),set=r.storage.setItem;
 r.storage.setItem=async(k,v)=>k.endsWith(':typed-graph')?false:set(k,v);
 assert.equal((await maintain(r)).maintenance.readbackVerified,false);assert.equal(key(r),undefined);
 const restarted=await runtime({store:r.store,cache:r.cache,lore:clone(r.chat.localLore)},{admittedHost:true});restarted.api.MemoryEngine.CONFIG.hmeAssociativeGraphMode='balanced';
 const rebuilt=await maintain(restarted);assert.equal(rebuilt.maintenance.mode,'built');assert.equal(rebuilt.maintenance.readbackVerified,true);assert.equal(rebuilt.maintenance.independentDurabilityRead,false);
 assert.equal(r.state.calls.length+restarted.state.calls.length,0);
});
