'use strict';
// The Compute SDK is retired from the plugins. A server-backed storage policy must give
// the same search results as plugin_only, computed locally, with no Compute request.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const plain=v=>JSON.parse(JSON.stringify(v));
const policySource=source=>source.replace("computeMode: serverBacked ? 'prefer_server' : 'local',","computeMode: globalThis.__searchTestMode || 'local',");
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-owner-paths-'));assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false,computeWorkers:2});
 const address=await app.listen(),url=`http://127.0.0.1:${address.port}`,computeCalls=[];
 const nativeFetch=async(url,init={})=>{if(String(url).includes('/v1/compute/'))computeCalls.push(String(url));return await fetch(url,init);};
 const args={memory_suite_server_url:url};let passed=0;
 try{
   for(const name of ['Flashback_Memory.js','HAYAKU_Locator_Continuity.js','LIBRA.js','LIA_Persona_Linker.js']){
     const source=fs.readFileSync(path.join(__dirname,'../plugins',name),'utf8');
     assert.doesNotMatch(source,/LIBRARIAN SYSTEM COMPUTE SDK v|createMemorySuiteComputeBridge|createMemorySuiteSearchClient/,name+' embeds no Compute SDK or search client');
   }
   passed++;
   const f=await createFixture({arguments:args,nativeFetch,source:policySource(fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8'))});
   try{
     const settings={...await f.api.loadSettings(),embeddingProvider:'openai',embeddingModel:'text-embedding-test',contextualRecall:true};
     const scope=await f.api.resolveCurrentScope();
     const rows=['a','b'].map((id,index)=>({id,sourceType:'response',scopeKey:scope.scopeKey,text:'User: query\nAssistant: '+id,provider:'openai',model:'text-embedding-test',
       embeddingProfileId:f.api._test.embeddingProfileId(settings,64,'openai','text-embedding-test'),vector:Array.from({length:64},(_,i)=>i===index?1:0)}));
     const request=()=>({records:rows,queryText:'a',queryVector:rows[0].vector,settings,context:{queryProvider:'openai',queryModel:'text-embedding-test'}});
     f.context.__searchTestMode='local';const local=await f.api._test.generateRecallCandidateArms(request());
     assert(local.dense.length>0,'fixture produces dense candidates');
     f.context.__searchTestMode='prefer_server';const served=await f.api._test.generateRecallCandidateArms(request());
     assert.deepEqual(plain(served),plain(local),'Flashback server-backed recall equals plugin-only recall');passed++;
   }finally{await f.dispose();}
   const hf=path.join(dir,'hayaku-test.js');fs.writeFileSync(hf,policySource(fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8')));
   const h=await createHayakuRuntime({autoRepair:false,arguments:args,nativeFetch,pluginSourceFile:hf});
   try{
     const t=h.hayaku._test,s=h.hayaku.settings(),p=createValidPacket({turn:1}),raw=JSON.stringify(p),store=t.emptyStore();
     t.ingestPacket(store,raw,'search-source',{messageIndex:1});t.rebuildIndex(store,{settings:s,deadlineAt:Date.now()+10000});
     await t.localRecallPrepareSources([{raw,hash:'search-source',messageIndex:1}],store,s,'search-scope',Date.now()+10000);
     const scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope),owner={scope,snapshot,worldline:t.authoritativeLedgerFromSnapshot(snapshot,scope).worldline};
     const local=await t.searchIndexCompositeRecall(store,'Alice',s,owner);
     const before=JSON.stringify(store._recallSourceRows);h.context.__searchTestMode='prefer_server';
     const served=await t.searchIndexCompositeRecall(store,'Alice',s,owner);
     assert.deepEqual(plain(served),plain(local),'HAYAKU server-backed composite recall equals plugin-only recall');
     assert.equal(JSON.stringify(store._recallSourceRows),before);passed++;
   }finally{await h.dispose();}
   const l=await createLibraVmHarness();try{assert.equal(l.api.debugRecallBm25fScoresLocal,undefined);assert.equal(l.api.getMemorySuiteComputeStatus().status,'retired');passed++;}finally{await l.cleanup();}
   assert.deepEqual(computeCalls,[],'no plugin calls a Compute route');
   console.log(JSON.stringify({test:'search_compute_owner_paths',passed,computeCalls:computeCalls.length,externalModelCalls:0}));
 }finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
