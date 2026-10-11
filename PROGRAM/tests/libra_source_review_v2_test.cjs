'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_review_runtime_fixture.cjs');
const {selection,replace,noJournal}=require('./fixtures/libra_selected_source_contract.cjs');
const {classifyCall}=require('./fixtures/libra_provider_call_kinds.cjs');
const results=[];
async function test(name,fn){const f=await fixture();try{await fn(f);noJournal(f);results.push(name);}finally{await f.r.cleanup();}}
const edit=f=>{f.chat.message[1].data='Alice did not sign the office agreement.';};
const canonicalCalls=f=>f.control.callArgs.filter(args=>classifyCall(args)==='canonical').length;
(async()=>{
 await test('explicit replacement pins exact five U+A and preserves previous evidence',async f=>{
  const record=JSON.parse(f.oldBytes),oldRaw=f.r.values.get(record.sourceEvidenceRef.key),source=JSON.parse(oldRaw);
  assert.equal(record.sourceEvidenceRef.owner,'libra');assert.equal(source.rows.length,5);
  assert.equal(source.rows[0].assistantText,'Alice signed the office agreement.');assert.equal(source.rows[4].userMessageId,'u5');
  edit(f);await f.r.sourceEditBoundary();assert.equal(f.control.calls,f.initialCalls,'ordinary request is model-free');
  const ticket=await selection(f);assert.equal(f.control.calls,f.initialCalls,'preview is model-free');
  const outcome=await f.r.api.startSelectedCanonicalBatches(ticket);assert.equal(outcome.ok,true,JSON.stringify(outcome));
  await f.r.api.retryPendingUnifiedVectors();
  const active=f.getManifest().memories['1'],current=JSON.parse(f.r.values.get(active.key));
  assert.equal(active.status,'committed');assert.ok(active.revision>f.oldRef.revision);
  assert.notEqual(active.sourceDigest,f.oldRef.sourceDigest);assert.notEqual(current.sourceEvidenceRef.key,record.sourceEvidenceRef.key);
  const next=JSON.parse(f.r.values.get(current.sourceEvidenceRef.key));assert.equal(next.rows.length,5);assert.equal(next.rows[0].assistantText,f.chat.message[1].data);
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);assert.equal(f.r.values.get(record.sourceEvidenceRef.key),oldRaw);
  assert.equal(canonicalCalls(f),f.initialCanonical+1,'exactly one selected Canonical call');
 });
 for(const damage of ['missing','corrupt'])await test(damage+' prior raw cannot invent a comparison or block current explicit replacement',async f=>{
  const record=JSON.parse(f.oldBytes),key=record.sourceEvidenceRef.key;
  if(damage==='missing')f.r.values.delete(key);else{const raw=JSON.parse(f.r.values.get(key));raw.rows[0].assistantText='forged';f.r.values.set(key,JSON.stringify(raw));}
  const damaged=f.r.values.get(key);edit(f);await f.r.sourceEditBoundary();
  assert.equal(f.control.calls,f.initialCalls,'missing comparison bytes do not launch automatic analysis');
  assert.equal(f.getManifest().memories['1'].key,f.oldRef.key,'same native slot preserves the approved canonical');
  await replace(f);
  const current=JSON.parse(f.r.values.get(f.getManifest().memories['1'].key));
  const evidence=JSON.parse(f.r.values.get(current.sourceEvidenceRef.key));
  assert.equal(evidence.rows[0].assistantText,f.chat.message[1].data,'new evidence comes from the live source');
  assert.ok(!JSON.stringify(evidence).includes('forged'));
  assert.equal(f.r.values.get(key),damaged,'old missing/corrupt evidence is not fabricated or repaired');
  assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);assert.equal(canonicalCalls(f),f.initialCanonical+1);
 });
 await test('evidence write failure cannot activate selected replacement',async f=>{
  edit(f);const ticket=await selection(f),raw=f.r.context.risuai.pluginStorage,prior=raw.setItem;let failed=0;
  raw.setItem=async function(k,v){if(String(k).includes(':source-evidence:v1:')){failed++;return false;}return prior.call(this,k,v);};
  try{const result=await f.r.api.startSelectedCanonicalBatches(ticket);assert.ok(failed>0,'real owner evidence write was attempted');assert.equal(result.ok,false);assert.equal(f.getManifest().memories['1'].key,f.oldRef.key);assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);}
  finally{raw.setItem=prior;}
 });
 await test('illustration-only append costs no call and leaves canonical source digest stable',async f=>{
  const before=await selection(f);f.chat.message[1].data+='\n<lb-xnai id="scene-9" operation="op" scene="9">{{inlay::dfb2caba-cc65-4585-808d-28815ff6aafe}}</lb-xnai>';
  await f.r.sourceEditBoundary();const after=await selection(f);
  assert.equal(after.ranges[0].sourceDigest,before.ranges[0].sourceDigest);
  assert.equal(f.control.calls,f.initialCalls);assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
 });
 await test('source deletion is not preserved as an unchanged native slot',async f=>{
  const ticket=await selection(f);f.chat.message.splice(0,2);await f.r.sourceEditBoundary();
  await assert.rejects(()=>f.r.api.startSelectedCanonicalBatches(ticket),/selected_batch_range_invalid/);
  assert.equal(f.control.calls,f.initialCalls);assert.notEqual(f.getManifest().memories['1'].status,'committed');
  assert.equal((await f.r.api.getCanonicalMemories()).length,0);assert.equal(f.r.values.get(f.oldRef.key),f.oldBytes);
 });
 console.log(JSON.stringify({test:'libra_source_review_v2',passed:results.length,results,boundary:'shipped LIBRA public selected action + synthetic host/provider'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
