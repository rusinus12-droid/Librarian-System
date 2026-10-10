'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{test}=require('node:test');
const fixtureRoot=process.env.LIBRA_TEST_FIXTURE_ROOT||__dirname;
const {createLibraVmHarness}=require(path.join(fixtureRoot,'fixtures/libra_vm_harness.cjs'));
const baselinePlugin=process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../plugins/LIBRA.js');
process.env.LIBRA_TEST_PLUGIN=baselinePlugin;
const delta=(a,b)=>Object.fromEntries(['hits','misses','writes','invalidations','evictions','pruned','pairBuilds','pairReuses'].map(k=>[k,(b[k]||0)-(a[k]||0)]));
const chat=(n,id='scan')=>({id,message:Array.from({length:n*2},(_,i)=>({role:i%2?'assistant':'user',chatId:'row-'+i,data:`Plain source row ${i}`}))});
const stats=r=>r.api.getPairRevisionCacheDiagnostics().stats;
const build=(r,c)=>r.api.debugBuildPairs(c,c.id);
async function harness(options={}){return createLibraVmHarness({}, {},options);}
const smallBudgets=s=>s.replace('const PAIR_REVISION_CACHE_MAX_ENTRIES_PER_SCOPE = 4096;','const PAIR_REVISION_CACHE_MAX_ENTRIES_PER_SCOPE = 8;').replace('const PAIR_REVISION_CACHE_MAX_RETAINED_CHARS = 24 * 1024 * 1024;','const PAIR_REVISION_CACHE_MAX_RETAINED_CHARS = 128;');
test('4098-row warm scans retain all 4096 cached projections without an eviction cascade',async()=>{const r=await harness();try{
 const c=chat(2049),first=build(r,c),before=stats(r),second=build(r,c),d=delta(before,stats(r));
 assert.deepEqual(second,first);assert.equal(d.hits,4096);assert.equal(d.misses,2);assert.equal(d.evictions,0);assert.equal(d.writes,0);
 const again=stats(r);build(r,c);assert.equal(delta(again,stats(r)).hits,4096);
}finally{await r.cleanup();}});
test('retained and nonretained same-ID edits are read exactly and change current pair content',async()=>{const r=await harness();try{
 const c=chat(2049);build(r,c);c.message[0].data='Early exact new source';c.message[4097].data='Tail exact new source';const b=stats(r),out=build(r,c),d=delta(b,stats(r));
 assert.equal(out[0].user.text,'Early exact new source');assert.equal(out.at(-1).assistant.text,'Tail exact new source');assert.equal(d.hits,4095);assert.equal(d.misses,3);assert.equal(d.invalidations,1);
}finally{await r.cleanup();}});
test('raw equality controls cache hits even when derived hash strings collide',async()=>{const r=await harness({transformSource(s){return s.replace('    const branchContentHash = value => {',"    const branchContentHash = value => { return 'forced-same-hash';").replace('    const digest = value => {',"    const digest = value => { return 'forced-same-digest';");}});try{
 const c=chat(2);build(r,c);const b=stats(r);c.message[1].data='Exact content changed despite identical test hashes';const out=build(r,c),d=delta(b,stats(r));
 assert.equal(d.misses,1);assert.equal(out[0].assistant.text,c.message[1].data,'hash collision must never return an earlier cached pair');
}finally{await r.cleanup();}});
test('character-pressure scans retain bounded recent entries and oversized rows do not flush them',async()=>{const r=await harness({transformSource:s=>smallBudgets(s).replace('MAX_ENTRIES_PER_SCOPE = 8;','MAX_ENTRIES_PER_SCOPE = 64;')});try{
 const c=chat(6);for(const row of c.message)row.data='abcdefgh';build(r,c);let b=stats(r);build(r,c);let d=delta(b,stats(r));assert.equal(d.hits,8);assert.equal(d.misses,4);assert.equal(d.evictions,0);
 c.message.unshift({role:'assistant',chatId:'oversized',data:'z'.repeat(200)});build(r,c);b=stats(r);build(r,c);d=delta(b,stats(r));assert.equal(d.hits,8);assert.equal(d.misses,5);assert.equal(d.evictions,0);assert.ok(stats(r).retainedChars<=128);
}finally{await r.cleanup();}});
test('recent admission evicts only displaced entries on append and rollback prunes removed rows',async()=>{const r=await harness({transformSource:smallBudgets});try{
 const c=chat(4);for(const row of c.message)row.data='abcd';build(r,c);c.message.push({role:'user',chatId:'new-u',data:'newU'},{role:'assistant',chatId:'new-a',data:'newA'});let b=stats(r);build(r,c);let d=delta(b,stats(r));assert.equal(d.hits,8);assert.equal(d.misses,2);assert.equal(d.evictions,2);
 b=stats(r);build(r,c);d=delta(b,stats(r));assert.equal(d.hits,8);assert.equal(d.misses,2);assert.equal(d.evictions,0);
 c.message=c.message.slice(0,4);b=stats(r);assert.equal(build(r,c).length,2);d=delta(b,stats(r));assert.ok(d.pruned>=6);b=stats(r);build(r,c);assert.equal(delta(b,stats(r)).hits,4);
}finally{await r.cleanup();}});
test('scope limit and native identity changes retain their current invalidation behavior',async()=>{const r=await harness();try{
 const chats=Array.from({length:5},(_,i)=>chat(2,'scope-'+i));for(const c of chats)build(r,c);assert.equal(r.api.getPairRevisionCacheDiagnostics().scopes,4);let b=stats(r);build(r,chats[0]);assert.equal(delta(b,stats(r)).misses,4);
 const c=chats[0];c.message[1].chatId='replacement-native-assistant';b=stats(r);const out=build(r,c),d=delta(b,stats(r));assert.equal(out[0].assistant.chatId,'replacement-native-assistant');assert.equal(d.misses,1);assert.equal(d.pruned,1);
}finally{await r.cleanup();}});
test('removed carrier changes remain observations even with unchanged visible body',async()=>{const r=await harness();try{
 const c=chat(2);c.message[1].data='Visible';const first=build(r,c);c.message[1].data='Visible<img src="local" />';const b=stats(r),second=build(r,c),d=delta(b,stats(r));assert.equal(d.misses,1);assert.notDeepEqual(second[0].assistant.rawPayloadDigests,first[0].assistant.rawPayloadDigests);assert.equal(second[0].assistant.text,'Visible');assert.equal(second[0].assistant.internalCarrierRemoved,true);
}finally{await r.cleanup();}});
test('partial read failure cannot leave a stale changed entry or unbounded admission behind',async()=>{const r=await harness({transformSource:smallBudgets});try{
 const c=chat(4);for(const row of c.message)row.data='abcd';build(r,c);c.message[0].data='changed';let fail=true;Object.defineProperty(c.message[1],'data',{configurable:true,get(){if(fail)throw Error('synthetic raw read failure');return 'later';}});
 assert.throws(()=>build(r,c),/synthetic raw read failure/);assert.ok(stats(r).retainedChars<=128);fail=false;const out=build(r,c);assert.equal(out[0].user.text,'changed');assert.equal(out[0].assistant.text,'later');assert.ok(stats(r).retainedChars<=128);
}finally{await r.cleanup();}});
test('uncached over-budget prefix edits never reuse pair snapshots when derived hashes collide',async()=>{const r=await harness({transformSource(s){return smallBudgets(s).replace('    const branchContentHash = value => {',"    const branchContentHash = value => { return 'forced-same-hash';").replace('    const digest = value => {',"    const digest = value => { return 'forced-same-digest';");}});try{
 const c=chat(6);for(const row of c.message)row.data='abcd';build(r,c);let b=stats(r);build(r,c);assert.equal(delta(b,stats(r)).misses,4);
 c.message[0].data='early';b=stats(r);const out=build(r,c),d=delta(b,stats(r));assert.equal(d.hits,8);assert.equal(d.misses,4);assert.equal(out[0].user.text,'early');assert.equal(d.pairBuilds,1);assert.equal(d.pairReuses,0);
}finally{await r.cleanup();}});
test('real standalone source evidence invalidates prior pair snapshots before hash-colliding reuse',async()=>{
 for(const oversized of [false,true]){const r=await harness({transformSource(s){return smallBudgets(s).replace('MAX_ENTRIES_PER_SCOPE = 8;','MAX_ENTRIES_PER_SCOPE = 64;')
  .replace('    const branchContentHash = value => {',"    const branchContentHash = value => { return 'forced-same-hash';")
  .replace('    const digest = value => {',"    const digest = value => { return 'forced-same-digest';")
  .replace('    const assertLibraStateCanonicalSlot = async memory => {','    globalThis.__testSourceEvidenceRows = libraSourceEvidenceRows;\n    const assertLibraStateCanonicalSlot = async memory => {');}});try{
  const c=chat(5);for(const row of c.message)row.data='abcd';if(oversized)c.message[0].data='z'.repeat(200);const first=build(r,c);
  c.message[0].data='edit';const rows=r.context.__testSourceEvidenceRows({chat:c,scope:{scopeKey:c.id}},first);assert.equal(rows[0].userRaw,'edit','the real shared-cache consumer observed current raw');
  const b=stats(r),second=build(r,c),d=delta(b,stats(r));assert.equal(d.hits,10);assert.equal(d.misses,0);assert.equal(second[0].user.text,'edit');assert.equal(d.pairReuses,0);assert.equal(d.pairBuilds,1);assert.ok(stats(r).retainedChars<=128);
 }finally{await r.cleanup();}}
});
