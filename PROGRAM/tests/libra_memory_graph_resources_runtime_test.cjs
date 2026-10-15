'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
for(const mode of ['plugin_only','server_only','mirror'])test(`${mode}: native source, persisted proof/projection and final currentness use one budget without writes or model calls`,async t=>{
 const x=await fixture({mode});t.after(()=>x.cleanup());const api=x.f.r.api;
 await api.buildMemoryGraphCorpus({limit:2});const calls=x.f.control.calls.length,writes=x.f.r.storageWrites.length,batches=x.server?.batches.length||0;
 const options={corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}};
 const first=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(first.modelDispatchEligible,true);
 const report=first.diagnostics.resourceAccess;
 assert.ok(report.sourceBytes>0);assert.ok(report.durableBytes>0);assert.ok(report.peakDecodeBytes>0);assert.ok(report.peakReservedIoBytes>0);
 assert.equal(report.reservedIoBytes,0);assert.equal(report.decodeBytes,0);assert.equal(report.pool.ioBytes,0);assert.equal(report.pool.decodeBytes,0);assert.equal(report.byteBounded,false);
 for(const resourceBudget of [{maxSourceBytes:1},{maxDurableBytes:1},{maxDecodeBytes:1},{maxReads:3}]){
   await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({...options,resourceBudget}),/LIBRA_GRAPH_RESOURCE_/);
 }
 const healthy=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(healthy.modelDispatchEligible,true);assert.equal(healthy.bundle.bundleDigest,first.bundle.bundleDigest);
 assert.equal(x.f.control.calls.length,calls);assert.equal(x.f.r.storageWrites.length,writes);assert.equal(x.server?.batches.length||0,batches);
 console.log(JSON.stringify({mode,sourceBytes:report.sourceBytes,durableBytes:report.durableBytes,reads:report.reads,decodePeak:report.peakDecodeBytes,ioReservationPeak:report.peakReservedIoBytes,byteBounded:false}));
});

test('overlapping native queries share reservations; cancellation returns late reservations without publishing old evidence',async t=>{
 const x=await fixture();t.after(()=>x.cleanup());const api=x.f.r.api;await api.buildMemoryGraphCorpus({limit:2});
 const options={corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}};
 const backend=x.f.r.context.risuai.pluginStorage,get=backend.getItem;
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 let held=0,holding=true;
 backend.getItem=async key=>{if(holding&&key.includes(':corpus:root:')){held++;if(held===4)entered();await gate;}return get.call(backend,key);};
 t.after(()=>{backend.getItem=get;release();});
 const pending=Array.from({length:4},()=>api.executeMemoryGraphUnifiedQuery(options));
 const settled=Promise.allSettled(pending);await started;
 await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery(options),/IO_BACKPRESSURE/);
 api.cancelMemoryGraphGenerationBuild();holding=false;release();
 const old=await settled;assert.ok(old.every(result=>result.status==='rejected'),'all suspended queries lose their serial at cancellation');
 backend.getItem=get;
 const healthy=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(healthy.modelDispatchEligible,true);
 assert.equal(healthy.accessTrace.resources.pool.ioBytes,0);assert.equal(healthy.accessTrace.resources.pool.decodeBytes,0);
 assert.equal(healthy.accessTrace.resources.pool.reads,0);
});

test('a Micro loader cannot turn a caught payload-budget failure into a deliverable partial answer',async t=>{
 const x=await fixture();t.after(()=>x.cleanup());const api=x.f.r.api,values=x.f.r.values,raw=values.get(x.active.recordKey);
 const body=JSON.parse(raw);body.reviewBudgetPadding='x'.repeat(1024*1024);values.set(x.active.recordKey,JSON.stringify(body));
 const calls=x.f.control.calls.length,writes=x.f.r.storageWrites.length;
 await assert.rejects(()=>api.executeMemoryGraphUnifiedQuery({corpusMode:'window',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'},resourceBudget:{maxValueBytes:256*1024}}),/LIBRA_GRAPH_RESOURCE_VALUE_BYTE_BUDGET/);
 assert.equal(x.f.control.calls.length,calls);assert.equal(x.f.r.storageWrites.length,writes);
 values.set(x.active.recordKey,raw);
 assert.equal((await api.executeMemoryGraphUnifiedQuery({queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}})).modelDispatchEligible,true);
});
