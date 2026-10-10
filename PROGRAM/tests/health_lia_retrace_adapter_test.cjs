'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const root=path.join(__dirname,'..');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(owner){
 const scope={scopeId:'c:chat',scopeKey:'c:chat',characterId:'character',chatId:'chat'};
 const ctx={character:{id:'character'},chat:{id:'chat',bindedPersona:owner==='LIA'?'lia-live-persona::x':'persona',message:[{data:'private transcript'}]},profile:{selectedPersona:'persona',personas:[{id:'persona',personaPrompt:'private profile'}]}};
 const shard={scopeKey:scope.scopeKey,livePersonaId:'lia-live-persona::x',ledgers:[],liveState:[]};
 const raw=JSON.stringify(shard),index={schema:'lia.live_persona_index.v2',entries:{[scope.scopeKey]:{storageKey:'shard',digest:hash(raw),livePersonaId:shard.livePersonaId}}};
 const state={authority:1,mode:'plugin_only',busy:false,alive:true,cacheComplete:true,writes:0,clears:0,reads:[],data:new Map(owner==='LIA'?[['index',JSON.stringify(index)],['shard',raw],['legacy',null]]:[['cold',null],['run',null]])};
 const cache={bindings:{[scope.scopeKey]:structuredClone(shard),other:{scopeKey:'other',data:'keep'}}};
 const derived={lastPreview:{identity:{characterId:'character',chatId:'chat'},snapshot:'derived'},compatibilitySuite:{derived:true},compatibilityCheckedAt:1,compatibilityAcknowledgedAt:1};
 const storage={captureReadOnlyAuthorityFence(){const n=state.authority;return{assertCurrent(){if(n!==state.authority)throw Error('AUTHORITY_CHANGED');}}},async inspectLocalHealthSnapshot(s,key,options){assert.equal(options.strictPhysical,true);assert.equal(s.scopeId,scope.scopeId);state.reads.push(key);return{raw:state.data.get(key)??null,mode:state.mode,binding:JSON.stringify([scope.scopeId,state.mode,state.authority])}},setItem(){state.writes++;throw Error('FORBIDDEN_WRITE')}};
 const c=vm.createContext({Promise,Map,Object,Set,WeakSet});
 vm.runInContext(fs.readFileSync(path.join(root,'sdk/MemorySuiteHealthRecovery.source.js'),'utf8'),c);
 const file=path.join(root,'sdk',owner==='LIA'?'MemorySuiteLiaHealth.source.js':'MemorySuiteRetraceHealth.source.js');
 assert.equal(fs.existsSync(file),true,owner+' owner adapter source must exist');
 vm.runInContext(fs.readFileSync(file,'utf8')+'\nglobalThis.create='+ (owner==='LIA'?'createMemorySuiteLiaHealthAdapter':'createMemorySuiteRetraceHealthAdapter')+';',c);
 const adapter=c.create({storage,readContext:async consume=>typeof consume==='function'?consume(structuredClone(ctx)):structuredClone(ctx),scopeFor:()=>scope,
   indexKey:'index',indexSchema:index.schema,keyFor:()=> 'shard',legacyKey:'legacy',hash,
   keysFor:()=>[{key:'cold',schema:'cold.v1'},{key:'run',schema:'run.v1'}],
   validateJournal:chat=>({available:!chat.memorySessionBridge||chat.memorySessionBridge.valid===true,reason:chat.memorySessionBridge?'valid':'handoff_journal_absent'}),
   cache:owner==='LIA'?{getStore:()=>cache,getComplete:()=>state.cacheComplete,setComplete:value=>{state.cacheComplete=value}}:derived,
   isBusy:()=>state.busy,isAlive:()=>state.alive});
 return{adapter,state,scope,ctx,cache,derived,index,shard};
}
for(const owner of ['LIA','RETRACE']){
 test(owner+': actual adapter reads metadata without touching canonical stores or host source',async()=>{const f=fixture(owner),before=JSON.stringify([f.ctx,[...f.state.data],f.cache,f.derived]);const r=await f.adapter.inspect(),t=await f.adapter.preview();assert.equal(r.owner,owner);assert.equal(r.known,true);assert.equal(r.complete,false);assert.equal(t.allowed,true);assert.equal(f.state.clears,0);assert.equal(f.state.writes,0);assert.equal(JSON.stringify([f.ctx,[...f.state.data],f.cache,f.derived]),before);assert.doesNotMatch(JSON.stringify([r,t]),/private transcript|private profile|ledgers/)});
 test(owner+': explicit cache clear preserves all canonical bytes and unrelated scope',async()=>{const f=fixture(owner),before=JSON.stringify([f.ctx,[...f.state.data]]),t=await f.adapter.preview();assert.equal((await f.adapter.repair(t)).status,'cache_invalidated');assert.equal(JSON.stringify([f.ctx,[...f.state.data]]),before);assert.equal(f.cache.bindings.other.data,'keep');assert.equal(f.adapter.isBusy(),false);assert.equal(f.state.writes,0)});
 test(owner+': failed reads, nonlocal mode and malformed metadata remain unknown',async()=>{for(const kind of ['mode','malformed']){const f=fixture(owner);if(kind==='mode')f.state.mode='server_only';else f.state.data.set(owner==='LIA'?'index':'cold','{invalid json');assert.equal((await f.adapter.inspect()).known,false);assert.equal((await f.adapter.preview()).allowed,false);assert.equal(f.state.clears,0)}});
 test(owner+': profile/source/persona/context changes invalidate private permit',async()=>{for(const change of [f=>f.ctx.profile.selectedPersona='different',f=>f.ctx.chat.message[0].data='edit',f=>f.ctx.chat.bindedPersona='other',f=>f.ctx.character.id='other']){const f=fixture(owner),t=await f.adapter.preview();change(f);assert.equal((await f.adapter.repair(t)).status,'blocked');assert.equal(f.state.clears,0)}});
}
test('LIA: unindexed, mismatched or legacy binding is not treated as validated current metadata',async()=>{for(const change of [f=>f.state.data.set('legacy','{"bindings":{"s":{}}}'),f=>f.state.data.set('shard',JSON.stringify({...f.shard,livePersonaId:'other'})),f=>{f.index.entries[f.scope.scopeKey].digest='wrong';f.state.data.set('index',JSON.stringify(f.index));},f=>f.state.data.delete('index')]){const f=fixture('LIA');change(f);assert.equal((await f.adapter.preview()).allowed,false);assert.equal(f.state.clears,0)}});
test('RETRACE: scope/schema mismatch or corrupt journal cannot produce a clear permit',async()=>{for(const change of [f=>f.state.data.set('cold',JSON.stringify({schema:'cold.v1',scopeKey:'other'})),f=>f.state.data.set('run',JSON.stringify({schema:'wrong',scopeKey:f.scope.scopeKey})),f=>f.ctx.chat.memorySessionBridge={valid:false}]){const f=fixture('RETRACE');change(f);assert.equal((await f.adapter.preview()).allowed,false);assert.equal(f.state.clears,0)}});
