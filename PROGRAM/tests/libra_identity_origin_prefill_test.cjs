'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {automaticIdentityFixture}=require('./fixtures/libra_automatic_identity_fixture.cjs');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const {lineageFixture}=require('./fixtures/libra_unified_lineage_fixture.cjs');
const {prepareAutomaticIdentityFixture}=require('./fixtures/libra_automatic_identity_fixture.cjs');
async function scenario(fn){const f=await automaticIdentityFixture();try{assert.equal((await f.run()).completed,2);await waitFor(()=>[1,6].every(start=>f.getMemory(start).embedding.status!=='pending'));await fn(f);}finally{await f.r.cleanup();}}
const bareTargets=p=>p.suggestedTargets.map(({key,name,aliases})=>({key,name,aliases}));
test('one automatic card retains separate native identity IDs and persisted fact-role provenance',()=>scenario(async f=>{
 const h=f.getHead();assert.equal(h.characters.length,1);assert.equal(h.characters[0].identityOrigins.length,2);
 const first=f.getMemory(1).unifiedIdentityProvenance,second=f.getMemory(6).unifiedIdentityProvenance;
 assert.equal(first.schema,'libra.identity_provenance.v1');assert.notEqual(first.entities[0].originId,second.entities[0].originId);
 assert.equal(first.factRoles[0].originId,first.entities[0].originId);assert.equal(second.factRoles[0].originId,second.entities[0].originId);
 const p=await f.r.api.previewWorldManagerIdentitySplit({sourceId:h.characters[0].id});
 assert.equal(p.originGroups.length,2);assert.equal(p.suggestedAssignments.length,p.occurrences.length);
 for(const o of p.occurrences){const a=p.suggestedAssignments.find(a=>a.occurrenceId===o.occurrenceId),t=p.suggestedTargets.find(t=>t.key===a.targetKey);assert.equal(t.originId,o.originIdentityId);assert.equal(t.name,o.originalEntityName);}
 assert.equal(f.control.calls.length,2);
}));
test('prefilled assignments can be saved immediately without per-fact approvals, preserving canonical bytes',()=>scenario(async f=>{
 const saved=[...f.r.values].filter(([key])=>Object.values(f.getManifest().memories).some(ref=>ref.key===key));
 const p=await f.r.api.previewWorldManagerIdentitySplit({sourceId:f.getHead().characters[0].id});
 const out=await f.r.api.splitWorldManagerIdentity({...p,targets:bareTargets(p),assignments:p.suggestedAssignments.map(({occurrenceId,targetKey})=>({occurrenceId,targetKey}))});
 assert.equal(out.ok,true);assert.equal(f.getHead().characters.length,2);for(const row of f.getHead().characters)assert.equal(row.identityOrigins.length,1);
 for(const [key,value] of saved)assert.equal(f.r.values.get(key),value);assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal(f.getHead().characters.length,2);
 assert.equal(f.control.calls.length,2);
}));
test('old canonical records reconstruct native origins without rewriting saved evidence',()=>scenario(async f=>{
 for(const ref of Object.values(f.getManifest().memories)){const memory=JSON.parse(f.r.values.get(ref.key));delete memory.unifiedIdentityProvenance;f.r.values.set(ref.key,JSON.stringify(memory));}
 const before=f.r.storageWrites.length,p=await f.r.api.previewWorldManagerIdentitySplit({sourceId:f.getHead().characters[0].id});
 assert.equal(p.originGroups.length,2);assert.ok(p.occurrences.every(o=>o.originProvenance==='canonical_reconstructed'));assert.equal(f.r.storageWrites.length,before);
}));
test('provenance tampering is rejected instead of prefilling a different person',()=>scenario(async f=>{
 const ref=f.getManifest().memories['6'],memory=f.getMemory(6);memory.unifiedIdentityProvenance.factRoles[0].originId='wrong-person';f.r.values.set(ref.key,JSON.stringify(memory));
 const before=f.r.storageWrites.length;await assert.rejects(()=>f.r.api.previewWorldManagerIdentitySplit({sourceId:f.getHead().characters[0].id}),/IDENTITY_PROVENANCE_MISMATCH/);assert.equal(f.r.storageWrites.length,before);
}));
test('a fresh runtime reads the same native IDs and suggestions from durable records',()=>scenario(async f=>{
 const sourceId=f.getHead().characters[0].id,p=await f.r.api.previewWorldManagerIdentitySplit({sourceId}),other=await fixture({snapshot:{chat:f.chat,values:[...f.r.values]}});
 try{const reloaded=await other.r.api.previewWorldManagerIdentitySplit({sourceId});assert.deepEqual(JSON.parse(JSON.stringify(reloaded.originGroups)),JSON.parse(JSON.stringify(p.originGroups)));assert.equal(other.control.calls.length,0);}finally{await other.r.cleanup();}
}));
test('explicit merge keeps distinct origins for reference roles and can split them again',async()=>{
 const f=await fixture();try{
  await f.run();const [a,b]=['지호','준호'].map(name=>f.getHead().characters.find(c=>c.name===name));
  const merge=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});await f.r.api.mergeWorldManagerIdentity({...merge,fieldChoices:{},relationChoices:{}});
  const p=await f.r.api.previewWorldManagerIdentitySplit({sourceId:b.id});assert.equal(p.originGroups.length,2);
  assert.ok(p.occurrences.some(o=>o.path==='targetTempRef'));assert.ok(p.occurrences.some(o=>o.path==='values.holderRef'));
  const out=await f.r.api.splitWorldManagerIdentity({...p,targets:bareTargets(p),assignments:p.suggestedAssignments.map(({occurrenceId,targetKey})=>({occurrenceId,targetKey}))});
  assert.equal(out.ok,true);assert.equal(f.getHead().characters.length,3);assert.ok(f.getHead().characters.every(c=>c.identityOrigins.length===1));assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);
 }finally{await f.r.cleanup();}
});
test('handoff preserves original identity IDs and per-fact suggestions without source rewrites',async()=>{
 const f=prepareAutomaticIdentityFixture(await lineageFixture());try{
  await f.run();const original=f.head(),p=await f.r.api.previewWorldManagerIdentitySplit({sourceId:original.characters[0].id});
  await f.r.api.prepareSessionHandoff({transferId:'origin-prefill'});f.empty('origin-prefill-target');const out=await f.r.api.adoptSessionHandoff({transferId:'origin-prefill',targetChatId:'origin-prefill-target'});assert.equal(out.verified,true);
  const after=await f.r.api.previewWorldManagerIdentitySplit({sourceId:original.characters[0].id});assert.deepEqual(JSON.parse(JSON.stringify(after.originGroups)),JSON.parse(JSON.stringify(p.originGroups)));assert.equal(f.control.calls.length,2);
 }finally{await f.r.cleanup();}
});
test('lost provenance on candidate storage readback cannot activate canonical memory',async()=>{
 const f=await fixture();const storage=f.r.context.risuai.pluginStorage,old=storage.setItem;let hit=false;
 storage.setItem=async(k,v)=>{const value=JSON.parse(v);if(!hit&&value?.schema==='libra.canonical_memory.v1'&&value.unifiedIdentityProvenance){hit=true;delete value.unifiedIdentityProvenance;return old(k,JSON.stringify(value));}return old(k,v);};
 try{const out=await f.run();assert.equal(hit,true);assert.equal(out.completed,0);assert.equal(Object.keys(f.getManifest()?.memories||{}).length,0);assert.equal(f.getHead(),null);}finally{storage.setItem=old;await f.r.cleanup();}
});
test('unreviewed links remain immediately usable in the next analysis without any approval',()=>scenario(async f=>{
 const source=f.chat.message.slice(10).map((row,i)=>({...row,chatId:`t${11+Math.floor(i/2)}-${i%2?'a':'u'}`}));f.chat.message.push(...source);
 const artifact=JSON.parse(JSON.stringify(f.getMemory(6).canonicalArtifact));for(const row of [...artifact.entities,...artifact.facts])for(const span of row.evidenceSpans)span.ref=span.ref.replace(/^t(\d+)/,(_,n)=>'t'+(Number(n)+5));
 f.control.onCall=()=>({type:'success',result:JSON.stringify(artifact)});assert.equal((await f.run()).completed,1);
 assert.equal(f.getHead().characters.length,1);assert.equal(f.getHead().characters[0].identityOrigins.length,2);
 const p=await f.r.api.listWorldManagerIdentityLinkReviews();assert.equal(p.rows[0].status,'review');assert.equal(p.rows[0].applied,true);assert.equal(p.rows[0].requiresApproval,false);assert.equal(f.control.calls.length,3);
}));
