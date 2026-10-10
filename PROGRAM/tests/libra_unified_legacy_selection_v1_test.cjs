'use strict';
const assert=require('node:assert/strict');const {lineageFixture}=require('./fixtures/libra_unified_lineage_fixture.cjs');const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const results=[],info=JSON.stringify;
const {classifyCall,countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
function shifted(offset){const a=artifact();for(const row of [...a.entities,...a.facts])for(const s of row.evidenceSpans)s.ref=s.ref.replace(/^t(\d+)/,(_,n)=>'t'+(Number(n)+offset));return a;}
function assertCanonicalMemoryStableExceptEmbedding(beforeRaw,afterRaw){const before=JSON.parse(beforeRaw),after=JSON.parse(afterRaw);for(const field of new Set([...Object.keys(before),...Object.keys(after)]))if(field!=='embedding')assert.deepEqual(after[field],before[field],`canonical payload field changed: ${field}`);}
async function setup(n=3){return await lineageFixture({snapshot:require('./fixtures/legacy_v3_frozen_3_batches.json')});}
async function select(f,starts){const p=await f.r.api.previewLegacyMemoryRebuild();return {previewDigest:p.previewDigest,expectedScopeKey:p.scopeKey,selectedKeys:p.rows.filter(r=>starts.includes(r.turnRange.start)).map(r=>r.key)};}
async function test(name,fn){const f=await setup();try{await fn(f);results.push(name);console.log('PASS',name);}finally{await f.r.cleanup();}}
(async()=>{
 await test('noncontiguous explicit selection converts only two approved source spans, retains legacy gap and history',async f=>{
  const old=Object.fromEntries(Object.entries(f.manifest().memories).map(([n,r])=>[n,{ref:r,bytes:f.r.values.get(r.key)}])),before=countCalls(f.control).canonical;
  let i=0;f.control.onCall=args=>({type:'success',result:JSON.stringify(classifyCall(args)==='canonical'?shifted([0,10][i++]):shifted(0))});
  const out=await f.r.api.rebuildSelectedLegacyMemories(await select(f,[1,11]));assert.equal(out.completed,2,info(out));assert.equal(out.ok,true,info(out));assert.equal(countCalls(f.control).canonical-before,2);
  assert.equal(f.r.values.get(old['6'].ref.key),old['6'].bytes);for(const x of Object.values(old))assert.equal(f.r.values.get(x.ref.key),x.bytes);
  assert.equal(f.manifest().memories['1'].artifactSchema,'libra.canonical_artifact.v4');assert.equal(f.manifest().memories['6'].artifactSchema,'libra.canonical_artifact.v3');assert.equal(f.manifest().memories['11'].artifactSchema,'libra.canonical_artifact.v4');
  assert.equal(f.head().throughTurn,15);assert.equal(f.head().unifiedCoverage.legacyCount,1);assert.equal(f.head().status,'partial');assert.deepEqual(JSON.parse(info(f.head().unifiedCoverage.unknownIntervals)),[{turnRange:{start:6,end:10},sessionEpoch:0}]);
  assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);
 });
 await test('selected legacy rebuild tolerates only derived embedding drift and retains approved evidence and gaps',async f=>{
  const selection=await select(f,[1]),before=f.manifest(),oldRows=Object.fromEntries(Object.entries(before.memories).map(([n,ref])=>[n,{ref,bytes:f.r.values.get(ref.key)}]));
  const oldMemory=JSON.parse(oldRows['1'].bytes),evidenceKey=oldMemory.sourceEvidenceRef.key,evidenceBytes=f.r.values.get(evidenceKey),manifestRow=f.getRecords('libra.manifest.v1').find(row=>row.value.scopeKey===before.scopeKey);
  const changed=JSON.parse(f.r.values.get(manifestRow.key));Object.assign(changed.memories['1'],{embeddingStatus:'disabled',retrievalVersion:'libra.retrieval_projection.v2',vectorCount:4,updatedAt:'2026-09-28T00:00:02.000Z'});
  f.r.values.set(manifestRow.key,JSON.stringify(changed));f.control.onCall=()=>({type:'success',result:JSON.stringify(shifted(0))});
  const out=await f.r.api.rebuildSelectedLegacyMemories(selection);assert.equal(out.completed,1,info(out));assert.equal(countCalls(f.control).canonical,1);
  const after=f.manifest();assert.equal(after.memories['1'].artifactSchema,'libra.canonical_artifact.v4');
  assert.equal(after.memories['6'].key,oldRows['6'].ref.key);assert.equal(after.memories['11'].key,oldRows['11'].ref.key);
  assert.equal(f.head().status,'partial');assert.equal(f.head().unifiedCoverage.legacyCount,2);
  assert.equal(f.r.values.get(oldRows['1'].ref.key),oldRows['1'].bytes);assert.equal(f.r.values.get(evidenceKey),evidenceBytes);
  for(const n of ['6','11'])assert.equal(f.r.values.get(oldRows[n].ref.key),oldRows[n].bytes);
 });
 await test('explicit completion of the remaining gap reconstructs all typed history without redoing converted spans',async f=>{
  let i=0;f.control.onCall=args=>({type:'success',result:JSON.stringify(classifyCall(args)==='canonical'?shifted([0,10][i++]):shifted(0))});await f.r.api.rebuildSelectedLegacyMemories(await select(f,[1,11]));
  const before=countCalls(f.control).canonical,saved=['1','11'].map(n=>{const r=f.manifest().memories[n],memory=JSON.parse(f.r.values.get(r.key));return[r.key,memory,f.r.values.get(memory.sourceEvidenceRef.key)];});f.control.onCall=()=>({type:'success',result:JSON.stringify(shifted(5))});
  const out=await f.r.api.rebuildSelectedLegacyMemories(await select(f,[6]));assert.equal(out.completed,1,info(out));assert.equal(countCalls(f.control).canonical-before,1);assert.equal(f.head().status,'ready');
  for(const[k,beforeMemory,evidenceBytes]of saved){const afterMemory=JSON.parse(f.r.values.get(k));assert.equal(afterMemory.revision,beforeMemory.revision);assert.equal(afterMemory.artifactDigest,beforeMemory.artifactDigest);assert.equal(afterMemory.sourceDigest,beforeMemory.sourceDigest);assert.deepEqual(afterMemory.turnRange,beforeMemory.turnRange);assert.deepEqual(afterMemory.canonicalArtifact,beforeMemory.canonicalArtifact);assert.deepEqual(afterMemory.sourceEvidenceRef,beforeMemory.sourceEvidenceRef);assert.equal(f.r.values.get(beforeMemory.sourceEvidenceRef.key),evidenceBytes);}
 });
 await test('missing or changed evidence and empty selection cannot authorize a model call',async f=>{
  const p=await select(f,[1]),m=JSON.parse(f.r.values.get(f.manifest().memories['1'].key)),before=countCalls(f.control).canonical;
  await assert.rejects(()=>f.r.api.rebuildSelectedLegacyMemories({...p,selectedKeys:[]}),/SELECTION_REQUIRED/);
  f.r.values.delete(m.sourceEvidenceRef.key);await assert.rejects(()=>f.r.api.rebuildSelectedLegacyMemories(p),/PREVIEW_CHANGED/);
  const next=await f.r.api.previewLegacyMemoryRebuild();assert.equal(next.rows.find(r=>r.turnRange.start===1).available,false);
  await assert.rejects(()=>f.r.api.rebuildSelectedLegacyMemories({previewDigest:next.previewDigest,expectedScopeKey:next.scopeKey,selectedKeys:[next.rows.find(r=>r.turnRange.start===1).key]}),/EVIDENCE_REQUIRED/);assert.equal(countCalls(f.control).canonical,before);
 });
 await test('edited live source is not silently substituted for stored approved evidence',async f=>{
  const p=await select(f,[1]),before=countCalls(f.control).canonical;f.current().message[1].data+=' 원문 변경';
  await assert.rejects(()=>f.r.api.rebuildSelectedLegacyMemories(p),/PREVIEW_CHANGED/);const preview=await f.r.api.previewLegacyMemoryRebuild();assert.equal(preview.rows[0].available,false);assert.match(preview.rows[0].reason,/SOURCE_REVIEW_REQUIRED/);assert.equal(countCalls(f.control).canonical,before);
 });
 await test('model failure keeps original active legacy and retries only still-legacy selections',async f=>{
  const original=f.manifest().memories['1'],raw=f.r.values.get(original.key);f.control.onCall=()=>({type:'error',result:'fixture model unavailable'});
  const out=await f.r.api.rebuildSelectedLegacyMemories(await select(f,[1]));assert.equal(out.completed,0,info(out));assert.equal(f.manifest().memories['1'].revision,original.revision);assert.equal(f.r.values.get(original.key),raw);
  f.control.onCall=()=>({type:'success',result:JSON.stringify(shifted(0))});const retry=await f.r.api.rebuildSelectedLegacyMemories(await select(f,[1]));assert.equal(retry.completed,1,info(retry));
 });
 await test('sparse converted history survives source-immutable handoff with honest gaps',async f=>{
  let i=0;f.control.onCall=args=>({type:'success',result:JSON.stringify(classifyCall(args)==='canonical'?shifted([0,10][i++]):shifted(0))});await f.r.api.rebuildSelectedLegacyMemories(await select(f,[1,11]));
  const sourceBytes=Object.values(f.manifest().memories).map(r=>{const raw=f.r.values.get(r.key),memory=JSON.parse(raw);return[r.key,raw,memory.sourceEvidenceRef?.key||'',memory.sourceEvidenceRef?.key?f.r.values.get(memory.sourceEvidenceRef.key):null];});await f.r.api.prepareSessionHandoff({transferId:'sparse-legacy'});for(const[k,raw,evidenceKey,evidenceBytes]of sourceBytes){assertCanonicalMemoryStableExceptEmbedding(raw,f.r.values.get(k));if(evidenceKey)assert.equal(f.r.values.get(evidenceKey),evidenceBytes);}
  f.empty('sparse-target');const result=await f.r.api.adoptSessionHandoff({transferId:'sparse-legacy',targetChatId:'sparse-target'});assert.equal(result.verified,true,info(result));assert.equal(f.head().unifiedCoverage.legacyCount,1);assert.equal(f.head().status,'partial');
 });
 await test('native copy carries sparse conversion policy without filling a legacy gap or rewriting parent',async f=>{
  let i=0;f.control.onCall=args=>({type:'success',result:JSON.stringify(classifyCall(args)==='canonical'?shifted([0,10][i++]):shifted(0))});await f.r.api.rebuildSelectedLegacyMemories(await select(f,[1,11]));
  const parent=f.current(),saved=Object.values(f.manifest().memories).map(r=>{const raw=f.r.values.get(r.key),memory=JSON.parse(raw);return[r.key,raw,memory.sourceEvidenceRef?.key||'',memory.sourceEvidenceRef?.key?f.r.values.get(memory.sourceEvidenceRef.key):null];}),n=countCalls(f.control).canonical;
  f.branch(12,'sparse-native-child');const out=await f.r.api.debugNativeChatCopy({force:true});assert.equal(out.result?.ok,true,info(out));
  assert.deepEqual(Object.keys(f.manifest().memories),['1','6']);assert.equal(f.head().status,'partial');assert.equal(f.head().unifiedCoverage.legacyCount,1);
  assert.equal(f.head(parent).throughTurn,15);assert.equal(countCalls(f.control).canonical,n);for(const[k,raw,evidenceKey,evidenceBytes]of saved){assertCanonicalMemoryStableExceptEmbedding(raw,f.r.values.get(k));if(evidenceKey)assert.equal(f.r.values.get(evidenceKey),evidenceBytes);}
 });
 console.log(JSON.stringify({test:'libra_unified_legacy_selection_v1',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
