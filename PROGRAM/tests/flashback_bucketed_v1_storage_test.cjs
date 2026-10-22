'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {createBucketFixture}=require('./fixtures/flashback_bucketed_v1_fixture.cjs');
(async()=>{
 const scopeKey='char:bucket-fixture|chat:inactive|persona:fixture',seed=createBucketFixture(scopeKey);
 const fixture=await createFixture();
 try{
  // The public API appears before asynchronous startup metadata writes settle.
  await new Promise(resolve=>setTimeout(resolve,100));
  for(const [key,value]of seed.entries)fixture.pluginStorage.values.set(key,value);
  const before=new Map(seed.entries),api=fixture.api._test;
  const manifest=await api.loadScopeManifest(scopeKey);
  assert.equal(manifest.manifestCorrupt,undefined);assert.equal(manifest.shardCount,32);assert.equal(manifest.count,45);
  const loaded=await api.loadScopeRecords(scopeKey,{readOnly:true,useCache:false});
  assert.equal(loaded.manifest.missingShards,0);assert.equal(loaded.manifest.recordCountMismatch,false);
  assert.equal(loaded.records.length,4);assert.equal(loaded.manifest.externalRetirementPending,41);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.records.map(r=>r.vector))),seed.records.slice(0,4).map(r=>r.vector));
  for(const [key,value]of before)assert.equal(fixture.pluginStorage.values.get(key),value,'read preserves historical source bytes');
  // Fresh physical reads detect edits after a manifest has already been read.
  const [key,raw]=seed.buckets[0],bad=JSON.parse(raw);bad.records[0].text='tampered';fixture.pluginStorage.values.set(key,JSON.stringify(bad));
  const reused=await api.loadScopeRecordsForRecall(scopeKey,{indexes:[0]},{manifest});
  assert.equal(reused.manifest.corruptShards,1,'a reused directory still checks fresh physical bucket bytes');
  const damaged=await api.loadScopeRecords(scopeKey,{readOnly:true,useCache:false});
  assert.equal(damaged.manifest.manifestCorrupt,true);assert.ok(damaged.manifest.corruptShards>0);
  fixture.pluginStorage.values.set(key,raw);
  fixture.pluginStorage.values.delete(seed.buckets[4][0]);
  const missingEmpty=await api.loadScopeRecords(scopeKey,{readOnly:true,useCache:false});
  assert.equal(missingEmpty.manifest.manifestCorrupt,true,'zero-record bucket still requires its envelope');
  fixture.pluginStorage.values.set(...seed.buckets[4]);
  fixture.pluginStorage.values.set(key+'-duplicate',raw);
  const ambiguous=await api.loadScopeManifest(scopeKey);assert.equal(ambiguous.manifestCorrupt,true);
  fixture.pluginStorage.values.delete(key+'-duplicate');
  const scope=await fixture.api.resolveCurrentScope(false),current=createBucketFixture(scope.scopeKey,scope);
  await new Promise(resolve=>setTimeout(resolve,100));
  for(const [key,value]of current.entries)fixture.pluginStorage.values.set(key,value);
  const portable=fixture.context.__FlashbackPortableMemoryBackup;
  const backup=await portable.exportCurrentScope();
  for(const [key]of current.buckets)assert.ok(backup.records.some(row=>row.key===key),'portable export includes every bucket');
  assert.equal((await portable.restoreCurrentScope(backup)).ok,true,'portable same-scope restore validates bucket envelopes');
  for(const [key,value]of current.entries)assert.equal(fixture.pluginStorage.values.get(key),value,'portable roundtrip retains exact bucket bytes');
  const saved=await api.saveAllRecords(current.records.slice(0,4),null,scope);
  assert.ok(saved.manifest.commitId);assert.equal(saved.manifest.storageMode,undefined);
  for(const field of ['bucketCount','bucketCounts','bucketHashes'])assert.equal(saved.manifest[field],undefined,'new shard commit drops old bucket metadata');
  for(const [key,value]of current.buckets)assert.equal(fixture.pluginStorage.values.get(key),value,'replacement preserves old bucket source');
  console.log('Flashback bucketed_v1 physical storage: PASS (32 buckets, 45 records, 1024D vectors, tamper/missing/ambiguity, portable roundtrip, committed rewrite)');
 }finally{await fixture.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
