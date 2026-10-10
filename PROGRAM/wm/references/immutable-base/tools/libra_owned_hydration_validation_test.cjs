'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,plain}=require('./libra_owned_hydration_test_adapter.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise}};
test('construction-bound original validator rejects wrapper and accessor before any private request',async()=>{
 const r=await fixture(),original=r.api.IntegrityMetaManager.validateIntegrityMeta,predicate=r.context.__ORIGINAL_HYDRATION_VALIDATOR__;
 assert.equal(typeof predicate,'function','construction-time predicate exists');assert.equal(predicate(),original);
 r.api.IntegrityMetaManager.validateIntegrityMeta=(...args)=>original(...args);assert.equal(predicate(),null);
 let reads=0;Object.defineProperty(r.api.IntegrityMetaManager,'validateIntegrityMeta',{configurable:true,get(){reads++;return original}});assert.equal(predicate(),null);assert.equal(reads,0);
});
test('unchanged fresh reads reuse one hydration fact while public inspection retains full work',async()=>{
 const r=await fixture(),token=r.open();let reads=0;const get=r.compat.pluginStorage.getItem;r.compat.pluginStorage.getItem=async(...args)=>{if(args[0]===r.key)reads++;return get(...args)};
 r.resetCounts();for(let i=0;i<3;i++){const {observation,result}=await r.observe(token);assert.equal(result.ok,true);assert.equal(result.entries,observation.read.entries);assert.equal(reads,i+1)}
 assert.equal(r.counts.full,1);assert.equal(r.counts.facts,2);assert.equal(r.counts.checksums,1);assert.equal(r.counts.parses,1);
 const read=await r.d.readVerified(r.scope,{readonly:true});for(let i=0;i<2;i++)assert.equal(r.d.inspectHydrationEntries(read.entries,r.contextFor()).ok,true);assert.equal(r.counts.full,3);assert.equal(r.counts.checksums,3);assert.equal(r.counts.parses,3);r.h.close(token);
});
for(const variant of ['unsigned','malformed','checksum','schema','owner','payload_scope','payload_chat','native','canonical_mapping','legacy_mapping','zero_change_mapping'])test('full hydration and private result parity: '+variant,async()=>{
 const r=await fixture();let row=r.signed(),record=JSON.parse(row.content),context=r.contextFor();
 if(variant==='unsigned')delete record.meta.integrity;
 if(variant==='checksum')record.name='Changed';
 if(variant==='schema')record.meta.integrity.schema='bad';
 if(variant==='owner')record.meta.integrity.scopeKey='foreign';
 if(variant==='payload_scope'||variant==='payload_chat'){record[variant==='payload_scope'?'scopeKey':'chatId']='foreign';r.api.IntegrityMetaManager.applyIntegrityMeta(record,{scopeKey:r.runtime,domain:'entity'})}
 if(variant==='canonical_mapping')record.meta.integrity.scopeKey=r.scope;
 if(variant==='legacy_mapping')record.meta.integrity.scopeKey=r.legacy;
 if(variant==='zero_change_mapping'){record.meta.integrity.scopeKey=' '+r.runtime+' '}
 row.content=variant==='malformed'?'{bad':JSON.stringify(record);r.put([row]);const token=r.open(),observation=await r.h.read(token,r.scope);if(variant==='native')context={...context,char:null};
 const expected=r.d.inspectHydrationEntries(observation.read.entries,context),actual=r.h.inspect(token,observation,observation.read.entries,context,true);assert.deepEqual(plain(actual),plain(expected));
 if(variant.includes('mapping')){assert.equal(r.context.__HYDRATION_STATE__.state(token).proof,null);if(variant==='zero_change_mapping')assert.equal(actual.changed,0)}r.h.close(token);
});
for(const variant of ['changed','missing','corrupt','failed','guard','reset','foreign_scope','runtime','chat'])test('fresh observation and identity never reuse stale positive fact: '+variant,async()=>{
 const r=await fixture();let current=true;assert.ok(r.h);const token=r.h.open({admission:r.admission,guard:()=>current});assert.equal((await r.observe(token)).result.ok,true);r.resetCounts();
 if(variant==='changed')r.put([r.signed({name:'Other'})]);if(variant==='missing')r.store.delete(r.key);if(variant==='corrupt')r.store.set(r.key,'bad');if(variant==='failed')r.compat.pluginStorage.getItem=async()=>{throw Error('failed')};if(variant==='guard')current=false;if(variant==='reset')r.put(undefined,{resetGeneration:1});
 const observation=await r.h.read(token,r.scope);let context=r.contextFor();if(variant==='foreign_scope')context.scopeKey+='-bad';if(variant==='runtime')context.runtimeScopeKey+='-bad';if(variant==='chat')context.runtimeChatId='bad';
 const result=r.h.inspect(token,observation,observation.read?.entries||[],context,true);
 assert.equal(r.counts.facts,0);if(!['changed','missing'].includes(variant))assert.equal(result.ok,false);if(variant==='changed')assert.equal(r.counts.full,1);r.h.close(token);
});
for(const kind of ['wrapper','accessor','host','oversize_ascii','oversize_utf8'])test('optimization misses run the legacy inspector exactly once: '+kind,async()=>{
 const r=await fixture(),token=r.open();if(kind.startsWith('oversize'))r.put([{key:'lmai_memory::large',comment:'lmai_memory',content:kind==='oversize_ascii'?'a'.repeat(4194305):'한'.repeat(1500000)}]);
 const original=r.api.IntegrityMetaManager.validateIntegrityMeta;let callbacks=0;if(kind==='wrapper')r.api.IntegrityMetaManager.validateIntegrityMeta=(...args)=>{callbacks++;return original(...args)};if(kind==='accessor')Object.defineProperty(r.api.IntegrityMetaManager,'validateIntegrityMeta',{get(){callbacks++;return original}});
 r.resetCounts();for(let i=0;i<2;i++){const observation=await r.h.read(token,r.scope),result=r.h.inspect(token,observation,observation.read.entries,r.contextFor(),kind!=='host');assert.equal(result.ok,true)}
 assert.equal(r.counts.full,2);assert.equal(r.counts.facts,0);if(kind==='wrapper'||kind==='accessor')assert.equal(callbacks,2);r.h.close(token);
});
test('scope switch in private prepare reads only new scope and reset without captured proof is rejected',async()=>{
 const r=await fixture(),token=r.open(),keys=[];const get=r.compat.pluginStorage.getItem;r.compat.pluginStorage.getItem=async(...args)=>{keys.push(args[0]);return get(...args)};
 const newChat={...r.chat,bindedPersona:'changed'},newScope=r.d.scopeKeyFor(r.char,newChat);r.store.set(r.d.storageKeyFor(newScope),JSON.stringify({scopeKey:newScope,entries:[],resetGeneration:0}));
 const result=await r.h.prepare(token,r.char,newChat);assert.equal(result.ok,false);assert.deepEqual(keys,[r.d.storageKeyFor(newScope)]);r.h.close(token);
 const t=r.open();r.put(undefined,{resetGeneration:1});const reset=await r.h.prepare(t,{...r.char},{...r.chat});assert.equal(reset.ok,false);assert.equal(reset.reason,'reset_generation_changed');r.h.close(t);
});
test('busy and closed acquisition preserve the original required single read without conferring authority',async()=>{
 const r=await fixture(),token=r.open();let reads=0;const get=r.compat.pluginStorage.getItem;r.compat.pluginStorage.getItem=async(...args)=>{reads++;return get(...args)};
 const marker=r.v.sources.beginWrite(r.scope);const busy=await r.h.read(token,r.scope);assert.equal(reads,1);assert.equal(busy.status,'busy');assert.equal(r.h.inspect(token,busy,busy.read.entries,r.contextFor(),true).ok,false);r.v.sources.endWrite(marker);
 r.h.close(token);const closed=await r.h.read(token,r.scope);assert.equal(reads,2);assert.equal(closed.status,'closed');assert.equal(r.h.inspect(token,closed,closed.read.entries,r.contextFor(),true).ok,false);
});
test('delayed write and local ABA invalidate a hydrated receipt even when raw bytes return',async()=>{
 const r=await fixture(),token=r.open();await r.observe(token);const old=r.raw;const marker=r.v.sources.beginWrite(r.scope);r.v.sources.endWrite(marker);r.store.set(r.key,old);r.resetCounts();await r.observe(token);assert.equal(r.counts.full,1);assert.equal(r.counts.facts,0);
 const entered=deferred(),gate=deferred(),get=r.compat.pluginStorage.getItem;r.compat.pluginStorage.getItem=async(...args)=>{const raw=await get(...args);entered.resolve();await gate.promise;return raw};const pending=r.h.read(token,r.scope);await entered.promise;const write=r.v.sources.beginWrite(r.scope);r.v.sources.endWrite(write);gate.resolve();const observation=await pending;assert.equal(observation.status,'stale');assert.equal(r.h.inspect(token,observation,observation.read.entries,r.contextFor(),true).ok,false);r.h.close(token);
});
test('retained opaque capsules and receipts release source material on close and unload',async()=>{
 assert.equal(typeof global.gc,'function');const r=await fixture();let token,receipt;const refs=await(async()=>{token=r.open();const observed=await r.observe(token);receipt=observed.observation.receipt;const state=r.context.__HYDRATION_STATE__.state(token),refs=[new WeakRef(observed.observation.read.entries),new WeakRef(state.proof)];r.h.close(token);assert.equal(state.proof,null);assert.equal(state.guard,null);assert.equal(state.owner,null);return refs})();
 assert.deepEqual(Object.keys(token),[]);assert.deepEqual(Object.keys(receipt),[]);assert.equal(r.context.__HYDRATION_STATE__.active(),0);r.put([{key:'lmai_memory::new',comment:'lmai_memory',content:'replacement'}]);await r.d.readVerified(r.scope,{readonly:true});for(let i=0;i<12;i++){await tick();global.gc()}assert.equal(refs[0].deref(),undefined);assert.equal(refs[1].deref(),undefined);
 const active=r.open();await r.observe(active);await r.context.__HYDRATION_UNLOAD__();assert.equal(r.context.__HYDRATION_STATE__.active(),0);assert.equal(r.h.open({admission:r.admission,guard:()=>true}),null);
});
test('context traversal that replaces validator never mints a reusable proof or replays inspection',async()=>{
 const r=await fixture(),token=r.open(),original=r.api.IntegrityMetaManager.validateIntegrityMeta;let callbacks=0;const wrapped=(...args)=>{callbacks++;return original(...args)};
 const context=r.contextFor();Object.defineProperty(context,'runtimeScopeKey',{get(){r.api.IntegrityMetaManager.validateIntegrityMeta=wrapped;return r.runtime}});
 const observation=await r.h.read(token,r.scope);r.resetCounts();assert.equal(r.h.inspect(token,observation,observation.read.entries,context,true).ok,true);assert.equal(r.context.__HYDRATION_STATE__.state(token).proof,null);assert.equal(r.counts.full,1);assert.equal(callbacks,1);r.h.close(token);
});
test('frozen borrowed entries and forged/cross-request observations cannot become authority',async()=>{
 const r=await fixture(),token=r.open(),other=r.open(),observation=await r.h.read(token,r.scope);
 assert.equal(r.h.inspect(other,observation,observation.read.entries,r.contextFor(),true).ok,false);
 assert.equal(r.h.inspect(token,{...observation,receipt:{}},observation.read.entries,r.contextFor(),true).ok,false);
 const fresh=await r.h.read(token,r.scope);assert.equal(r.h.inspect(token,fresh,Object.freeze(plain(fresh.read.entries)),r.contextFor(),true).ok,false);r.h.close(token);r.h.close(other);
});
test('old two-MiB boundary and one extra byte now both reuse',async()=>{
 const r=await fixture();const row={key:'lmai_memory::cap',comment:'lmai_memory',content:''};const overhead=Buffer.byteLength(r.put([row]));row.content='a'.repeat(2097152-overhead);r.put([row]);assert.equal(Buffer.byteLength(r.raw),2097152);const token=r.open();r.resetCounts();await r.observe(token);await r.observe(token);assert.equal(r.counts.full,1);assert.equal(r.counts.facts,1);
 row.content+='a';r.put([row]);r.resetCounts();await r.observe(token);await r.observe(token);assert.equal(r.counts.full,1);assert.equal(r.counts.facts,1);r.h.close(token);
});
test('immutable fact evaluator reapplies each recorded owner, payload scope and chat comparison',async()=>{
 const r=await fixture();assert.equal(typeof r.v.evaluate,'function');const identity={ok:true,allowedScopes:new Set(['runtime','canonical']),runtime:'runtime',chatId:'chat'},base={signed:true,owner:'runtime',scopes:['runtime'],chats:['chat']};assert.equal(r.v.evaluate([base],identity),true);
 for(const [fact,context]of [[{...base,owner:'foreign'},identity],[{...base,scopes:[]},{...identity,allowedScopes:new Set(['canonical'])}],[{...base,signed:false},{...identity,allowedScopes:new Set(['canonical'])}],[{...base,scopes:['foreign']},identity],[{...base,scopes:['canonical']},identity],[{...base,chats:['other']},identity],[{...base,owner:'canonical'},identity]])assert.equal(r.v.evaluate([fact],context),false);
});
test('validator replacement during the final capsule guard cannot return a proof-backed success',async()=>{
 const r=await fixture();let trigger=false,calls=0;const original=r.api.IntegrityMetaManager.validateIntegrityMeta;const token=r.h.open({admission:r.admission,guard:()=>{if(trigger&&++calls===3)r.api.IntegrityMetaManager.validateIntegrityMeta=(...args)=>original(...args);return true}});
 await r.observe(token);const observation=await r.h.read(token,r.scope);trigger=true;r.resetCounts();const result=r.h.inspect(token,observation,observation.read.entries,r.contextFor(),true);assert.equal(result.ok,false);assert.equal(r.context.__HYDRATION_STATE__.state(token).proof,null);r.h.close(token);
});
for(const kind of ['host','validator'])test('legacy fallback still enforces capsule context admission: '+kind,async()=>{
 const r=await fixture();r.put([{key:'lmai_memory::unsigned',comment:'lmai_memory',content:'unsigned'}]);const token=r.open(),observation=await r.h.read(token,r.scope),chat={...r.chat,branchId:'different'},char={...r.char,chats:[chat]},runtime=r.context.__HYDRATION_RUNTIME_SCOPE__(chat,char),context={char,chat,scopeKey:r.scope,runtimeScopeKey:runtime,runtimeChatId:chat.id,canonicalEnvelopeVerified:true};
 if(kind==='validator'){const original=r.api.IntegrityMetaManager.validateIntegrityMeta;r.api.IntegrityMetaManager.validateIntegrityMeta=(...args)=>original(...args)}
 assert.equal(r.d.inspectHydrationEntries(observation.read.entries,context).ok,true,'legacy inspector alone cannot bind request admission');const result=r.h.inspect(token,observation,observation.read.entries,context,kind!=='host');assert.equal(result.ok,false);r.h.close(token);
});
test('context accessor closing its capsule fails currentness without replay or throwing',async()=>{
 const r=await fixture(),token=r.open(),observation=await r.h.read(token,r.scope),context=r.contextFor();let reads=0;Object.defineProperty(context,'scopeKey',{get(){reads++;r.h.close(token);return r.scope}});
 let result;assert.doesNotThrow(()=>{result=r.h.inspect(token,observation,observation.read.entries,context,true)});assert.equal(result.ok,false);assert.equal(reads,1);assert.equal(r.context.__HYDRATION_STATE__.active(),0);
});
test('inherited nested identity accessors select one legacy traversal without extra getter calls',async()=>{
 const r=await fixture();let reads=0;const proto=Object.create(null);Object.defineProperty(proto,'id',{get(){reads++;return 'nested-branch'}});r.chat.branch=Object.create(proto);r.runtime=r.context.__HYDRATION_RUNTIME_SCOPE__(r.chat,r.char);r.admission.runtimeScopeKey=r.runtime;r.put([{key:'lmai_memory::plain',comment:'lmai_memory',content:'plain'}]);const token=r.open(),observation=await r.h.read(token,r.scope);
 reads=0;const expected=r.d.inspectHydrationEntries(observation.read.entries,r.contextFor());const expectedReads=reads;reads=0;const actual=r.h.inspect(token,observation,observation.read.entries,r.contextFor(),true);assert.deepEqual(plain(actual),plain(expected));assert.equal(reads,expectedReads);assert.equal(r.context.__HYDRATION_STATE__.state(token).proof,null);r.h.close(token);
});
test('a self-closing guard cannot revive its state or skip the required legacy read',async()=>{
 const r=await fixture();let trigger=false,token;token=r.h.open({admission:r.admission,guard:()=>{if(trigger)r.h.close(token);return true}});trigger=true;let reads=0;const get=r.compat.pluginStorage.getItem;r.compat.pluginStorage.getItem=async(...args)=>{reads++;return get(...args)};const observation=await r.h.read(token,r.scope);assert.equal(observation.status,'closed');assert.equal(reads,1);assert.equal(r.h.inspect(token,observation,observation.read.entries,r.contextFor(),true).ok,false);assert.equal(r.context.__HYDRATION_STATE__.active(),0);
});

// Independent reviewer boundary regressions, retained in the candidate suite.
for(const owners of ['same','different'])test('overlapping capsule acquisition returns older stale exactly once: '+owners,async()=>{
 const r=await fixture(),first=r.open(),second=owners==='same'?first:r.open(),get=r.compat.pluginStorage.getItem,entered=deferred(),release=deferred();let reads=0;
 r.compat.pluginStorage.getItem=async(...args)=>{const raw=await get(...args);if(args[0]===r.key&&++reads===1){entered.resolve();await release.promise}return raw};
 const older=r.h.read(first,r.scope);await entered.promise;
 const newer=await r.h.read(second,r.scope);assert.equal(newer.status,'issued');
 assert.equal(r.h.inspect(second,newer,newer.read.entries,r.contextFor(),true).ok,true);
 release.resolve();const stale=await older;assert.equal(stale.status,'stale');assert.equal(stale.receipt,null);assert.equal(reads,2);
 r.resetCounts();assert.equal(r.h.inspect(first,stale,stale.read.entries,r.contextFor(),false).ok,false);assert.equal(r.counts.full,0);assert.equal(r.counts.facts,0);assert.equal(reads,2);
 r.h.close(first);r.h.close(second);
});
for(const fallback of ['host','wrapper'])test('receipt revocation rejects before legacy optimization fallback: '+fallback,async()=>{
 const r=await fixture(),token=r.open();await r.observe(token);const observation=await r.h.read(token,r.scope);const marker=r.v.sources.beginWrite(r.scope);r.v.sources.endWrite(marker);
 if(fallback==='wrapper'){const original=r.api.IntegrityMetaManager.validateIntegrityMeta;r.api.IntegrityMetaManager.validateIntegrityMeta=(...args)=>original(...args)}
 r.resetCounts();const result=r.h.inspect(token,observation,observation.read.entries,r.contextFor(),fallback!=='host');assert.equal(result.ok,false);assert.deepEqual(Array.from(result.reasons),['validation_source_stale']);assert.equal(r.counts.full,0);assert.equal(r.counts.facts,0);assert.equal(r.context.__HYDRATION_STATE__.state(token).proof,null);r.h.close(token);
});
test('late closed newer capsule still fences older successful bytes',async()=>{
 const r=await fixture(),olderToken=r.open(),newerToken=r.open(),get=r.compat.pluginStorage.getItem,entered=deferred(),release=deferred();let reads=0;
 r.compat.pluginStorage.getItem=async(...args)=>{const raw=await get(...args);if(args[0]===r.key&&++reads===1){entered.resolve();await release.promise}return raw};
 const old=r.h.read(olderToken,r.scope);await entered.promise;const latest=await r.h.read(newerToken,r.scope);assert.equal(latest.status,'issued');r.h.close(newerToken);release.resolve();const completed=await old;
 assert.equal(completed.status,'stale');assert.equal(completed.receipt,null);assert.equal(r.h.inspect(olderToken,completed,completed.read.entries,r.contextFor(),true).ok,false);assert.equal(reads,2);r.h.close(olderToken);
});
test('successful read after corruption runs full verification rather than reviving an old fact',async()=>{
 const r=await fixture(),token=r.open();await r.observe(token);const raw=r.raw;r.store.set(r.key,'bad');const failed=await r.h.read(token,r.scope);assert.equal(failed.status,'read_failed');assert.equal(r.h.inspect(token,failed,[],r.contextFor(),true).ok,false);
 r.store.set(r.key,raw);r.resetCounts();const recovered=await r.observe(token);assert.equal(recovered.result.ok,true);assert.equal(r.counts.full,1);assert.equal(r.counts.facts,0);assert.equal(r.counts.checksums,1);r.h.close(token);
});
for(const invalidation of ['guard_false','receipt_revoked'])test('cold proof issuance boundary cannot return success after observed invalidation: '+invalidation,async()=>{
 const r=await fixture();let trigger=false,calls=0;
 const token=r.h.open({admission:r.admission,guard:()=>{
  if(trigger&&++calls===4){
   if(invalidation==='guard_false')return false;
   const marker=r.v.sources.beginWrite(r.scope);r.v.sources.endWrite(marker);
  }
  return true;
 }});
 const observation=await r.h.read(token,r.scope);trigger=true;
 const result=r.h.inspect(token,observation,observation.read.entries,r.contextFor(),true);
 assert.equal(calls,4,'witness invalidates during the proof-issuance currentness check');
 assert.equal(result.ok,false,'private currentness failure must not be treated as mere proof-minting miss');
 r.h.close(token);
});
test('equal-length equal-hash different raw source bytes cannot reuse the previous fact',async()=>{
 const r=await fixture();r.put([r.signed({name:'Aa'})]);const token=r.open();await r.observe(token);const before=r.raw,after=before.replace('Aa','BB');const hash=s=>{let h=0;for(let i=0;i<s.length;i++)h=((h<<5)-h+s.charCodeAt(i))|0;return Math.abs(h).toString(36)};assert.notEqual(before,after);assert.equal(before.length,after.length);assert.equal(hash(before),hash(after));r.store.set(r.key,after);r.resetCounts();const result=await r.observe(token);assert.equal(result.result.ok,true);assert.equal(r.counts.full,1);assert.equal(r.counts.facts,0);assert.equal(r.counts.checksums,1);assert.ok(result.result.entries[0].content.includes('BB'));r.h.close(token);
});
