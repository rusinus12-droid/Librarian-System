'use strict';
const assert=require('node:assert/strict');
const {fixture,artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {createRootBoundary}=require('./fixtures/source_edit_root_boundary.cjs');
const results=[];
const {isDeepStrictEqual}=require('node:util');
const {countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
function assertMemoryStableExceptEmbedding(expectedRaw,actualRaw,message){
 const expected=JSON.parse(expectedRaw),actual=JSON.parse(actualRaw),expectedEmbedding=expected.embedding,actualEmbedding=actual.embedding;
 delete expected.embedding;delete actual.embedding;assert.deepEqual(actual,expected,message);
 const embeddingChanged=!isDeepStrictEqual(actualEmbedding,expectedEmbedding);
 if(!embeddingChanged)assert.equal(actualRaw,expectedRaw,`${message}: unchanged embedding retains exact raw bytes`);
 return {embeddingChanged};
}
const sourceChanged=f=>{
 const quote='서재에서 준호가 열쇠를 지호에게 건넸지만 지호는 민아에게 돌려주지 않았다. 오늘 반환 약속은 아직 이행되지 않았다. 공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.';
 f.chat.message[9].data=quote;
 const a=artifact();for(const x of [...a.entities,...a.facts])for(const e of x.evidenceSpans)if(e.ref==='t5-a')e.quote=quote;
 a.facts.find(x=>x.tempFactId==='f11').values.holderRef='jiho';a.facts.find(x=>x.tempFactId==='f11').text='지호는 열쇠를 민아에게 아직 반환하지 않았다.';
 a.facts.find(x=>x.tempFactId==='f12').values.thread.status='open';a.facts.find(x=>x.tempFactId==='f12').text='오늘 반환 약속은 아직 이행되지 않았다.';f.control.artifact=a;
};
async function setup(){const root=createRootBoundary(),f=await fixture({host:{getRootDocument:async()=>root.root}});return {root,f};}
async function boundary(f,root){
 const before=countCalls(f.control).canonical;await f.r.sourceEditBoundary();
 assert.equal(await root.ready(),false,'beforeRequest must not open source-edit consent UI');
 assert.equal(countCalls(f.control).canonical,before,'request observation never reanalyzes edited source');
 const selection=await f.r.api.listCanonicalBatchRanges();
 assert.ok(selection.ranges.length,'explicit selection contains saved source ranges');
 assert.ok(selection.ranges.every(row=>row.status==='saved'),'replacement targets saved ranges');
 assert.equal(countCalls(f.control).canonical,before,'explicit range inspection is model-free');
 return f.r.api.startSelectedCanonicalBatches({scopeKey:selection.scopeKey,mode:'source_edit',ranges:selection.ranges});
}
async function scenario(name,fn){const {root,f}=await setup();try{await fn(f,root);results.push(name);}finally{await f.r.cleanup();}}

(async()=>{
 await scenario('explicit selected source replacement commits one segment and preserves prior body',async(f,root)=>{
  await f.run();const old=f.getMemory(),oldKey=f.getManifest().memories['1'].key,oldBytes=f.r.values.get(oldKey);
  sourceChanged(f);const result=await boundary(f,root);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(countCalls(f.control).canonical,2,'the source edit still runs the Canonical pass twice (initial commit plus replacement)');
  assert.equal(f.getMemory().revision,2);assert.notEqual(f.getMemory().artifactDigest,old.artifactDigest);
  assert.equal(f.r.values.get(oldKey),oldBytes);const h=f.getHead();assert.equal(h.throughTurn,5);
  assert.equal(h.world.find(r=>r.name==='은빛 열쇠').state.holderRef,h.characters.find(r=>r.name==='지호').id);
  assert.equal(result.job.completed,1);assert.equal(result.job.failed,0);
  assert.equal(f.getRecords('libra.unified_basis_snapshot.v1').length,0);
  const canonicalCalls=f.control.calls.filter(args=>require('./fixtures/libra_provider_call_kinds.cjs').classifyCall(args)==='canonical');
  const supplied=canonicalCalls[canonicalCalls.length-1].map(x=>typeof x==='string'?x:JSON.stringify(x)).join('\n');
  assert.ok(supplied.includes('[READ-ONLY LAST-KNOWN STATE; NOT CURRENT EVENT EVIDENCE'));
 });
 await scenario('provider failure retains prior canonical and Head',async(f,root)=>{
  await f.run();const old=f.getMemory(),h=JSON.stringify(f.getHead());sourceChanged(f);f.control.modelFails=true;const result=await boundary(f,root);
  assert.equal(f.getMemory().revision,old.revision);assert.equal(JSON.stringify(f.getHead()),h);
  assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.job.failed,1);
 });
 await scenario('source re-edited during provider call cannot activate stale candidate',async(f,root)=>{
  await f.run();const old=f.getMemory();sourceChanged(f);
  f.control.onCall=async()=>{f.chat.message[9].data+=' changed while provider was running';return {type:'success',result:JSON.stringify(f.control.artifact)};};
  const result=await boundary(f,root);assert.equal(f.getMemory().revision,old.revision);
  assert.equal(result.ok,false,JSON.stringify(result));
 });
 await scenario('downstream changed segments are rebuilt from their own historical prefixes',async(f,root)=>{
  await f.run();const extra=f.chat.message.slice(0,10).map((m,i)=>({...m,chatId:'t'+(6+Math.floor(i/2))+'-'+(i%2?'a':'u')}));f.chat.message.push(...extra);
  f.control.artifact=artifact();for(const x of [...f.control.artifact.entities,...f.control.artifact.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\d+)/,(_,n)=>'t'+(Number(n)+5));
  assert.equal((await f.run()).completed,1);const oldLaterRef=f.getManifest().memories['6'],later=f.r.values.get(oldLaterRef.key),laterMemory=JSON.parse(later);
  const evidenceKey=laterMemory.sourceEvidenceRef?.key,evidenceBytes=f.r.values.get(evidenceKey);assert.ok(evidenceKey,'later segment has a durable source-evidence row');sourceChanged(f);
  const firstArtifact=f.clone(f.control.artifact),laterArtifact=artifact();for(const x of [...laterArtifact.entities,...laterArtifact.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\d+)/,(_,n)=>'t'+(Number(n)+5));
  f.control.onCall=async args=>({type:'success',result:JSON.stringify(JSON.stringify(args).includes('[t6-u]')?laterArtifact:firstArtifact)});
  const result=await boundary(f,root);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.job.completed,2);
  assert.equal(countCalls(f.control).canonical,4,'the two-segment rebuild runs four Canonical passes');
  const rebuiltCalls=f.control.calls.filter(args=>require('./fixtures/libra_provider_call_kinds.cjs').classifyCall(args)==='canonical').slice(-2);
  const rebuiltPrompts=rebuiltCalls.map(args=>JSON.stringify(args));
  assert.ok(rebuiltPrompts[0].includes('[t1-u]'));assert.ok(rebuiltPrompts[0].includes('[State applied through turn 0;'),'first selected range uses the state before its own historical source');
  assert.ok(rebuiltPrompts[1].includes('[t6-u]'));assert.ok(rebuiltPrompts[1].includes('[State applied through turn 5;'),'second selected range uses the rebuilt first-range prefix');
  const laterAfter=f.r.values.get(oldLaterRef.key),laterAfterMemory=JSON.parse(laterAfter);
  assertMemoryStableExceptEmbedding(later,laterAfter,'rebuilding an earlier source segment preserves all later canonical fields except derived embedding state');
  assert.equal(laterAfterMemory.revision,laterMemory.revision,'later segment revision stays unchanged');
  assert.equal(laterAfterMemory.sourceDigest,laterMemory.sourceDigest,'later segment source digest stays unchanged');
  assert.equal(laterAfterMemory.artifactDigest,laterMemory.artifactDigest,'later segment artifact digest stays unchanged');
  assert.equal(f.r.values.get(evidenceKey),evidenceBytes,'later segment source-evidence bytes stay unchanged');
  assert.equal(f.getMemory(6).revision,2);assert.equal(f.getMemory().revision,2);
  const h=f.getHead();assert.equal(h.throughTurn,10);assert.equal(h.world.find(r=>r.name==='은빛 열쇠').state.holderRef,h.characters.find(r=>r.name==='민아').id);
 });
 await scenario('post-canonical Head failure keeps canonical and retries state locally',async(f,root)=>{
  await f.run();const oldRef=f.getManifest().memories['1'],oldBytes=f.r.values.get(oldRef.key),oldHead=JSON.stringify(f.getHead());sourceChanged(f);
  const storage=f.r.context.risuai.pluginStorage,original=storage.setItem;let hit=false;
  storage.setItem=async(k,v)=>{const x=JSON.parse(v);if(!hit&&x.schema==='libra.continuity_state.v2'){hit=true;return true;}return original(k,v);};
  let result;try{result=await boundary(f,root);}finally{storage.setItem=original;}
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.job.state,'completed_with_warnings');
  assert.ok(hit,'actual post-commit Head write must be exercised');assert.equal(f.getMemory().revision,2);
  assert.equal(f.r.values.get(oldRef.key),oldBytes);assert.equal(JSON.stringify(f.getHead()),oldHead);
  const newBytes=f.r.values.get(f.getManifest().memories['1'].key),calls=countCalls(f.control).canonical;assert.equal(calls,2,'the replacement runs two Canonical passes');
  const retry=await f.r.api.rebuildWorldManagerState();assert.equal(retry.ok,true,JSON.stringify(retry));
  assert.equal(countCalls(f.control).canonical,calls,'a state rebuild adds no Canonical provider call');// Explicit apply may return while its existing derived embedding queue settles.
  // State-only retry must preserve every canonical/source field; it must not
  // freeze a background embedding acknowledgement as though it were raw source.
  assertMemoryStableExceptEmbedding(newBytes,f.r.values.get(f.getManifest().memories['1'].key),'state retry preserves canonical/source while derived embedding may settle');
  assert.equal(f.getHead().world.find(r=>r.name==='은빛 열쇠').state.holderRef,f.getHead().characters.find(r=>r.name==='지호').id);
 });
 console.log(JSON.stringify({test:'libra_unified_source_edit_v2',passed:results.length,results,boundary:'actual beforeRequest pipeline; synthetic host/provider'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
