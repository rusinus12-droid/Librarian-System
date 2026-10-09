'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {createMemorySuiteServer,mockFetch,trace}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {load}=require('./gradia/host.cjs');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
test('actual SQLite -> readonly server -> existing SDK -> GRA immutable session; replacement retires old draft',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gradia-cross-project-')),app=createMemorySuiteServer({dataDir:dir,port:0,autoBackup:false,computeEnabled:false,token:'offline-only'});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const address=await app.listen(),url=`http://127.0.0.1:${address.port}`,pluginId='serial_gradation_agents_for_rp';
 const scope={scopeKey:'e2e',characterId:'c',chatId:'h'},key='libra:v1:scope:e2e:memory:1:r1',manifestKey='libra:v1:scope:e2e:manifest';
 function put(k,value,revision=1){const json=JSON.stringify(JSON.stringify(value));app.repositories.libra.database.prepare('INSERT OR REPLACE INTO kv(space,key,value_json,deleted,revision,digest,updated_at)VALUES(?,?,?,?,?,?,?)').run('plugin',k,json,0,revision,sha(json),1);}
 const ref={status:'committed',key,memoryId:'one',revision:1,sourceDigest:'source-one',turnRange:{start:1,end:5},sessionEpoch:0};
 const text='ACTUAL_DATABASE_TEXT '.repeat(900);
 put(manifestKey,{schema:'libra.manifest.v1',...scope,branchGuard:{schema:'libra.branch_guard.v1',status:'ready'},memories:{1:ref},inheritedMemories:[]});
 put(key,{schema:'libra.canonical_memory.v1',status:'committed',scopeKey:scope.scopeKey,memoryId:'one',revision:1,sourceDigest:'source-one',turnRange:ref.turnRange,text});
 const values=new Map(),store={getItem:async k=>values.get(k)??null,setItem:async()=>{throw Error('SDK_WRITE_FORBIDDEN')},removeItem:async()=>{throw Error('SDK_WRITE_FORBIDDEN')}};
 const registry={schema:'memory-suite.scope-routing.v1',namespace:'libra',version:1,legacyGlobalModeImported:true,entries:{e2e:{scopeId:'e2e',scopeKey:'e2e',mode:'server_only',origin:'user_explicit',updatedAt:1}}};
 values.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify(registry));
 const host={getArgument:async name=>name.includes('url')?url:undefined,pluginStorage:store,getLocalPluginStorage:async()=>store,nativeFetch:mockFetch};
 const context=vm.createContext({console,URL,Response,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,RisuAI:host});
 let source=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8');

 vm.runInContext(source+';globalThis.factory=createMemorySuiteStorageBridge',context);
 const bridge=context.factory({namespace:'libra',pluginId,managementButton:false,startupDiagnostics:false});t.after(()=>bridge.dispose());
 // Explicit test setup uses the existing public connection flow once. The
 // adapter itself only receives that already accepted connection afterward.
 const accepted=await bridge.bootstrap();assert.equal(accepted.dataIdentityCertified,true);assert.equal(accepted.capabilities['libra-read-session.v1'],true);
 const g=await load({testGlobals:{crypto:crypto.webcrypto},transformSource:s=>s.replace('  const publicApi = Object.freeze({','  globalThis.__testCreateLibReadConsumer = createLibServerReadConsumer;\n  const publicApi = Object.freeze({')});
 const client=bridge.createLibraReadOnlyClient(),binding={client,scope,maxCorpusBytes:4194304};
 const consumer=g.createLibReadConsumer({getBinding:()=>binding,assertNativeScope:async()=>true,digest:async v=>sha(v)});
 const before=app.repositories.libra.database.prepare('SELECT * FROM kv ORDER BY key').all();const start=trace.length;
 const session=await consumer.beginRead({requestId:'e2e'});assert.equal((await session.getEvidence()).items[0].content,text);assert.equal(session.selection.corpusBytes,Buffer.byteLength(text));await session.bindDraft('DRAFT_FROM_CURRENT_TEXT');assert.equal(await session.finalizeDraft(),'DRAFT_FROM_CURRENT_TEXT');
 assert.deepEqual(app.repositories.libra.database.prepare('SELECT * FROM kv ORDER BY key').all(),before);assert.equal(app.repositories.libra.database.prepare('SELECT COUNT(*) n FROM operations').get().n,0);
 assert.ok(trace.slice(start).every(r=>r.url.endsWith('/capture')||r.url.endsWith('/current')));assert.equal(trace.slice(start).filter(r=>r.url.endsWith('/capture')).length,1);
 put(key,{schema:'libra.canonical_memory.v1',status:'committed',scopeKey:scope.scopeKey,memoryId:'one',revision:1,sourceDigest:'source-one',turnRange:ref.turnRange,text:'explicit replacement'},2);
 await assert.rejects(()=>session.finalizeDraft(),e=>/^LIB_READ_/.test(e.code));assert.equal(g.getCalls(),0);
});
