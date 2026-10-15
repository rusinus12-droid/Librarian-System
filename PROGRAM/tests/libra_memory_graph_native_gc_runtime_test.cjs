'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,QUOTE}=require('./fixtures/libra_memory_graph_reader_fixture.cjs');
test('shipped server owner reclaims orphan corpus pages and keeps roots, proofs and recent large checkpoints',async t=>{
 const x=await fixture({mode:'server_only'});t.after(()=>x.cleanup());const api=x.f.r.api;
 await api.buildMemoryGraphCorpus({limit:1,maxWindowsPerStep:1});await api.buildMemoryGraphCorpus({limit:1});
 const before=x.server.storedRows().filter(row=>row.key.includes(':memory-graph:v1:'));
 const orphan='libra:v1:scope:'+x.scopeKey+':memory-graph:v1:corpus:page:directory:'+'f'.repeat(64);
 const other=orphan.replace('f'.repeat(64),'e'.repeat(64));await x.server.mutate(orphan,{orphan:true});await x.server.mutate(other,{orphan:true});
 const dry=await api.collectMemoryGraphGarbage({dryRun:true,candidateKeys:[orphan]});assert.equal(dry.status,'completed');assert.ok(dry.candidateKeys.includes(orphan));assert.ok(!dry.candidateKeys.includes(other));assert.equal(dry.deletedKeys.length,0);
 const real=await api.collectMemoryGraphGarbage({dryRun:false,candidateKeys:[orphan]});assert.equal(real.status,'completed');assert.ok(real.deletedKeys.includes(orphan));assert.ok(!real.deletedKeys.includes(other));
 assert.equal(real.corpusReclamation,'owner_atomic_reachability');
 const after=x.server.storedRows();for(const row of before)assert.ok(after.some(saved=>saved.key===row.key&&saved.raw===row.raw),row.key);
 const query=await api.executeMemoryGraphUnifiedQuery({corpusMode:'required',queryInput:{queryText:QUOTE},semanticPolicy:{mode:'disabled'}});assert.equal(query.modelDispatchEligible,true);
});
for(const mode of ['plugin_only','mirror'])test(`${mode}: storage without an atomic local/mirror protocol keeps destructive GC blocked`,async t=>{
 const x=await fixture({mode});t.after(()=>x.cleanup());const result=await x.f.r.api.collectMemoryGraphGarbage({dryRun:false});assert.equal(result.status,'blocked_atomic_gc_unavailable');assert.equal(result.deletedKeys.length,0);
});
