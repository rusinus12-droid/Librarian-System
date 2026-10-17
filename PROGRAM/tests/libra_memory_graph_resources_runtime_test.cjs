'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
for(const mode of ['plugin_only','server_only','mirror'])test(`${mode}: native source, persisted proof/projection and final currentness use one budget without writes or model calls`,async t=>{
 const x=await fixture({mode});t.after(()=>x.cleanup());const api=x.f.r.api;
 await api.buildMemoryGraphCorpus({limit:2});const calls=x.f.control.calls.length,writes=x.f.r.storageWrites.length,batches=x.server?.batches.length||0;
 const options={corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}};
 const first=await api.executeMemoryGraphUnifiedQuery(options);assert.equal(first.modelDispatchEligible,true);
 const report=first.diagnostics.resourceAccess;
 assert.equal(report.limits.maxDecodeBytes,64*1024*1024);assert.equal(report.limits.maxRetainedBytes,128*1024*1024);
 assert.ok(report.retainedBytes>0);assert.ok(report.peakRetainedBytes>=report.retainedBytes);
 for(const label of ['durable_decoded_record','native_authority_maps','private_readset','consumer_packet'])assert.ok(report.retainedByCategory[label]>0,label);
 assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0,'the public clone retains no private native authority');
 assert.equal(api.inspectMemoryGraphStore().resources.sessions,0);
 assert.ok(report.sourceBytes>0);assert.ok(report.durableBytes>0);assert.ok(report.peakDecodeBytes>0);assert.ok(report.peakReservedIoBytes>0);
 assert.equal(report.reservedIoBytes,0);assert.equal(report.decodeBytes,0);assert.equal(report.pool.ioBytes,0);assert.equal(report.pool.decodeBytes,0);assert.equal(report.byteBounded,false);
 for(const resourceBudget of [{maxSourceBytes:1},{maxDurableBytes:1},{maxDecodeBytes:1},{maxReads:3},{maxRetainedBytes:1}]){
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
 assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0);assert.equal(api.inspectMemoryGraphStore().resources.sessions,0);
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


test('native build and eager audit share retained admission and always release their sessions',async t=>{
 const x=await fixture();t.after(()=>x.cleanup());const api=x.f.r.api;
 const built=await api.buildMemoryGraphCorpus();assert.ok(built.resourceAccess.peakRetainedBytes>0);
 assert.equal(built.resourceAccess.limits.maxDecodeBytes,64*1024*1024);assert.equal(built.resourceAccess.limits.maxRetainedBytes,192*1024*1024);
 assert.ok(built.resourceAccess.retainedByCategory.publication_projection>0);
 const roots=()=>[...x.f.r.values].filter(([key])=>key.includes(':corpus:root:'));
 const root=JSON.parse(roots()[0][1]),manifest=JSON.parse(x.f.r.values.get(root.manifestKey));
 assert.equal(manifest.config.limit,20);assert.equal(manifest.config.pageBytes,8192);
 const settings=await api.getLibraMemorySettings();assert.equal(settings.unifiedMaxUnits,24);assert.equal(settings.recallMaxChars,5000);
 const before=roots(),writes=x.f.r.storageWrites.length;
 await assert.rejects(()=>api.buildMemoryGraphCorpus({resourceBudget:{maxRetainedBytes:1}}),/RETAINED_/);
 assert.deepEqual(roots(),before);assert.equal(x.f.r.storageWrites.length,writes);
 await assert.rejects(()=>api.verifyMemoryGraphCorpus({resourceBudget:{maxRetainedBytes:1}}),/RETAINED_/);
 const audit=await api.verifyMemoryGraphCorpus();assert.equal(audit.status,'verified');assert.ok(audit.resourceAccess.peakRetainedBytes>0);
 assert.equal(audit.resourceAccess.limits.maxDecodeBytes,64*1024*1024);assert.equal(audit.resourceAccess.limits.maxRetainedBytes,192*1024*1024);
 assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0);assert.equal(api.inspectMemoryGraphStore().resources.sessions,0);
});

test('real owner receipts hold accounted authority across repeated checks and release on disposal or invalidation',async t=>{
 const bus=require('./fixtures/libra_gradia_read_bus.cjs')();
 const x=await fixture({mode:'server_only',hostOverrides:bus.api('libra'),transformSource:source=>{
   const anchor='state.memoryGraphResources = createLibraMemoryGraphResources({ measure:';
   assert.equal(source.split(anchor).length,2);
   return source.replace(anchor,'state.memoryGraphResources = createLibraMemoryGraphResources({ limits: { sessions: 1 }, measure:');
 }});t.after(()=>x.cleanup());const api=x.f.r.api;await api.buildMemoryGraphCorpus({limit:2});
 const boot=await fetch(x.server.url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'libra'}}).then(r=>r.json());
 const create=require('../tools/libra_gradia_unified_read.cjs');
 const client=create({role:'client',api:bus.api('serial_gradation_agents_for_rp'),timeoutMs:10000});t.after(()=>client.dispose());
 const input={scope:{scopeKey:x.scopeKey,characterId:x.f.character.id,chatId:x.f.chat.id},
   binding:{url:x.server.url,dataInstanceId:boot.dataInstanceId,resetEpoch:boot.resetEpochs.libra ?? 0},queryText:QUOTE,maxCorpusBytes:16384};
 const proof=r=>({scope:r.scope,readIdentity:r.readIdentity,dependencies:r.dependencies,evidenceRevision:r.evidenceRevision,dataInstanceId:r.dataInstanceId,resetEpoch:r.resetEpoch});
 const first=await client.capture(input),held=api.inspectMemoryGraphStore().resources.retainedBytes;assert.ok(held>0);
 for(let i=0;i<3;i++){assert.equal((await client.current({proof:proof(first)})).current,true);assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,held);}
 await assert.rejects(()=>client.capture(input),/LIB_READ_UNIFIED_UNAVAILABLE/);
 assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,held,'backpressure preserves the prior receipt');
 await client.release(first.readIdentity.ownerReceiptId);assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0);
 await assert.rejects(()=>client.current({proof:proof(first)}),/LIB_READ_STALE/);
 const second=await client.capture(input);assert.ok(api.inspectMemoryGraphStore().resources.retainedBytes>0);
 api.cancelMemoryGraphGenerationBuild();assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0);
 await assert.rejects(()=>client.current({proof:proof(second)}),/LIB_READ_/);
 await client.capture(input);await client.dispose();assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0);assert.equal(api.inspectMemoryGraphStore().resources.sessions,0);
});


test('Classic transfers authority to four UI contexts and eviction releases the oldest corpus',async t=>{
 const x=await fixture();t.after(()=>x.cleanup());const api=x.f.r.api;
 await api.buildMemoryGraphCorpus({limit:2});await api.saveLibraMemorySettings({unifiedMemoryEngineMode:'unified'});
 const contexts=[],held=[];
 for(let i=0;i<5;i++){
   const messages=[{role:'user',content:QUOTE}];const out=await x.f.control.hooks.beforeRequest(messages,'model');
   assert.ok(out.length>messages.length,JSON.stringify(api.getRuntime().lastMemoryInjectionMeta));
   contexts.push(api.getLastResponseContext());held.push(api.inspectMemoryGraphStore().resources.retainedBytes);
   assert.equal(api.inspectMemoryGraphStore().resources.sessions,Math.min(i+1,4));
 }
 assert.ok(held.every(bytes=>bytes>0));assert.equal(held[4],held[3],'the fifth context replaces one equal corpus instead of leaking another');
 assert.equal((await api.validateResponseContext(contexts[0])).ok,false);
 assert.equal((await api.validateResponseContext(contexts[4])).ok,true);
 api.cancelMemoryGraphGenerationBuild();assert.equal(api.inspectMemoryGraphStore().resources.retainedBytes,0);
 assert.equal((await api.validateResponseContext(contexts[4])).ok,false);
});
