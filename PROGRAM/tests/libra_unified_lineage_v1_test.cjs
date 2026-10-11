'use strict';
const assert=require('node:assert/strict');
const {lineageFixture,clone}=require('./fixtures/libra_unified_lineage_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const ownerObserver=source=>{
 const marker='    const acquirePortableOperation = kind => {';
 assert.equal(source.split(marker).length,2,'current portable guard has one owner');
 return source.replace(marker,`    globalThis.__LINEAGE_OWNER_TRANSACTIONS__ = () => ({
      canonical: portableCanonicalJobBusy(), pipeline: Runtime.inFlight,
      memory: LibraMemoryCore.state.queues.size, receipts: LibraMemoryCore.state.receiptQueues.size,
      micro: LibraMemoryCore.state.microQueues.size
    });\n${marker}`);
};
async function waitOwnerSettled(f){
 assert.equal(typeof f.r.context.__LINEAGE_OWNER_TRANSACTIONS__,'function');
 await waitFor(()=>Object.values(f.r.context.__LINEAGE_OWNER_TRANSACTIONS__()).every(value=>!value),15000);
}
async function runSettled(f){const value=await f.run();await waitOwnerSettled(f);return value;}
async function exportSettledScope(f){await waitOwnerSettled(f);return await f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope();
}
const results=[];async function test(name,fn){const f=await lineageFixture({transformSource:ownerObserver});try{await fn(f);results.push(name);console.log('PASS',name);}finally{await f.r.cleanup();}}
const info=x=>JSON.stringify(x);
const canonicalCallCount = calls => calls.filter(args =>
 !String(args?.[0]?.messages?.[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')).length;
const {isDeepStrictEqual}=require('node:util');
function assertMemoryStableExceptEmbedding(expectedRaw,actualRaw,message){
 const expected=JSON.parse(expectedRaw),actual=JSON.parse(actualRaw),expectedEmbedding=expected.embedding,actualEmbedding=actual.embedding;
 delete expected.embedding;delete actual.embedding;assert.deepEqual(actual,expected,message);
 const embeddingChanged=!isDeepStrictEqual(actualEmbedding,expectedEmbedding);
 if(!embeddingChanged)assert.equal(actualRaw,expectedRaw,`${message}: unchanged embedding retains exact raw bytes`);
 return {embeddingChanged};
}
(async()=>{
 await test('native copied prefix rebinds evidence, preserves parent, and continues same identities',async f=>{
  assert.equal((await runSettled(f)).completed,1);const parent=f.current();f.appendFive();assert.equal((await runSettled(f)).completed,1);
  const pm=f.manifest(parent),ph=clone(f.head(parent)),stored=[...f.r.values].filter(([k])=>k.includes(`:scope:${pm.scopeKey}:`));
  f.branch(5,'child');const n=f.control.calls.length;const result=await f.r.api.debugNativeChatCopy({force:true});assert.equal(result.result?.ok,true,info(result));
  const cm=f.manifest();assert.equal(Object.keys(cm.memories).length,1);assert.equal(f.head().throughTurn,5);assert.equal(f.control.calls.length,n);
  const mem=JSON.parse(f.r.values.get(cm.memories['1'].key));assert.equal(mem.sourceEvidenceRef.scopeKey,cm.scopeKey);assert.notEqual(mem.sourceEvidenceRef.scopeKey,pm.scopeKey);
  assert.deepEqual(f.head().characters.map(x=>x.id).sort(),ph.characters.map(x=>x.id).sort());
  for(const [k,v]of stored)assert.equal(f.r.values.get(k),v,'parent bytes '+k);
  f.appendFive();const next=await runSettled(f);assert.equal(next.completed,1,info(next));assert.equal(f.head().characters.length,ph.characters.length);assert.equal(f.head().throughTurn,10);
 });
 await test('native correction before fork inherits, postfork correction does not',async f=>{
  await runSettled(f);const parent=f.current(),mina=f.head().characters.find(x=>x.name==='민아');
  assert.equal((await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:mina.id,set:{condition:'부모 T5 교정'}}]}})).ok,true);
  f.appendFive();await runSettled(f);assert.equal((await f.r.api.addWorldManagerCorrection({anchorTurn:10,target:{domain:'characters'},patch:{characters:[{id:mina.id,set:{condition:'부모 T10 교정'}}]}})).ok,true);
  f.branch(5,'corrected-child');const res=await f.r.api.debugNativeChatCopy({force:true});assert.equal(res.result?.ok,true,info(res));assert.equal(f.head().characters.find(x=>x.id===mina.id).state.condition,'부모 T5 교정');assert.equal(f.head(parent).characters.find(x=>x.id===mina.id).state.condition,'부모 T10 교정');
 });
 await test('handoff archives v4 and reconstructs target from sealed evidence',async f=>{
  await runSettled(f);const parent=f.current(),pm=clone(f.manifest()),keys=[...f.r.values].filter(([k])=>k.includes(`:scope:${pm.scopeKey}:`));
  const prep=await f.r.api.prepareSessionHandoff({transferId:'unified-five-A-B'});assert.equal(prep.ok!==false,true,info(prep));
  f.empty('session-b');const result=await f.r.api.adoptSessionHandoff({transferId:'unified-five-A-B',targetChatId:'session-b'});assert.equal(result.verified,true,info(result));assert.equal(result.continuityStateAuthority,'target_canonical_chain',info(result));assert.equal(f.head().throughTurn,0);assert.equal(f.head().characters.length,3);assert.equal(canonicalCallCount(f.control.calls),1);
  for(const[k,v]of keys)assert.equal(f.r.values.get(k),v,'source changed '+k);
  const archives=[...f.r.values].filter(([k,v])=>{try{return JSON.parse(v).scopeKey?.startsWith('archive:');}catch{return false;}});
  const repeated=await f.r.api.adoptSessionHandoff({transferId:'unified-five-A-B',targetChatId:'session-b'});assert.equal(repeated.verified,true,info(repeated));
  f.appendFive();const next=await runSettled(f);assert.equal(next.completed,1,info(next));assert.equal(f.head().throughTurn,5);assert.equal(f.head().characters.length,3);
  const prep2=await f.r.api.prepareSessionHandoff({transferId:'unified-five-B-C'});f.empty('session-c');const r2=await f.r.api.adoptSessionHandoff({transferId:'unified-five-B-C',targetChatId:'session-c'});assert.equal(r2.continuityStateAuthority,'target_canonical_chain',info(r2));
  for(const[k,v]of archives)assert.equal(f.r.values.get(k),v,'ancestor archive rewritten '+k);
  for(const[k]of keys)f.r.values.delete(k);const rebuilt=await f.r.api.rebuildWorldManagerState();assert.equal(rebuilt.ok,true,info(rebuilt));assert.equal(canonicalCallCount(f.control.calls),2);
 });

 await test('portable backup includes evidence and restores in a different runtime without source storage',async f=>{
  await runSettled(f);const exporter=f.r.context.__LIBRAPortableMemoryBackup;assert.ok(exporter,'portable API');
  const backup=await exportSettledScope(f);assert.ok(JSON.stringify(backup).includes('source-evidence.v1'));
  const other=await lineageFixture();try{other.empty('portable-destination');const preview=await other.r.api.previewPortableMemoryImport(backup);const restored=await other.r.api.importPortableMemoryAsArchive(backup);assert.equal(restored.ok,true,info(restored));assert.equal(other.head().characters.length,3);assert.equal(other.control.calls.length,0);assert.equal((await other.r.api.rebuildWorldManagerState()).ok,true);}finally{await other.r.cleanup();}
 });
 await test('portable native copy matches prefix and restores corrected identity without model calls',async f=>{
  await runSettled(f);const p=f.head().characters.find(x=>x.name==='민아');const c=await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:p.id,name:'민아',renameTo:'민아 선배',aliases:['민아']}]}});assert.equal(c.ok,true,info(c));
  const backup=await exportSettledScope(f);const other=await lineageFixture();
  try{other.current().id='portable-copy';other.current().chatId='portable-copy';const res=await other.r.api.reconstructPortableCopiedChat(backup);assert.equal(res.ok,true,info(res));assert.equal(other.head().characters.find(x=>x.id===p.id).name,'민아 선배');assert.equal(other.control.calls.length,0);other.appendFive();assert.equal((await other.run()).completed,1);assert.equal(other.head().characters.length,3);assert.equal(other.head().characters.find(x=>x.id===p.id).name,'민아 선배');}finally{await other.r.cleanup();}
 });
 await test('main rollback hides post-frontier state, keeps canonical bytes, and reopens explicitly',async f=>{
  await runSettled(f);f.appendFive();await runSettled(f);const manifest=f.manifest(),saved=Object.values(manifest.memories).map(ref=>{
   const raw=f.r.values.get(ref.key),memory=JSON.parse(raw),evidenceKey=memory.sourceEvidenceRef?.key,evidenceRaw=f.r.values.get(evidenceKey);
   assert.ok(evidenceKey,'each canonical memory has a durable source-evidence row');
   return {key:ref.key,raw,evidenceKey,evidenceRaw,memory};
  });
  const rolled=await f.r.api.rollbackWorldManagerState({throughTurn:5});assert.equal(rolled.ok,true,info(rolled));assert.equal(f.head().throughTurn,5);
  assert.equal((await f.r.api.rebuildWorldManagerState()).head.throughTurn,5);
  for(const row of saved){
   const actualRaw=f.r.values.get(row.key),actualMemory=JSON.parse(actualRaw);
   assertMemoryStableExceptEmbedding(row.raw,actualRaw,`rollback and rebuild preserve canonical record ${row.key}`);
   assert.equal(actualMemory.revision,row.memory.revision,`revision is unchanged for ${row.key}`);
   assert.equal(actualMemory.sourceDigest,row.memory.sourceDigest,`source digest is unchanged for ${row.key}`);
   assert.equal(actualMemory.artifactDigest,row.memory.artifactDigest,`artifact digest is unchanged for ${row.key}`);
   assert.equal(f.r.values.get(row.evidenceKey),row.evidenceRaw,`source-evidence bytes are unchanged for ${row.key}`);
  }
  const reopened=await f.r.api.setWorldManagerWorldline({worldlineId:'main',cutoffTurn:null});assert.equal(reopened.ok,true,info(reopened));assert.equal(f.head().throughTurn,10);assert.equal(canonicalCallCount(f.control.calls),2);
 });
 await test('repeated source preparation does not rewrite sealed v4 archive records',async f=>{
  await runSettled(f);await f.r.api.prepareSessionHandoff({transferId:'repeat-A'});const records=[...f.r.values].filter(([k,v])=>{try{return JSON.parse(v)?.scopeKey?.startsWith('archive:')||JSON.parse(v)?.schema==='libra.shared_archive_manifest.v1';}catch{return false;}});
  await f.r.api.prepareSessionHandoff({transferId:'repeat-B'});for(const[k,v]of records)assert.equal(f.r.values.get(k),v,'shared record '+k);
 });

 await test('non-batch fork inherits only completed prefix, never an overhanging five-turn memory',async f=>{
  await runSettled(f);f.appendFive();await runSettled(f);const parent=f.current(),pm=f.manifest(parent),before=Object.values(pm.memories).map(r=>[r.key,f.r.values.get(r.key)]);
  f.branch(7,'fork-at-seven');const out=await f.r.api.debugNativeChatCopy({force:true});assert.equal(out.result?.ok,true,info(out));assert.deepEqual(Object.keys(f.manifest().memories),['1']);assert.equal(f.head().throughTurn,5);for(const[k,v]of before)assert.equal(f.r.values.get(k),v);assert.equal(canonicalCallCount(f.control.calls),2);
 });
 await test('missing or corrupted v4 evidence blocks handoff before any sealed source is altered',async f=>{
  await runSettled(f);const m=f.manifest(),ref=m.memories['1'],memory=JSON.parse(f.r.values.get(ref.key)),original=f.r.values.get(ref.key);f.r.values.delete(memory.sourceEvidenceRef.key);
  await assert.rejects(()=>f.r.api.prepareSessionHandoff({transferId:'missing-evidence-transfer'}),/UNIFIED_REPLAY_EVIDENCE_MISMATCH/);assert.equal(f.r.values.get(ref.key),original);assert.equal(f.head().throughTurn,5);assert.equal(canonicalCallCount(f.control.calls),1);
 });
 await test('portable missing evidence is not accepted as a successful import',async f=>{
  await runSettled(f);const backup=await exportSettledScope(f);const bad=clone(backup);const oldLength=bad.records.length;bad.records=bad.records.filter(r=>!r.key.includes(':source-evidence:v1:'));assert.ok(bad.records.length<oldLength);
  const other=await lineageFixture();try{other.empty('missing-portable');await assert.rejects(()=>other.r.api.importPortableMemoryAsArchive(bad));assert.equal(other.head(),undefined);assert.equal(other.control.calls.length,0);}finally{await other.r.cleanup();}
 });
 await test('State-only rollback cannot silently export future memory as current handoff or portable adoption',async f=>{
  await runSettled(f);f.appendFive();await runSettled(f);await f.r.api.rollbackWorldManagerState({throughTurn:5});
  await assert.rejects(()=>f.r.api.prepareSessionHandoff({transferId:'rollback-transfer'}),/UNIFIED_HANDOFF_ROLLBACK_REQUIRES_NATIVE_PREFIX/);
  const backup=await exportSettledScope(f);const other=await lineageFixture();try{other.empty('rollback-portable');await assert.rejects(()=>other.r.api.importPortableMemoryAsArchive(backup),/UNIFIED_PORTABLE_ROLLBACK_REQUIRES_NATIVE_PREFIX/);assert.equal(other.head(),undefined);}finally{await other.r.cleanup();}assert.equal(f.head().throughTurn,5);assert.equal(canonicalCallCount(f.control.calls),2);
 });
 console.log(JSON.stringify({test:'libra_unified_lineage_v1',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
