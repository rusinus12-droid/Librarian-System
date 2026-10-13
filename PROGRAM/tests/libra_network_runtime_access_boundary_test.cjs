'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const observe=source=>{
 const entry='const refreshMemoryNetworkIndex = async (context, manifest, catalog, frame, guard) => {';
 assert.equal(source.split(entry).length,2);source=source.replace(entry,entry+'globalThis.__a2CacheCalls=(globalThis.__a2CacheCalls||0)+1;globalThis.__a2CacheBefore=[state.microRestoreGeneration,manifestRevisionOf(key.manifest(context.scope))];');
 const check='if(capturedNetworkEpoch!==Number(state.microRestoreGeneration||0)';
 assert.equal(source.split(check).length,2);source=source.replace(check,'        globalThis.__a2CacheAfter=[state.microRestoreGeneration,manifestRevisionOf(key.manifest(context.scope))];\n'+check);
 const anchor='      getUnifiedStorageStatus,';assert.equal(source.split(anchor).length,2);
 source=source.replace(anchor,`      a2GuardedRecall: async query => recall(await resolveContext(),query,createRecallGuard()),
      a2ReadOnlyRecall: async query => {const context=await resolveContext(),settings=await loadMemorySettings(),pairs=buildPairs(context.chat,context.scope.scopeKey),bundle=buildQueryBundle([{role:'user',content:query}],context,settings,pairs);return recall(context,{...bundle,requestLocalReadOnly:true,persistRecallCatalog:false});},\n`+anchor);
 return source.replace('    async getUnifiedStorageStatus() {','    a2GuardedRecall: query => LibraMemoryCore.a2GuardedRecall(query),\n    a2ReadOnlyRecall: query => LibraMemoryCore.a2ReadOnlyRecall(query),\n    async getUnifiedStorageStatus() {');
};
(async()=>{
 const direct=await fixture({transformSource:observe});
 try{
  assert.equal((await direct.run()).completed,1);
  const result=await direct.r.api.previewUnifiedMemoryRecall('민아 은빛 열쇠');assert.ok(result.memories.length);
  assert.equal(direct.r.context.__a2CacheCalls||0,0,'direct preview must not acquire an optional request cache');
  assert.equal(direct.r.api.inspectMemoryNetwork({}).coverage.status,'unavailable');
  const before=[...direct.r.values],writes=direct.r.storageWrites.length;
  const readOnly=await direct.r.api.a2ReadOnlyRecall('민아 은빛 열쇠');assert.ok(readOnly.memories.length);
  assert.equal(direct.r.context.__a2CacheCalls||0,0);assert.deepEqual([...direct.r.values],before);assert.equal(direct.r.storageWrites.length,writes);
 }finally{await direct.r.cleanup();}
 // Force one-row allocation pages in this synthetic test so a small corpus
 // exercises a real cooperative yield inside the registered normal hook.
 const racing=await fixture({transformSource:source=>observe(source).replace('index: factory.createPagedIndex(),','index: factory.createPagedIndex({pageSize:1}),')});
 try{
  assert.equal((await racing.run()).completed,1);
  // f.run queued the existing derived-vector timer. A2's cooperative yield lets
  // its real verified saveManifest publish while the normal hook is in flight.
  const messages=await racing.control.hooks.beforeRequest([{role:'user',content:'민아 은빛 열쇠'}],'model');
  assert.ok(racing.r.context.__a2CacheCalls>0,'registered normal hook must run the cache preparation');
  const before=racing.r.context.__a2CacheBefore,after=racing.r.context.__a2CacheAfter;
  assert.equal(before[0],after[0]);assert.ok(after[1]>before[1],'real derived-vector publication changed the observed manifest revision');
  assert.equal(racing.r.api.inspectMemoryNetwork({}).coverage.status,'partial','raced cache cannot retain complete coverage');
  const viewer=racing.r.api.getLastMemoryRecallViewer();assert.equal(viewer.injectedMemories,0,'raced guarded request must not deliver the captured source');assert.equal(viewer.errorCode,'CONSUMER_NETWORK_BINDING_CHANGED');
  assert.ok(JSON.stringify(messages).includes('민아 은빛 열쇠'),'base model request still continues');
  console.log(JSON.stringify({guardedQueuedVectorRace:{before,after,cacheCalls:racing.r.context.__a2CacheCalls,injected:viewer.injectedMemories}}));
 }finally{await racing.r.cleanup();}
 const concurrent=await fixture({transformSource:source=>observe(source)
  .replace('index: factory.createPagedIndex(),','index: factory.createPagedIndex({pageSize:1}),')
  .replace('state.memoryNetworkIO.indexYieldCalls++;await new Promise','state.memoryNetworkIO.indexYieldCalls++;if(globalThis.__a2Pause)await globalThis.__a2Pause();await new Promise')});
 let resume,first;
 try{
  assert.equal((await concurrent.run()).completed,1);await concurrent.r.api.retryPendingUnifiedVectors();await new Promise(resolve=>setTimeout(resolve,5));
  let entered,visits=0;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>resume=resolve);
  concurrent.r.context.__a2Pause=async()=>{if(++visits===1){entered();await gate;}};
  first=concurrent.r.api.a2GuardedRecall('민아 은빛 열쇠');await ready;
  assert.equal(concurrent.r.api.inspectMemoryNetwork({}).coverage.status,'partial','first writer is active before the second request');
  const second=await concurrent.r.api.a2GuardedRecall('민아 은빛 열쇠');assert.ok(second.memories.length,'busy derived preparation must not remove A1 candidates');
  assert.equal(concurrent.r.api.inspectMemoryNetwork({}).io.indexBusySkips,1,'exact busy branch must be counted');
  resume();const original=await first;first=null;assert.ok(original.memories.length);
  assert.deepEqual(second.memories.map(row=>[row.memory.memoryId,row.memory.revision]),original.memories.map(row=>[row.memory.memoryId,row.memory.revision]));
  console.log(JSON.stringify({guardedRecallBusySkip:{skips:concurrent.r.api.inspectMemoryNetwork({}).io.indexBusySkips,selected:second.memories.map(row=>row.memory.memoryId)}}));
 }finally{resume?.();if(first)await first;await concurrent.r.cleanup();}
 console.log('libra_network_runtime_access_boundary_test: PASS');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
