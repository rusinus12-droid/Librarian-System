'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const {automaticIdentityFixture}=require('./fixtures/libra_automatic_identity_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
async function scenario(fn){const f=await automaticIdentityFixture();try{assert.equal((await f.run()).completed,2);await waitFor(()=>[1,6].every(start=>f.getMemory(start).embedding.status!=='pending'));await fn(f);}finally{await f.r.cleanup();}}
const review=f=>f.r.api.listWorldManagerIdentityLinkReviews();
const request=p=>({scopeKey:p.scopeKey,previewDigest:p.previewDigest,linkId:p.rows[0].linkId});
test('automatic linking remains operational; review records exact evidence and candidate identity without mutating storage',()=>scenario(async f=>{
 assert.equal(f.getHead().characters.length,1);assert.equal(f.getHead().characters[0].name,'김민아');
 const writes=f.r.storageWrites.length,p=await review(f),row=p.rows[0];
 assert.equal(row.status,'review');assert.equal(row.applied,true);assert.equal(row.requiresApproval,false);assert.equal(row.modelJudgement,false);assert.equal(row.reason,'name_form_only');
 assert.notEqual(row.originEntityId,row.targetId);assert.equal(row.evidenceSpans[0].quote,f.chat.message.find(r=>r.chatId==='t7-a').data);
 assert.deepEqual(Array.from(row.names),['김민아','민아']);assert.equal(p.splitSupported,true);assert.equal(f.r.storageWrites.length,writes);assert.equal(f.control.calls.length,2);
}));
test('confirmation persists, replays, suspends and resumes with unchanged canonical records and no model calls',()=>scenario(async f=>{
 const p=await review(f),saved=Object.values(f.getManifest().memories).map(ref=>[ref.key,f.r.values.get(ref.key)]),people=JSON.stringify(f.getHead().characters);
 const out=await f.r.api.confirmWorldManagerIdentityLink(request(p));assert.equal(out.ok,true);assert.equal((await review(f)).rows[0].status,'confirmed');
 assert.equal(JSON.stringify(f.getHead().characters),people);assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal((await review(f)).rows[0].status,'confirmed');
 assert.equal((await f.r.api.setWorldManagerCorrectionStatus(out.correctionId,'suspended')).ok,true);assert.equal((await review(f)).rows[0].status,'review');
 assert.equal((await f.r.api.setWorldManagerCorrectionStatus(out.correctionId,'active')).ok,true);assert.equal((await review(f)).rows[0].status,'confirmed');
 for(const [key,value] of saved)assert.equal(f.r.values.get(key),value);assert.equal(f.control.calls.length,2);
}));
test('stale preview, changed scope and duplicate confirmation cannot write',()=>scenario(async f=>{
 const p=await review(f),person=f.getHead().characters[0];let writes=f.r.storageWrites.length;
 await assert.rejects(()=>f.r.api.confirmWorldManagerIdentityLink({...request(p),scopeKey:'another-chat'}),/REVIEW_CHANGED/);assert.equal(f.r.storageWrites.length,writes);
 await f.r.api.addWorldManagerCorrection({anchorTurn:10,target:{domain:'characters'},patch:{characters:[{id:person.id,set:{condition:'피곤함'}}]}});writes=f.r.storageWrites.length;
 await assert.rejects(()=>f.r.api.confirmWorldManagerIdentityLink(request(p)),/REVIEW_CHANGED/);assert.equal(f.r.storageWrites.length,writes);
 const fresh=await review(f);await f.r.api.confirmWorldManagerIdentityLink(request(fresh));writes=f.r.storageWrites.length;
 await assert.rejects(()=>f.r.api.confirmWorldManagerIdentityLink(request(fresh)),/REVIEW_CHANGED/);assert.equal(f.r.storageWrites.length,writes);
}));
test('confirmed automatic link can later split by immutable fact roles and remains split on replay',()=>scenario(async f=>{
 const p=await review(f);assert.equal((await f.r.api.confirmWorldManagerIdentityLink(request(p))).ok,true);
 const preview=await f.r.api.previewWorldManagerIdentitySplit({sourceId:p.rows[0].currentTargetId});
 const saved=Object.values(f.getManifest().memories).map(ref=>[ref.key,f.r.values.get(ref.key)]);
 const out=await f.r.api.splitWorldManagerIdentity({...preview,targets:[{key:'first',name:'민아',aliases:[]},{key:'second',name:'김민아',aliases:[]}],assignments:preview.occurrences.map(o=>({occurrenceId:o.occurrenceId,targetKey:o.turnRange.start===1?'first':'second'}))});
 assert.equal(out.ok,true);assert.equal(f.getHead().characters.length,2);assert.equal((await review(f)).rows[0].status,'split');
 assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal(f.getHead().characters.length,2);assert.equal((await review(f)).rows.filter(r=>r.status==='review').length,0);
 assert.notEqual(f.getHead().characters[0].id,f.getHead().characters[1].id);for(const [key,value] of saved)assert.equal(f.r.values.get(key),value);assert.equal(f.control.calls.length,2);
}));
test('lost Head write rolls back the review decision and journal',()=>scenario(async f=>{
 const p=await review(f),before=JSON.stringify(f.getHead()),storage=f.r.context.risuai.pluginStorage,old=storage.setItem;let hit=false;
 storage.setItem=async(k,v)=>{if(!hit&&JSON.parse(v)?.schema==='libra.continuity_state.v2'){hit=true;return true;}return old(k,v);};
 try{await assert.rejects(()=>f.r.api.confirmWorldManagerIdentityLink(request(p)));}finally{storage.setItem=old;}
 assert.equal(hit,true);assert.equal(JSON.stringify(f.getHead()),before);assert.equal((await review(f)).rows[0].status,'review');assert.equal(f.control.calls.length,2);
}));
test('existing Head without automatic link metadata can confirm and replay with reconstructed provenance',()=>scenario(async f=>{
 const record=f.getRecords('libra.continuity_state.v2')[0],head=record.value;delete head.unifiedAutomaticIdentityLinks;
 f.r.values.set(record.key,JSON.stringify(head));const p=await review(f);assert.equal(p.rows[0].reason,'legacy_name_alias');
 const out=await f.r.api.confirmWorldManagerIdentityLink(request(p));assert.equal(out.ok,true);assert.equal((await review(f)).rows[0].status,'confirmed');
 assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal((await review(f)).rows[0].status,'confirmed');
}));
