'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
let fake;try{fake=require('fake-indexeddb');}catch(_){fake=require('../build-support/node_modules/fake-indexeddb');}
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const options={corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}};
const stored=async indexedDB=>{
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('libra-derived-corpus-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const r=db.transaction('records').objectStore('records').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}
};

test('plugin_only rebuilds reuse a transactional corpus and reclaim old generations without host writes',async t=>{
 const indexedDB=new fake.IDBFactory(),x=await fixture({contextGlobals:{indexedDB}});t.after(()=>x.cleanup());const api=x.f.r.api;
 const baseline=await api.executeMemoryGraphUnifiedQuery({...options,corpusMode:'auto'}),sourceRows=()=>[...x.f.r.values].filter(([key])=>key.startsWith('libra:v1:scope:'+x.scopeKey+':')),hostBefore=sourceRows();
 assert.equal(baseline.modelDispatchEligible,true);const observations=[];
 for(let n=0;n<6;n++){
  const build=await api.buildMemoryGraphCorpus({limit:1});assert.equal(build.persistenceBackend,'indexeddb');
  assert.equal(build.reclamation.status,'completed');
  const rows=await stored(indexedDB);observations.push({records:rows.length,chars:rows.reduce((sum,row)=>sum+row.raw.length,0),deleted:build.reclamation.deletedKeys.length});
  const result=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(result.modelDispatchEligible,true);
  assert.equal(result.corpusRead.persistenceBackend,'indexeddb');assert.equal(result.corpusRead.mode,'durable_common_index');
  assert.deepEqual(result.bundle.items.map(item=>[item.family,item.text]).sort(),baseline.bundle.items.map(item=>[item.family,item.text]).sort());
 }
 assert.deepEqual(sourceRows(),hostBefore,'derived maintenance cannot change original host records');
 assert.ok(observations.slice(1).some(row=>row.deleted>0));
 assert.ok(Math.max(...observations.slice(2).map(row=>row.chars))<observations[0].chars*2,'six builds do not grow six copies');
 await assert.rejects(api.executeMemoryGraphUnifiedQuery({...options,resourceBudget:{maxDurableBytes:1}}),/LIBRA_GRAPH_RESOURCE_/);
 await assert.rejects(api.executeMemoryGraphUnifiedQuery({...options,resourceBudget:{maxSourceBytes:1}}),/LIBRA_GRAPH_RESOURCE_/);
 const gc=await api.collectMemoryGraphGarbage({dryRun:false});assert.equal(gc.status,'completed');assert.equal(gc.backend,'indexeddb');
 console.log(JSON.stringify({test:'plugin_only_local_index_rebuilds',observations}));
});
test('plugin_only reload restores the local index without a rebuild or a provider call',async t=>{
 const indexedDB=new fake.IDBFactory(),x=await fixture({contextGlobals:{indexedDB}});t.after(()=>x.cleanup());
 await x.f.r.api.buildMemoryGraphCorpus({limit:1});const before=await x.f.r.api.executeMemoryGraphUnifiedQuery(options);
 await x.restart();const calls=x.f.control.calls.length,after=await x.f.r.api.executeMemoryGraphUnifiedQuery(options);
 assert.equal(after.corpusRead.persistenceBackend,'indexeddb');assert.equal(after.corpusRead.mode,'durable_common_index');
 assert.equal(after.bundle.bundleDigest,before.bundle.bundleDigest);assert.equal(after.modelDispatchEligible,true);
 assert.equal(x.f.control.calls.length,calls);assert.equal(x.f.r.api.inspectVolatileMemoryGraphCorpus().builds,0);
});
test('legacy host indexes remain readable and unchanged while new builds move to local transactions',async t=>{
 const x=await fixture();t.after(()=>x.cleanup());let api=x.f.r.api;
 const legacy=await api.buildMemoryGraphCorpus({limit:1});assert.equal(legacy.persistenceBackend,'host_storage');
 const legacyRows=[...x.f.r.values].filter(([key])=>key.includes(':memory-graph:v1:corpus:'));
 x.f.r.context.indexedDB=new fake.IDBFactory(); // Existing runtime disabled itself; a restart re-detects capability.
 const values=[...x.f.r.values],chat=JSON.parse(JSON.stringify(x.f.chat)),lore=x.f.character.lorebook;
 const {fixture:base}=require('./fixtures/libra_unified_runtime_fixture.cjs');await x.f.r.cleanup();
 const restarted=await base({snapshot:{values,chat},contextGlobals:{indexedDB:new fake.IDBFactory()}});t.after(()=>restarted.r.cleanup());restarted.character.lorebook=lore;api=restarted.r.api;
 const old=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(old.corpusRead.persistenceBackend,'host_storage');assert.equal(old.modelDispatchEligible,true);
 const build=await api.buildMemoryGraphCorpus({limit:1});assert.equal(build.persistenceBackend,'indexeddb');
 assert.equal(build.reclamation.legacyHostRecords,'preserved_atomic_gc_unavailable');
 for(const [key,raw] of legacyRows)assert.equal(restarted.r.values.get(key),raw);
 const current=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(current.corpusRead.persistenceBackend,'indexeddb');assert.equal(current.bundle.bundleDigest,old.bundle.bundleDigest);
});
test('opaque browser origins keep host GC blocked and expose why local transactions are unavailable',async t=>{
 const indexedDB={open(){throw new DOMException('opaque origin','SecurityError');}},x=await fixture({contextGlobals:{indexedDB}});t.after(()=>x.cleanup());
 const result=await x.f.r.api.buildMemoryGraphCorpus({limit:1});assert.equal(result.persistenceBackend,'host_storage');
 assert.equal(result.reclamation.status,'blocked_atomic_gc_unavailable');
 assert.equal(x.f.r.api.inspectLocalMemoryGraphCorpus().unavailableReason,'SecurityError');
 const gc=await x.f.r.api.collectMemoryGraphGarbage({dryRun:false});assert.equal(gc.status,'blocked_atomic_gc_unavailable');assert.equal(gc.deletedKeys.length,0);
});

test('revoking local pins during an original body read cannot deliver a cached corpus',async t=>{
 const indexedDB=new fake.IDBFactory(),x=await fixture({contextGlobals:{indexedDB}});t.after(()=>x.cleanup());const api=x.f.r.api;
 await api.buildMemoryGraphCorpus({limit:1});
 const memoryKey=x.f.getManifest().memories['1'].key,backend=x.f.r.context.risuai.pluginStorage,get=backend.getItem;
 let release,enter,held=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enter=resolve);
 t.after(()=>{backend.getItem=get;release();});
 backend.getItem=async key=>{if(key===memoryKey&&!held){held=true;enter();await gate;}return await get.call(backend,key);};
 const pending=api.executeMemoryGraphUnifiedQuery(options),settled=pending.then(value=>({value}),error=>({error}));
 await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(new Error('source read was not reached')),5000).unref())]);
 const store=require('../tools/libra_memory_graph_local_store.cjs')({indexedDB,fingerprint:raw=>require('node:crypto').createHash('sha256').update(raw).digest('hex')});
 try{await store.discardScope(x.scopeKey);}finally{await store.close();}
 release();const result=await settled;assert.ok(result.error||result.value.modelDispatchEligible!==true);
 assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0);
});
