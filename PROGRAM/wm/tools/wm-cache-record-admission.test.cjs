'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,plain}=require('./wm-native-cache-support.cjs');
for(const identity of ['model','endpoint','text'])test('unversioned vector cannot masquerade as a current '+identity+' entry while versioned hits remain valid',async()=>{
 const f=await fixture(),m=f.r.api.MemoryEngine; m.clearDerivedCaches();
 m.CONFIG.embed={enabled:true,provider:'ollama',url:'http://127.0.0.1:9999/api/embed',key:'',model:'first-model',timeout:120000};
 const oldText='Synthetic old text record binding',newText=identity==='text'?'Synthetic new text record binding':oldText;
 await m.EmbeddingEngine.getEmbedding(oldText);
 if(identity==='model')m.CONFIG.embed.model='second-model';
 if(identity==='endpoint')m.CONFIG.embed.url='http://127.0.0.1:9998/api/embed';
 await m.EmbeddingEngine.getEmbedding(newText); const before=f.r.state.calls.length;
 assert.deepEqual(plain(await m.EmbeddingEngine.getEmbedding(newText)),[1,.25,-.5]);assert.equal(f.r.state.calls.length,before,'current versioned record hits');
 const cache=f.r.api.MemoryState.embeddingCache,key=[...cache.cache.keys()].at(-1);cache.set(key,[9,9,9]);
 assert.deepEqual(plain(await m.EmbeddingEngine.getEmbedding(newText)),[1,.25,-.5]);assert.equal(f.r.state.calls.length,before+1,'unversioned record requires configured offline adapter');
});
test('verified unrelated-scope save preserves an unchanged metadata cache hit',async()=>{
 const f=await fixture(),m=f.r.api.MemoryEngine; m.clearDerivedCaches();
 const source=await f.d.readVerified(f.scope),entry=source.entries.find(e=>e.comment==='lmai_memory');assert(entry);
 const first=m.getCachedMeta(entry);
 const otherScope='char:other-character|chat:other-chat|persona:other-persona';
 const saved=await f.d.saveVerified(otherScope,[{key:'unrelated-control',comment:'lmai_memory',content:'[META:{"t":1}]\nUnrelated scope evidence'}],{isCurrent:async()=>true});
 assert.equal(saved.ok,true);assert.equal(m.getCachedMeta(entry),first);
});
