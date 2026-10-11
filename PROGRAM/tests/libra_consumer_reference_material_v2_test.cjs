'use strict';
// Shared reference freshness survives Input Writer retirement. The packet below
// declares consumption; the snapshot and re-read both use real host selection.
const {assert,withReferences}=require('./fixtures/libra_retained_contract_probe.cjs');
(async()=>{
 await withReferences(async(h,d)=>{
  d.character.globalLore=[{id:'lore-secret',key:'금고',comment:'금고',content:'금고의 암호는 민아만 알고 있다.',alwaysActive:true,mode:'normal'},{id:'lore-unused',key:'등대',comment:'등대',content:'먼 등대에는 파란 종이 있다.',mode:'normal'}];
  const first=await h.api.retainedContractProbe();
  const entry=first.snapshot.consumerSourceInventory.lore.find(x=>x.id.includes('lore-secret'));
  assert(entry,'native selected character lore is in the physical inventory');
  const p=await h.api.retainedContractProbe({lore_material:{stages:{shared:{promptBlock:'금고의 암호는 민아만 알고 있다.',selectedItems:[{id:entry.id}]}}}});
  assert(p.readSet.entries.some(x=>x.kind==='lore'&&x.id===entry.id));assert.equal(await p.verify(),true);
  d.character.globalLore[0].content+=' 암호가 바뀌었다.';await assert.rejects(p.verify(),/CONSUMER_REFERENCE_CHANGED/);
 });
 await withReferences(async(h,d)=>{
  d.db.personas=[{id:'persona-a',name:'지호',description:'PERSONA_USED'},{id:'persona-b',name:'유진',description:'다른 사람'}];d.chat.bindedPersona='persona-a';
  const p=await h.api.retainedContractProbe({bootstrap_references:{personaCount:1}});
  assert(p.readSet.entries.some(x=>x.kind==='persona'));assert.equal(await p.verify(),true);
  d.chat.bindedPersona='persona-b';await assert.rejects(p.verify(),/CONSUMER_REFERENCE_SELECTION_CHANGED|CONSUMER_REFERENCE_CHANGED/);
 });
 await withReferences(async(h,d)=>{
  d.chat.note='';const p=await h.api.retainedContractProbe();assert.equal(await p.verify(),true);
  d.chat.note='새로운 금지 지시';await assert.rejects(p.verify(),/CONSUMER_REFERENCE_CHANGED/);
 });
 await withReferences(async(h,d)=>{
  d.chat.note='{{user}}에게 암호를 공개하지 않는다.';d.db.personas=[{id:'persona-a',name:'지호',description:'한 명의 사용자'}];d.chat.bindedPersona='persona-a';
  const p=await h.api.retainedContractProbe({author_note_prompt:'지호에게 암호를 공개하지 않는다.'});
  assert(p.snapshot.authorNote.content.includes('지호'));assert.equal(await p.verify(),true);
  d.db.personas[0].name='유진';await assert.rejects(p.verify(),/CONSUMER_REFERENCE_CHANGED/);
 });
 // The former Writer RP/author mode is gone. A retained provider policy change
 // still invalidates the same settings digest, without any model generation.
 const {createLibraVmHarness,expose,hostData}=require('./fixtures/libra_retained_contract_probe.cjs');
 const d=hostData(),h=await createLibraVmHarness({enable_gui:'false'},d.host,{transformSource:expose});
 try {const p=await h.api.retainedContractProbe();await h.api.saveLibraProviderConfig({defaultPresetName:'changed-policy'});await assert.rejects(p.verify(),/CONSUMER_POLICY_CHANGED/);}finally{await h.cleanup();}
 console.log('libra_consumer_reference_material_v2_test: PASS (5 current reference cases; Writer mode retired)');
})().catch(e=>{console.error(e);process.exitCode=1;});
