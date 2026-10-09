'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {runtime,request}=require('./integration-runtime.cjs'),{createReferenceProvider}=require('./reference-snapshot-provider.cjs');
const dist=process.env.WM_VERSIONED_DIST||path.join(__dirname,'../dist/LIBRA World Manager Full.js');
const config={enabled:true,qualification:{kind:'test-fixture',reference:'wm-common-derived-controlled',version:'1'},budgets:{maxBytes:4*1024*1024,maxEntries:8,maxFlights:8,maxSubscribers:32,maxOwners:64,maxObservations:64,maxValueNodes:100000}};
const tick=()=>new Promise(r=>setImmediate(r)),defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
async function fixture({enabled=true,cacheConfig=config,wrap,provider=true}={}){
 const p=createReferenceProvider(),r=await runtime(provider?(wrap?wrap(p):p):undefined,{dist,transformCode(code){
 const seam='snapshotAuthority: globalThis.__SNAPSHOT_PROVIDER__';assert.equal(code.split(seam).length,2);code=code.replace(seam,seam+', snapshotDerivedCache: '+JSON.stringify(enabled?cacheConfig:null));
 const end=code.lastIndexOf('})();');return code.slice(0,end)+';globalThis.__WM_DERIVED_TEST__=typeof WmReadonlyDerivedCache!=="undefined"?WmReadonlyDerivedCache:null;'+code.slice(end);
 }});const d=r.api.LibraDataStorage,b=r.context.__WM_SNAPSHOT_TEST__.bridge,scope=d.scopeKeyFor(r.char,r.chat),key=d.storageKeyFor(scope),raw=r.store.get(key);if(provider)await p.seed(scope,raw);
 return {p,r,d,b,scope,key,raw,cache:r.context.__WM_DERIVED_TEST__};
}
function cacheOf(f){assert.ok(f.cache,'WM derived adapter is not implemented');return f.cache;}
const read=async(f,owner)=>f.d.readVerified(f.scope,{readonly:true,authorityRequest:owner});
async function commit(f,raw,operation='normal'){return require('../src/wm-versioned-snapshot.cjs').createSnapshotAuthority(f.p).commit({scope:f.scope,expectedHead:await f.p.peek(f.scope),raw,operation,operationId:crypto.randomUUID()});}

test('adapter remains disabled without explicit fixture configuration',async()=>{const f=await fixture({enabled:false});assert.equal(cacheOf(f).enabled,false);const o=f.b.openRequest();assert.equal((await read(f,o)).ok,true);await f.b.closeRequest(o);assert.equal(f.p.activeLeases(),0);});
test('native C0 never activates provider cache even when requested',async()=>{const f=await fixture({provider:false});assert.equal(cacheOf(f).enabled,false);const before=await f.d.readVerified(f.scope,{readonly:true});assert.equal(before.ok,true);f.r.store.delete(f.key);assert.equal((await f.d.readVerified(f.scope,{readonly:true})).missing,true);});
test('explicit production qualification is refused by this test-only adapter',async()=>{await assert.rejects(()=>fixture({cacheConfig:{...config,qualification:{kind:'reviewed-provider',reference:'not-authorized',version:'1'}}}),/wm_derived_cache_test_only/);});
test('separate requests share only immutable parsed data and keep fresh receipts and one whole read each',async()=>{
 const f=await fixture(),cache=cacheOf(f);f.p.resetCounters();const a=f.b.openRequest(),x=await read(f,a);assert.equal(x.ok,true);assert.equal(Object.isFrozen(x.entries),true);assert.equal(cache.stats().parseLoads,1);await f.b.closeRequest(a);assert.equal(cache.stats().requestBorrows,0);assert.equal(f.p.activeLeases(),0);
 const b=f.b.openRequest(),y=await read(f,b);assert.equal(y.ok,true);assert.equal(y.entries,x.entries);assert.notEqual(y.authoritySource,x.authoritySource);assert.notEqual(y,x);assert.equal(cache.stats().parseLoads,1);assert.equal(f.p.counters().wholePayloadReads,2);await f.b.closeRequest(b);assert.equal(cache.stats().requestBorrows,0);assert.ok(cache.stats().core.retainedBytes>0);assert.equal(f.b.diagnostics().requestOwnedBytes,0);
});
test('mutable management read never receives cached frozen entries or contaminates them',async()=>{
 const f=await fixture(),cache=cacheOf(f),a=f.b.openRequest(),x=await read(f,a);await f.b.closeRequest(a);const mutable=await f.d.readVerified(f.scope);assert.equal(Object.isFrozen(mutable.entries),false);mutable.entries.push({comment:'lmai_memory',key:'caller-only',content:'not committed'});const b=f.b.openRequest(),y=await read(f,b);assert.equal(y.entries.some(e=>e.key==='caller-only'),false);assert.equal(y.entries,x.entries);await f.b.closeRequest(b);assert.equal(cache.stats().requestBorrows,0);
});
test('same-byte restore forces a different epoch-bound parse proof',async()=>{
 const f=await fixture(),cache=cacheOf(f),a=f.b.openRequest();const x=await read(f,a);await f.b.closeRequest(a);assert.equal((await commit(f,f.raw,'restore')).ok,true);const b=f.b.openRequest(),y=await read(f,b);assert.equal(y.ok,true);assert.notEqual(y.entries,x.entries);assert.equal(cache.stats().parseLoads,2);await f.b.closeRequest(b);
});
test('first owner close during a shared parse observation does not poison a surviving peer',async()=>{
 const gate=defer();let armed=false;
 const f=await fixture({wrap:p=>({...p,observeHeads:async scopes=>{if(armed)await gate.promise;return p.observeHeads(scopes)}})}),cache=cacheOf(f),a=f.b.openRequest(),b=f.b.openRequest();armed=true;const x=read(f,a),y=read(f,b);for(let i=0;i<8;i++)await tick();await f.b.closeRequest(a);assert.equal((await x).ok,false);gate.resolve();const good=await y;assert.equal(good.ok,true);assert.equal(cache.stats().parseLoads,1);await f.b.closeRequest(b);await cache.drain();assert.equal(cache.stats().requestBorrows,0);assert.equal(f.p.activeLeases(),0);
});
test('close or dispose during pending metadata rejects late proof and releases derivative resources',async()=>{
 const gate=defer();let armed=false;const f=await fixture({wrap:p=>({...p,observeHeads:async scopes=>{if(armed)await gate.promise;return p.observeHeads(scopes)}})}),cache=cacheOf(f),o=f.b.openRequest();armed=true;const x=read(f,o);for(let i=0;i<8;i++)await tick();await f.b.dispose();assert.equal((await x).ok,false);gate.resolve();await cache.drain();assert.equal(cache.stats().requestBorrows,0);assert.equal(cache.stats().core.totalBytes,0);assert.equal(cache.stats().core.jobs,0);assert.equal(f.p.activeLeases(),0);
});
test('cache budget miss uses same verified source uncached without a new data-size limit',async()=>{
 const f=await fixture({cacheConfig:{...config,budgets:{...config.budgets,maxBytes:512}}}),cache=cacheOf(f),o=f.b.openRequest();f.p.resetCounters();const x=await read(f,o);assert.equal(x.ok,true);assert.ok(x.entries.length>0);assert.ok(cache.stats().budgetFallbacks>0);assert.equal(cache.stats().core.entries,0);assert.equal(f.p.counters().wholePayloadReads,1);await f.b.closeRequest(o);assert.equal(cache.stats().requestBorrows,0);
});
test('failed source observation never falls back to a previous parse or native blob',async()=>{
 let bad=false;const f=await fixture({wrap:p=>({...p,observeHeads:async scopes=>{if(bad)throw Error('offline');return p.observeHeads(scopes)}})}),cache=cacheOf(f),a=f.b.openRequest();assert.equal((await read(f,a)).ok,true);await f.b.closeRequest(a);bad=true;const b=f.b.openRequest();assert.equal((await read(f,b)).ok,false);assert.equal(cache.stats().budgetFallbacks,0);await f.b.closeRequest(b);
});
test('writer admission failure alone does not invalidate unrelated parsed generations',async()=>{
 const f=await fixture(),cache=cacheOf(f),a=f.b.openRequest(),x=await read(f,a);await f.b.closeRequest(a);const before=cache.stats().core.invalidations;assert.equal((await f.d.save(f.r.char,f.r.chat,[])).reason,'authority_write_token_required');const b=f.b.openRequest(),y=await read(f,b);assert.equal(y.entries,x.entries);assert.equal(cache.stats().core.invalidations,before);await f.b.closeRequest(b);
});
test('registered cold and warm output stays exact and cache savings do not claim a second whole-read reduction',async()=>{
 const cached=await fixture(),control=await fixture({enabled:false});const cache=cacheOf(cached);
 for(const f of [cached,control]){f.r.chat.message=Array.from({length:10},(_,i)=>[{role:'user',data:'A asks about pendant '+i},{role:'assistant',data:'A replies in city '+i}]).flat();f.r.api.MemoryEngine.CONFIG.injectionUnknownHostCapTokens=8000;f.r.api.MemoryEngine.CONFIG.injectionBudgetMaxTokens=16000;}
 const evidence=[];
 for(const phase of ['cold','warm']){cached.p.resetCounters();control.p.resetCounters();const before=cache.stats().parseLoads;const got=await cached.r.api.libraBeforeRequestReplacer(request(),'model'),expected=await control.r.api.libraBeforeRequestReplacer(request(),'model');assert.equal(JSON.stringify(got),JSON.stringify(expected));assert.match(JSON.stringify(got),/Historical reference;/);assert.equal(cached.p.counters().wholePayloadReads,1);assert.equal(control.p.counters().wholePayloadReads,1);assert.equal(cache.stats().requestBorrows,0);assert.equal(cached.p.activeLeases(),0);evidence.push({phase,cacheParseLoads:cache.stats().parseLoads-before,cached:cached.p.counters(),control:control.p.counters(),cache:cache.stats()});}
 assert.ok(evidence[0].cacheParseLoads>0);assert.equal(evidence[1].cacheParseLoads,0);assert.equal(cached.r.state.calls.length,0);console.log('WM_DERIVED_COUNTS '+JSON.stringify(evidence));
});

test('confirmed scope publication invalidates that scope without cancelling a different active scope',async()=>{
 const f=await fixture(),cache=cacheOf(f),otherScope=f.scope.replace('|chat:','|chat:other-');await f.p.seed(otherScope,JSON.stringify({scopeKey:otherScope,entries:[]}));
 const a=f.b.openRequest(),b=f.b.openRequest(),one=await read(f,a),two=await f.d.readVerified(otherScope,{readonly:true,authorityRequest:b});assert.equal(one.ok,true);assert.equal(two.ok,true);assert.equal(cache.stats().parseLoads,2);
 const result=await f.d.saveVerified(f.scope,one.entries,{expectedSource:one.authoritySource,isCurrent:async()=>true});assert.equal(result.ok,true);assert.equal(cache.stats().core.invalidations,1);
 const peer=await f.d.readVerified(otherScope,{readonly:true,authorityRequest:b});assert.equal(peer.ok,true);assert.equal(peer.entries,two.entries);assert.equal(cache.stats().parseLoads,2);assert.equal((await read(f,a)).ok,false);
 await f.b.closeRequest(a);await f.b.closeRequest(b);const fresh=f.b.openRequest(),next=await read(f,fresh);assert.equal(next.ok,true);assert.equal(cache.stats().parseLoads,3);await f.b.closeRequest(fresh);assert.equal(f.p.activeLeases(),0);
});
for(const fault of ['restore','branch','secret','rollout'])test('cache hit still enforces actual post-release final '+fault+' gate',async()=>{
 let armed=false,changed=false,f;
 f=await fixture({wrap:p=>({...p,observeHeads:async scopes=>{
  if(armed&&!changed&&p.activeLeases()===0){changed=true;if(fault==='restore')assert.equal((await commit(f,f.raw,'restore')).ok,true);if(fault==='branch')f.r.chat.branchId='cache-final-branch';if(fault==='rollout')f.r.context.__QUEUE_TEST__.rollout.begin();if(fault==='secret')f.r.context.__WM_SNAPSHOT_TEST__.secret.getState().secrets.push({id:'cache-secret',content:'민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.',knownBy:['user'],status:'active'});}
  return p.observeHeads(scopes);
 }})});const cache=cacheOf(f);f.r.chat.message=Array.from({length:10},(_,i)=>[{role:'user',data:'A asks about pendant '+i},{role:'assistant',data:'A replies in city '+i}]).flat();f.r.api.MemoryEngine.CONFIG.injectionUnknownHostCapTokens=8000;f.r.api.MemoryEngine.CONFIG.injectionBudgetMaxTokens=16000;
 assert.match(JSON.stringify(await f.r.api.libraBeforeRequestReplacer(request(),'model')),/Historical reference;/);const parses=cache.stats().parseLoads;armed=true;
 const out=await f.r.api.libraBeforeRequestReplacer(request(),'model');assert.equal(changed,true);assert.doesNotMatch(JSON.stringify(out),/Historical reference;/);if(fault==='secret')assert.ok(!JSON.stringify(out).includes('민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.'));assert.equal(cache.stats().parseLoads,parses);assert.equal(cache.stats().requestBorrows,0);assert.equal(f.p.activeLeases(),0);
});
test('true reset and delete preserve origin-bound writers and cannot resurrect cached entries',async()=>{
 const f=await fixture(),cache=cacheOf(f),a=f.b.openRequest(),before=await read(f,a);await f.b.closeRequest(a);
 assert.equal((await f.d.resetVerified(f.scope,{expectedGeneration:before.resetGeneration,expectedSource:before.authoritySource,isCurrent:async()=>true})).ok,true);
 const b=f.b.openRequest(),reset=await read(f,b);assert.equal(reset.ok,true);assert.equal(reset.entries.length,0);assert.equal(reset.resetGeneration,1);assert.notEqual(reset.authoritySource,before.authoritySource);await f.b.closeRequest(b);
 const removed=await f.d.remove(f.r.char,f.r.chat,{expectedSource:reset.authoritySource});assert.equal(removed.ok,true);const c=f.b.openRequest(),missing=await read(f,c);assert.equal(missing.ok,true);assert.equal(missing.missing,true);assert.equal(missing.entries.length,0);await f.b.closeRequest(c);assert.equal(cache.stats().requestBorrows,0);
});
