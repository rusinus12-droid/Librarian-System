'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const candidate=path.resolve(__dirname,'..');
const {runtime}=require(candidate+'/tools/integration-runtime.cjs');
const {createReferenceProvider}=require(candidate+'/tools/reference-snapshot-provider.cjs');
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
async function fixture({maxValueNodes=100000,enabled=true,wrap,rawTransform}={}) {
 const p=createReferenceProvider(),config={enabled,qualification:{kind:'test-fixture',reference:'independent-lifetime',version:'1'},budgets:{maxBytes:4*1024*1024,maxValueNodes}};
 const r=await runtime(wrap?wrap(p):p,{dist:process.env.WM_VERSIONED_DIST||path.join(candidate,'dist/LIBRA World Manager Full.js'),transformCode(code){const seam='snapshotAuthority: globalThis.__SNAPSHOT_PROVIDER__';assert.equal(code.split(seam).length,2);code=code.replace(seam,seam+', snapshotDerivedCache: '+JSON.stringify(config));const end=code.lastIndexOf('})();');return code.slice(0,end)+';globalThis.__WM_DERIVED_TEST__=WmReadonlyDerivedCache;'+code.slice(end);}});
 const d=r.api.LibraDataStorage,b=r.context.__WM_SNAPSHOT_TEST__.bridge,scope=d.scopeKeyFor(r.char,r.chat),raw0=r.store.get(d.storageKeyFor(scope)),raw=rawTransform?rawTransform(raw0):raw0,cache=r.context.__WM_DERIVED_TEST__;
 await p.seed(scope,raw);return {p,r,d,b,scope,raw,cache};
}
test('unchanged-source capacity fallback succeeds and fully releases',async()=>{
 const f=await fixture({maxValueNodes:1}),o=f.b.openRequest(),got=await f.d.readVerified(f.scope,{readonly:true,authorityRequest:o});assert.equal(got.ok,true);assert.ok(got.entries.length>0);assert.equal(f.cache.stats().budgetFallbacks,1);assert.equal(f.cache.stats().core.entries,0);assert.equal((await f.b.finalObservation(o)).ok,true);f.b.finishRequest(o);await f.cache.drain();assert.equal(f.cache.stats().requestOwners,0);assert.equal(f.cache.stats().requestBorrows,0);assert.equal(f.p.activeLeases(),0);await f.b.dispose();assert.equal(f.cache.stats().core.totalBytes,0);
});
for(const mode of ['close','dispose','fresh-head-change'])test('capacity fallback rejects '+mode,async()=>{
 const entered=defer(),resume=defer();let armed=false;
 const f=await fixture({maxValueNodes:1,wrap:p=>({...p,observeHeads:async scopes=>{if(armed){armed=false;entered.resolve();await resume.promise;}return p.observeHeads(scopes);}})});
 const prior=await f.d.readVerified(f.scope),o=f.b.openRequest();armed=true;
 const pending=f.d.readVerified(f.scope,{readonly:true,authorityRequest:o});await entered.promise;
 if(mode==='close')await f.b.closeRequest(o);
 if(mode==='dispose')await f.b.dispose();
 if(mode==='fresh-head-change')assert.equal((await f.b.commit(f.scope,prior.authoritySource,f.raw,'restore')).ok,true);
 resume.resolve();const got=await pending;assert.equal(got.ok,false);
 await f.b.closeRequest(o);await f.b.dispose();await f.cache.drain();assert.equal(f.cache.stats().core.jobs,0);assert.equal(f.cache.stats().core.totalBytes,0);assert.equal(f.p.activeLeases(),0);
});
test('warm hit rejects invalidation after old HEAD observation and cannot republish',async()=>{
 const entered=defer(),resume=defer();let armed=false;
 const f=await fixture({wrap:p=>({...p,observeHeads:async scopes=>{const observed=await p.observeHeads(scopes);if(armed){armed=false;entered.resolve();await resume.promise;}return observed;}})});
 const a=f.b.openRequest(),prior=await f.d.readVerified(f.scope,{readonly:true,authorityRequest:a});assert.equal(prior.ok,true);await f.b.closeRequest(a);
 const o=f.b.openRequest();armed=true;const pending=f.d.readVerified(f.scope,{readonly:true,authorityRequest:o});await entered.promise;
 assert.equal((await f.b.commit(f.scope,prior.authoritySource,f.raw,'restore')).ok,true);const got=await pending;assert.equal(got.ok,false);
 resume.resolve();await f.cache.drain();assert.equal(f.cache.stats().core.entries,0);await f.b.closeRequest(o);await f.b.dispose();assert.equal(f.p.activeLeases(),0);
});
test('canonical optional number valid under cache-off is accepted cache-on',async()=>{
 const rawTransform=raw=>raw.replace('"entries":[','"entries":[{"comment":"lmai_optional","content":"optional numeric field","testNumericOverflow":1e400},');
 for(const enabled of [false,true]){
  const f=await fixture({enabled,rawTransform}),o=f.b.openRequest(),got=await f.d.readVerified(f.scope,{readonly:true,authorityRequest:o});
  console.log('OVERFLOW_SUPPORT '+JSON.stringify({enabled,ok:got.ok,reason:got.reason,overflow:got.entries?.[0]?.testNumericOverflow===Infinity}));
  await f.b.closeRequest(o);await f.b.dispose();if(enabled)await f.cache.drain();
  assert.equal(got.ok,true,'optional overflowed JSON numeric metadata accepted by canonical parser should not fail only when cache is enabled');
 }
});
