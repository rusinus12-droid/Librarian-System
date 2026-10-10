'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,cacheOf,read,open,hook,plain}=require('./wm-native-cache-support.cjs');

test('default native registered hook reaches C0 common cache without provider or enable flag',async()=>{
 const f=await fixture(),off=await fixture({config:{enabled:false}}),cache=cacheOf(f);assert.equal(f.native.bridge.mode,'native');assert.equal(f.native.bridge.read,undefined);
 const evidence=[];for(const phase of ['cold','warm']){f.physical.length=0;off.physical.length=0;const before=f.counts.total,control=off.counts.total,hits=cache.stats().core?.hits||0;const out=await hook(f),expected=await hook(off);assert.deepEqual(plain(out),plain(expected));assert.match(JSON.stringify(out),/Historical reference;/);assert.deepEqual(f.physical,off.physical);assert.ok(f.physical.length>1,'every original native read remains');assert.equal(cache.stats().requestOwners,0);assert.equal(cache.stats().requestBorrows,0);assert.equal(cache.stats().core.observations,0);assert.ok(cache.stats().core.hits>hits);evidence.push({phase,parses:f.counts.total-before,legacyParses:off.counts.total-control,physicalCalls:f.physical.length,physicalBytes:f.physical.reduce((n,x)=>n+x.bytes,0),stats:cache.stats()});}
 assert.equal(evidence[1].parses,evidence[1].legacyParses,'one-scope warm savings already existed');console.log('WM_NATIVE_COUNTS '+JSON.stringify(evidence));
});
test('fresh native reads create fresh wrappers while sharing only immutable parse artifacts',async()=>{
 const f=await fixture(),cache=cacheOf(f),owner=open(f),a=await read(f,owner),b=await read(f,owner);assert.equal(a.ok,true);assert.equal(b.ok,true);assert.notEqual(a,b);assert.equal(a.entries,b.entries);assert.equal(a.authoritySource,undefined);assert.equal(b.authoritySource,undefined);assert.equal(Object.isFrozen(b.entries),true);assert.equal(f.counts.total,1);assert.equal(f.physical.length,2);assert.ok(cache.stats().core.hits>=1);cache.releaseRequest(owner);assert.equal(cache.stats().core.owners,0);assert.equal(cache.stats().core.observations,0);
});
test('A B A gains bounded cross-scope parse reuse beyond native single-slot baseline',async()=>{
 const evidence=[];for(const config of [undefined,{enabled:false}]){const f=await fixture({config});const scopeB=f.scope.replace('|chat:','|chat:b-'),value=JSON.parse(f.raw);value.scopeKey=scopeB;f.r.store.set(f.d.storageKeyFor(scopeB),JSON.stringify(value));let first,last;
 for(const scope of [f.scope,scopeB,f.scope]){const owner=f.cache?.enabled?open(f):null;const got=await read(f,owner,scope);assert.equal(got.ok,true);if(!first)first=got;last=got;if(owner)f.cache.releaseRequest(owner);}
 evidence.push({parses:f.counts.total,physical:f.physical.length,same:first.entries===last.entries});}
 assert.deepEqual(evidence,[{parses:2,physical:3,same:true},{parses:3,physical:3,same:false}]);
});
test('large native fallback preserves repeated same-scope legacy parse count and accepted data',async()=>{
 const evidence=[];for(const config of [undefined,{enabled:false}]){const f=await fixture({config}),value=JSON.parse(f.raw);value.entries.push({comment:'lmai_extra',content:'x'.repeat(200000)});f.r.store.set(f.key,JSON.stringify(value));const owner=f.cache?.enabled?open(f):null;let first,last;for(let i=0;i<8;i++){last=await read(f,owner);assert.equal(last.ok,true);if(!first)first=last;}if(owner)f.cache.releaseRequest(owner);evidence.push({parses:f.counts.total,physical:f.physical.length,same:first.entries===last.entries,length:last.entries.at(-1).content.length});}
 assert.deepEqual(evidence,[{parses:1,physical:8,same:true,length:200000},{parses:1,physical:8,same:true,length:200000}]);
});
test('mutable management read stays independent from cached frozen readonly entries',async()=>{
 const f=await fixture(),owner=open(f),a=await read(f,owner),m=await f.d.readVerified(f.scope);assert.equal(Object.isFrozen(m.entries),false);m.entries.push({comment:'lmai_memory',content:'caller-only'});const b=await read(f,owner);assert.equal(b.entries,a.entries);assert.equal(b.entries.some(x=>x.content==='caller-only'),false);f.cache.releaseRequest(owner);
});
