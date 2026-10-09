'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {createCostFixture}=require('./fixtures/flashback_append_cost_fixture.cjs');
const {fixture}=require('./flashback_server_inspection_ui_test.cjs');
const groups=[];
(async()=>{const x=await createCostFixture({precomputedVectors:true});try{
 await x.seed(128);await x.append(129,'A','ingest');
 const manifest=await x.t.loadScopeManifest(x.scope);assert.equal(manifest.rawPageLayout,'flashback.raw_pages.v1');assert(manifest.rawPageReferences.some(r=>r.payloadCommitId!==manifest.commitId));
 const seed={plugin:[...x.pluginStorage.values],local:[...x.safeLocalStorage.values],chat:structuredClone(x.f.currentChat)};
 const f=await fixture({seed});try{const out=await f.api.inspectMemoryMaintenance();assert.equal(out.inspection.complete,true);assert.equal(out.storedRecords,129);assert.equal(out.storageMissingShards,0);assert.equal(out.storageCorruptShards,0);assert.equal(out.missingVectors,1);assert.equal(out.storageRecordCountMismatch,false);assert.equal(f.counts().localCorpusReads,0);assert.equal(f.counts().credentialReads,0);assert.equal(f.counts().writes,0);groups.push({name:'actual_cow_pages_and_base64_vector_sidecars',records:out.storedRecords,serverReads:f.counts().calls,reusedPages:manifest.rawPageReferences.filter(r=>r.payloadCommitId!==manifest.commitId).length});}finally{await f.dispose()}
 Object.assign(x.f.context,{CompressionStream,DecompressionStream,ReadableStream,Response,TextEncoder,TextDecoder,Blob});
 const archive=await x.t.createImmutableFlashbackHandoffArchive(x.scope.scopeKey,129,x.cfg);let compressed=0;
 for(const [key,value]of x.pluginStorage.values){const raw=typeof value==='string'?JSON.parse(value):value;if(raw?.schema!=='flashback_memory.archive_shard_gzip.v1')continue;const decoded=await x.t.decodeFlashbackShardEnvelope(value);assert.equal(decoded.compressed,true);assert.equal(decoded.parsed.scopeKey,archive.archiveRef.archiveScopeKey);assert(Array.isArray(decoded.parsed.records));compressed++;}
 assert(compressed>0,'actual archive writer emitted compressed records');groups.push({name:'actual_archive_gzip_decoder',compressed,uiCoverage:'excluded'});
 const current=await x.t.loadScopeManifest(x.scope);await x.t.saveScopeManifest({...current,archiveRef:archive.archiveRef},x.scope);
 const linked=await fixture({seed:{plugin:[...x.pluginStorage.values],local:[...x.safeLocalStorage.values],chat:structuredClone(x.f.currentChat)}});try{const out=await linked.api.inspectMemoryMaintenance();assert.equal(out.inspection.complete,false);assert(out.inspection.reasons.includes('archive_scope_excluded'));assert.equal(linked.counts().localCorpusReads,0);assert.equal(linked.counts().writes,0);groups.push({name:'real_linked_archive_remains_incomplete'});}finally{await linked.dispose()}
 assert.equal(x.providerCalls(),0);assert.equal(x.mockQueryCalls(),0);
 console.log(JSON.stringify({test:'flashback_server_inspection_production_format',passed:groups,providerCalls:0,liveRequests:0}));
 }finally{await x.dispose();fs.rmSync(x.root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
