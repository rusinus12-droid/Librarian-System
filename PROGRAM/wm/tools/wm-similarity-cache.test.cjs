'use strict';
const {profileLabel}=require('./wm-historical-fixture-paths.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fresh,cfg,publish,settle,release,pub,plain}=require('./wm-similarity-cache-support.cjs');
const E=['Alice remembers the silver pendant promise at the market','Alice remembers the silver pendant promise after meeting Bob at the tower'];
const D=['민지는 현우에게 맡긴 은색 펜던트의 약속을 기억했다.','현우는 민지에게 맡은 은색 펜던트의 약속을 기억했다.'];
const ref=async(f,a,b)=>(await f.a.calcSimilarityDetailed(a,b,{})).similarity;
const score=(f,pair=E)=>f.a.calcSimilarity(...pair);
test('E ordered public heavy scores preserve the pendant-04 true/false decision',async()=>{
 const f=await fresh();assert.equal(f.m.CONFIG.hybridDuplicateFastEnabled,true);assert.equal(f.m.CONFIG.hybridDuplicateMaxHeavy,12);
 const forward=await pub(f,...E),reverse=await pub(f,...E.slice().reverse());
 assert.deepEqual(forward,{result:true,heavyScores:[.7860746505662892]});
 assert.deepEqual(reverse,{result:false,heavyScores:[.7396829346092504]});
 assert.equal(await score(f),forward.heavyScores[0]);assert.equal(f.r.state.calls.length,0);
});
test('D off/on public heavy score follows pendant-17 current embedding configuration',async()=>{
 const f=await fresh();const off=await pub(f,...D);publish(f,{enabled:true});const on=await pub(f,...D);
 assert.deepEqual(off,{result:false,heavyScores:[.7103624125874127]});
 assert.deepEqual(on,{result:true,heavyScores:[.7827718094405596]});assert.equal(f.r.state.calls.length,2);
});
test('D original below-threshold audit stays equal to ordered uncached result',async()=>{
 const f=await fresh(),pair=['Synthetic alpha promise','Synthetic beta location'];await score(f,pair);publish(f,{enabled:true});const expected=await ref(f,...pair);assert.equal(await score(f,pair),expected);
});
test('same-order stable cache hit avoids detailed scorer and any extra provider work',async()=>{
 const f=await fresh();publish(f,{enabled:true});const first=await score(f),count=f.obs.details,calls=f.r.state.calls.length;
 assert.equal(await score(f),first);assert.equal(f.obs.details,count);assert.equal(calls,2);assert.equal(f.r.state.calls.length,calls);
});
test('only locator hash collisions miss on exact ordered witnesses',async()=>{
 const f=await fresh(),one=['alpha beta','alpha zeta'],two=['gamma beta','theta zeta'];
 assert.equal(one[0].length,two[0].length);assert.equal(one[1].length,two[1].length);
 const a=await ref(f,...one),b=await ref(f,...two);assert.notEqual(a,b);f.obs.hash=()=>1;
 assert.equal(await score(f,one),a);assert.equal(await score(f,two),b);assert.equal(await score(f,one),a);
 assert.equal(f.a.getSimCache().stats.size,1,'one shallow record per colliding locator');
});
test('legacy numeric and malformed records never authorize a score hit',async()=>{
 const f=await fresh(),expected=await score(f),cache=f.a.getSimCache(),key=[...cache.cache.keys()][0],valid=cache.peek(key);
 for(const bad of [99,null,{}, {...valid,schema:'other'}, {...valid,generation:-1}, {...valid,textA:E[1]}, {...valid,textB:E[0]}, {...valid,score:NaN}, {...valid,score:Infinity}, {...valid,score:'1'}]){
  cache.set(key,bad);const before=f.obs.details;assert.equal(await score(f),expected);assert.equal(f.obs.details,before+1,'malformed record is a miss');
 }
});
test('existing trim conversion shares a witness, raw Unicode remains exact',async()=>{
 const f=await fresh();const first=await score(f),before=f.obs.details;
 assert.equal(await score(f,[' \n'+E[0]+' \t',E[1]+'\n']),first);assert.equal(f.obs.details,before);
 f.obs.hash=()=>7;const one=['caf\u00e9 foo','caf\u00e9 bar'],two=['cafe\u0301 foo','cafe\u0301 bar'];
 assert.equal(await score(f,one),await ref(f,...one));assert.equal(await score(f,two),await ref(f,...two));
 const records=[...f.a.getSimCache().cache.values()];assert(records.some(x=>x?.textA===one[0]));assert(records.some(x=>x?.textA===two[0]));
});
for(const field of ['word','char','concept','lexicalCoverage','focus','wordCoverageFactor','charCoverageFactor','conceptCoverageFactor'])test('in-place '+field+' weight change invalidates by scalar value',async()=>{
 const f=await fresh();await score(f);f.m.CONFIG.scoringWeights[field]+=0.013;const expected=await ref(f,...E),before=f.obs.details;assert.equal(await score(f),expected);assert.equal(f.obs.details,before+1);
});
test('anchor and profile publication invalidate while equivalent replacement weights hit',async()=>{
 const f=await fresh();await score(f);f.m.CONFIG.scoringWeights={...f.m.CONFIG.scoringWeights};let before=f.obs.details;await score(f);assert.equal(f.obs.details,before);
 f.m.CONFIG.recallAnchorBonus=.031;let expected=await ref(f,...E);before=f.obs.details;assert.equal(await score(f),expected);assert.equal(f.obs.details,before+1);
 f.m.CONFIG.scoringProfile='conservative-profile-observation';f.m.EmbeddingEngine.noteConfigurationPublished();before=f.obs.details;await score(f);assert.equal(f.obs.details,before+1);
});
test('window debug cache limits and legacy-unused revision preserve compatible hits',async()=>{
 const f=await fresh();publish(f,{enabled:true});const value=await score(f),before=f.obs.details,calls=f.r.state.calls.length;
 Object.assign(f.m.CONFIG,{recallSentenceWindowChars:1234,recallSentenceWindowEnabled:true,debug:true,embeddingCacheMaxEntries:128,embeddingCacheMaxTextChars:256});f.m.CONFIG.embed.modelRevision='unused-legacy-revision';f.m.EmbeddingEngine.noteConfigurationPublished();
 assert.equal(await score(f),value);assert.equal(f.obs.details,before);assert.equal(f.r.state.calls.length,calls);
});
test('equivalent effective endpoint and provider aliases preserve compatible hits',async()=>{
 const f=await fresh();publish(f,{enabled:true,url:'http://127.0.0.1:9999'});const value=await score(f),before=f.obs.details;
 publish(f,{url:'http://127.0.0.1:9999/api/embed',provider:'OLLAMA'});assert.equal(await score(f),value);assert.equal(f.obs.details,before);
});
for(const [label,change] of [
 ['enable',f=>{f.m.CONFIG.embed.enabled=false;}],['provider',f=>{f.m.CONFIG.embed.provider='openai';f.m.CONFIG.embed.key='synthetic-provider-key';}],
 ['model',f=>{f.m.CONFIG.embed.model='other-3';}],['endpoint',f=>{f.m.CONFIG.embed.url='http://127.0.0.1:9998/api/embed';}],
 ['credential',f=>{f.m.CONFIG.embed.key='synthetic-new-key';}],['dimension',f=>{f.m.CONFIG.embed.dimension=4;}],['timeout',f=>{f.m.CONFIG.embed.timeout=777;}],
 ['missing model',f=>{f.m.CONFIG.embed.model='';}],['weight',f=>{f.m.CONFIG.scoringWeights.word+=.02;}],['anchor',f=>{f.m.CONFIG.recallAnchorBonus=.025;}]
])test('pending '+label+' change returns existing result but never publishes stale score',async()=>{
 const f=await fresh();publish(f,{enabled:true});f.r.state.blockDoc=true;const pending=score(f),cache=f.a.getSimCache();await settle(f);change(f);release(f);
 assert.equal(typeof await pending,'number');assert.equal(cache.stats.size,0);assert(f.r.state.calls.length<=2,'no retry/recompute or extra provider call');
});
for(const [label,change] of [
 ['public clear',f=>f.m.clearDerivedCaches()],['MemoryState reset',f=>f.s.reset()],['direct clear',f=>f.a.getSimCache().clear()],
 ['dispose',f=>f.a.getSimCache().dispose()],['instance replacement',f=>{f.s.simCache=null;f.a.getSimCache();}],['runtime unload',f=>f.r.context.__NATIVE_UNLOAD__()],['runtime epoch replacement',f=>{f.r.context.__LIBRA_WORLD_MAKER_RUNTIME_EPOCH__+=1;}]
])test('pending '+label+' cannot repopulate retired or current similarity cache',async()=>{
 const f=await fresh();publish(f,{enabled:true});f.r.state.blockDoc=true;const pending=score(f),cache=f.a.getSimCache();await settle(f);await change(f);release(f);assert.equal(typeof await pending,'number');
 assert.equal(cache.stats.size,0);assert.equal(f.s.simCache?.stats.size||0,0);
});
test('pending unchanged completion publishes normally with exactly two legacy adapter calls',async()=>{
 const f=await fresh();publish(f,{enabled:true});f.r.state.blockDoc=true;const pending=score(f);await settle(f);f.m.CONFIG.recallSentenceWindowChars=777;f.m.EmbeddingEngine.noteConfigurationPublished();release(f);
 const value=await pending;assert.equal(f.a.getSimCache().stats.size,1);const before=f.obs.details;assert.equal(await score(f),value);assert.equal(f.obs.details,before);assert.equal(f.r.state.calls.length,2);
});
test('completed scores invalidate for on/off and configured/unconfigured changes',async()=>{
 const f=await fresh();publish(f,{enabled:true});await score(f,D);publish(f,{enabled:false});assert.equal(await score(f,D),await ref(f,...D));
 publish(f,{enabled:true,model:''});assert.equal(await score(f,D),await ref(f,...D));
});
test('shallow witnesses charge all text bytes and oversized admission preserves older entries',async()=>{
 const f=await fresh(),cache=f.a.getSimCache();assert.equal(cache.maxSize,2500);assert.equal(cache.maxBytes,10*1024*1024);cache.maxBytes=4096;
 await score(f);const key=[...cache.cache.keys()][0],record=cache.peek(key);assert.equal(record.schema,'libra.similarity.cache.v2');assert(cache.stats.bytes>2*(E[0].length+E[1].length));
 const long=['synthetic '.repeat(600),'witnesses '.repeat(600)];const expected=await ref(f,...long);assert.equal(await score(f,long),expected);assert.equal(cache.peek(key),record,'oversized record skipped before admission, not admitted then evicted');
 assert.equal(cache.stats.size,1);assert(cache.stats.bytes<=cache._effectiveMaxBytes());cache.clear();assert.equal(cache.stats.bytes,0);
});
test('many pairs remain within inherited entry and effective byte budgets',async()=>{
 const f=await fresh(),cache=f.a.getSimCache();cache.maxSize=12;cache.maxBytes=5000;
 for(let i=0;i<40;i++){await score(f,[E[0]+i,E[1]+i]);assert(cache.stats.size<=12);assert(cache.stats.bytes<=cache._effectiveMaxBytes());}
 cache.clear();assert.equal(cache.stats.size,0);assert.equal(cache.stats.bytes,0);
});
test('similarity keys records and observations do not retain endpoint or credentials',async()=>{
 const f=await fresh();publish(f,{enabled:false,url:'https://user:synthetic-password@private.invalid/api/embed?api_key=synthetic-query-key',key:'synthetic-credential'});await score(f);
 const dump=JSON.stringify({cache:plain([...f.a.getSimCache().cache]),capture:plain(f.a.capture())});
 for(const secret of ['private.invalid','synthetic-password','synthetic-query-key','synthetic-credential'])assert(!dump.includes(secret));
});
test('offline guard records zero external transport attempts',()=>assert.deepEqual(globalThis.__finalDeliveryTransportAttempts||[],[]));

const declaredCases=[{"id": "pendant-01", "a": "Alice saved a silver pendant", "b": "Alice saved a silver pendant from old market and returned it to Bob"}, {"id": "pendant-02", "a": "Alice saved a silver pendant from the market", "b": "Alice saved a silver pendant from the old market and returned it to Bob"}, {"id": "pendant-03", "a": "Alice remembers the silver pendant promise", "b": "Alice remembers the silver pendant promise and returns the pendant to Bob"}, {"id": "pendant-04", "a": "Alice remembers the silver pendant promise at the market", "b": "Alice remembers the silver pendant promise after meeting Bob at the tower"}, {"id": "pendant-05", "a": "Alice remembers the silver pendant promise at the old market", "b": "Bob remembers the silver pendant promise at the old tower"}, {"id": "pendant-06", "a": "Alice remembers a promise to return the silver pendant", "b": "Alice remembers the promise and returns the silver pendant to Bob"}, {"id": "pendant-07", "a": "Alice trusts Bob with the silver pendant", "b": "Alice trusts Bob to return the silver pendant after visiting the market"}, {"id": "pendant-08", "a": "Alice trusts Bob to return the pendant from the market", "b": "Alice trusts Bob to return the silver pendant from the old tower"}, {"id": "pendant-09", "a": "Alice remembers that Bob kept the silver pendant safe", "b": "Alice remembers that Bob returned the silver pendant safely"}, {"id": "pendant-10", "a": "Alice remembers the promise and keeps the pendant safe", "b": "Bob remembers the promise and keeps the silver pendant safe"}, {"id": "pendant-11", "a": "Alice remembers the silver pendant and the promise", "b": "Alice remembers the silver pendant and returns it after the promise"}, {"id": "pendant-12", "a": "Alice remembers a promise about the silver pendant", "b": "Bob remembers a promise about returning the silver pendant"}, {"id": "pendant-13", "a": "민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.", "b": "민지가 현우에게 은색 펜던트를 맡겼다."}, {"id": "pendant-14", "a": "민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.", "b": "민지가 현우에게 은색 펜던트를 맡기고 돌려달라고 약속했다."}, {"id": "pendant-15", "a": "민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.", "b": "민지가 현우에게 펜던트를 맡기고 돌아오면 돌려달라고 약속했다."}, {"id": "pendant-16", "a": "민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.", "b": "민지가 현우에게 은색 펜던트를 맡기고 내일 돌아오면 돌려달라고 약속했다."}, {"id": "pendant-17", "a": "민지는 현우에게 맡긴 은색 펜던트의 약속을 기억했다.", "b": "현우는 민지에게 맡은 은색 펜던트의 약속을 기억했다."}, {"id": "pendant-18", "a": "민지는 현우에게 맡긴 은색 펜던트의 약속을 기억했다.", "b": "민지는 현우에게 은색 펜던트를 돌려달라고 약속한 일을 기억했다."}, {"id": "pendant-19", "a": "민지는 현우에게 맡긴 은색 펜던트의 약속을 기억했다.", "b": "민지는 은색 펜던트의 약속을 기억했다."}, {"id": "pendant-20", "a": "민지는 현우에게 맡긴 은색 펜던트의 약속을 기억했다.", "b": "민지는 현우에게 맡긴 은색 펜던트의 약속을 시장에서 기억했다."}, {"id": "pendant-21", "a": "민지가 은색 펜던트를 현우에게 돌려달라고 부탁했다.", "b": "민지가 은색 펜던트를 현우에게 돌려달라고 약속했다."}, {"id": "pendant-22", "a": "민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.", "b": "현우가 민지에게 은색 펜던트를 돌려주겠다고 약속했다."}, {"id": "pendant-23", "a": "민지는 현우를 믿고 은색 펜던트를 맡겼다.", "b": "민지는 현우를 믿고 은색 펜던트를 맡기며 약속을 기억했다."}, {"id": "pendant-24", "a": "민지는 현우를 믿고 은색 펜던트를 맡겼다.", "b": "현우는 민지를 믿고 은색 펜던트를 돌려주었다."}];
test('all 24 declared public cases match ordered uncached scores and decisions',async()=>{
 const f=await fresh(),results=[];
 for(const c of declaredCases){
  f.m.clearDerivedCaches();publish(f,{enabled:false});const forward=await pub(f,c.a,c.b),reverseWarm=await pub(f,c.b,c.a);f.a.getSimCache().clear();const reverseCold=await pub(f,c.b,c.a);
  assert.deepEqual(reverseWarm,reverseCold,c.id+' ordered reverse');f.a.getSimCache().clear();const disabled=await pub(f,c.a,c.b);publish(f,{enabled:true});const enabledWarm=await pub(f,c.a,c.b);f.a.getSimCache().clear();const enabledCold=await pub(f,c.a,c.b);
  assert.deepEqual(enabledWarm,enabledCold,c.id+' embedding enabled');results.push({...c,forward,reverseWarm,reverseCold,disabled,enabledWarm,enabledCold});
 }
 assert.equal(results.length,24);if(process.env.WM_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.WM_EVIDENCE_DIR,'CASES-'+profileLabel()+'.json'),JSON.stringify({results,offlineProviderCalls:f.r.state.calls.length,externalTransportAttempts:globalThis.__finalDeliveryTransportAttempts||[]},null,2)+'\n');
});

test('effective scalar identity uses Object.is and ignores weight property order',async()=>{
 const f=await fresh();f.m.CONFIG.scoringWeights.word=0;await score(f);f.m.CONFIG.scoringWeights.word=-0;let before=f.obs.details;await score(f);assert.equal(f.obs.details,before+1,'signed-zero scalar change is observed exactly');
 f.m.CONFIG.scoringWeights=Object.fromEntries(Object.entries(f.m.CONFIG.scoringWeights).reverse());before=f.obs.details;await score(f);assert.equal(f.obs.details,before,'same scalars in another property order are equivalent');
});

test('retired runtime cache hit equals its now-uncached embedding fallback',async()=>{
 const f=await fresh();publish(f,{enabled:true});const before=await score(f);f.r.context.__LIBRA_WORLD_MAKER_RUNTIME_EPOCH__+=1;
 const expected=await ref(f,...E);assert.notEqual(before,expected,'retired embedding engine now follows existing sparse fallback');assert.equal(await score(f),expected);assert.equal(f.r.state.calls.length,2,'retired runtime cannot invoke a provider');
});
