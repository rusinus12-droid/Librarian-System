'use strict';
// Basic in-memory host. Runs each actual SDK, never a live server or DATA.
// Removing real publication, strict readback, transition records, namespace binding
// or honest unqualified status must break the corresponding assertions.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),GLOBAL='__memory_suite_global__';
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(namespace='libra',initial=null,options={}) {
 const sdk=namespace==='libra'?'MemorySuiteStorageClient.libra.source.js':'MemorySuiteStorageClient.source.js';
 const key='__memory_suite_internal_scope_routes_v1__:'+namespace,values=initial||new Map(),writes=[],reads=[],args=new Map([['memory_suite_server_mode',options.initialMode||'plugin_only'],['memory_suite_server_url','http://127.0.0.1:47630']]);let transport=0;
 const scope={scopeId:'scope-a',scopeKey:'scope-a',characterId:'char-a',chatId:'chat-a'};
 if(options.globalInventory&&!values.has(key))values.set(key,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace,legacyGlobalModeImported:true,globalMigrationRemoteHistory:false,entries:{}}));
 const store={async getItem(k){reads.push(k);return values.get(k)??null;},async setItem(k,v){writes.push({key:k,value:v});if(options.rejectWrite?.(k,v))return false;values.set(k,v);return true;},async removeItem(k){values.delete(k);return true;},async keys(){return [...values.keys()];}};
 const host={getDatabase:async()=>({characters:[{chaId:'char-a',chats:[{id:'chat-a'}]}]}),pluginStorage:store,getLocalPluginStorage:async()=>options.device||store,getArgument:async n=>args.get(n)||'',setArgument:async(n,v)=>{args.set(n,v);return true;},nativeFetch:async()=>{transport++;throw Error('SIMULATED_OFFLINE_HOST');}};
 const context=vm.createContext({risuai:host,console:{log(){},warn(){},error(){},info(){}},setTimeout:()=>({unref(){}}),clearTimeout(){},queueMicrotask,AbortController,URL,TextEncoder,TextDecoder,crypto:globalThis.crypto,performance,Response,Headers});
 let source=fs.readFileSync(path.join(root,'sdk',sdk),'utf8');
 if(options.internals)source=source.replace('  const bridge = Object.freeze({','  globalThis.internal = { persistMode, maybeImportLegacyGlobalMode, hydrateScopeRegistryFromServer, persistRecoveryRequired, clearRecoveryRequired };\n  const bridge = Object.freeze({');
 vm.runInContext(source+'\nglobalThis.create=createMemorySuiteStorageBridge;',context);
 const bridge=context.create({namespace,pluginId:namespace,pluginVersion:'basic',managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>scope,...(options.globalInventory?{discoverGlobalScopes:async()=>({scopes:[scope],records:[],blockers:[],completeKnownScopes:true})}:{}),...options.bridge});
 bridge.createPluginStorageProxy?.(store);
 return {bridge,context,store,host,values,writes,reads,args,scope,key,transport:()=>transport,record:()=>JSON.parse(values.get(key)),close:()=>bridge.dispose()};
}
for(const namespace of ['libra','flashback','hayaku']) {
 test(namespace+': observation of an absent record is readonly and never supplies a default epoch',async()=>{const f=fixture(namespace);try{
  const view=await f.bridge.inspectModePublication();assert.equal(view.status,'absent');assert.equal(view.semanticModeEpoch,null);assert.equal(view.atomicOwnerQualified,false);assert.equal(f.writes.length,0);assert.equal(f.transport(),0);
 }finally{await f.close();}});
 test(namespace+': genuine scope and global setters publish durable namespace-specific diagnostics through restart',async()=>{const f=fixture(namespace,null,{globalInventory:true});try{
  await f.bridge.setScopeMode(f.scope,'plugin_only');const one=await f.bridge.inspectModePublication();
  assert.equal(one.status,'observed');assert.equal(one.publication.namespace,namespace);assert.equal(one.publication.phase,'settled');assert.equal(one.atomicOwnerQualified,false);assert.equal(one.semanticModeEpoch,null);
  await f.bridge.setGlobalMode('plugin_only');const two=await f.bridge.inspectModePublication();assert.ok(two.publication.revision>one.publication.revision);assert.notEqual(two.publication.epoch,one.publication.epoch);assert.equal((await f.bridge.getScopeMode(f.scope)).mode,'plugin_only');
  await f.bridge.clearGlobalMode();const three=await f.bridge.inspectModePublication();assert.ok(three.publication.revision>two.publication.revision);assert.equal(f.record().entries[GLOBAL].mode,'plugin_only');assert.equal(f.record().entries[f.scope.scopeId].origin,'inherited');
  const g=fixture(namespace,f.values);try {const before=g.writes.length,restart=await g.bridge.inspectModePublication();assert.equal(restart.publication.epoch,three.publication.epoch);assert.equal(restart.instanceGeneration,0);assert.equal(g.writes.length,before);}finally{await g.close();}
 }finally{await f.close();}});
}
test('compatibility parser and merge preserve unrelated top-level and row metadata',async()=>{const f=fixture();try{
 f.values.set(f.key,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',legacyGlobalModeImported:true,extra:{future:7},entries:{other:{scopeId:'other',scopeKey:'other',mode:'plugin_only',origin:'user_explicit',updatedAt:1,futureRow:{ok:true}}}}));
 await f.bridge.setScopeMode(f.scope,'plugin_only');assert.deepEqual(f.record().extra,{future:7});assert.deepEqual(f.record().entries.other.futureRow,{ok:true});assert.equal((await f.bridge.inspectModePublication()).status,'observed');
}finally{await f.close();}});
test('repeated connection argument publication changes durable diagnostics, never semantic authority',async()=>{const f=fixture();try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');const first=await f.bridge.inspectModePublication();await f.bridge.setServerUrl('http://127.0.0.1:47630');const second=await f.bridge.inspectModePublication();
 assert.ok(second.publication.revision>first.publication.revision);assert.notEqual(second.publication.epoch,first.publication.epoch);assert.equal(second.publication.reason,'server_url_settled');assert.equal(second.semanticModeEpoch,null);
}finally{await f.close();}});
test('failed migration records draining, mirror and failure without publishing an unverified destination mode',async()=>{const f=fixture();try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');await assert.rejects(()=>f.bridge.setScopeMode(f.scope,'server_only'));
 const records=f.writes.filter(r=>r.key===f.key).map(r=>JSON.parse(r.value).modePublication).filter(Boolean);
 assert.ok(records.some(r=>r.reason==='transition_draining'&&r.phase==='pending'));assert.ok(records.some(r=>r.reason==='transition_mirror'&&r.phase==='pending'));assert.equal(records.at(-1).reason,'transition_failed');
 assert.equal(f.record().entries[f.scope.scopeId].mode,'plugin_only');assert.equal((await f.bridge.inspectModePublication()).status,'unsettled');
}finally{await f.close();}});
test('invalid mirror selections do not create mode records',async()=>{const f=fixture();try{
 for(const action of [()=>f.bridge.setMode('mirror'),()=>f.bridge.setScopeMode(f.scope,'mirror'),()=>f.bridge.setGlobalMode('mirror'),()=>f.bridge.configureConnection({mode:'mirror'})])await assert.rejects(action,e=>e.code==='MEMORY_SUITE_MIRROR_TRANSITION_ONLY');
 assert.equal(f.writes.length,0);
}finally{await f.close();}});
test('route content tamper, forged qualification and foreign-owner records never become epoch authority',async()=>{const f=fixture();try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');const saved=f.record();saved.modePublication.atomicOwnerQualified=true;f.values.set(f.key,JSON.stringify(saved));assert.equal((await f.bridge.inspectModePublication()).status,'malformed');
 saved.modePublication.atomicOwnerQualified=false;saved.modePublication.namespace='hayaku';f.values.set(f.key,JSON.stringify(saved));assert.equal((await f.bridge.inspectModePublication()).status,'malformed');
 saved.modePublication.namespace='libra';saved.entries[f.scope.scopeId].mode='server_only';f.values.set(f.key,JSON.stringify(saved));assert.equal((await f.bridge.inspectModePublication()).status,'mismatch');
}finally{await f.close();}});
test('divergent real plugin and device record copies remain explicitly conflicting',async()=>{const values=new Map(),device={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);return true;}};const f=fixture('libra',null,{device});try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');const older=values.get(f.key);await f.bridge.setServerUrl('http://127.0.0.1:47630');values.set(f.key,older);
 const before=f.writes.length,view=await f.bridge.inspectModePublication();assert.equal(view.status,'conflict');assert.equal(view.semanticModeEpoch,null);assert.equal(f.writes.length,before);
}finally{await f.close();}});
test('rejected mode persistence does not claim a published readback',async()=>{let reject=false;const f=fixture('libra',null,{rejectWrite:()=>reject});try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');const prior=f.values.get(f.key);reject=true;await assert.rejects(()=>f.bridge.setServerUrl('http://127.0.0.1:47630'),/STORAGE_UNAVAILABLE|storage_unavailable/);assert.equal(f.values.get(f.key),prior);
}finally{await f.close();}});
test('legacy mode argument and recovery publication use the same real sink',async()=>{const f=fixture('libra',null,{internals:true});try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');await f.context.internal.persistMode('server_only');assert.equal((await f.bridge.inspectModePublication()).publication.reason,'legacy_mode_settled');
 await f.context.internal.persistRecoveryRequired(f.scope,Error('fixture restore failed'),null,{localOnly:true});const view=await f.bridge.inspectModePublication();assert.equal(view.status,'observed');assert.equal(f.record().entries[f.scope.scopeId].mode,'server_only');assert.equal(f.record().entries[f.scope.scopeId].recoveryRequired.required,true);
}finally{await f.close();}});
test('invalid connection URLs are rejected before any diagnostic persistence',async()=>{const f=fixture();try{
 await assert.rejects(()=>f.bridge.setServerUrl('https://example.invalid'),e=>e.code==='MEMORY_SUITE_INVALID_SERVER_URL');assert.equal(f.writes.length,0);
}finally{await f.close();}});
test('final asynchronous store identity read cannot hide an overlapping configuration change',async()=>{const f=fixture();try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');let reads=0,changed=false;
 f.host.getLocalPluginStorage=async()=>{reads++;if(reads===2&&!changed){changed=true;await f.bridge.setServerUrl('http://127.0.0.1:47630');}return f.store;};
 assert.equal((await f.bridge.inspectModePublication()).status,'changed');
}finally{await f.close();}});
test('malformed registry without a publication is not reported as a valid absent legacy record',async()=>{const f=fixture();try{
 f.values.set(f.key,JSON.stringify({schema:'invented',namespace:'libra',entries:{}}));assert.equal((await f.bridge.inspectModePublication()).status,'malformed');
}finally{await f.close();}});
test('readonly inspection bounds physically pending calls and releases slots only after completion',async()=>{const f=fixture();let release;try{
 const gate=new Promise(r=>{release=r;});f.store.getItem=async()=>{await gate;return null;};
 const pending=Array.from({length:4},()=>f.bridge.inspectModePublication());let immediate=null;const fifth=f.bridge.inspectModePublication().then(value=>{immediate=value;return value;});await new Promise(setImmediate);assert.equal(immediate?.status,'busy');release();await Promise.all([...pending,fifth]);assert.equal((await f.bridge.inspectModePublication()).status,'absent');
}finally{release?.();await f.close();}});
test('retired local-only and manager owners do not gain a writable mode epoch',async()=>{const f=fixture('lia',null,{bridge:{storagePolicy:'local_only'}}),g=fixture('retrace',null,{bridge:{storagePolicy:'manager_only'}});try{
 assert.equal((await f.bridge.inspectModePublication()).status,'unsupported_owner');await assert.rejects(()=>f.bridge.setMode('server_only'));assert.equal(f.writes.length,0);assert.equal(g.bridge.inspectModePublication,undefined);assert.equal(g.bridge.setGlobalMode,undefined);assert.equal(g.writes.length,0);
}finally{await f.close();await g.close();}});
test('legacy argument remains read-only compatibility evidence until explicit all-chat apply',async()=>{const f=fixture('libra',null,{internals:true,initialMode:'mirror'});try{
 assert.equal(await f.bridge.getMode(),'mirror');assert.equal(f.args.get('memory_suite_server_mode'),'mirror');
 const view=await f.bridge.inspectModePublication();assert.equal(view.status,'absent');assert.equal(f.writes.length,0);assert.equal(view.semanticModeEpoch,null);
}finally{await f.close();}});
test('incomplete global discovery preserves source routes and does not publish target success',async()=>{const f=fixture();try{
 const raw=JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',legacyGlobalModeImported:true,entries:{'scope-a':{scopeId:'scope-a',scopeKey:'scope-a',mode:'plugin_only',origin:'inherited',updatedAt:1}}});f.values.set(f.key,raw);
 await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE');assert.equal(f.values.get(f.key),raw);assert.equal((await f.bridge.inspectModePublication()).semanticModeEpoch,null);
}finally{await f.close();}});
test('caller proof data and a host CAS lookalike cannot elevate ordinary get/set observations',async()=>{const f=fixture();try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');f.store.compareAndSet=async()=>true;f.host.atomicOwnerQualified=true;
 await assert.rejects(()=>f.bridge.inspectModePublication({modeEpoch:2,authorityQualified:true}),e=>e.code==='MODE_PUBLICATION_REQUEST_INVALID');const view=await f.bridge.inspectModePublication();assert.equal(view.semanticModeEpoch,null);assert.equal(view.authorityQualified,false);
}finally{await f.close();}});
test('unknown future publication records are preserved and refuse downgrade on a later setter',async()=>{const f=fixture();try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');const saved=f.record();saved.modePublication.schema='memory-suite.mode-publication.v2';saved.modePublication.futureMetadata={keep:true};const raw=JSON.stringify(saved);f.values.set(f.key,raw);
 await assert.rejects(()=>f.bridge.setServerUrl('http://127.0.0.1:47630'),e=>e.code==='MODE_PUBLICATION_RECORD_UNSUPPORTED');assert.equal(f.values.get(f.key),raw);
}finally{await f.close();}});
test('diagnostic revision exhaustion refuses wrap or default reset',async()=>{const f=fixture();try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');const saved=f.record();saved.modePublication.revision=Number.MAX_SAFE_INTEGER;const raw=JSON.stringify(saved);f.values.set(f.key,raw);
 await assert.rejects(()=>f.bridge.setServerUrl('http://127.0.0.1:47630'),e=>e.code==='MODE_PUBLICATION_GENERATION_EXHAUSTED');assert.equal(f.values.get(f.key),raw);
}finally{await f.close();}});
test('partial physical persistence keeps existing mode behavior but exposes unqualified conflict',async()=>{let reject=false;const values=new Map(),device={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{if(reject)return false;values.set(k,v);return true;}};const f=fixture('libra',null,{device});try{
 await f.bridge.setScopeMode(f.scope,'plugin_only');reject=true;await f.bridge.setServerUrl('http://127.0.0.1:47630');assert.equal(f.record().entries[f.scope.scopeId].mode,'plugin_only');const view=await f.bridge.inspectModePublication();assert.equal(view.status,'conflict');assert.equal(view.semanticModeEpoch,null);
}finally{await f.close();}});
