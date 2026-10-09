'use strict';
const assert=require('node:assert/strict');
const {lineageFixture}=require('./fixtures/libra_unified_lineage_fixture.cjs');
const results=[];const info=JSON.stringify;
async function test(name,fn,prepare=null){const f=await lineageFixture();try{if(prepare)await prepare(f);await f.run();await fn(f);results.push(name);console.log('PASS',name);}finally{await f.r.cleanup();}}
async function plan(f,targets=[{key:'a',name:'민아',aliases:[]},{key:'b',name:'민희',aliases:[]}]){
 const source=f.head().characters.find(c=>c.name==='민아'),p=await f.r.api.previewWorldManagerIdentitySplit({sourceId:source.id});
 return {...p,targets,assignments:Array.from(p.occurrences,o=>({occurrenceId:o.occurrenceId,targetKey:['f9','f6'].includes(o.factId)?'b':'a'}))};
}
(async()=>{
 await test('split allocates fact roles independently, preserves canonical bytes and costs zero model calls',async f=>{
  const p=await plan(f),manifest=f.manifest(),bytes=Object.values(manifest.memories).map(r=>[r.key,f.r.values.get(r.key)]),calls=f.control.calls.length;
  assert.ok(p.occurrences.some(o=>o.path==='subjectTempRef'));assert.ok(p.occurrences.some(o=>o.path==='values.ownerRef'));
  const out=await f.r.api.splitWorldManagerIdentity(p);assert.equal(out.ok,true,info(out));
  const h=f.head(),a=h.characters.find(r=>r.name==='민아'),b=h.characters.find(r=>r.name==='민희');
  assert.ok(a&&b);assert.notEqual(a.id,b.id);assert.equal(h.characters.length,4);assert.ok(!h.characters.some(r=>r.id===p.sourceId));
  assert.deepEqual(Array.from(b.state.knowledge),['상자의 암호']);assert.equal(a.state.knowledge,undefined);
  const key=h.world.find(r=>r.name==='은빛 열쇠');assert.equal(key.state.ownerRef,b.id);assert.equal(key.state.holderRef,a.id);
  assert.equal(h.relationships[0].subjectId,a.id);assert.equal(f.control.calls.length,calls);
  for(const[k,v]of bytes)assert.equal(f.r.values.get(k),v);
  const replay=await f.r.api.rebuildWorldManagerState();assert.equal(replay.ok,true,info(replay));assert.equal(f.head().characters.length,4);
 });
 await test('all occurrences require a unique explicit assignment; missing duplicate and stale choices cannot write',async f=>{
  const p=await plan(f),head=info(f.head()),before=f.r.storageWrites.length;
  await assert.rejects(()=>f.r.api.splitWorldManagerIdentity({...p,assignments:p.assignments.slice(1)}),/ALL_REFERENCES_REQUIRED/);
  const bad=p.assignments.slice();bad[1]={...bad[0]};await assert.rejects(()=>f.r.api.splitWorldManagerIdentity({...p,assignments:bad}),/ASSIGNMENT_INVALID/);
  await assert.rejects(()=>f.r.api.splitWorldManagerIdentity({...p,previewDigest:'old'}),/PREVIEW_CHANGED/);
  assert.equal(info(f.head()),head);assert.equal(f.r.storageWrites.length,before);
 });
 await test('same label and existing identity collision are rejected rather than merging children',async f=>{
  const p=await plan(f);await assert.rejects(()=>f.r.api.splitWorldManagerIdentity({...p,targets:[{key:'a',name:'민희',aliases:[]},{key:'b',name:'민희',aliases:[]}]}),/LABEL_AMBIGUOUS/);
  await assert.rejects(()=>f.r.api.splitWorldManagerIdentity({...p,targets:[{key:'a',name:'민아',aliases:[]},{key:'b',name:'지호',aliases:[]}]}),/EXISTING_IDENTITY_COLLISION/);
 });
 await test('split uses existing correction journal; pause replays the original and resume restores allocation',async f=>{
  const p=await plan(f),out=await f.r.api.splitWorldManagerIdentity(p);assert.equal(out.ok,true,info(out));
  const pause=await f.r.api.setWorldManagerCorrectionStatus(out.correctionId,'suspended');assert.equal(pause.ok,true,info(pause));assert.equal(f.head().characters.length,3);assert.ok(f.head().characters.some(r=>r.id===p.sourceId));
  const resume=await f.r.api.setWorldManagerCorrectionStatus(out.correctionId,'active');assert.equal(resume.ok,true,info(resume));assert.equal(f.head().characters.length,4);
 });
 await test('split group Head failure restores original Registry and Head without reanalysis',async f=>{
  const p=await plan(f),h=info(f.head()),registry=f.getRecords('libra.entity_registry.v2')[0],raw=f.r.values.get(registry.key),storage=f.r.context.risuai.pluginStorage,old=storage.setItem;let hit=false;
  storage.setItem=async(k,v)=>{if(!hit&&JSON.parse(v)?.schema==='libra.continuity_state.v2'){hit=true;return true;}return old(k,v);};
  try{await assert.rejects(()=>f.r.api.splitWorldManagerIdentity(p));}finally{storage.setItem=old;}
  assert.ok(hit);assert.equal(info(f.head()),h);assert.equal(f.r.values.get(registry.key),raw);assert.equal(f.control.calls.length,1);
 });
 await test('handoff retains allocation without rewriting source or ancestor',async f=>{
  const p=await plan(f);await f.r.api.splitWorldManagerIdentity(p);const h=info(f.head()),sourceScope=f.manifest().scopeKey;
  await f.r.api.prepareSessionHandoff({transferId:'split-handoff'});assert.equal(info(f.head()),h);
  f.empty('split-target');const adopted=await f.r.api.adoptSessionHandoff({transferId:'split-handoff',targetChatId:'split-target'});assert.equal(adopted.verified,true,info(adopted));assert.equal(f.head().characters.length,4);
  for(const[k]of [...f.r.values])if(k.includes(':scope:'+sourceScope+':'))f.r.values.delete(k);
  const rebuilt=await f.r.api.rebuildWorldManagerState();assert.equal(rebuilt.ok,true,info(rebuilt));assert.equal(f.head().characters.length,4);
 });
 await test('native prefix copy preserves pre-fork split and never mutates parent records',async f=>{
  const p=await plan(f);await f.r.api.splitWorldManagerIdentity(p);const parent=f.current(),h=info(f.head());
  const saved=Object.values(f.manifest().memories).map(r=>[r.key,f.r.values.get(r.key)]);
  f.branch(5,'split-native-child');const result=await f.r.api.debugNativeChatCopy({force:true});assert.equal(result.result?.ok,true,info(result));
  assert.equal(f.head().characters.length,4);assert.equal(info(f.head(parent)),h);for(const[k,v]of saved)assert.equal(f.r.values.get(k),v);
  f.appendFive();assert.equal((await f.run()).completed,1);assert.ok(!f.head().characters.some(r=>r.id===p.sourceId));assert.equal(f.head().characters.length,4);
 });
 await test('split anchored after a native fork is excluded from the older prefix',async f=>{
  f.appendFive();await f.run();const p=await plan(f);await f.r.api.splitWorldManagerIdentity(p);const parent=f.current();assert.equal(f.head().characters.length,4);
  f.branch(5,'split-older-prefix');const result=await f.r.api.debugNativeChatCopy({force:true});assert.equal(result.result?.ok,true,info(result));
  assert.equal(f.head().characters.length,3);assert.equal(f.head(parent).characters.length,4);assert.ok(f.head().characters.some(r=>r.id===p.sourceId));
 });
 await test('evidence-backed portable split restores in a separate runtime without source data or model',async f=>{
  const p=await plan(f);await f.r.api.splitWorldManagerIdentity(p);const backup=await f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope();
  const other=await lineageFixture();try{other.empty('split-portable');const out=await other.r.api.importPortableMemoryAsArchive(backup);assert.equal(out.ok,true,info(out));assert.equal(other.head().characters.length,4);assert.equal(other.control.calls.length,0);
  assert.equal((await other.r.api.rebuildWorldManagerState()).ok,true);assert.ok(other.head().characters.some(r=>r.name==='민희'));}finally{await other.r.cleanup();}
 });
 await test('next analysis preserves allocated identity rather than restoring the original combined id',async f=>{
  const p=await plan(f);await f.r.api.splitWorldManagerIdentity(p);const id=f.head().characters.find(r=>r.name==='민아').id;
  f.appendFive();const next=await f.run();assert.equal(next.completed,1,info(next));assert.equal(f.head().characters.find(r=>r.name==='민아').id,id);assert.ok(!f.head().characters.some(r=>r.id===p.sourceId));
 });
 await test('retired ambiguous label becomes pending instead of creating a third combined person',async f=>{
  const p=await plan(f,[{key:'a',name:'민아 A',aliases:[]},{key:'b',name:'민아 B',aliases:[]}]);await f.r.api.splitWorldManagerIdentity(p);
  f.appendFive();await f.run();assert.ok(!f.head().characters.some(r=>r.id===p.sourceId));assert.ok(f.head().unifiedApplied.pending.some(p=>p.reason==='split_identity_requires_disambiguation'||p.reason==='ambiguous_identity'));
 });
 await test('existing model temp IDs cannot collide with generated split identities',async f=>{
  const p=await plan(f);const jiho=f.head().characters.find(r=>r.name==='지호').id;await f.r.api.splitWorldManagerIdentity(p);
  const h=f.head();assert.equal(h.characters.length,4);assert.equal(h.characters.find(r=>r.name==='지호').id,jiho);assert.equal(h.relationships[0].targetId,jiho);
 },async f=>{f.control.artifact=JSON.parse(JSON.stringify(f.control.artifact).replaceAll('"jiho"','"split_a"'));});
 await test('generic correction endpoint cannot forge an unreviewed split group',async f=>{
  const p=await plan(f),head=info(f.head()),before=f.r.storageWrites.length;
  await assert.rejects(()=>f.r.api.addWorldManagerCorrection({anchorTurn:5,target:{domain:'head'},patch:{identitySplit:{schema:'libra.unified_identity_split.v1',sourceId:p.sourceId,beforeDigest:p.beforeDigest,targets:[],assignments:[],changes:{}}}}),/UNIFIED_SPLIT_VALIDATED_PREVIEW_REQUIRED/);
  assert.equal(info(f.head()),head);assert.equal(f.r.storageWrites.length,before);
 });
 console.log(JSON.stringify({test:'libra_unified_identity_split_v1',passed:results.length,results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
