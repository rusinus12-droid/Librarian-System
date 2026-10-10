'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./libra_typed_graph_discovery_test.cjs');
async function prepared(){
 const r=await fixture('narrative');
 const initial=JSON.parse(JSON.stringify(r.chat.localLore));
 assert.equal((await r.persist(r.chat,initial)).ok,true);
 const scope=r.api.LibraDataStorage.scopeKeyFor(r.char,r.chat);
 r.api.LibraDataStorage.setActiveScope(scope);
 const read=()=>r.api.LibraDataStorage.readVerified(scope);
 const before=await read();assert.equal(before.ok,true);assert(before.entries.some(e=>e.comment==='lmai_narrative'));
 return {r,read,without:JSON.parse(JSON.stringify(before.entries.filter(e=>e.comment!=='lmai_narrative')))};
}
test('an ordinary incomplete acknowledgment preserves the missing managed source category',async()=>{
 const {r,read,without}=await prepared();
 assert.equal((await r.persist(r.chat,without)).ok,true);
 assert((await read()).entries.some(e=>e.comment==='lmai_narrative'));
 assert.equal(r.state.calls.length,0);
});
test('explicit acknowledged deletion removes canonical source and its permanent HME node',async()=>{
 const {r,read,without}=await prepared(),reports=[],original=r.api.MemoryEngine.maintainHmeTypedSourceGraph;
 r.api.MemoryEngine.maintainHmeTypedSourceGraph=async snapshot=>{const result=await original(snapshot);reports.push(result);return result;};
 assert.equal((await r.persist(r.chat,without,{reason:'manual-delete',allowManagedDrops:true})).ok,true);
 const current=await read();assert.equal(current.ok,true);assert(!current.entries.some(e=>e.comment==='lmai_narrative'),'deleted source cannot be reintroduced by hydrated shadow');
 assert.equal(reports.at(-1).maintenance.removedNodes,1);
 assert.equal(reports.at(-1).maintenance.rebuiltNodes,0);
 assert.equal(r.state.calls.length,0);
});
test('acknowledged canonical data larger than the host-copy bound still maintains its permanent graph',async()=>{
 const {r,read}=await prepared(),initial=(await read()).entries;
 const body='ordinary canonical source word '.repeat(75000);
 const lore=[...JSON.parse(JSON.stringify(initial)),...['large-a','large-b'].map(id=>({key:'lmai_memory::'+id,comment:'lmai_memory',content:'[META:{"t":4,"ttl":-1,"imp":7}]\n'+body}))];
 assert(Buffer.byteLength(JSON.stringify(lore))>4*1024*1024,'fixture exceeds existing unissued/host-copy bound');
 const reports=[],original=r.api.MemoryEngine.maintainHmeTypedSourceGraph;
 r.api.MemoryEngine.maintainHmeTypedSourceGraph=async snapshot=>{const result=await original(snapshot);reports.push(result);return result;};
 r.jobs.pause(r.snapshot.scopeKey);
 assert.equal(r.jobs.watchesScope(r.snapshot.scopeKey),true,'existing semantic runtime scope is watched without a model/provider');
 assert.equal((await r.persist(r.chat,lore)).ok,true);
 assert.equal((await read()).entries.filter(e=>e.key==='lmai_memory::large-a'||e.key==='lmai_memory::large-b').length,2,'canonical sources remain intact');
 assert.equal(reports.length,1,'large verified canonical storage cannot silently skip graph maintenance');
 assert.equal(reports[0].ok,true);
 assert.equal(reports[0].maintenance.sourceChanges,2);
 assert.equal(r.state.calls.length,0);
});
