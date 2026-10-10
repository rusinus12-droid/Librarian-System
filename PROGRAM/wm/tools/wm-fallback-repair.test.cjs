'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {runtime}=require('./integration-runtime.cjs'),{createReferenceProvider}=require('./reference-snapshot-provider.cjs');
const dist=process.env.WM_VERSIONED_DIST||path.join(__dirname,'../dist/LIBRA World Manager Full.js');
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
async function fixture(kind,{enabled=true,sign='1e400'}={}){
 const p=createReferenceProvider(),entered=defer(),resume=defer();let armed=false;
 const wrapped={...p,observeHeads:async scopes=>{const observed=await p.observeHeads(scopes);if(armed){armed=false;entered.resolve(observed);await resume.promise;}return observed;}};
 const cfg={enabled,qualification:{kind:'test-fixture',reference:'wm-fallback-repair',version:'1'},budgets:{maxBytes:4*1024*1024,maxValueNodes:kind==='capacity'?1:100000}};
 const r=await runtime(wrapped,{dist,transformCode(code){const seam='snapshotAuthority: globalThis.__SNAPSHOT_PROVIDER__';assert.equal(code.split(seam).length,2);code=code.replace(seam,seam+', snapshotDerivedCache: '+JSON.stringify(cfg));const end=code.lastIndexOf('})();');return code.slice(0,end)+';globalThis.__WM_DERIVED_TEST__=WmReadonlyDerivedCache;'+code.slice(end);}});
 const d=r.api.LibraDataStorage,b=r.context.__WM_SNAPSHOT_TEST__.bridge,scope=d.scopeKeyFor(r.char,r.chat),raw0=r.store.get(d.storageKeyFor(scope)),raw=kind==='representation'?raw0.replace('"entries":[','"entries":[{"comment":"lmai_optional","content":"optional numeric field","testNumericOverflow":'+sign+'},'):raw0;
 await p.seed(scope,raw);return{p,r,d,b,scope,raw,cache:r.context.__WM_DERIVED_TEST__,entered,resume,arm(){armed=true}};
}
for(const kind of ['capacity','representation'])for(const action of ['change','restore','delete','noop','other-scope'])test(kind+' fallback delayed ACK respects '+action+' with exact owner/scope membership',async()=>{
 const f=await fixture(kind),before=await f.d.readVerified(f.scope),o=f.b.openRequest();let got;
 try{
  assert.equal(before.ok,true);let otherScope,otherRaw,otherReceipt;
  if(action==='other-scope'){otherScope=f.scope.replace('|chat:','|chat:other-');otherRaw=JSON.stringify({scopeKey:otherScope,entries:[]});await f.p.seed(otherScope,otherRaw);otherReceipt=(await f.b.read(otherScope)).sourceToken;}
  f.arm();const pending=f.d.readVerified(f.scope,{readonly:true,authorityRequest:o});
  const first=await Promise.race([f.entered.promise.then(heads=>({kind:'observed',heads})),pending.then(result=>({kind:'settled',result}))]);
  assert.equal(first.kind,'observed','test must reach the asynchronous fallback HEAD observation');
  if(action==='noop')assert.equal((await f.d.save(f.r.char,f.r.chat,[])).reason,'authority_write_token_required');
  else if(action==='other-scope')assert.equal((await f.b.commit(otherScope,otherReceipt,otherRaw,'normal')).ok,true);
  else {
   const raw=action==='delete'?null:action==='change'?JSON.stringify({...JSON.parse(f.raw),entries:[...JSON.parse(f.raw).entries,{comment:'lmai_change',content:'new canonical source'}]}):f.raw;
   const result=await f.b.commit(f.scope,before.authoritySource,raw,action==='delete'?'remove':action==='restore'?'restore':'normal');assert.equal(result.ok,true);
   assert.notEqual((await f.p.peek(f.scope)).revision,first.heads[0].revision);assert.ok(f.cache.stats().core.invalidations>0);
  }
  f.resume.resolve();got=await pending;const shouldStay=action==='noop'||action==='other-scope';assert.equal(got.ok,shouldStay);
  if(shouldStay){assert.ok(got.entries.length>0);if(kind==='representation')assert.equal(got.entries[0].testNumericOverflow,Infinity);}
  const final=await f.b.finalObservation(o);assert.equal(final.ok,shouldStay,'final Bridge source gate remains independently effective');
 }finally{f.resume.resolve();await f.b.closeRequest(o);f.b.finishRequest(o);await f.b.dispose();await f.cache.drain();assert.equal(f.cache.stats().requestOwners,0);assert.equal(f.cache.stats().requestBorrows,0);assert.equal(f.cache.stats().core.totalBytes,0);assert.equal(f.p.activeLeases(),0);}
});
for(const sign of ['1e400','-1e400'])test('optional canonical '+sign+' has exact cache-off/cache-on parser range parity',async()=>{
 const results=[];for(const enabled of [false,true]){const f=await fixture('representation',{enabled,sign}),o=f.b.openRequest();try{const got=await f.d.readVerified(f.scope,{readonly:true,authorityRequest:o});assert.equal(got.ok,true);assert.equal(got.entries[0].testNumericOverflow,sign[0]==='-'?-Infinity:Infinity);results.push({raw:got.raw,scopeKey:got.scopeKey,resetGeneration:got.resetGeneration,entries:got.entries});}finally{await f.b.closeRequest(o);await f.b.dispose();await f.cache.drain();}}
 assert.equal(results[0].raw,results[1].raw);assert.equal(results[0].scopeKey,results[1].scopeKey);assert.equal(results[0].resetGeneration,results[1].resetGeneration);assert.equal(results[0].entries.length,results[1].entries.length);assert.equal(results[0].entries[0].testNumericOverflow,results[1].entries[0].testNumericOverflow);
});
