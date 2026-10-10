'use strict';
const assert=require('node:assert/strict');
const {lineageFixture,clone}=require('./fixtures/libra_unified_lineage_fixture.cjs');
const results=[];async function test(name,fn){const f=await lineageFixture();try{await f.run();await fn(f);results.push(name);console.log('PASS',name);}finally{await f.r.cleanup();}}
const info=x=>JSON.stringify(x),person=(f,n)=>f.head().characters.find(x=>x.name===n);
(async()=>{
 await test('explicit merge rebinds directional relation and next analysis registry, preserves sealed canonical',async f=>{
  const a=person(f,'지호'),b=person(f,'준호'),m=f.manifest(),saved=Object.values(m.memories).map(r=>[r.key,f.r.values.get(r.key)]);
  const preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});
  assert.equal(preview.fieldConflicts.length,0);const calls=f.control.calls.length;
  const merged=await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{}});assert.equal(merged.ok,true,info(merged));assert.equal(f.head().characters.length,2);assert.equal(f.head().relationships[0].targetId,b.id);assert.equal(f.control.calls.length,calls);
  for(const[k,v]of saved)assert.equal(f.r.values.get(k),v);
  const rebuilt=await f.r.api.rebuildWorldManagerState();assert.equal(rebuilt.ok,true,info(rebuilt));assert.equal(f.head().characters.length,2);
  f.appendFive();const next=await f.run();assert.equal(next.completed,1,info(next));assert.equal(f.head().characters.length,2);assert.equal(f.head().relationships[0].targetId,b.id);
 });
 await test('conflicting fields require every explicit choice and exact preview',async f=>{
  const a=person(f,'지호'),b=person(f,'준호');
  for(const[p,v]of [[a,'피곤함'],[b,'안정됨']])assert.equal((await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:p.id,set:{condition:v}}]}})).ok,true);
  const preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});assert.deepEqual(Array.from(preview.fieldConflicts,x=>x.field),['condition']);
  await assert.rejects(()=>f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{}}),/CHOICE_REQUIRED/);
  assert.equal((await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{condition:'source'},relationChoices:{}})).ok,true);assert.equal(person(f,'준호').state.condition,'피곤함');
 });
 for(const choice of ['source','target'])await test('knowledge '+choice+' choice still keeps only that list',async f=>{
  const a=person(f,'지호'),b=person(f,'준호');
  for(const[p,knowledge]of [[a,['출입 암호를 안다']],[b,['열쇠 위치를 안다']]])assert.equal((await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:p.id,set:{knowledge}}]}})).ok,true);
  const preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});
  assert.equal((await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{knowledge:choice},relationChoices:{}})).ok,true);
  const expected=choice==='source'?['출입 암호를 안다']:['열쇠 위치를 안다'];
  assert.deepEqual(clone(person(f,'준호').state.knowledge),expected);
  assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);
  assert.deepEqual(clone(person(f,'준호').state.knowledge),expected);
 });
 await test('both knowledge lists survive persisted merge, replay, suspend and resume without extra model calls',async f=>{
  const a=person(f,'지호'),b=person(f,'준호'),sourceKnowledge=['출입 암호는 달빛','등대에 지도가 있다'],targetKnowledge=['등대에 지도가 있다','지도는 서재에 있었다'];
  for(const[p,knowledge]of [[a,sourceKnowledge],[b,targetKnowledge]])assert.equal((await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:p.id,set:{knowledge}}]}})).ok,true);
  const saved=Object.values(f.manifest().memories).map(r=>[r.key,f.r.values.get(r.key)]),calls=f.control.calls.length;
  const preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});
  assert.ok(preview.fieldConflicts.some(r=>r.field==='knowledge'));
  const result=await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{knowledge:'both'},relationChoices:{}});
  assert.equal(result.ok,true,info(result));
  const expected=[...new Set([...targetKnowledge,...sourceKnowledge])];
  const verify=()=>assert.deepEqual(clone(person(f,'준호').state.knowledge),expected);
  verify();assert.equal(person(f,'준호').fieldCorrectionProvenance.knowledge.choice,'both');
  assert.deepEqual(clone(person(f,'준호').fieldCorrectionProvenance.knowledge.mergedFrom.map(r=>r.recordId)),[b.id,a.id]);
  assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);verify();
  assert.equal((await f.r.api.setWorldManagerCorrectionStatus(result.correctionId,'suspended')).ok,true);
  assert.deepEqual(clone(person(f,'지호').state.knowledge),sourceKnowledge);assert.deepEqual(clone(person(f,'준호').state.knowledge),targetKnowledge);
  assert.equal((await f.r.api.setWorldManagerCorrectionStatus(result.correctionId,'active')).ok,true);verify();
  for(const[k,v]of saved)assert.equal(f.r.values.get(k),v);
  assert.equal(f.control.calls.length,calls);
 });
 await test('both is rejected for a single-valued condition and for knowledge clear versus value',async f=>{
  const a=person(f,'지호'),b=person(f,'준호');
  for(const[p,condition]of [[a,'피곤함'],[b,'안정됨']])assert.equal((await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:p.id,set:{condition,knowledge:['공통 지식']}}]}})).ok,true);
  let preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});
  await assert.rejects(()=>f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{condition:'both'},relationChoices:{}}),/CHOICE_REQUIRED/);
  assert.equal((await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:a.id,clear:['knowledge']}]}})).ok,true);
  preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});
  const before=info(f.head());
  await assert.rejects(()=>f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{condition:'source',knowledge:'both'},relationChoices:{}}),/CHOICE_REQUIRED/);
  assert.equal(info(f.head()),before);
 });
 await test('merge creating self relation is blocked unless the exact relation is explicitly dropped',async f=>{
  const a=person(f,'민아'),b=person(f,'지호'),preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});assert.equal(preview.relationConflicts.length,1);
  await assert.rejects(()=>f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{}}),/RELATION_CHOICE/);
  const result=await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{[preview.relationConflicts[0].key]:'drop'}});assert.equal(result.ok,true,info(result));assert.equal(f.head().relationships.length,0);
 });
 await test('kind mismatch and stale preview reject without changing state',async f=>{
  const a=person(f,'지호'),b=person(f,'준호'),w=f.head().world[0];await assert.rejects(()=>f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:w.id}),/KIND_MISMATCH/);
  const preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});await f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'characters'},patch:{characters:[{id:a.id,set:{condition:'변경됨'}}]}});
  await assert.rejects(()=>f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{}}),/PREVIEW_CHANGED/);assert.equal(f.head().characters.length,3);
 });
 await test('merged identity and root correction survive native branch',async f=>{
  const a=person(f,'지호'),b=person(f,'준호'),preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{}});
  f.branch(5,'merged-branch');const result=await f.r.api.debugNativeChatCopy({force:true});assert.equal(result.result?.ok,true,info(result));assert.equal(f.head().characters.length,2);assert.equal(f.head().relationships[0].targetId,b.id);
 });
 await test('pausing merge replays original identities rather than inventing an arbitrary split',async f=>{
  const a=person(f,'지호'),b=person(f,'준호'),preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});const c=await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{}});assert.equal(f.head().characters.length,2);
  const paused=await f.r.api.setWorldManagerCorrectionStatus(c.correctionId,'suspended');assert.equal(paused.ok,true,info(paused));assert.equal(f.head().characters.length,3);assert.equal(f.head().relationships[0].targetId,a.id);assert.equal(f.control.calls.length,1);
  const resumed=await f.r.api.setWorldManagerCorrectionStatus(c.correctionId,'active');assert.equal(resumed.ok,true,info(resumed));assert.equal(f.head().characters.length,2);
 });
 await test('identity group Head write failure restores original Registry and Head',async f=>{
  const a=person(f,'지호'),b=person(f,'준호'),preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});const before=info(f.head()),registry=f.getRecords('libra.entity_registry.v2')[0],registryBytes=f.r.values.get(registry.key),storage=f.r.context.risuai.pluginStorage,old=storage.setItem;let hit=false,error=null;
  storage.setItem=async(k,v)=>{if(!hit&&JSON.parse(v)?.schema==='libra.continuity_state.v2'){hit=true;return true;}return old(k,v);};
  try{await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{}});}catch(e){error=e;}finally{storage.setItem=old;}
  assert.ok(hit);assert.ok(error);assert.equal(info(f.head()),before);assert.equal(f.r.values.get(registry.key),registryBytes);assert.equal(f.control.calls.length,1);
 });
 await test('merged identity handoff replays target correction without source data',async f=>{
  const a=person(f,'지호'),b=person(f,'준호'),preview=await f.r.api.previewWorldManagerIdentityMerge({sourceId:a.id,targetId:b.id});await f.r.api.mergeWorldManagerIdentity({...preview,fieldChoices:{},relationChoices:{}});const sourceScope=f.manifest().scopeKey;
  await f.r.api.prepareSessionHandoff({transferId:'merged-handoff'});f.empty('merged-target');const result=await f.r.api.adoptSessionHandoff({transferId:'merged-handoff',targetChatId:'merged-target'});assert.equal(result.verified,true,info(result));assert.equal(f.head().characters.length,2);
  for(const[k]of [...f.r.values])if(k.includes(':scope:'+sourceScope+':'))f.r.values.delete(k);
  assert.equal((await f.r.api.rebuildWorldManagerState()).ok,true);assert.equal(f.head().characters.length,2);assert.equal(f.control.calls.length,1);
 });

 await test('newly inherited session at local T0 can correct identity without a new model run',async f=>{
  await f.r.api.prepareSessionHandoff({transferId:'immediate-correction'});f.empty('immediate-target');await f.r.api.adoptSessionHandoff({transferId:'immediate-correction',targetChatId:'immediate-target'});
  const h=f.head(),a=h.characters.find(r=>r.name==='민아'),calls=f.control.calls.length;assert.equal(h.throughTurn,0);
  const out=await f.r.api.addWorldManagerCorrection({anchorTurn:0,target:{domain:'characters'},patch:{characters:[{id:a.id,name:a.name,renameTo:'민아 선배'}]}});
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(f.head().throughTurn,0);assert.equal(f.head().characters.find(r=>r.id===a.id).name,'민아 선배');assert.equal(f.control.calls.length,calls);
  f.appendFive();const next=await f.run();assert.equal(next.completed,1,JSON.stringify(next));assert.equal(f.head().characters.find(r=>r.id===a.id).name,'민아 선배');
 });
 console.log(JSON.stringify({test:'libra_unified_identity_v1',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
