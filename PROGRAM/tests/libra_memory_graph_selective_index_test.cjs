'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_selective_index_fixture.cjs');
const idle=x=>{const stats=x.env.pages.inspect();assert.equal(stats.pins,0);assert.equal(stats.activeRequests,0);assert.equal(stats.bytes.request,0);assert.equal(stats.bytes.staging,0);};
const tableReads=x=>x.reads.filter(key=>key.includes(':corpus:page:'));
test('opening a durable index loads no tables; one query reads only its posting and frontier pages with eager-identical proof',async()=>{
 const x=fixture();await x.build();x.reads.length=0;const opened=await x.read();
 assert.equal(tableReads(x).length,0);assert.equal(opened.compiledIndex.postings,undefined);assert.equal(opened.compiledIndex.directory,undefined);
 const {result,corpus}=await x.execute();assert.equal(result.modelDispatchEligible,true);assert.equal(result.queryComplete,true);
 assert.ok(result.bundle.items.some(item=>item.nodeId==='n0007'));
 assert.ok(corpus.access.storage.pagesRead>0&&corpus.access.storage.pagesRead<corpus.access.storage.publishedPages/2,JSON.stringify(corpus.access.storage));
 assert.equal(corpus.access.storage.pagesRead,tableReads(x).length);assert.ok(!tableReads(x).some(k=>k.includes(':reverseDependencies:')||k.includes(':directory:')));
 const eager=await x.execute({eager:true});assert.equal(eager.result.bundle.bundleDigest,result.bundle.bundleDigest);assert.equal(eager.result.packet.packetDigest,result.packet.packetDigest);
 assert.deepEqual(eager.result.bundle.items,result.bundle.items);idle(x);
 console.log(JSON.stringify({selective:corpus.access.storage,eager:eager.corpus.access.storage}));
});
test('cold, warm, evicted and restarted requests preserve scores, witnesses, packet and actual first-use storage checks',async()=>{
 const x=fixture();await x.build();const first=await x.execute();
 for(const phase of ['warm','evicted','restart']){
  if(phase==='evicted')x.env.pages.invalidate();if(phase==='restart')x.restart();x.reads.length=0;
  const {result,corpus}=await x.execute();assert.equal(result.bundle.bundleDigest,first.result.bundle.bundleDigest);assert.deepEqual(result.bundle.items,first.result.bundle.items);
  assert.equal(result.packet.packetDigest,first.result.packet.packetDigest);assert.ok(tableReads(x).length>0);assert.equal(corpus.access.storage.pagesRead,tableReads(x).length);idle(x);
 }
});
test('unrequested corruption stays outside the query; audit and first-use of a corrupted selected page both reject',async()=>{
 const x=fixture();await x.build();x.reads.length=0;await x.execute();const used=tableReads(x).find(key=>key.includes(':postings:'));
 const reverse=x.manifest().manifest.refs.find(ref=>ref.table==='reverseDependencies');x.values.set(reverse.key,'CORRUPTED_UNUSED_PAGE');
 await x.execute();await assert.rejects(()=>x.read({eager:true}),/PAGE_CORRUPT/);idle(x);
 x.values.set(used,'CORRUPTED_SELECTED_PAGE');await assert.rejects(()=>x.execute(),/PAGE_CORRUPT/);idle(x);
});
test('storage byte/page admission stops before I/O and reports partial coverage without a legacy execution',async()=>{
 const x=fixture();await x.build();x.reads.length=0;
 const limited=await x.execute({laneBudget:{maxStorageBytes:512}});assert.equal(limited.result.queryComplete,false);
 assert.equal(limited.result.stopReason,'lane_storage_byte_budget');assert.equal(limited.result.legacyRankerExecuted,false);assert.equal(tableReads(x).length,0);
 assert.equal(limited.result.accessTrace.lane.storage.bytesRead,0);assert.ok(limited.result.accessTrace.lane.unreadCursors.length);idle(x);
 x.reads.length=0;const one=await x.execute({laneBudget:{maxStoragePages:1}});
 assert.equal(one.result.queryComplete,false);assert.equal(one.result.stopReason,'lane_storage_page_count_budget');assert.equal(tableReads(x).length,1);idle(x);
 const full=await x.execute({laneBudget:{maxStoragePages:512,maxStorageBytes:8388608}});assert.equal(full.result.queryComplete,true);idle(x);
});
test('cancellation during a physical read releases all page/decode reservations and cannot publish a late result',async()=>{
 const x=fixture();await x.build();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 x.onRead(async key=>{if(key.includes(':page:postings:')){entered();await gate;}});
 const pending=x.execute();await started;x.cancel();release();await assert.rejects(()=>pending,/OWNER_CANCELED/);idle(x);
});
test('root replacement while page I/O is pending invalidates the captured index even with unchanged native facts',async()=>{
 const x=fixture();await x.build();let changed=false;
 x.onRead(async key=>{if(!changed&&key.includes(':page:postings:')){changed=true;const {loc,root}=x.manifest();x.values.set(loc.rootKey,JSON.stringify({...root,publication:2}));}});
 await assert.rejects(()=>x.execute(),/ROOT_CHANGED/);idle(x);
});
test('directory identity, offsets, counts and selected routing are verified before using stored rows',async()=>{
 for(const mode of ['foreign','offset','rows','routing','version']){
  const x=fixture();await x.build();const manifest=x.manifest().manifest;
  if(mode==='foreign')manifest.refs[0].key='foreign-secret';
  if(mode==='offset')manifest.refs[0].offset=1;
  if(mode==='rows')manifest.refs[0].rows++;
  if(mode==='routing')for(const ref of manifest.refs)if(ref.table==='postings'&&ref.routing.some(r=>r.kind==='lexical'))ref.routing=ref.routing.map(r=>r.kind==='lexical'?{...r,min:'aaa',max:'zzz'}:r);
  if(mode==='version')manifest.routingVersion='unrecognized';
  x.replaceManifest(manifest);x.reads.length=0;await assert.rejects(()=>x.execute(),/DIRECTORY_INVALID|PAGE_CORRUPT|ROUTING_INVALID/);
  assert.ok(!x.reads.includes('foreign-secret'));idle(x);
 }
});
test('pre-routing manifests remain readable through the same engine and the explicit materialized audit path',async()=>{
 const x=fixture();await x.build();const baseline=await x.execute(),manifest=x.manifest().manifest;
 delete manifest.routingVersion;for(const ref of manifest.refs)delete ref.routing;x.replaceManifest(manifest);
 const result=await x.execute();assert.equal(result.corpus.access.storage.storageAccess,'materialized_tables');assert.equal(result.result.packet.packetDigest,baseline.result.packet.packetDigest);idle(x);
});
test('awaiting Lane I/O refuses overlapping execution; cancellation drops the late access and preserves its unread cursor',async()=>{
 const x=fixture();await x.build();const opened=await x.read(),session=x.env.lane.createSession(opened.compiledIndex);let canceled=false,entered,release;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 x.onRead(async key=>{if(key.includes(':page:postings:')){entered();await gate;}});
 session.enqueue({laneRole:'query_anchor_access',table:'postings',channel:'lexical',term:'topic0007'});
 const pending=session.drainPendingAsync({checkCancel:()=>canceled});await started;
 assert.throws(()=>session.step(),/SESSION_BUSY/);assert.throws(()=>session.finalize(),/SESSION_BUSY/);
 canceled=true;release();const result=await pending;assert.equal(result.stoppedByBudget,true);assert.equal(result.newAccesses.length,0);
 const report=session.finalize();assert.equal(report.complete,false);assert.equal(report.stopReason,'cancelled');assert.equal(report.pagesRead,0);
 assert.ok(report.unreadCursors.length);assert.equal(report.storage.pagesRead,1);idle(x);
});
test('nearby anchors share only Cache Manager pages; physical counts and actual reads agree',async()=>{
 const x=fixture();await x.build();x.reads.length=0;
 const {result,corpus}=await x.execute({queryText:'topic0007 topic0008'});
 assert.ok(result.bundle.items.some(item=>item.nodeId==='n0007'));assert.ok(result.bundle.items.some(item=>item.nodeId==='n0008'));
 assert.ok(corpus.access.storage.cacheHits>0);assert.equal(result.accessTrace.lane.storage.pagesRead,tableReads(x).length);
 assert.equal(corpus.access.storage.pagesRead,tableReads(x).length);idle(x);
});
test('cache invalidation during pending I/O revokes the decode handle without restoring a request or lease',async()=>{
 const x=fixture();await x.build();let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 x.onRead(async key=>{if(key.includes(':page:postings:')){entered();await gate;}});
 const pending=x.execute();await started;x.env.pages.invalidate();release();await assert.rejects(()=>pending,/REQUEST_REVOKED/);idle(x);
});

test('N01-c: Lane unreadCursors captures intermediate storageCursor on storage budget stop and resumes seamlessly',async()=>{
 const x=fixture();await x.build();x.reads.length=0;
 const opened=await x.read();
 const s1=x.env.lane.createSession(opened.compiledIndex,{maxPages:16,maxStoragePages:1});
 s1.enqueue({laneRole:'graph_neighborhood',table:'adjacency'});
 const r1=await s1.drainPendingAsync();
 assert.equal(r1.stoppedByBudget,true);
 const rep1=s1.finalize();
 assert.equal(rep1.complete,false);
 assert.ok(rep1.unreadCursors.length>0);
 const unread=rep1.unreadCursors[0];
 assert.ok(unread.storageCursor,'unread cursor must carry storageCursor');
 assert.equal(unread.storageCursor.schema,'libra.graph_storage_access_cursor.v1');
 assert.equal(unread.storageCursor.refIndex,1);

 // Resume in a second session with full storage and logical budget
 const s2=x.env.lane.createSession(opened.compiledIndex,{maxPages:64,maxBytes:524288,maxStoragePages:16,resumeCursors:rep1.unreadCursors});
 const r2=await s2.drainPendingAsync();
 assert.equal(r2.stoppedByBudget,false);
 const rep2=s2.finalize();
 assert.equal(rep2.complete,true);
 assert.equal(rep2.unreadCursors.length,0);
 idle(x);
});
