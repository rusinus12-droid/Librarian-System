'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const instrument=s=>s.replace('    const stateDerivedWorldlineSuffix =',`    globalThis.__readCache = { storage, state, invalidateVerifiedRead, invalidateAllVerifiedReads,
      fresh: value => { freshReadDepth = value; },
      limits: {entry: VERIFIED_READ_CACHE_ENTRY_BYTES, total: VERIFIED_READ_CACHE_MAX_BYTES},
      age: () => { for (const row of verifiedReadCache.values()) row.at -= VERIFIED_READ_CACHE_TTL_MS; },
      ageFlights: () => { for (const row of verifiedReadFlights.values()) row.at -= VERIFIED_READ_CACHE_TTL_MS; } };
    const stateDerivedWorldlineSuffix =`).replace('  const serverBinding = () =>',
      '  globalThis.__advanceCacheBinding = () => { dataBinding.generation++; };\n  const serverBinding = () =>');
test('plugin cache TTL, isolation, invalidation, fresh bypass and byte budgets',async t=>{
 const r=await createLibraVmHarness({}, {},{transformSource:instrument});t.after(()=>r.cleanup());
 const c=r.context.__readCache,scope={_cachedMode:'plugin_only'},key='libra:v1:scope:cache-test:source-receipt-head:w:e0:t1';
 r.values.set(key,JSON.stringify({n:1}));
 const read=()=>c.storage.getVerifiedJson(key,scope);
 assert.equal((await read()).n,1);const before=r.storageReads.length,parsed=c.state.memoryNetworkIO.parsedRows;
 const got=await read();got.n=99;assert.equal((await read()).n,1);assert.equal(r.storageReads.length,before+2,'native currentness observes actual bytes');
 assert.equal(c.state.memoryNetworkIO.parsedRows,parsed,'unchanged native bytes reuse decode');
 r.values.set(key,JSON.stringify({n:2}));c.age();assert.equal((await read()).n,2);
 r.values.set(key,JSON.stringify({n:3}));c.fresh(1);assert.equal((await read()).n,3);c.fresh(0);
 c.invalidateVerifiedRead(key);assert.equal((await read()).n,3);
 await c.storage.setVerifiedJson(key,{n:4},scope);assert.equal((await read()).n,4);
 r.values.set(key,JSON.stringify({n:5}));c.state.microRestoreGeneration++;assert.equal((await read()).n,5);
 r.values.set(key,JSON.stringify({n:55}));r.context.__advanceCacheBinding();assert.equal((await read()).n,55,'connection generation changes invalidate hits');
 r.values.set(key,JSON.stringify({n:6}));assert.equal((await c.storage.getStoredJson(key)).n,6,'unscoped raw reads bypass');
 c.invalidateAllVerifiedReads();
 const large='libra:v1:scope:cache-test:large';r.values.set(large,JSON.stringify({text:'한'.repeat(80000)}));await c.storage.getVerifiedJson(large,scope);
 assert.equal(c.state.verifiedReadCacheStats.entries,0,'oversized entries rejected');
 for(let i=0;i<150;i++){const k=large+i;r.values.set(k,JSON.stringify({text:'한'.repeat(24000)}));await c.storage.getVerifiedJson(k,scope);}
 assert.ok(c.state.verifiedReadCacheStats.entries<150);assert.ok(c.state.verifiedReadCacheStats.bytes<=c.limits.total);
 c.age();await read();assert.equal(c.state.verifiedReadCacheStats.entries,1,'one access sweeps all expired entries');
 await c.storage.remove(key);assert.equal(await read(),null,'removal invalidates cached value');
 const missing=large+'-missing';
 assert.equal((await c.storage.getVerifiedJson(missing,scope,{fallback:1})).fallback,1);
 assert.equal((await c.storage.getVerifiedJson(missing,scope,{fallback:2})).fallback,2,'negative cache respects each caller fallback');
});
test('read overlapping a local write cannot repopulate stale cache',async t=>{
 const values=new Map();let hold=null;
 const backend={async getItem(k){const v=values.get(k)??null;if(hold&&k==='libra:v1:scope:cache-test:cache-race'){const h=hold;hold=null;h.started();await h.promise;}return v;},async setItem(k,v){values.set(k,v);return true;},async removeItem(k){values.delete(k);return true;},async keys(){return [...values.keys()];}};
 const r=await createLibraVmHarness({}, {pluginStorage:backend,safeLocalStorage:backend,getLocalPluginStorage:async()=>backend},{transformSource:instrument});t.after(()=>r.cleanup());
 const c=r.context.__readCache,scope={_cachedMode:'plugin_only'};values.set('libra:v1:scope:cache-test:cache-race','{"n":1}');
 let release,started;const ready=new Promise(r=>started=r);hold={promise:new Promise(r=>release=r),started};
 const pending=c.storage.getVerifiedJson('libra:v1:scope:cache-test:cache-race',scope);await ready;
 await c.storage.setJson('libra:v1:scope:cache-test:cache-race',{n:2});release();assert.equal((await pending).n,1);
 assert.equal((await c.storage.getVerifiedJson('libra:v1:scope:cache-test:cache-race',scope)).n,2);
});
test('a lost read flight expires and its late cleanup cannot capture a new read',async t=>{
 const key='libra:v1:scope:cache-test:lost-flight';let value='{"n":1}',reads=0,release,started;
 const ready=new Promise(r=>started=r),lost=new Promise(r=>release=r);
 const backend={async getItem(k){if(k!==key)return null;reads++;const snapshot=value;if(reads===1){started();await lost;}return snapshot;},async setItem(){return true;},async removeItem(){return true;},async keys(){return [];}};
 const r=await createLibraVmHarness({}, {pluginStorage:backend,safeLocalStorage:backend,getLocalPluginStorage:async()=>backend},{transformSource:instrument});t.after(()=>r.cleanup());
 const c=r.context.__readCache,scope={_cachedMode:'plugin_only'},first=c.storage.getVerifiedJson(key,scope);await ready;
 c.ageFlights();value='{"n":2}';assert.equal((await c.storage.getVerifiedJson(key,scope)).n,2);assert.equal(reads,2);
 release();assert.equal((await first).n,1);
 assert.equal((await c.storage.getVerifiedJson(key,scope)).n,2,'late old completion cannot authorize old native bytes');
});
