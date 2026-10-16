'use strict';
// Composition contract: actual producer/storage/SQLite/handler/SDK/consumer code.
// Only host UI/model responses and HTTP delivery use existing offline fixtures.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createMemorySuiteServer,mockFetch,trace}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const serverPath=require.resolve('../server/server.cjs'),actual=require(serverPath);
require.cache[serverPath].exports={...actual,createMemorySuiteServer};
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
require.cache[serverPath].exports=actual;
const {load}=require('./gradia/host.cjs');
const createOwnerUnifiedReadProvider=require('./fixtures/libra_owner_unified_read_provider.cjs');
const {createReadBoundaryDiagnostic}=require('./fixtures/composed_read_boundary_diagnostic.cjs');
const {createNaturalManifestTrace}=require('./fixtures/composed_natural_manifest_trace.cjs');
const acorn=require('acorn'),sha=v=>crypto.createHash('sha256').update(v).digest('hex'),plain=v=>JSON.parse(JSON.stringify(v));
function captureConsumer(source){
 const ast=acorn.parse(source,{ecmaVersion:'latest'});let target;
 function walk(n){if(!n||typeof n!=='object')return;if(n.type==='ArrowFunctionExpression'&&source.slice(n.start,n.end).includes('gradia.lib-server-read-consumer.v1')&&(!target||n.end-n.start<target.end-target.start))target=n;for(const value of Object.values(n))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}walk(ast);assert.ok(target,'real consumer factory found');
 return source.slice(0,target.start)+'(globalThis.__testCreateLibReadConsumer='+source.slice(target.start,target.end)+')'+source.slice(target.end);
}
async function reader(t,fx,diagnostic,natural){
 const m=fx.getManifest(),scope={scopeKey:m.scopeKey,characterId:m.characterId,chatId:m.chatId};
 const values=new Map(),store={getItem:async k=>values.get(k)??null,setItem:async()=>{throw Error('READONLY_SDK_WRITE_FORBIDDEN')},removeItem:async()=>{throw Error('READONLY_SDK_WRITE_FORBIDDEN')}};
 values.set('__memory_suite_internal_scope_routes_v1__:libra',JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'libra',version:1,legacyGlobalModeImported:true,entries:{[scope.scopeKey]:{scopeId:scope.scopeKey,scopeKey:scope.scopeKey,mode:'server_only',origin:'user_explicit',updatedAt:1}}}));
 const readerRequests=[];
 const host={getArgument:async name=>name.includes('url')?fx.url:undefined,pluginStorage:store,getLocalPluginStorage:async()=>store,nativeFetch:async(url,init)=>{readerRequests.push({url,method:init.method,principal:init.headers?.['X-Memory-Suite-Plugin']});return natural.fetch(url,init,mockFetch);}};
 const context=vm.createContext({console,URL,Response,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,RisuAI:host,__composedReadDiagnostic:diagnostic.observe});
 vm.runInContext(diagnostic.sdkSource(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.source.js'),'utf8'))+';globalThis.factory=createMemorySuiteStorageBridge',context);
 // The LIBRA read is served by the owner unified engine now, so the fixture supplies that owner read
 // from the canonical memory the LIBRA plugin itself produced and re-read after a replacement.
 const ownerMemory=()=>({key:fx.getManifest().memories['1'].key,revision:fx.getManifest().memories['1'].revision,text:fx.getMemory().text});
 let accepted;
 const ownerRead=createOwnerUnifiedReadProvider({scope,dataInstanceId:()=>accepted?.dataInstanceId,resetEpoch:()=>accepted?.resetEpoch,
   revision:()=>ownerMemory().revision,
   items:()=>{const current=ownerMemory();return [{id:'one',key:current.key,content:current.text,revision:current.revision,turnRange:{start:1,end:5}}];}});
 const bridge=context.factory({namespace:'libra',pluginId:'serial_gradation_agents_for_rp',managementButton:false,startupDiagnostics:false,unifiedReadProvider:ownerRead});t.after(()=>bridge.dispose());
 accepted=await bridge.bootstrap();assert.equal(accepted.dataIdentityCertified,true);assert.equal(accepted.capabilities['libra-read-session.v1'],true);
 const g=await load({testGlobals:{crypto:crypto.webcrypto,__composedReadDiagnostic:diagnostic.observe},transformSource:source=>captureConsumer(diagnostic.consumerSource(source))});
 const client=bridge.createLibraReadOnlyClient(),binding={client,scope,maxCorpusBytes:4194304};
 const bound=g.plugin.bindLibReadOnlyClient(client,{scope});assert.equal(bound.liveConnectionVerified,false,'binding is not certification');
 const consumer=g.createLibReadConsumer({getBinding:()=>binding,assertNativeScope:async()=>true,digest:async v=>sha(v)});
 return {consumer,g,scope,bridge,readerRequests};
}
test('composed producer replacement reaches GRA; tag-only host edits preserve evidence and replacement retires old read',async t=>{
 const diagnostic=createReadBoundaryDiagnostic();
 const natural=createNaturalManifestTrace();
 const fx=await serverFixture({mode:'server_only',transformSource:natural.transform,host:{__naturalManifestTrace:natural.observe,__naturalAuditTimer:natural.schedule}}),f=fx.f;t.after(()=>fx.cleanup());
 const restoreNatural=natural.observeRepository(fx.app.repositories.libra);t.after(()=>{restoreNatural();console.log('COMPOSED_NATURAL_MANIFEST_TRACE '+JSON.stringify(natural.report()));});
 console.log('COMPOSED_RUNTIME_LOAD '+JSON.stringify({libraPath:process.env.LIBRA_TEST_PLUGIN||'source',libraSha256:sha(f.r.source),graPath:process.env.GRADIA_FILE||'source'}));
 await f.r.api.setSourceEditRules({version:1,ignoredTags:['decoration'],unwrapTags:[],sourceTags:[],controls:[]});
 assert.equal((await f.run()).completed,1);natural.observe('producer.returned');const vectorDrain=await f.r.api.retryPendingUnifiedVectors();natural.observe('vectorDrain.returned');
 const old=plain(fx.getManifest().memories['1']),oldRaw=fx.storedRows().find(r=>r.key===old.key).raw,oldText=fx.getMemory().text;
 const {consumer,g,readerRequests}=await reader(t,fx,diagnostic,natural);
 natural.observe('reader.ready');
 const db=fx.app.repositories.libra.database,rows=()=>db.prepare('SELECT * FROM kv ORDER BY key').all(),ops=()=>db.prepare('SELECT COUNT(*) n FROM operations').get().n;
 const before=rows(),beforeOps=ops(),start=readerRequests.length;
 const restoreMetadataObserver=diagnostic.observeRepository(fx.app.repositories.libra);let priorSession;
 try{natural.observe('firstRead.begin');priorSession=await consumer.beginRead({requestId:'before-explicit-reanalysis'});natural.observe('firstRead.ready');}
 catch(error){console.log('COMPOSED_READ_BOUNDARY_DIAGNOSTIC '+JSON.stringify(diagnostic.report(error,{libraSource:f.r.source,vectorDrain})));throw error;}
 finally{restoreMetadataObserver();}
 const evidence=await priorSession.getEvidence();assert.equal(evidence.items.length,1);assert.equal(evidence.items[0].content,oldText);assert.equal(priorSession.selection.corpusBytes,Buffer.byteLength(oldText));
 await priorSession.bindDraft('DRAFT_USING_OLD_CANONICAL');assert.equal(await priorSession.finalizeDraft(),'DRAFT_USING_OLD_CANONICAL');
 assert.deepEqual(rows(),before);assert.equal(ops(),beforeOps);assert.equal(readerRequests.slice(start).length,0,'the LIBRA owner read must not touch the server read-session endpoints any more');
 // Source edits alone must neither rerun a model nor revoke committed canonical history.
 const calls=f.control.calls.length;
 f.chat.message[1].data+='<decoration>TAG_ONLY_LOCAL_HOST_CHANGE</decoration>';
 await f.control.hooks.beforeRequest([{role:'user',content:'Continue from existing memory.'}],'model');await f.control.hooks.afterRequest('','model');
 assert.equal(f.control.calls.length,calls);assert.equal(fx.getManifest().memories['1'].key,old.key);assert.equal(fx.getManifest().memories['1'].status,'committed');
 assert.equal(await priorSession.finalizeDraft(),'DRAFT_USING_OLD_CANONICAL','tag-only host edit does not invalidate unchanged canonical evidence');
 const selection=await f.r.api.listCanonicalBatchRanges();assert.equal(selection.ranges[0].status,'saved');
 f.chat.message[0].data+=' COMPOSED_CURRENT_SOURCE_EDIT';
 f.control.artifact.facts[0].text='서재가 도서관 내부에 있다.';
 const result=await f.r.api.startSelectedCanonicalBatches({scopeKey:selection.scopeKey,mode:'source_edit',ranges:selection.ranges});assert.equal(result.ok,true,JSON.stringify(result));
 const replacement=fx.getManifest().memories['1'],newText=fx.getMemory().text;
 assert.ok(replacement.revision>old.revision);assert.notEqual(replacement.key,old.key);assert.notEqual(newText,oldText);assert.equal(fx.storedRows().find(r=>r.key===old.key).raw,oldRaw);
 assert.match(JSON.stringify(f.control.calls.at(-1)),/COMPOSED_CURRENT_SOURCE_EDIT/);assert.doesNotMatch(JSON.stringify(f.control.calls.at(-1)),/TAG_ONLY_LOCAL_HOST_CHANGE/);
 await assert.rejects(()=>priorSession.finalizeDraft(),e=>/^LIB_READ_/.test(e.code));
 const after=rows(),afterOps=ops(),readStart=readerRequests.length,newSession=await consumer.beginRead({requestId:'after-explicit-reanalysis'}),newEvidence=await newSession.getEvidence();
 assert.equal(newEvidence.items.length,1);assert.equal(newEvidence.items[0].content,newText);assert.equal(newEvidence.items[0].key,replacement.key);assert.equal(newSession.selection.corpusBytes,Buffer.byteLength(newText));
 await newSession.bindDraft('DRAFT_USING_NEW_CANONICAL');assert.equal(await newSession.finalizeDraft(),'DRAFT_USING_NEW_CANONICAL');assert.deepEqual(rows(),after);assert.equal(ops(),afterOps);assert.equal(readerRequests.slice(readStart).length,0,'the replacement read must not touch the server read-session endpoints either');
 assert.equal(g.getCalls(),0);assert.equal(fx.storedRows().some(r=>r.key.includes(':source-edit-consent:')),false);
 console.log('COMPOSED_REPLACEMENT_PROOF '+JSON.stringify({oldKey:old.key,newKey:replacement.key,oldTextSha256:sha(oldText),newTextSha256:sha(newText),oldRevision:old.revision,newRevision:replacement.revision,tagOnlyKeptCurrent:true,oldReadRejected:true,newReadValid:true,readerWrites:0}));
});
