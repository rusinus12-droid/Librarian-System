'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture,fiveMore}=require('./fixtures/libra_server_runtime_fixture.cjs');
const instrument=source=>source.replace('    const stateDerivedWorldlineSuffix =',
 '    globalThis.__familyCache = {storage,state,invalidateAllVerifiedReads, fresh: value => {freshReadDepth=value;}};\n    const stateDerivedWorldlineSuffix =')
 .replace('    let lensRegistryWriteTail =','    globalThis.__readLensRegistry = readLensRegistry;\n    let lensRegistryWriteTail =');
// Product helpers + server handlers + on-disk SQLite. Opaque source-family rows
// exercise cache coherence; full producer behavior is covered by separate suites.
for(const mode of ['server_only','mirror'])test(`${mode}: Micro, Lens, Canonical and State additions/updates/ABA/deletions validate cached revisions`,async t=>{
 const s=await serverFixture({mode,transformSource:instrument});t.after(()=>s.cleanup());
 const c=s.f.r.context.__familyCache,scope={_cachedMode:mode},prefix='libra:v1:scope:seventh-server-scope:';
 const families=['micro-memory-head:main:e0:t99','lens:cache-fixture:records','memory:cache-fixture:r1','continuity-state'];
 const change=async(key,value,kind='set')=>{await s.mutate(key,value,kind);if(mode==='mirror'){if(kind==='set')s.local.set(key,JSON.stringify(value));else s.local.delete(key);}};
 for(const family of families){
  const key=prefix+family,read=()=>c.storage.getVerifiedJson(key,scope,null);
  assert.equal(await read(),null);assert.equal(await read(),null);
  const epoch=c.state.snapshotSourceEpoch||0;
  await change(key,{text:'added'});assert.equal((await read()).text,'added',family+' negative->present');
  assert.ok(c.state.snapshotSourceEpoch>epoch,'remote additions invalidate derived source views');
  const parsed=c.state.memoryNetworkIO.parsedRows,hits=c.state.verifiedReadCacheStats.hits;
  const same=await read();same.text='mutated by reader';assert.equal((await read()).text,'added');
  assert.equal(c.state.memoryNetworkIO.parsedRows,parsed,'unchanged server bytes reuse JSON decode');
  assert.ok(c.state.verifiedReadCacheStats.hits>hits);
  await change(key,{text:'updated'});assert.equal((await read()).text,'updated');
  const changes=c.state.verifiedReadCacheStats.remoteChanges;
  await change(key,{text:'ABA'});await change(key,{text:'updated'});assert.equal((await read()).text,'updated');
  assert.ok(c.state.verifiedReadCacheStats.remoteChanges>changes,'same-value ABA still changes server revision');
  await change(key,null,'remove');assert.equal(await read(),null,family+' tombstone');
  await change(key,{text:'recreated'});assert.equal((await read()).text,'recreated');
  if(mode==='mirror'){
   await s.mutate(key,{text:'server-only change'});
   await assert.rejects(read,/LIBRA_VERIFIED_STORAGE_VALUE_MISMATCH/);
   s.local.set(key,JSON.stringify({text:'server-only change'}));assert.equal((await read()).text,'server-only change');
  }
 }
 c.invalidateAllVerifiedReads();
 const before=s.requests.filter(r=>r.url.endsWith('/v1/kv/get-many')).length;
 await Promise.all(families.map(f=>c.storage.getVerifiedJson(prefix+f,scope)));
 assert.equal(s.requests.filter(r=>r.url.endsWith('/v1/kv/get-many')).length-before,1,'different families share one server batch');
 const sameKey=prefix+families[0],beforeSame=s.requests.length;
 await Promise.all(Array.from({length:20},()=>c.storage.getVerifiedJson(sameKey,scope)));
 assert.equal(s.requests.length-beforeSame,1,'same-key concurrent validation shares one transfer');
 assert.ok(c.state.verifiedReadCacheStats.coalesced>=19);
 c.fresh(1);const beforeFresh=s.requests.length;await c.storage.getVerifiedJson(sameKey,scope);c.fresh(0);
 assert.equal(s.requests.length-beforeFresh,1);assert.ok(s.requests.at(-1).url.includes('/v1/kv/get?'),'delivery fresh path does not borrow cached observations');
 const restarted=await s.restart();assert.ok(await restarted.r.context.__familyCache.storage.getVerifiedJson(sameKey,scope));
});
test('conditional batch response carries no unchanged body and rejects malformed revision pins',async t=>{
 const s=await serverFixture();t.after(()=>s.cleanup());const key='libra:v1:scope:seventh-server-scope:lens:cache-fixture:records';
 await s.mutate(key,{text:'x'.repeat(10000)});
 const initial=(await s.send('GET','/v1/kv/get?namespace=libra&space=plugin&key='+encodeURIComponent(key))).result;
 const pin={exists:initial.exists,tombstone:initial.tombstone,revision:initial.revision,digest:initial.digest};
 const request=knownValues=>s.send('POST','/v1/kv/get-many',{namespace:'libra',space:'plugin',keys:[key],knownValues});
 const unchanged=await request({[key]:pin});assert.equal(unchanged.status,200);
 assert.equal(unchanged.result.values[key].unchanged,true);assert.ok(!Object.hasOwn(unchanged.result.values[key],'value'));
 assert.ok(JSON.stringify(unchanged).length<1000,'unchanged large body stays on client');
 assert.equal((await request({[key]:{...pin,revision:-1}})).status,400);
 assert.equal((await request({'unrequested':pin})).status,400);
 await s.mutate(key,{text:'new'});const changed=await request({[key]:pin});assert.equal(changed.result.values[key].value,JSON.stringify({text:'new'}));
});
for(const mode of ['server_only','mirror'])test(`${mode}: real Lens additions, Canonical append and State correction survive warm caches`,async t=>{
 const s=await serverFixture({mode,transformSource:instrument});t.after(()=>s.cleanup());const f=s.f,c=f.r.context.__familyCache,scope={_cachedMode:mode};
 assert.equal((await f.run()).completed,1);
 const manifestKey=s.storedRows().find(row=>row.key.endsWith(':manifest')).key;
 const headKey=s.getRecords('libra.continuity_state.v2')[0].key;
 await c.storage.getVerifiedJson(manifestKey,scope);await c.storage.getVerifiedJson(headKey,scope);
 await c.storage.getVerifiedJson(manifestKey,scope);await c.storage.getVerifiedJson(headKey,scope);
 const world=s.getHead().world.find(row=>row.name==='도서관');
 const corrected=await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'world'},patch:{world:[{id:world.id,set:{condition:'CACHE_STATE_UPDATED'}}]}});
 assert.equal(corrected.ok,true,JSON.stringify(corrected));
 assert.equal((await c.storage.getVerifiedJson(headKey,scope)).world.find(row=>row.id===world.id).state.condition,'CACHE_STATE_UPDATED');
 f.control.onCall=async args=>JSON.stringify(args).includes('LIBRA LENS ANALYZER')
  ? {type:'success',result:JSON.stringify({items:[{label:'약속',text:'열쇠를 오늘 돌려주기로 했다.',refs:['t2-a'],quote:'오늘 돌려주겠다고 약속했다'}]})}
  : {type:'success',result:JSON.stringify(f.control.artifact)};
 const first=await f.r.api.createLens({name:'캐시 검증 첫 렌즈',instruction:{goal:'현재 사실을 기록한다.'}});
 await f.r.context.__readLensRegistry();
 const settingsKey='libra:v1:runtime-settings',settingsRaw=s.local.get(settingsKey),envelope=JSON.parse(settingsRaw);
 const settings=envelope.settings || envelope;assert.ok(settings.lens_registry?.lenses?.length);
 settings.lens_registry.lenses[0].name='EXTERNAL_LENS_DEFINITION';s.local.set(settingsKey,JSON.stringify(envelope));
 assert.equal((await f.r.context.__readLensRegistry()).lenses[0].name,'EXTERNAL_LENS_DEFINITION','registry TTL cannot hide external definition edits');
 s.local.set(settingsKey,settingsRaw);
 assert.equal((await f.r.core.runLensForRange(first.lensId,{startTurn:1,endTurn:5})).status,'succeeded');
 const lensKey=s.storedRows().find(row=>row.key.endsWith(':lens:head')).key;
 await c.storage.getVerifiedJson(lensKey,scope);await c.storage.getVerifiedJson(lensKey,scope);
 const second=await f.r.api.createLens({name:'캐시 검증 추가 렌즈',instruction:{goal:'관계 변화를 기록한다.'}});
 assert.equal((await f.r.core.runLensForRange(second.lensId,{startTurn:1,endTurn:5})).status,'succeeded');
 assert.ok((await f.r.api.getLensRegistry()).lenses.some(lens=>lens.lensId===second.lensId));
 assert.ok((await c.storage.getVerifiedJson(lensKey,scope)).lenses[second.lensId]);
 fiveMore(f);assert.equal((await f.run()).completed,1);
 const manifest=await c.storage.getVerifiedJson(manifestKey,scope);assert.equal(Object.keys(manifest.memories).length,2);assert.ok(manifest.memories['6']);
 assert.equal((await c.storage.getVerifiedJson(manifest.memories['6'].key,scope)).artifactSchema,'libra.canonical_artifact.v4');
 const newer=await c.storage.getVerifiedJson(headKey,scope);assert.equal(newer.throughTurn,10);
 const restarted=await s.restart();assert.equal((await restarted.r.api.getLensRegistry()).lenses.length,2);assert.equal(s.getHead().throughTurn,10);
});
test('plugin_only: externally added/edited/deleted source-family bytes never reuse a stale decode',async t=>{
 const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
 const r=await createLibraVmHarness({}, {},{transformSource:instrument});t.after(()=>r.cleanup());
 const c=r.context.__familyCache,scope={_cachedMode:'plugin_only'};
 for(const family of ['micro-memory-head:main:e0:t1','lens:fixture:records','memory:fixture:r1','continuity-state']){
  const key='libra:v1:scope:cache-local:'+family,read=()=>c.storage.getVerifiedJson(key,scope);
  assert.equal(await read(),null);assert.equal(await read(),null);
  r.values.set(key,'{"text":"external addition"}');assert.equal((await read()).text,'external addition');
  r.values.set(key,'{"text":"external edit"}');assert.equal((await read()).text,'external edit');
  r.values.delete(key);assert.equal(await read(),null);
  await c.storage.setVerifiedJson(key,{text:'own write'},scope);assert.equal((await read()).text,'own write');
  const before=r.storageReads.filter(k=>k===key).length;
  await Promise.all(Array.from({length:20},read));assert.equal(r.storageReads.filter(k=>k===key).length-before,1,'same-key native physical observations share one flight');
 }
});
test('an older server ignoring knownValues falls back to full current reads',async t=>{
 const s=await serverFixture({transformSource:instrument});t.after(()=>s.cleanup());
 s.hooks.beforeServerRequest=async(url,init)=>{if(url.endsWith('/v1/kv/get-many')){const body=JSON.parse(init.body);delete body.knownValues;init.body=JSON.stringify(body);}};
 const c=s.f.r.context.__familyCache,scope={_cachedMode:'server_only'},key='libra:v1:scope:seventh-server-scope:memory:legacy:r1';
 await s.mutate(key,{text:'old'});await c.storage.getVerifiedJson(key,scope);
 const hits=c.state.verifiedReadCacheStats.hits,parsed=c.state.memoryNetworkIO.parsedRows;
 assert.equal((await c.storage.getVerifiedJson(key,scope)).text,'old');assert.equal(c.state.verifiedReadCacheStats.hits,hits);
 assert.ok(c.state.memoryNetworkIO.parsedRows>parsed,'legacy full response is decoded instead of reused without revision validation');
 await s.mutate(key,{text:'updated'});assert.equal((await c.storage.getVerifiedJson(key,scope)).text,'updated');
});
