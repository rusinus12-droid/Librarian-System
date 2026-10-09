'use strict';
const assert = require('node:assert/strict');
const {load}=require('./libra_management_storage_verified_test.cjs');
const checks=[];
const clone=x=>JSON.parse(JSON.stringify(x));
async function test(name,fn){try{await fn();checks.push({name,ok:true})}catch(e){checks.push({name,ok:false,error:e.stack});process.exitCode=1}}
async function fixture(){
 const f=await load({artifact:true,extraExports:'IntegrityMetaManager,EntityManager,MemoryState,getChatRuntimeScopeKey'});
 f.chat={id:'current',bindedPersona:'p1',message:[],localLore:[]};f.char={id:'char-1',chatPage:0,chats:[f.chat]};
 f.hostRuntime=f.runtime;f.d=f.api.LibraDataStorage;f.scope=f.d.scopeKeyFor(f.char,f.chat);f.runtime=f.api.getChatRuntimeScopeKey(f.chat,f.char);f.key=f.d.storageKeyFor(f.scope);
 f.api.MemoryState._activeScopeKey=f.runtime;
 f.row=(scope=f.runtime)=>{const entity={id:'mira',name:'Mira',background:{occupation:'Archivist'},meta:{created:1,updated:1}};if(scope!==null)f.api.IntegrityMetaManager.applyIntegrityMeta(entity,{domain:'entity',recordId:'Mira',scopeKey:scope,turn:1});return {key:'mira',comment:'lmai_entity',content:JSON.stringify(entity)}};
 f.put=(rows,envelope=f.scope)=>{const raw=JSON.stringify({version:'1.0',scopeKey:envelope,entries:rows});f.store.set(f.key,raw);return raw};
 f.hydrate=(options={})=>f.d.hydrate(f.char,f.chat,{runtimeScopeKey:f.runtime,runtimeChatId:f.chat.id,...options});
 return f;
}
(async()=>{
 await test('valid current runtime signature is byte-identical in shadow and prompt consumer',async()=>{const f=await fixture(),row=f.row(),raw=f.put([row]);const r=await f.hydrate();assert.equal(r.ok,true);assert.equal(f.d.getShadowEntries(f.scope)[0].content,row.content);f.api.EntityManager.rebuildCache([]);assert(f.api.EntityManager.formatEntityForPrompt(f.api.EntityManager.getEntityCache().get('Mira')).includes('Archivist'));assert.equal(f.store.get(f.key),raw)});
 await test('canonical signed scope maps only through actual same character/chat identity',async()=>{const f=await fixture(),row=f.row(f.scope),raw=f.put([row]);const r=await f.hydrate();assert.equal(r.ok,true);const mapped=JSON.parse(f.d.getShadowEntries(f.scope)[0].content);assert.equal(mapped.meta.integrity.scopeKey,f.runtime);assert.equal(f.api.IntegrityMetaManager.validateIntegrityMeta(mapped,{scopeKey:f.runtime}).ok,true);assert.equal(f.store.get(f.key),raw)});
 for(const fault of ['foreign','checksum','legacy_foreign','signed_unscoped'])await test(`${fault} row is excluded with diagnostic and unchanged durable bytes`,async()=>{const f=await fixture(),row=f.row(fault==='foreign'?'foreign-runtime':fault==='legacy_foreign'?null:f.runtime),record=JSON.parse(row.content);if(fault==='checksum')record.background.occupation='tampered';if(fault==='legacy_foreign')record.scopeKey='foreign-runtime';if(fault==='signed_unscoped')record.meta.integrity.scopeKey='';row.content=JSON.stringify(record);const raw=f.put([row]),r=await f.hydrate();assert.equal(r.ok,false);assert.equal(r.reason,'canonical_provenance_unverified');assert.equal(r.excludedCount,1);assert.equal(f.d.getShadowEntries(f.scope).length,0);assert.equal(f.store.get(f.key),raw);assert.equal(f.d.getHydrationDiagnostics(f.scope).readOnly,true)});
 await test('unscoped legacy record stays unsigned and unchanged in matched envelope',async()=>{const f=await fixture(),row=f.row(null),raw=f.put([row]);const r=await f.hydrate();assert.equal(r.ok,true);assert.equal(f.d.getShadowEntries(f.scope)[0].content,row.content);assert.equal(f.store.get(f.key),raw)});
 for(const fault of ['wrong_envelope','missing_envelope','runtime_identity','chat_identity'])await test(`${fault} cannot authorize hydration rebinding`,async()=>{const f=await fixture(),row=f.row(f.scope);let raw=f.put([row],fault==='wrong_envelope'?'foreign-canonical':f.scope);if(fault==='missing_envelope'){raw=JSON.stringify([row]);f.store.set(f.key,raw)}const r=await f.hydrate(fault==='runtime_identity'?{runtimeScopeKey:'foreign-runtime'}:fault==='chat_identity'?{runtimeChatId:'other-chat'}:{});assert.equal(r.ok,false);assert.equal(f.d.getShadowEntries(f.scope).length,0);assert.equal(f.store.get(f.key),raw)});
 await test('readonly provenance block prevents later generic save from deleting excluded bytes',async()=>{const f=await fixture(),raw=f.put([f.row('foreign-runtime')]);await f.hydrate();const saved=await f.d.save(f.char,f.chat,[]);assert.equal(saved.ok,false);assert.equal(saved.reason,'canonical_provenance_unverified');assert.equal(f.store.get(f.key),raw);assert.equal(f.writes.length,0)});
 await test('a later corrected canonical reread clears readonly diagnostic without rewriting input',async()=>{const f=await fixture();f.put([f.row('foreign-runtime')]);await f.hydrate();const raw=f.put([f.row()]);assert.equal((await f.hydrate()).ok,true);assert.equal(f.d.getHydrationDiagnostics(f.scope).readOnly,false);assert.equal(f.store.get(f.key),raw)});
 await test('runtime signature with contradictory payload ownership is readonly instead of re-signed',async()=>{const f=await fixture(),row=f.row(),record=JSON.parse(row.content);record.scopeKey='old-parent';record.chatId='old-chat';f.api.IntegrityMetaManager.applyIntegrityMeta(record,{domain:'entity',scopeKey:f.runtime,recordId:'Mira'});row.content=JSON.stringify(record);f.put([row]);const raw=f.store.get(f.key);assert.equal((await f.hydrate()).ok,false);assert.equal(f.d.getShadowEntries(f.scope).length,0);assert.equal(f.store.get(f.key),raw)});
 for(const invalid of [false,true])await test(`META memory original checksum is checked before mapping: tampered=${invalid}`,async()=>{
  const f=await fixture(),meta={t:1,imp:5};f.api.IntegrityMetaManager.annotateMemoryMeta(meta,'Recorded body',{scopeKey:f.scope,domain:'memory',turn:1});
  const row={key:'m1',comment:'lmai_memory',content:'[META:'+JSON.stringify(meta)+']\n'+(invalid?'tampered body':'Recorded body')};const raw=f.put([row]),r=await f.hydrate();
  assert.equal(r.ok,!invalid);assert.equal(f.store.get(f.key),raw);assert.equal(f.d.getShadowEntries(f.scope).length,invalid?0:1);
  if(!invalid){const out=f.d.getShadowEntries(f.scope)[0].content;const m=JSON.parse(out.slice(6,out.indexOf('\n')-1));assert.equal(m.integrity.scopeKey,f.runtime);assert.equal(f.api.IntegrityMetaManager.validateMemoryMeta(m,'Recorded body',{scopeKey:f.runtime}).ok,true)}
 });
 await test('adapter read failure preserves prior foreign-row guard and blocks generic overwrite',async()=>{
  const f=await fixture(),raw=f.put([f.row('foreign-runtime')]);await f.hydrate();f.control.failReads=true;
  const read=await f.hydrate();assert.equal(read.ok,false);assert.equal(read.reason,'canonical_read_unavailable');assert.equal(f.d.getHydrationDiagnostics(f.scope).readOnly,true);
  f.control.failReads=false;const saved=await f.d.save(f.char,f.chat,[]);assert.equal(saved.ok,false);assert.equal(f.store.get(f.key),raw);assert.equal(f.writes.length,0);
 });
 await test('initial unavailable canonical read never absorbs legacy host lore or reports missing',async()=>{
  const f=await fixture(),row=f.row(null);f.chat.localLore=[row];f.control.failReads=true;
  const r=await f.hydrate();assert.equal(r.ok,false);assert.equal(r.reason,'canonical_read_unavailable');assert.equal(f.writes.length,0);assert.deepEqual(f.chat.localLore,[row]);assert.equal(f.d.getHydrationDiagnostics(f.scope).readOnly,true);
 });
 await test('legacy absorption reports rejected save and retains the original host entries',async()=>{
  const f=await fixture(),row=f.row(null);f.chat.localLore=[row];f.control.mode='reject';const r=await f.hydrate();
  assert.equal(r.ok,false);assert.equal(r.reason,'legacy_absorption_unverified');assert.deepEqual(f.chat.localLore,[row]);assert.equal(f.store.has(f.key),false);assert.equal(f.d.getShadowEntries(f.scope).length,0);assert.equal(f.d.getHydrationDiagnostics(f.scope).readOnly,true);
 });
 for(const fault of ['checksum','foreign_owner','wrong_envelope','read_failure','missing_warm_source'])await test(`native inheritance refuses unverified parent ${fault} without writing a child copy`,async()=>{
  const f=await fixture(),msgs=Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',data:'parent '+i,chatId:'pm'+i,isComment:false,disabled:false}));
  const parent={id:'parent',bindedPersona:'p1',message:msgs,localLore:[]};f.chat.message=[...clone(msgs),{role:'assistant',data:'{{specialcomment::branchedfrom::parent::Parent::pm5::}}',chatId:'marker',isComment:true,disabled:true}];f.char.chats=[parent,f.chat];f.runtime=f.api.getChatRuntimeScopeKey(f.chat,f.char);f.api.MemoryState._activeScopeKey=f.runtime;
  const ps=f.d.scopeKeyFor(f.char,parent),pk=f.d.storageKeyFor(ps),row=f.row(fault==='foreign_owner'?'foreign':ps);
  if(fault==='checksum'){const entity=JSON.parse(row.content);entity.background.occupation='tampered';row.content=JSON.stringify(entity)}
  const raw=JSON.stringify({scopeKey:fault==='wrong_envelope'?'foreign':ps,entries:[row]});f.store.set(pk,raw);
  if(fault==='read_failure'){const get=f.hostRuntime.pluginStorage.getItem;f.hostRuntime.pluginStorage.getItem=async key=>{if(key===pk)throw new Error('synthetic parent read failure');return get(key)}}
  if(fault==='missing_warm_source'){await f.d.hydrate(f.char,parent,{runtimeScopeKey:f.api.getChatRuntimeScopeKey(parent,f.char),runtimeChatId:parent.id});f.store.delete(pk)}
  const r=await f.hydrate();assert.equal(r.ok,false);assert.equal(r.reason,'branch_source_unverified');assert.equal(f.d.getShadowEntries(f.scope).length,0);assert.equal(f.store.has(f.key),false);assert.equal(f.store.get(pk),fault==='missing_warm_source'?undefined:raw);assert.equal(f.d.getHydrationDiagnostics(f.scope).readOnly,true);
 });
 await test('proven native branch inheritance still rebinds source records before ordinary child hydration',async()=>{const f=await fixture();const msgs=Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',data:'parent '+i,chatId:'pm'+i,isComment:false,disabled:false}));const parent={id:'parent',bindedPersona:'p1',message:msgs,localLore:[]};f.chat.message=[...clone(msgs),{role:'assistant',data:'{{specialcomment::branchedfrom::parent::Parent::pm5::}}',chatId:'marker',isComment:true,disabled:true},{role:'user',data:'child',chatId:'cu'}];f.char.chats=[parent,f.chat];f.runtime=f.api.getChatRuntimeScopeKey(f.chat,f.char);f.api.MemoryState._activeScopeKey=f.runtime;const ps=f.d.scopeKeyFor(f.char,parent);f.store.set(f.d.storageKeyFor(ps),JSON.stringify({scopeKey:ps,entries:[f.row(f.api.getChatRuntimeScopeKey(parent,f.char))]}));const r=await f.hydrate();assert.equal(r.ok,true);assert.equal(r.source,'branch_inheritance');assert.equal(r.entryCount,1);const inheritedRaw=f.store.get(f.key);assert.equal(JSON.parse(inheritedRaw).inheritedFrom,'parent');assert.equal((await f.hydrate()).ok,true);const record=JSON.parse(f.d.getShadowEntries(f.scope)[0].content);assert.equal(f.api.IntegrityMetaManager.validateIntegrityMeta(record,{scopeKey:f.runtime}).ok,true);assert.equal(f.store.get(f.key),inheritedRaw)});
 console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,checks},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
