 'use strict';
// Input Writer generation/delivery was retired. Exercise its surviving shared
// read-set gate directly, including a real awaited host-read race and no writes.
const {assert,withReferences}=require('./fixtures/libra_retained_contract_probe.cjs');
(async()=>{
 await withReferences(async(h,d)=>{
  const p=await h.api.retainedContractProbe({author_note_prompt:d.chat.note});
  assert.equal(await p.verify(),true);d.character.desc+=' UNUSED';assert.equal(await p.verify(),true);
  d.chat.note+=' CHANGED';await assert.rejects(p.verify(),/CONSUMER_REFERENCE_CHANGED/);
 });
 await withReferences(async(h,d)=>{
  const p=await h.api.retainedContractProbe({bootstrap_references:{characterDefinitionCount:1}});
  assert(p.readSet.entries.some(x=>x.kind==='character_definition'));
  d.character.desc+=' UPDATED';await assert.rejects(p.verify(),/CONSUMER_REFERENCE_CHANGED/);
 });
 await withReferences(async(h,d)=>{
  const p=await h.api.retainedContractProbe({author_note_prompt:d.chat.note}),host=h.context.risuai,get=host.getChatFromIndex;let reached=false;
  host.getChatFromIndex=async(...args)=>{const chat=await get(...args);if(!reached){reached=true;chat.note+=' RACE';}return chat;};
  await assert.rejects(p.verify(),/CONSUMER_REFERENCE_CHANGED/);assert(reached);
 });
 await withReferences(async(h)=>{
  const p=await h.api.retainedContractProbe(),head={status:'ready',throughTurn:5,characters:[{id:'ce_a',name:'민수',aliases:['형 민수'],state:{}},{id:'ce_b',name:'민수',aliases:['동생 민수'],state:{}}],relationships:[{subjectId:'ce_a',targetId:'ce_b',dimension:'trust',state:'신뢰'}],world:[{id:'ce_key',name:'열쇠',kind:'object',state:{ownerRef:'ce_a',holderRef:'ce_b'}}],narrative:{threads:[]}};
  const before=JSON.stringify(head),v=p.project(head,'열쇠'),a=v.entityMap.find(x=>x.aliases.includes('형 민수')).ref,b=v.entityMap.find(x=>x.aliases.includes('동생 민수')).ref;
  assert.notEqual(a,b);assert.equal(v.state.world[0].state.ownerRef,a);assert.equal(v.state.world[0].state.holderRef,b);assert.equal(v.state.relationships[0].subjectRef,a);assert.equal(v.state.relationships[0].targetRef,b);assert.equal(JSON.stringify(head),before);
  const copy=structuredClone(p.readSet);copy.entries[0].digest='tampered';await assert.rejects(p.verify(copy),/CONSUMER_READSET_INVALID/);
 });
 console.log('libra_response_readset_v2_test: PASS (5 retained obligations; retired candidate-generation race not claimed)');
})().catch(e=>{console.error(e);process.exitCode=1;});
