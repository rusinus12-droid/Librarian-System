'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), acorn = require('acorn');
const { fixture, hook, tick, plain } = require('./wm-native-cache-support.cjs');
const { loadGui } = require('./wm-cache-currentness-gui-support.cjs');
const cfg = (extra = {}) => ({ enabled:true, provider:'ollama', url:'http://127.0.0.1:9999/api/embed', key:'', model:'tiny-3', timeout:120000, ...extra });
function transform(code) {
 const nodes=[], stack=[acorn.parse(code,{ecmaVersion:'latest'})];
 while(stack.length) { const n=stack.pop(); if(!n||typeof n!=='object')continue; nodes.push(n); for(const v of Object.values(n))if(Array.isArray(v))stack.push(...v);else if(v&&typeof v==='object')stack.push(v); }
 const engines=nodes.filter(n=>n.type==='VariableDeclarator'&&n.id?.name==='MemoryEngine');assert.equal(engines.length,1,'one actual MemoryEngine binding');
 const scope=engines[0].init?.callee?.body;assert.equal(scope?.type,'BlockStatement','MemoryEngine lexical body');
 const bindings=scope.body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations);
 const target=bindings.find(n=>n.id?.name==='getCachedMeta');assert(target,'metadata observer belongs to MemoryEngine');
 for(const name of ['getMetaCache','getEmbeddingCache'])assert(bindings.some(n=>n.id?.name===name),'cache observer binding '+name);
 const exports=scope.body.filter(n=>n.type==='ReturnStatement'&&n.argument?.type==='ObjectExpression'&&['CONFIG','getSafeKey','getCachedMeta'].every(name=>n.argument.properties.some(p=>p.key?.name===name&&p.value?.name===name)));
 assert.equal(exports.length,1,'one actual MemoryEngine return object');
 const original=code.slice(target.init.start,target.init.end),at=exports[0].argument.start+1;
 const edits=[{start:target.init.start,end:target.init.end,text:'((original)=>(entry)=>{const result=original(entry);const expected=parseMeta(entry.content);globalThis.__META_OBSERVATIONS__.push({matches:JSON.stringify(result)===JSON.stringify(expected),key:getSafeKey(entry)});return result;})('+original+')'},
  {start:at,end:at,text:'__cacheTest:{getMetaCache,getEmbeddingCache},'}];
 for(const edit of edits.sort((a,b)=>b.start-a.start))code=code.slice(0,edit.start)+edit.text+code.slice(edit.end);
 const end=code.lastIndexOf('})();');
 return code.slice(0,end)+';globalThis.__META_OBSERVATIONS__=[];globalThis.__CACHE_HELPERS__={forceMemoryTurnAnchor,refreshManagedMemoryEntryIntegrity,VertexAIProvider};'+code.slice(end);
}
async function fresh() { const f=await fixture({transform}); f.m=f.r.api.MemoryEngine; f.m.clearDerivedCaches(); return f; }
const settle = async f => { for(let i=0;i<50&&!f.r.state.pending.length;i++)await tick(); assert(f.r.state.pending.length,'real provider request is pending'); };
const release = f => { f.r.state.blockDoc=false; f.r.state.pending.splice(0).forEach(fn=>fn()); };
const publish = (f,patch) => { f.m.CONFIG.embed={...f.m.CONFIG.embed,...patch}; f.m.EmbeddingEngine.noteConfigurationPublished?.(); };
const vector = v => assert.deepEqual(plain(v),[1,.25,-.5]);

test('A registered beforeRequest uses current metadata after verified same-key canonical replacement',async()=>{
 const f=await fresh();await hook(f);assert(f.m.getCacheStats().meta.size>0);
 const base=await f.d.readVerified(f.scope),entry=base.entries.find(e=>e.comment==='lmai_memory'),old=f.m.parseMeta(entry.content);
 f.r.context.__CACHE_HELPERS__.forceMemoryTurnAnchor(entry,{turn:old.t+1,imp:old.imp===9?8:9,scopeKey:f.scope});
 const saved=await f.d.saveVerified(f.scope,base.entries,{isCurrent:async()=>true});assert.equal(saved.ok,true);
 f.r.context.__META_OBSERVATIONS__.length=0;const physical=f.physical.length;await hook(f);
 assert(f.physical.length>physical,'new physical canonical read still occurs');assert(f.r.context.__META_OBSERVATIONS__.length>0);
 assert.equal(f.r.context.__META_OBSERVATIONS__.filter(x=>!x.matches).length,0,'all metadata returned inside actual registered hook is current');
 assert.equal(f.r.state.calls.length,0);
});
test('A exact witness preserves unchanged hits, same-byte restores and unrelated-scope entries',async()=>{
 const f=await fresh(),a={key:'same',content:'[META:{"t":4,"imp":8}]\nOriginal'},b={key:'other-scope',content:'[META:{"t":2}]\nOther'};
 const first=f.m.getCachedMeta(a),other=f.m.getCachedMeta(b);assert.equal(f.m.getCachedMeta({...a}),first);
 const changed={...a,content:'[META:{"t":5,"imp":9}]\nNew'};assert.equal(f.m.getCachedMeta(changed).t,5);
 assert.equal(f.m.getCachedMeta({...b}),other,'unrelated scope remains a hit');
 const restored=f.m.getCachedMeta(a);assert.equal(restored.t,4);assert.equal(f.m.getCachedMeta({...a}),restored);
 a.content='[META:{"t":6}]\nIn-place reanalysis';assert.equal(f.m.getCachedMeta(a).t,6);
 const bodyOnly={...a,content:a.content+' changed body'};assert.notEqual(f.m.getCachedMeta(bodyOnly),f.m.getCachedMeta(a),'full content, not metadata prefix, is the witness');
});
test('A metadata content witness is included in bounded LRU retention accounting',async()=>{
 const f=await fresh(),raw='[META:{"t":1}]\n'+'x'.repeat(100000),cache=f.m.__cacheTest.getMetaCache();f.m.getCachedMeta({key:'large',content:raw});
 assert(cache.stats.bytes>=raw.length*2,'retained content is charged');
 for(let i=0;i<100;i++)f.m.getCachedMeta({key:'large-'+i,content:raw+i});
 assert(cache.stats.bytes<=cache.maxBytes);assert(cache.stats.size<100,'byte budget evicts witnesses');
});
test('B disabled cold and warm requests return null without transport, re-enable preserves compatible hit',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg({enabled:false});const text='Synthetic disabled warm request';
 assert.equal(await f.m.EmbeddingEngine.getEmbedding(text),null);assert.equal(f.r.state.calls.length,0);
 publish(f,{enabled:true});vector(await f.m.EmbeddingEngine.getEmbedding(text));assert.equal(f.r.state.calls.length,1);
 publish(f,{enabled:false});assert.equal(await f.m.EmbeddingEngine.getEmbedding(text),null);assert.equal(f.r.state.calls.length,1);
 publish(f,{enabled:true});vector(await f.m.EmbeddingEngine.getEmbedding(text));assert.equal(f.r.state.calls.length,1);
});
test('B required credentials and model are checked before warm cache lookup',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg();const text='Synthetic cache configuration guard';vector(await f.m.EmbeddingEngine.getEmbedding(text));
 f.m.CONFIG.embed.model='';assert.equal(await f.m.EmbeddingEngine.getEmbedding(text),null);assert.equal(f.r.state.calls.length,1);
 f.m.CONFIG.embed=cfg({provider:'openai',key:'synthetic-key'});
 f.r.host.nativeFetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({data:[{embedding:[1,.25,-.5]}]})});
 vector(await f.m.EmbeddingEngine.getEmbedding(text));f.m.CONFIG.embed.key='';assert.equal(await f.m.EmbeddingEngine.getEmbedding(text),null);
});
for(const [name,change] of [
 ['endpoint',f=>{f.m.CONFIG.embed.url='http://127.0.0.1:9998/api/embed';}],
 ['model',f=>{f.m.CONFIG.embed.model='other-3';}],
 ['credential',f=>{f.m.CONFIG.embed.key='synthetic-replacement-key';}],
 ['dimension',f=>{f.m.CONFIG.embed.dimension=4;}],
 ['disable',f=>{f.m.CONFIG.embed.enabled=false;}],
 ['public clear',f=>{f.m.clearDerivedCaches();}],
 ['runtime reset',f=>{f.r.api.MemoryState.reset();}],
 ['cache resize',f=>{f.m.CONFIG.embeddingCacheMaxEntries=128;f.m.getCacheStats();}],
 ['unload',async f=>{await f.r.context.__NATIVE_UNLOAD__();}]
])test('C pending '+name+' change rejects old consumer result and late cache publication',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg();f.r.state.blockDoc=true;
 const pending=f.m.EmbeddingEngine.getEmbedding('Synthetic pending '+name+' request');await settle(f);await change(f);release(f);
 assert.equal(await pending,null,'stale provider vector never reaches old consumer');assert.equal(f.m.getCacheStats().embedding.size,0,'no late insertion');
});
test('C endpoint change requires a new actual endpoint request rather than relabeling old result',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg();f.r.state.blockDoc=true;const text='Synthetic endpoint identity request';
 const pending=f.m.EmbeddingEngine.getEmbedding(text);await settle(f);f.m.CONFIG.embed.url='http://127.0.0.1:9998/api/embed';release(f);await pending;
 vector(await f.m.EmbeddingEngine.getEmbedding(text));assert.equal(f.r.state.calls.length,2);assert.equal(f.r.state.calls[1].url,f.m.CONFIG.embed.url);
});
test('C pending unchanged and unrelated config publication succeeds and is reusable',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg();f.r.state.blockDoc=true;const text='Synthetic unchanged pending request';
 const pending=f.m.EmbeddingEngine.getEmbedding(text);await settle(f);f.m.CONFIG.scoringProfile='unrelated-control';f.m.EmbeddingEngine.noteConfigurationPublished?.();release(f);
 vector(await pending);vector(await f.m.EmbeddingEngine.getEmbedding(text));assert.equal(f.r.state.calls.length,1);
});
test('C caller abort before lookup and after transport suppresses hits and late publication',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg();const text='Synthetic cancelled request';vector(await f.m.EmbeddingEngine.getEmbedding(text));
 const a=new AbortController();a.abort();assert.equal(await f.m.EmbeddingEngine.getEmbedding(text,{signal:a.signal}),null);assert.equal(f.r.state.calls.length,1);
 const b=new AbortController();f.r.state.blockDoc=true;const pending=f.m.EmbeddingEngine.getEmbedding(text+' pending',{signal:b.signal});await settle(f);b.abort();release(f);
 assert.equal(await pending,null);assert.equal(f.m.getCacheStats().embedding.size,1,'old compatible completed entry is preserved');
});
test('C queued requests retain their entry snapshot and do not execute under changed config',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg();f.r.state.blockDoc=true;
 const one=f.m.EmbeddingEngine.getEmbedding('Synthetic active queue one'),two=f.m.EmbeddingEngine.getEmbedding('Synthetic active queue two');await settle(f);
 const queued=f.m.EmbeddingEngine.getEmbedding('Synthetic queued old request');f.m.CONFIG.embed.model='new-model';release(f);
 assert.deepEqual(await Promise.all([one,two,queued]),[null,null,null]);assert.equal(f.r.state.calls.length,2,'queued stale work did not call new provider config');
});
test('C cache refuses unversioned records and never retains raw credentials',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg({key:'synthetic-secret-no-retain'});const text='Synthetic versioned cache record';vector(await f.m.EmbeddingEngine.getEmbedding(text));
 const cache=f.m.__cacheTest.getEmbeddingCache(),key=[...cache.cache.keys()][0];assert(key);assert(!JSON.stringify([...cache.cache]).includes('synthetic-secret-no-retain'));
 cache.set(key,[9,9,9]);vector(await f.m.EmbeddingEngine.getEmbedding(text));assert.equal(f.r.state.calls.length,2,'legacy array cannot be a valid versioned hit');
 cache.set([...cache.cache.keys()][0],{schema:'libra.embedding.cache.v1',vector:[9,9,9],dim:3,fingerprint:f.m.EmbeddingEngine.getFingerprintMeta([9,9,9])});
 vector(await f.m.EmbeddingEngine.getEmbedding(text));assert.equal(f.r.state.calls.length,3,'old record cannot be upgraded by guess');
});

test('C registered settings import ABA retires pending work while preserving CONFIG identity and descriptors',async()=>{
 let releaseRequest,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>releaseRequest=r);let calls=0;
 const f=await loadGui({args:{embedding_enabled:''},nativeFetch:async()=>{calls++;started();await gate;return {ok:true,status:200,text:async()=>JSON.stringify({embeddings:[[1,.25,-.5]]})};}});
 try {
  const m=f.api.MemoryEngine,identity=m.CONFIG,descriptor=Object.getOwnPropertyDescriptor(m.CONFIG,'embed');
  const imported=async embed=>{await f.overlay.querySelector('#settings-file-input').onchange({target:{files:[{name:'synthetic.json',text:async()=>JSON.stringify({embed})}]}});assert.equal(JSON.parse(f.store.get('LMAI_Config')).embed.model,embed.model);};
  await imported(cfg());const pending=m.EmbeddingEngine.getEmbedding('Synthetic real GUI publication ABA');await ready;
  await imported(cfg({enabled:false}));await imported(cfg());releaseRequest();assert.equal(await pending,null);
  assert.equal(m.CONFIG,identity);const after=Object.getOwnPropertyDescriptor(m.CONFIG,'embed');assert.equal(after.get,descriptor.get);assert.equal(after.set,descriptor.set);
  assert.equal(m.getCacheStats().embedding.size,0);assert.equal(calls,1);
 } finally {releaseRequest();f.close();}
});
test('offline guard confirms zero actual network attempts',()=>{assert.deepEqual(globalThis.__finalDeliveryTransportAttempts||[],[]);});

test('B disabled and incomplete Vertex config fail open without resolving an invalid request endpoint',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg({provider:'vertex',enabled:false,url:'',key:''});
 assert.equal(await f.m.EmbeddingEngine.getEmbedding('Synthetic disabled Vertex config'),null);
 f.m.CONFIG.embed.enabled=true;assert.equal(await f.m.EmbeddingEngine.getEmbedding('Synthetic incomplete Vertex config'),null);
 assert.equal(f.r.state.calls.length,0);
});
test('C equivalent resolved endpoint and unrelated settings preserve completed hits',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg({url:'http://127.0.0.1:9999'});const text='Synthetic equivalent resolved endpoint';
 vector(await f.m.EmbeddingEngine.getEmbedding(text));publish(f,{url:'http://127.0.0.1:9999/api/embed'});
 f.m.CONFIG.recallAnchorBonus=.0123;f.m.EmbeddingEngine.noteConfigurationPublished?.();vector(await f.m.EmbeddingEngine.getEmbedding(text));assert.equal(f.r.state.calls.length,1);
});
test('C supported expected dimension is checked on newly returned and cached vectors',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg({dimension:4});const text='Synthetic expected dimension validation';
 assert.equal(await f.m.EmbeddingEngine.getEmbedding(text),null);assert.equal(f.m.getCacheStats().embedding.size,0);
 publish(f,{dimension:3});vector(await f.m.EmbeddingEngine.getEmbedding(text));vector(await f.m.EmbeddingEngine.getEmbedding(text));assert.equal(f.r.state.calls.length,2);
});

test('C actual Vertex adapter uses captured model endpoint and credential across its authentication await',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg({provider:'vertex',url:'http://127.0.0.1:9999/locations/test',key:'synthetic-old-key',model:'old-model'});
 let start,releaseAuth;const ready=new Promise(r=>start=r),gate=new Promise(r=>releaseAuth=r);let usedKey;
 f.r.context.__CACHE_HELPERS__.VertexAIProvider._getAccessToken=async key=>{usedKey=key;start();await gate;return 'synthetic-token';};
 const requests=[];f.r.host.nativeFetch=async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return {ok:true,status:200,text:async()=>JSON.stringify({predictions:[{embeddings:{values:[1,.25,-.5]}}]})};};
 const pending=f.m.EmbeddingEngine.getEmbedding('Synthetic Vertex snapshot request');await ready;
 f.m.CONFIG.embed=cfg({provider:'vertex',url:'http://127.0.0.1:9998/locations/next',key:'synthetic-new-key',model:'new-model'});releaseAuth();
 assert.equal(await pending,null);assert.equal(usedKey,'synthetic-old-key');assert.equal(requests.length,1);
 assert.equal(requests[0].url,'http://127.0.0.1:9999/locations/test/publishers/google/models/old-model:predict');assert.equal(f.m.getCacheStats().embedding.size,0);
});
test('C exact content and endpoint witnesses disambiguate compact hash-key collisions',async()=>{
 const f=await fresh();f.m.CONFIG.embed=cfg();const original=f.m.TokenizerEngine.simpleHash;f.m.TokenizerEngine.simpleHash=()=>1;
 try {
  vector(await f.m.EmbeddingEngine.getEmbedding('Synthetic alpha same-size input'));
  vector(await f.m.EmbeddingEngine.getEmbedding('Synthetic omega same-size input'));assert.equal(f.r.state.calls.length,2);
  publish(f,{url:'http://127.0.0.1:9998/api/embed'});vector(await f.m.EmbeddingEngine.getEmbedding('Synthetic omega same-size input'));assert.equal(f.r.state.calls.length,3);
 } finally {f.m.TokenizerEngine.simpleHash=original;}
});
