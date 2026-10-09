'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
async function prepared(){
 const r=await runtime(null,{admittedHost:true}),ds=r.api.LibraDataStorage;
 const scope=ds.scopeKeyFor(r.char,r.chat),key=ds.storageKeyFor(scope);
 const read=()=>ds.readVerified(scope);
 const entries=clone((await read()).entries);
 assert.equal((await ds.save(r.char,r.chat,entries)).ok,true);
 const io={reads:0,writes:0,writeBytes:0};
 const get=r.storage.getItem,set=r.storage.setItem;
 r.storage.getItem=async k=>{io.reads++;return get(k);};
 r.storage.setItem=async(k,v)=>{io.writes++;io.writeBytes+=Buffer.byteLength(String(v));return set(k,v);};
 return {r,ds,scope,key,read,io,entries};
}
test('strictly verified unchanged canonical source keeps raw bytes and performs zero physical writes',async()=>{
 const {r,ds,key,read,io}=await prepared(),entries=clone((await read()).entries),raw=r.store.get(key);
 r.clock.now+=1000;
 const result=await ds.save(r.char,r.chat,entries);
 assert.equal(result.ok,true);assert.equal(result.verified,true);
 assert(io.reads>0,'the unchanged verdict requires a fresh physical read');
 assert.equal(io.writes,0);assert.equal(io.writeBytes,0);assert.equal(r.store.get(key),raw,'last source-write audit timestamp and exact bytes survive');
 assert.equal(result.unchanged,true);
 assert.equal(r.state.calls.length,0);
});
test('missing envelope normalization fields require one real write before no-op reuse',async()=>{
 const {r,ds,scope,key,entries,io}=await prepared();
 r.store.set(key,JSON.stringify({scopeKey:scope,entries,ownerNote:'preserve legacy metadata'}));
 assert.equal((await ds.save(r.char,r.chat,entries)).ok,true);assert(io.writes>0);
 const envelope=JSON.parse(r.store.get(key));assert.equal(envelope.version,'1.0');assert.equal(envelope.entryCount,entries.length);assert.equal(envelope.resetGeneration,0);assert.equal(envelope.ownerNote,'preserve legacy metadata');assert(Number.isFinite(envelope.updatedAt));
 io.writes=0;io.writeBytes=0;r.clock.now+=1000;
 assert.equal((await ds.save(r.char,r.chat,entries)).unchanged,true);assert.equal(io.writes,0);
});
test('body, unknown metadata, ordering and deletion differences cannot receive unchanged acknowledgment',async()=>{
 for(const kind of ['body','metadata','order','delete']){
  const {r,ds,key,read,io}=await prepared(),entries=clone((await read()).entries);
  if(kind==='body')entries[0].content+=' current correction';
  if(kind==='metadata')entries[0].userExtension={futureField:'current value'};
  if(kind==='order')entries.reverse();
  if(kind==='delete')entries.pop();
  const result=await ds.save(r.char,r.chat,entries);assert.equal(result.ok,true,kind);assert.notEqual(result.unchanged,true,kind);assert(io.writes>0,kind);
  assert.equal(JSON.stringify(JSON.parse(r.store.get(key)).entries),JSON.stringify(entries),kind+' preserves the exact requested source');
  assert.equal(r.state.calls.length,0);
 }
});
test('prior successful reads do not hide current canonical physical corruption',async()=>{
 const {r,ds,key,entries,read,io}=await prepared();assert.equal((await read()).ok,true);
 const damaged='{"scopeKey":';r.store.set(key,damaged);
 const result=await ds.save(r.char,r.chat,entries);assert.equal(result.ok,false);assert.equal(result.reason,'canonical_invalid');assert.equal(io.writes,0);assert.equal(r.store.get(key),damaged);
});
test('changed reset generation rejects unchanged content before writing or stripping the host',async()=>{
 const {r,ds,key,entries,io}=await prepared();const envelope=JSON.parse(r.store.get(key));envelope.resetGeneration=1;r.store.set(key,JSON.stringify(envelope));r.chat.localLore=clone(entries);const host=JSON.stringify(r.chat.localLore);
 const result=await ds.save(r.char,r.chat,entries);assert.equal(result.ok,false);assert.equal(result.reason,'reset_generation_changed');assert.equal(io.writes,0);assert.equal(JSON.stringify(r.chat.localLore),host);
});
test('identity changed during the strict read cannot write to or publish the captured source',async()=>{
 const {r,ds,key,entries,io}=await prepared(),raw=r.store.get(key),get=r.storage.getItem;let changed=false;
 r.chat.localLore=clone(entries);const host=JSON.stringify(r.chat.localLore);
 entries[0].content+=' correction that must not reach a stale scope';
 r.storage.getItem=async k=>{const value=await get(k);if(k===key&&!changed){changed=true;r.chat.id='different-chat-after-read';}return value;};
 const result=await ds.save(r.char,r.chat,entries);assert.equal(result.ok,false);assert.equal(result.reason,'stale_identity');assert.equal(io.writes,0);assert.equal(r.store.get(key),raw);assert.equal(JSON.stringify(r.chat.localLore),host);
});
test('unchanged acknowledgment strips only exact managed copies and preserves native lore and new additions',async()=>{
 const {r,ds,key,entries,io}=await prepared(),get=r.storage.getItem;let added=false;
 const native={key:'native',comment:'Original native lore',content:'original body'};
 const addition={key:'lmai_memory::concurrent',comment:'lmai_memory',content:'[META:{"t":10,"ttl":-1,"imp":5}]\nconcurrent host addition'};
 r.chat.localLore=[native,...clone(entries)];
 r.storage.getItem=async k=>{const value=await get(k);if(k===key&&!added){added=true;r.chat.localLore.push(addition);}return value;};
 const result=await ds.save(r.char,r.chat,clone(entries));assert.equal(result.ok,true);assert.equal(result.unchanged,true);assert.equal(io.writes,0);
 assert.equal(JSON.stringify(r.chat.localLore),JSON.stringify([native,addition]));
});
test('a failed changed-source write cannot be reported as an unchanged success',async()=>{
 const {r,ds,key,entries,io}=await prepared(),raw=r.store.get(key);const changed=clone(entries);changed[0].content+=' not acknowledged';r.state.failCanonical=true;
 const result=await ds.save(r.char,r.chat,changed);assert.equal(result.ok,false);assert.notEqual(result.unchanged,true);assert(io.writes>0);assert.equal(r.store.get(key),raw);assert.equal(result.reason,'canonical_save_unverified');
});
