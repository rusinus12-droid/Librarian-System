'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
// These are actual retained shared builder/validator functions. Only test access
// is added; there is no new production route or recreated Writer/Planner API.
const expose=source=>{
 const anchor='      getUnifiedStorageStatus,';assert.equal(source.split(anchor).length,2);
 return source.replace(anchor,`      retirementReferenceProbe: async (packet = {}) => {
        const context=await resolveContext(),settings=await loadSettings(),snapshot=await loadRisuContextSnapshot(settings,[]);
        const readSet=buildConsumerReadSet(packet,snapshot,settings,context.scope);
        await assertConsumerReadSet(readSet);
        return {readSet,verify:value=>assertConsumerReadSet(value||readSet),project:(head,seed)=>consumerEntityProjection(head,null,seed)};
      },\n`+anchor).replace('    async getUnifiedStorageStatus() {','    retirementReferenceProbe: packet => LibraMemoryCore.retirementReferenceProbe(packet),\n    async getUnifiedStorageStatus() {');
};
async function withReferences(run){const f=await fixture({transformSource:expose});try{f.chat.note='consumed current author note';f.character.desc='consumable character definition';await f.r.api.getResponseContext();f.r.storageWrites.length=0;f.r.storageRemovals.length=0;const calls=f.control.calls.length;await run(f);assert.equal(f.control.calls.length,calls);assert.deepEqual(f.r.storageWrites,[]);assert.deepEqual(f.r.storageRemovals,[]);}finally{await f.r.cleanup();}}
test('shared consumed author note is re-read; unused definition remains outside the read set',()=>withReferences(async f=>{
 const probe=await f.r.api.retirementReferenceProbe({author_note_prompt:f.chat.note});assert(probe.readSet.entries.some(e=>e.kind==='author_note'));
 f.character.desc+=' unused change';await probe.verify();f.chat.note+=' physical change';await assert.rejects(probe.verify(),/CONSUMER_REFERENCE_CHANGED/);
}));
test('actually consumed character definition changes invalidate shared reference evidence',()=>withReferences(async f=>{
 const probe=await f.r.api.retirementReferenceProbe({bootstrap_references:{characterDefinitionCount:1}});assert(probe.readSet.entries.some(e=>e.kind==='character_definition'));f.character.desc+=' changed consumed definition';await assert.rejects(probe.verify(),/CONSUMER_REFERENCE_CHANGED/);
}));
test('shared reference gate rechecks a mutation made during an awaited host read',()=>withReferences(async f=>{
 const probe=await f.r.api.retirementReferenceProbe({author_note_prompt:f.chat.note}),host=f.r.context.risuai,get=host.getChatFromIndex;let reached=false;
 host.getChatFromIndex=async(...args)=>{const chat=await get(...args);if(!reached){reached=true;chat.note+=' await-race';}return chat;};try{await assert.rejects(probe.verify(),/CONSUMER_REFERENCE_CHANGED/);assert(reached,'fault reaches actual physical reference read');}finally{host.getChatFromIndex=get;}
}));
test('public read-set digest tampering is rejected by the retained shared validator',()=>withReferences(async f=>{
 const probe=await f.r.api.retirementReferenceProbe({author_note_prompt:f.chat.note}),copy=structuredClone(probe.readSet);assert(copy.entries.length);copy.entries[0].digest='tampered';await assert.rejects(probe.verify(copy),/CONSUMER_READSET_INVALID/);
}));
test('shared consumer projection preserves homonym identities, relationship and distinct ownership without source mutation',()=>withReferences(async f=>{
 const probe=await f.r.api.retirementReferenceProbe(),head={status:'ready',throughTurn:5,characters:[{id:'ce_a',name:'same person name',aliases:['north person'],state:{}},{id:'ce_b',name:'same person name',aliases:['south person'],state:{}}],relationships:[{subjectId:'ce_a',targetId:'ce_b',dimension:'trust',state:'different identities'}],world:[{id:'ce_key',name:'key',kind:'object',state:{ownerRef:'ce_a',holderRef:'ce_b'}}],narrative:{threads:[]}},raw=JSON.stringify(head),projection=probe.project(head,'key'),a=projection.entityMap.find(r=>r.aliases.includes('north person')).ref,b=projection.entityMap.find(r=>r.aliases.includes('south person')).ref;
 assert.notEqual(a,b);assert.equal(projection.state.world[0].state.ownerRef,a);assert.equal(projection.state.world[0].state.holderRef,b);assert.equal(projection.state.relationships[0].subjectRef,a);assert.equal(JSON.stringify(head),raw);
}));
