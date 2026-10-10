'use strict';
const assert=require('node:assert/strict');const {lineageFixture}=require('./fixtures/libra_unified_lineage_fixture.cjs');
const info=JSON.stringify,results=[];async function test(name,fn){const f=await lineageFixture();try{await f.run();for(let i=0;i<100;i++){const pending=f.getRecords('libra.canonical_memory.v1').some(r=>r.value?.embedding?.status==='pending');if(!pending&&i>2)break;await new Promise(r=>setTimeout(r,10));}await fn(f);results.push(name);console.log('PASS',name);}finally{await f.r.cleanup();}}
function orphan(f,suffix='old'){const k=`libra:v1:scope:${f.manifest().scopeKey}:entity-registry:v2:unified-basis:${suffix}:1`;f.r.values.set(k,info({schema:'libra.unified_basis_snapshot.v1',scopeKey:f.manifest().scopeKey,createdAt:new Date(Date.now()-30*86400000).toISOString(),head:null,registry:null}));return k;}
async function apply(f,p,keys){return f.r.api.collectMemoryRetention({expectedScopeKey:p.scopeKey,previewDigest:p.previewDigest,selectedKeys:keys});}
(async()=>{
 await test('only old unreferenced transient snapshot is collected, canonical/evidence and other owners unchanged',async f=>{
  const k=orphan(f),other='flashback:test:old';f.r.values.set(other,'unrelated');const before=new Map(f.r.values),calls=f.control.calls.length;
  const p=await f.r.api.previewMemoryRetention();assert.equal(p.complete,true,info(p.errors));assert.equal(p.rows.find(r=>r.key===k).lifecycle,'GC_ELIGIBLE');
  const out=await apply(f,p,[k]);assert.equal(out.removed,1,info(out));assert.equal(out.canonicalDeleted,0);assert.equal(out.evidenceDeleted,0);assert.equal(out.archiveDeleted,0);assert.ok(!f.r.values.has(k));
  for(const[key,v]of before)if(key!==k)assert.equal(f.r.values.get(key),v,key);assert.equal(f.control.calls.length,calls);
 });
 await test('unfinished transaction references pin the snapshot even after its retention age',async f=>{
  const k=orphan(f),tx=`libra:v1:scope:${f.manifest().scopeKey}:test-pending-transaction`;f.r.values.set(tx,info({schema:'libra.unified_replay_tx.v1',snapshotKey:k,status:'pending'}));
  const p=await f.r.api.previewMemoryRetention();assert.equal(p.rows.find(r=>r.key===k).lifecycle,'PINNED');await assert.rejects(()=>apply(f,p,[k]),/PROTECTED/);assert.ok(f.r.values.has(k));
 });
 await test('new references after preview invalidate deletion authorization',async f=>{
  const k=orphan(f),p=await f.r.api.previewMemoryRetention();f.r.values.set(`libra:v1:scope:${f.manifest().scopeKey}:kept`,info({schema:'libra.audit.v1',ref:k}));
  await assert.rejects(()=>apply(f,p,[k]),/PREVIEW_CHANGED_OR_INCOMPLETE/);assert.ok(f.r.values.has(k));
 });
 await test('undated and recent snapshots stay dormant; immutable orphan archive is preserved',async f=>{
  const a=orphan(f,'undated'),v=JSON.parse(f.r.values.get(a));delete v.createdAt;f.r.values.set(a,info(v));const b=orphan(f,'recent'),r=JSON.parse(f.r.values.get(b));r.createdAt=new Date().toISOString();f.r.values.set(b,info(r));
  const archive='libra:v1:archive:old-ancestor';f.r.values.set(archive,info({schema:'libra.archive.v1',createdAt:'2000-01-01T00:00:00Z'}));const p=await f.r.api.previewMemoryRetention();
  assert.equal(p.rows.find(r=>r.key===a).lifecycle,'DORMANT');assert.equal(p.rows.find(r=>r.key===b).lifecycle,'DORMANT');assert.notEqual(p.rows.find(r=>r.key===archive).lifecycle,'GC_ELIGIBLE');
 });
 await test('malformed record makes inventory incomplete and prevents every removal',async f=>{
  const k=orphan(f);f.r.values.set('libra:v1:broken','{broken');const p=await f.r.api.previewMemoryRetention();assert.equal(p.complete,false);assert.ok(p.errors.length);await assert.rejects(()=>apply(f,p,[k]),/INCOMPLETE/);assert.ok(f.r.values.has(k));
 });
 await test('readback failure reports retained rather than a successful deletion',async f=>{
  const k=orphan(f),p=await f.r.api.previewMemoryRetention(),storage=f.r.context.risuai.pluginStorage,old=storage.removeItem;storage.removeItem=async key=>key===k?true:old(key);
  try{const out=await apply(f,p,[k]);assert.equal(out.ok,false);assert.equal(out.removed,0);assert.equal(out.retained,1);assert.ok(f.r.values.has(k));}finally{storage.removeItem=old;}
 });
 await test('scope switch cannot apply an old maintenance selection',async f=>{const k=orphan(f),p=await f.r.api.previewMemoryRetention();f.empty('other-chat');await assert.rejects(()=>apply(f,p,[k]),/SCOPE_CHANGED/);assert.ok(f.r.values.has(k));});
 await test('a transient schema label outside the exact basis-key family cannot delete history or unknown records',async f=>{
  const temp=orphan(f),raw=f.r.values.get(temp),keys=[`libra:v1:scope:${f.manifest().scopeKey}:memory:old:1`,`libra:v1:scope:${f.manifest().scopeKey}:source-evidence:old:1`,`libra:v1:archive:old-basis`,`libra:v1:scope:${f.manifest().scopeKey}:entity-registry:unified-basis:legacy-shaped:1`];
  for(const k of keys)f.r.values.set(k,raw);const p=await f.r.api.previewMemoryRetention();assert.equal(p.complete,true);for(const k of keys){assert.notEqual(p.rows.find(r=>r.key===k).lifecycle,'GC_ELIGIBLE');await assert.rejects(()=>apply(f,p,[k]),/PROTECTED/);assert.equal(f.r.values.get(k),raw);}
 });
 console.log(JSON.stringify({test:'libra_unified_retention_v1',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
