"use strict";
const assert=require('node:assert/strict');const {fixture}=require('./fixtures/libra_review_runtime_fixture.cjs');
const results=[];
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
const sourceEditStatus=f=>f.r.api.getSourceEditSyncStatus();
(async()=>{
await test('new canonical pins exact five U+A and automatic replacement stores fresh evidence',async f=>{
 const record=JSON.parse(f.oldBytes);assert.equal(record.sourceEvidenceRef.owner,'libra');const source=JSON.parse(f.r.values.get(record.sourceEvidenceRef.key));assert.equal(source.rows.length,5);
 assert.equal(source.rows[0].assistantText,'Alice signed the office agreement.');assert.equal(source.rows[4].userMessageId,'u5');
 f.chat.message[1].data='Alice did not sign the office agreement.';await f.r.sourceEditBoundary();
 const status=sourceEditStatus(f),task=status.tasks.find(row=>row.start===1),active=f.getManifest().memories['1'];
 assert.equal(task?.state,'applied');assert.equal(active.status,'committed');assert.ok(active.revision>f.oldRef.revision);
 const current=JSON.parse(f.r.values.get(active.key)),nextSource=JSON.parse(f.r.values.get(current.sourceEvidenceRef.key));
 assert.equal(nextSource.rows.length,5);assert.match(nextSource.rows[0].assistantText,/Alice did not sign/);
 assert.equal(task.originalDigest,f.oldRef.sourceDigest);assert.equal(task.sourceDigest,active.sourceDigest);
 assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes,'previous canonical bytes remain immutable');
 // The one-turn Micro producer adds its own calls per completed turn, so the guarantee is counted on
 // the Canonical pass: the replacement must run exactly one Canonical call, immediately.
 const canonicalNow=f.control.callArgs.filter(a=>require('./fixtures/libra_provider_call_kinds.cjs').classifyCall(a)==='canonical').length;
 assert.equal(canonicalNow,f.initialCanonical+1,'beforeRequest performs the canonical replacement without waiting for approval');
});
await test('missing prior raw evidence cannot invent a source-edit comparison',async f=>{
 const record=JSON.parse(f.oldBytes);f.r.values.delete(record.sourceEvidenceRef.key);
 f.chat.message[1].data='Alice did not sign the office agreement.';await f.r.sourceEditBoundary();
 const status=sourceEditStatus(f),active=f.getManifest().memories['1'];
 assert.equal(status.tasks.length,0,'missing raw evidence is not turned into a synthetic diff');
 assert.equal(f.control.calls,f.initialCalls,'no fabricated edit launches a model call');
 assert.notEqual(active.status,'committed','branch guard excludes a ref it cannot validate against current source');
 assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
});
await test('corrupt previous source is not accepted as a baseline or rendered as authentic',async f=>{
 const record=JSON.parse(f.oldBytes),raw=JSON.parse(f.r.values.get(record.sourceEvidenceRef.key));raw.rows[0].assistantText='forged';f.r.values.set(record.sourceEvidenceRef.key,JSON.stringify(raw));
 f.chat.message[1].data='Alice did not sign the office agreement.';await f.r.sourceEditBoundary();
 const status=sourceEditStatus(f),active=f.getManifest().memories['1'];
 assert.equal(status.tasks.length,0,'corrupt owner evidence cannot seed an automatic source comparison');
 assert.equal(f.control.calls,f.initialCalls);assert.notEqual(active.status,'committed');
 assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
});
await test('old evidence survives an automatic verified replacement',async f=>{
 const old=JSON.parse(f.oldBytes).sourceEvidenceRef,key=old.key,bytes=f.r.values.get(key);
 f.chat.message[1].data='Alice did not sign the office agreement.';await f.r.sourceEditBoundary();
 const current=JSON.parse(f.r.values.get(f.getManifest().memories['1'].key));assert.notEqual(current.sourceEvidenceRef.key,key);assert.equal(f.r.values.get(key),bytes);assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
});
await test('evidence persistence failure keeps the previous canonical and blocks request-local recall',async f=>{
 f.chat.message[1].data='Alice did not sign the office agreement.';const raw=f.r.context.risuai.pluginStorage,prior=raw.setItem;let failed=0;
 raw.setItem=async function(k,v){if(String(k).includes(':source-evidence:v1:')){failed++;return false;}return prior.call(this,k,v)};
 try{
  await f.r.sourceEditBoundary();assert.ok(failed>0);
  const status=sourceEditStatus(f),ref=f.getManifest().memories['1'];
  assert.equal(status.tasks[0].state,'failed');assert.equal(ref.key,f.oldRef.key);assert.equal(ref.status,'committed');
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
  assert.ok(!JSON.stringify(f.r.api.getLastMemoryRecallViewer()?.rows||[]).includes(f.oldRef.memoryId),'the failed replacement does not expose stale canonical to the actual recall consumer');
 }finally{raw.setItem=prior;}
});
await test('illustration-only append is not a source edit',async f=>{
 f.chat.message[1].data+='\n<lb-xnai id="scene-9" operation="op" scene="9">{{inlay::dfb2caba-cc65-4585-808d-28815ff6aafe}}</lb-xnai>';
 await f.r.sourceEditBoundary();assert.equal(sourceEditStatus(f).tasks.length,0);assert.equal(f.control.calls,f.initialCalls);assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
});
console.log(JSON.stringify({test:'libra_source_review_v2',passed:results.length,results,environment:'full deployed LIBRA + test host/provider'}));
})().catch(e=>{console.error(e);process.exitCode=1});
