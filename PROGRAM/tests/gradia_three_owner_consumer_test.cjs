'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {load}=require('./gradia/host.cjs');
const scope={scopeKey:'l',characterId:'c',chatId:'h'},owners=['libra','hayaku','flashback'];
const row=(owner,id,content)=>({owner,id,content});
async function fixture(items,options={}){
 const host=await load({testGlobals:{crypto:crypto.webcrypto},transformSource:s=>s.replace('  const publicApi = Object.freeze({','  globalThis.__testCreateLibReadConsumer = createLibServerReadConsumer;\n  const publicApi = Object.freeze({')});
 let current=true;
 const client={schema:'memory-suite.memory-read-client.v1',pluginId:'serial_gradation_agents_for_rp',openReadSession:async()=>{throw Error('IPC response must not open a server read session');}};
 const consumer=host.createLibReadConsumer({
   getBinding:()=>({client,scope,readSource:'plugin_ipc'}),
   assertNativeScope:async()=>true,
   selectOwnerRecall:async owner=>{if(!current) return {absent:true,code:'LIB_READ_STALE'};if(owner===options.unavailableOwner)return {absent:true,code:'LIB_READ_OWNER_UNAVAILABLE'};return {content:items.filter(item=>item.owner===owner).map(item=>`${item.id}:${item.content}`).join('\n')};},
   digest:async s=>crypto.createHash('sha256').update(s).digest('hex')
 });
 return {consumer,host,invalidate:()=>{current=false;}};
}
test('plugin IPC response evidence preserves every available owner',async()=>{
 const f=await fixture(owners.map(owner=>row(owner,'same-id',owner+' memory')));
 const session=await f.consumer.beginRead({requestId:'r'}),e=await session.getEvidence();
 assert.equal(session.readSource,'plugin_ipc');
 assert.deepEqual([...new Set(e.items.map(i=>i.owner))].sort(),[...owners].sort());
 assert.equal(e.items.length,3);assert.equal(f.host.getCalls(),0);
});
test('plugin IPC response evidence uses deterministic owner round-robin selection',async()=>{
 const rows=owners.flatMap(owner=>Array.from({length:20},(_,n)=>row(owner,String(n),owner+String(n)+' '+'x'.repeat(1000))));
 const f=await fixture(rows),budget={evidenceBudget:{maxChars:96000,maxBytes:96000*4+8192}};
 const s=await f.consumer.beginRead(budget),e=await s.getEvidence();
 assert(e.items.every(i=>owners.includes(i.owner)));assert.equal(s.selection.truncated,false);
 assert.equal(s.selection.promptByteLimit,96000*4+8192);assert.equal(s.selection.promptCharLimit,96000);
});
test('owner selection failures are isolated from the remaining owners',async()=>{
 const f=await fixture(owners.map(owner=>row(owner,'same',owner)),{unavailableOwner:'hayaku'});
 const session=await f.consumer.beginRead({});
 assert.equal(JSON.stringify(session.selection.unavailableOwners),JSON.stringify({hayaku:'LIB_READ_OWNER_UNAVAILABLE'}));
 assert.deepEqual([...new Set((await session.getEvidence()).items.map(i=>i.owner))].sort(),['flashback','libra']);
});
test('an owner becoming stale invalidates the bound draft',async()=>{
 const f=await fixture(owners.map(owner=>row(owner,'m',owner))),s=await f.consumer.beginRead({});
 await s.bindDraft('DRAFT');s.invalidate('LIB_READ_INVALIDATED');
 await assert.rejects(()=>s.finalizeDraft(),e=>/^LIB_READ_/.test(e.code));
});
