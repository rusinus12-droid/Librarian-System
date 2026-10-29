'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {prepareAutomaticIdentityFixture}=require('./fixtures/libra_automatic_identity_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
for(const mode of ['server_only','mirror'])test(mode+' reviews, confirms and physically replays automatic links without model calls',async()=>{
 const s=await serverFixture({mode});try{
  const f=prepareAutomaticIdentityFixture(s.f);assert.equal((await f.run()).completed,2);
  assert.equal(s.getHead().characters.length,1);assert.equal(s.getHead().characters[0].identityOrigins.length,2);
  await waitFor(()=>[1,6].every(start=>s.getMemory(start).embedding.status!=='pending'));
  const saved=Object.values(s.getManifest().memories).map(ref=>[ref.key,s.storedRows().find(row=>row.key===ref.key).raw]);
  const p=await f.r.api.listWorldManagerIdentityLinkReviews();assert.equal(p.rows[0].status,'review');
  const out=await f.r.api.confirmWorldManagerIdentityLink({scopeKey:p.scopeKey,previewDigest:p.previewDigest,linkId:p.rows[0].linkId});assert.equal(out.ok,true);
  assert.equal(s.getHead().unifiedIdentityLinkDecisions[p.rows[0].linkId].status,'confirmed');assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);
  assert.equal((await f.r.api.listWorldManagerIdentityLinkReviews()).rows[0].status,'confirmed');
  const split=await f.r.api.previewWorldManagerIdentitySplit({sourceId:p.rows[0].currentTargetId});
  assert.equal(split.originGroups.length,2);assert.ok(split.occurrences.every(o=>o.originProvenance==='persisted'));
  const result=await f.r.api.splitWorldManagerIdentity({...split,targets:split.suggestedTargets.map(({key,name,aliases})=>({key,name,aliases})),assignments:split.suggestedAssignments.map(({occurrenceId,targetKey})=>({occurrenceId,targetKey}))});
  assert.equal(result.ok,true);assert.equal(s.getHead().characters.length,2);assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal(s.getHead().characters.length,2);
  assert.equal((await f.r.api.listWorldManagerIdentityLinkReviews()).rows[0].status,'split');assert.equal(f.control.calls.length,2);
  for(const [key,value] of saved)assert.equal(s.storedRows().find(row=>row.key===key).raw,value,'canonical bytes remain unchanged in SQLite');
 }finally{await s.cleanup();}
});
