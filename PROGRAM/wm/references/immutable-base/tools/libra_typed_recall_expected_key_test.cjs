'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { runtime, backend, provider, record, typedBytes } = require('./libra_typed_recall_index_test.cjs');
const OUT = path.resolve(__dirname, '../test-output/typed-recall/task2');
const results = [];
const clone = x => JSON.parse(JSON.stringify(x));
const policy = { storage: { maxRowBytes: 8192, maxJobBytes: 65536, maxExpectedBytes: 65536, maxExpectedRows: 64 } };
async function check(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error.stack }); } }
async function fresh() { return runtime(backend({ owned: false, local: true })); }
async function main() {
 const p = provider();
 await check('normal_get_set_host_writes_without_cas', async () => {
  const r = await fresh(), h = await r.index.open(r.snapshot, p, policy);
  assert.equal(h.writable, true, 'ordinary awaited get/set host must support expected-key publication');
  assert.equal((await r.index.publish(h, r.all.map(u => record(r,u)), r.snapshot)).ok, true);
  const v = r.index.read(h,r.all); assert.equal(v.readiness.status,'ready');
  assert.equal(v.readiness.persistence.persistentReady,true);
  assert.equal(r.back.state.cas,0); assert.equal(r.back.state.writes,r.all.length);
  assert.ok([...r.back.store.keys()].every(k=>k.includes(':row:')), 'no mutable head/probe/bank writes');
 });
 await check('independent_vms_same_binding_valid_vector_race', async () => {
  const b=backend({owned:false}), a=await runtime(b), z=await runtime(b);
  const ha=await a.index.open(a.snapshot,p,policy), hz=await z.index.open(z.snapshot,p,policy);
  const outs=await Promise.all([a.index.publish(ha,[record(a,a.units[0],p,[1,2,3])],a.snapshot),z.index.publish(hz,[record(z,z.units[0],p,[3,2,1])],z.snapshot)]);
  assert.ok(outs.every(x=>x.ok), 'both valid values in the same vector space are allowed');
  const h=await a.index.open(a.snapshot,p,policy), rows=a.index.read(h,a.units).rows;
  assert.equal(rows.length,1); assert.ok(a.index.validate(rows[0],a.units[0],p,p.documentMode).ok);
  assert.equal(b.store.size,1);
 });
 await check('old_revision_late_write_cannot_affect_current_expected_keys', async () => {
  const r=await fresh(), old=await r.index.open(r.snapshot,p,policy), oldSnap=r.snapshot, oldUnit=r.units[0];
  const entry=r.chat.localLore.find(x=>x.key===oldUnit.entry.key); entry.content+=' LATEST_CANON';
  const latest=r.corpus.capture(r.char,r.chat,{currentTurn:10}), unit=r.corpus.enumerate(latest).find(u=>u.identity===oldUnit.identity);
  const h=await r.index.open(latest,p,policy);
  assert.equal((await r.index.publish(h,[record({...r,snapshot:latest},unit)],latest)).ok,true);
  assert.equal((await r.index.publish(old,[record(r,oldUnit)],oldSnap)).ok,true);
  const reload=await r.index.open(latest,p,policy), rows=r.index.read(reload,[unit]).rows;
  assert.equal(rows.length,1); assert.equal(rows[0].sourceHash,r.index.sourceHash(unit.text));
  assert.notEqual(r.index.rowKey(latest,unit,p),r.index.rowKey(oldSnap,oldUnit,p));
 });
 await check('same_key_other_binding_forgery_and_checksum_rejected', async () => {
  const r=await fresh(), h=await r.index.open(r.snapshot,p,policy), good=record(r);
  assert.equal(typeof r.index.rowKey,'function', 'canonical expected-row key API exists');
  const key=r.index.rowKey(r.snapshot,r.units[0],p);
  assert.equal((await r.index.publish(h,[good],r.snapshot)).ok,true);
  const stored=JSON.parse(r.back.store.get(key));
  for(const forged of [{...stored,identity:r.units[1].identity},{...stored,vector:[7,8,9]},{...stored,viewerId:'another-viewer'}]) {
   r.back.store.set(key,JSON.stringify(forged));
   const reload=await r.index.open(r.snapshot,p,policy); assert.equal(r.index.read(reload,r.units).rows.length,0);
  }
 });
 await check('corrupt_and_torn_payload_are_excluded', async () => {
  const r=await fresh(), h=await r.index.open(r.snapshot,p,policy);
  assert.equal((await r.index.publish(h,[record(r)],r.snapshot)).ok,true);
  const key=r.index.rowKey(r.snapshot,r.units[0],p), raw=r.back.store.get(key);
  for(const value of [raw.slice(0,-9),raw+'torn',JSON.stringify({...JSON.parse(raw),vector:[0,0,0]})]) {
   r.back.store.set(key,value); const reload=await r.index.open(r.snapshot,p,policy);
   assert.equal(r.index.read(reload,r.units).rows.length,0);
  }
 });
 await check('cache_first_set_failure_never_persistent_ready_including_reload', async () => {
  const b=backend({owned:false,cacheFirst:true,local:true}), r=await runtime(b), h=await r.index.open(r.snapshot,p,policy);
  b.state.failSet=true; assert.equal((await r.index.publish(h,[record(r)],r.snapshot)).ok,false);
  assert.equal(b.store.size,0); assert.equal(b.cache.size,1, 'fixture reproduces installed host cache-before-set side effect');
  const same=await r.index.open(r.snapshot,p,policy), sameView=r.index.read(same,r.units);
  assert.equal(sameView.rows.length,0); assert.equal(sameView.readiness.persistence.persistentReady,false);
  const freshVM=await runtime(b), freshHandle=await freshVM.index.open(freshVM.snapshot,p,policy), view=freshVM.index.read(freshHandle,freshVM.units);
  assert.equal(view.readiness.persistence.persistentReady,false, 'new VM cannot treat a shared-cache read as an acknowledged durable write');
  assert.equal(view.readiness.persistence.acknowledged,0);
 });
 await check('successful_ack_readback_and_cold_reload_are_distinct', async () => {
  const r=await fresh(), h=await r.index.open(r.snapshot,p,policy);
  assert.equal((await r.index.publish(h,r.all.map(u=>record(r,u)),r.snapshot)).ok,true);
  assert.equal(r.index.read(h,r.all).readiness.persistence.persistentReady,true);
  const b=backend({owned:false,local:true}); b.canonicalLore=clone(r.back.canonicalLore); for(const [k,v] of r.back.store)b.store.set(k,v);
  const z=await runtime(b), hz=await z.index.open(z.snapshot,p,policy), v=z.index.read(hz,z.all);
  assert.equal(v.readiness.status,'ready'); assert.equal(v.rows.length,z.all.length);
  assert.equal(v.readiness.persistence.status,'unverified_read'); assert.equal(v.readiness.persistence.persistentReady,false);
 });
 await check('quota_failure_does_not_mutate_canon_or_declare_persistence', async () => {
  const r=await fresh(), before=JSON.stringify(r.chat.localLore), h=await r.index.open(r.snapshot,p,policy); r.back.state.quota=100;
  assert.equal((await r.index.publish(h,[record(r)],r.snapshot)).ok,false);
  assert.equal(r.index.read(h,r.units).readiness.persistence.persistentReady,false);
  assert.equal(JSON.stringify(r.chat.localLore),before); assert.equal(r.back.store.size,0);
 });
 await check('row_job_current_corpus_byte_bounds_and_retire_no_deletion', async () => {
  const r=await fresh(); const row=record(r), min=JSON.stringify(row).length;
  const tiny=await r.index.open(r.snapshot,p,{storage:{...policy.storage,maxRowBytes:256}});
  assert.equal((await r.index.publish(tiny,[row],r.snapshot)).ok,false); assert.equal(r.back.state.writes,0);
  const job=await r.index.open(r.snapshot,p,{storage:{...policy.storage,maxJobBytes:min+400}});
  const out=await r.index.publish(job,r.all.map(u=>record(r,u)),r.snapshot); assert.equal(out.ok,false); assert.equal(r.back.state.writes,0);
  const limited=await r.index.open(r.snapshot,p,{storage:{...policy.storage,maxExpectedBytes:256}});
  assert.equal(limited.writable,false); assert.equal(r.index.read(limited,r.units).readiness.status,'degraded');
  const h=await r.index.open(r.snapshot,p,policy); assert.equal((await r.index.publish(h,[row],r.snapshot)).ok,true);
  const stored=typedBytes(r.back.store), count=r.back.store.size; assert.equal((await r.index.retire(h,[row.identity])).ok,true);
  assert.equal(r.index.read(h,r.units).rows.length,0); assert.equal(typedBytes(r.back.store),stored); assert.equal(r.back.store.size,count);
  assert.equal(r.back.state.networkCalls,0);
 });
 await check('stored_payload_has_only_strict_row_fields', async () => {
  const r=await fresh(),h=await r.index.open(r.snapshot,p,policy); assert.equal((await r.index.publish(h,[record(r)],r.snapshot)).ok,true);
  const key=r.index.rowKey(r.snapshot,r.units[0],p), stored=JSON.parse(r.back.store.get(key));
  r.back.store.set(key,JSON.stringify({...stored,canonicalText:'UNTRUSTED_PAYLOAD_TEXT'}));
  const reload=await r.index.open(r.snapshot,p,policy);
  assert.equal(r.index.read(reload,r.units).rows.length,0,'unknown stored payload fields cannot become strict derived rows');
 });
 await check('all_binding_inputs_change_expected_key', async () => {
  const r=await fresh(),unit=r.units[0],base=r.index.rowKey(r.snapshot,unit,p);
  for(const field of ['scopeKey','branchId','viewerId'])assert.notEqual(r.index.rowKey({...r.snapshot,[field]:'different'},unit,p),base,field);
  assert.equal(r.index.rowKey({...r.snapshot,worldlineRevision:'next-turn'},unit,p),base,'request revision does not rewrite persistent content');
  for(const field of ['identity','family','subtype','persistentContentHash','persistentDependencyHash','representationVersion','text'])assert.notEqual(r.index.rowKey(r.snapshot,{...unit,[field]:'different'},p),base,field);
  assert.notEqual(r.index.rowKey(r.snapshot,{...unit,locator:{...unit.locator,id:'other'}},p),base);
  for(const field of ['spaceFingerprint','provider','model','modelRevision','endpoint','queryMode','documentMode'])assert.notEqual(r.index.rowKey(r.snapshot,unit,{...p,[field]:'different'}),base,field);
  assert.notEqual(r.index.rowKey(r.snapshot,unit,{...p,dimension:4}),base);
  assert.notEqual(r.index.rowKey(r.snapshot,unit,{...p,options:{normalize:false}}),base);
 });
 await check('valid_competing_readback_is_not_required_to_equal_own_bytes', async () => {
  const r=await fresh(),h=await r.index.open(r.snapshot,p,policy);
  r.back.state.afterSet=async (key,raw)=>{
   const other=JSON.parse(raw);other.vector=[9,8,7];other.vectorChecksum=r.index.vectorChecksum(other.vector);r.back.store.set(key,JSON.stringify(other));
  };
  assert.equal((await r.index.publish(h,[record(r)],r.snapshot)).ok,true);
  const v=r.index.read(h,r.units);assert.deepEqual([...v.rows[0].vector],[9,8,7]);
  assert.equal(v.readiness.persistence.acknowledged,0,'own success ack does not certify a different observed vector');
 });
 await check('invalid_snapshot_open_has_readable_degraded_result', async () => {
  const r=await fresh(),h=await r.index.open({...r.snapshot,branchId:null},p,policy);
  assert.equal(h.writable,false);
  assert.equal(r.index.read(h,r.units).readiness.status,'degraded','invalid input fails closed without crashing the caller fallback');
 });
 await check('full_corpus_cache_ghost_after_failed_replacement_is_never_persistent_ready', async () => {
  const b=backend({owned:false,cacheFirst:true,local:true}),r=await runtime(b),h=await r.index.open(r.snapshot,p,policy);
  assert.equal((await r.index.publish(h,r.all.map(u=>record(r,u)),r.snapshot)).ok,true);
  assert.equal(r.index.read(h,r.all).readiness.persistence.persistentReady,true);
  b.state.failSet=true;const replacement=record(r,r.units[0],p,[9,8,7]);
  assert.equal((await r.index.publish(h,[replacement],r.snapshot)).ok,false);
  const z=await runtime(b),hz=await z.index.open(z.snapshot,p,policy),v=z.index.read(hz,z.all);
  assert.equal(v.rows.length,z.all.length); assert.equal(v.readiness.status,'ready','all cached rows are valid for runtime search');
  assert.equal(v.readiness.persistence.acknowledged,0);assert.equal(v.readiness.persistence.persistentReady,false);
  assert.deepEqual([...v.rows.find(x=>x.identity===z.units[0].identity).vector],[9,8,7]);
  const key=z.index.rowKey(z.snapshot,z.units[0],p);assert.notDeepEqual(JSON.parse(b.store.get(key)).vector,[9,8,7],'persistent fixture store still holds the older acknowledged vector');
 });
 await check('acknowledgements_do_not_cross_storage_domains', async () => {
  const r=await fresh(),h=await r.index.open(r.snapshot,p,policy);
  assert.equal((await r.index.publish(h,r.all.map(u=>record(r,u)),r.snapshot)).ok,true);
  assert.equal(r.index.read(h,r.all).readiness.persistence.persistentReady,true);
  const other=backend({owned:false});for(const [k,v] of r.back.store)other.store.set(k,v);
  r.back.host.getLocalPluginStorage=async()=>other.storage;
  const reload=await r.index.open(r.snapshot,p,policy),v=r.index.read(reload,r.all);
  assert.equal(v.rows.length,r.all.length);
  assert.equal(v.readiness.persistence.acknowledged,0,'a previous backend ack cannot certify the replacement backend');
  assert.equal(v.readiness.persistence.persistentReady,false);
 });
 await check('fallback_api_completion_cannot_certify_persistence', async () => {
  const r=await runtime(backend({owned:false})),h=await r.index.open(r.snapshot,p,policy);
  assert.equal(h.writable,true);assert.equal((await r.index.publish(h,r.all.map(u=>record(r,u)),r.snapshot)).ok,true);
  const v=r.index.read(h,r.all);assert.equal(v.readiness.status,'ready');
  assert.equal(v.readiness.persistence.persistentReady,false,'installed pluginStorage setter mutates DB state without awaited disk persistence');
 });
 fs.mkdirSync(OUT,{recursive:true}); const output={passed:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,assertions:results};
 fs.writeFileSync(path.join(OUT,'expected-key-result.json'),JSON.stringify(output,null,2)); console.log(JSON.stringify(output,null,2)); process.exitCode=output.failed?1:0;
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
