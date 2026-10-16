'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const options={corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}};
const idle=api=>{
 const state=api.inspectMemoryGraphStore();
 for(const key of ['retainedBytes','sessions','ioBytes','decodeBytes','reads'])assert.equal(state.resources[key],0,key);
 assert.equal(state.corpus.storageStaging.entries,0);
};
for(const mode of ['plugin_only','server_only','mirror'])test(`${mode}: public storage continuation survives request release, is one-use and cancellation drains it`,async t=>{
 const x=await fixture({mode});t.after(()=>x.cleanup());const api=x.f.r.api;
 await api.buildMemoryGraphCorpus({limit:2});
 const full=await api.executeMemoryGraphUnifiedQuery(options);idle(api);
 const first=await api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:1}});
 assert.equal(first.stopReason,'lane_storage_page_count_budget');
 const state=api.inspectMemoryGraphStore(), cursors=first.accessTrace.lane.unreadCursors;
 assert.ok(cursors.some(c=>c.storageCursor));
 assert.equal(state.resources.sessions,state.corpus.storageStaging.entries,'no request activity remains charged');
 assert.equal(state.resources.retainedBytes,state.corpus.storageStaging.retainedBytes,'only bounded continuation data remains');
 const second=await api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:512,resumeCursors:cursors}});
 assert.equal(second.queryComplete,true);assert.equal(second.modelDispatchEligible,true);
 assert.deepEqual(second.bundle.items,full.bundle.items);idle(api);
 await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:512,resumeCursors:cursors}}),/STORAGE_CURSOR_INVALID/);idle(api);
 await api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:1}});
 api.cancelMemoryGraphGenerationBuild();idle(api);
});

test('public continuation is bound to query, viewer, temporal frame and logical access',async t=>{
 const x=await fixture();t.after(()=>x.cleanup());const api=x.f.r.api;await api.buildMemoryGraphCorpus({limit:2});
 const first=await api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:1}});
 const cursors=first.accessTrace.lane.unreadCursors;
 for(const queryInput of [{queryText:QUOTE+' changed'},{queryText:QUOTE,viewerId:'other'},{queryText:QUOTE,asOfTurn:1}]){
  await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({...options,queryInput,laneBudget:{maxStoragePages:512,resumeCursors:cursors}}),/LANE_CURSOR_INVALID/);
 }
 const forged=JSON.parse(JSON.stringify(cursors));forged.find(c=>c.storageCursor).term+='changed';
 await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:512,resumeCursors:forged}}),/STORAGE_CURSOR_INVALID/);
 const healthy=await api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:512,resumeCursors:cursors}});
 assert.equal(healthy.modelDispatchEligible,true);idle(api);
});

test('abandoned public continuation expires and a later failed request leaves no new continuation',async t=>{
 const timers=new Map();let fail=false;
 const x=await fixture({hostOverrides:{reviewStagingSchedule(fn){const token={unref(){}};timers.set(token,fn);return token;},reviewStagingCancel(token){timers.delete(token);},reviewAfterQuery(){if(fail)throw Error('REVIEW_AFTER_QUERY');}},transformSource:source=>{
  const marker='inventory: state.memoryGraphInventory, resources: state.memoryGraphResources });';
  assert.equal(source.split(marker).length,2);
  source=source.replace(marker,'inventory: state.memoryGraphInventory, resources: state.memoryGraphResources, schedule: risuai.reviewStagingSchedule, cancel: risuai.reviewStagingCancel });');
  const after='resources.retain(execution.bundle.items,\'display_metadata\',2);';
  assert.equal(source.split(after).length,2);return source.replace(after,after+' risuai.reviewAfterQuery();');
 }});t.after(()=>x.cleanup());const api=x.f.r.api;await api.buildMemoryGraphCorpus({limit:2});
 const first=await api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:1}});
 assert.ok(timers.size);for(const expire of [...timers.values()])expire();idle(api);assert.equal(timers.size,0);
 await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:512,resumeCursors:first.accessTrace.lane.unreadCursors}}),/STORAGE_CURSOR_INVALID/);
 fail=true;await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({...options,laneBudget:{maxStoragePages:1}}),/REVIEW_AFTER_QUERY/);idle(api);
});

test('real incremental checkpoints above 64KiB remain intact during native GC observation and blocked deletion',async t=>{
 const x=await fixture();t.after(()=>x.cleanup());const api=x.f.r.api;
 const step=await api.buildMemoryGraphCorpus({limit:1,maxWindowsPerStep:1});assert.equal(step.status,'checkpointed');
 const checkpoints=[...x.f.r.values].filter(([key])=>key.includes(':corpus:checkpoint:'));
 assert.ok(checkpoints.some(([,raw])=>Buffer.byteLength(raw)>65536));
 const before=new Map(x.f.r.values),writes=x.f.r.storageWrites.length;
 for(const dryRun of [true,false]){
  const result=await api.collectMemoryGraphGarbage({dryRun});
  assert.equal(result.status,dryRun?'completed':'blocked_atomic_gc_unavailable');
  assert.equal(result.corpusReclamation,'conservative_namespace_retention');assert.equal(result.deletedKeys.length,0);
 }
 assert.deepEqual(x.f.r.values,before);assert.equal(x.f.r.storageWrites.length,writes);idle(api);
});
