'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const plain=v=>JSON.parse(JSON.stringify(v));
// Search offload is off by default (measured slower on the loopback server); the remote
// path stays covered by forcing it through __searchTestOffload.
const policySource=source=>source.replace("computeMode: serverBacked ? 'prefer_server' : 'local',","computeMode: globalThis.__searchTestMode || 'local',")
 .replace("const offloads=kind=>offload[kind]===true;","const offloads=kind=>(globalThis.__searchTestOffload||offload)[kind]===true;");
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-owner-paths-'));assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false,computeWorkers:2});
 const address=await app.listen(),url=`http://127.0.0.1:${address.port}`,calls=[];let afterCompute=null;
 const nativeFetch=async(url,init={})=>{if(url.includes('/compute/execute'))calls.push(JSON.parse(init.body));const result=await fetch(url,init);if(url.includes('/compute/execute')&&afterCompute)afterCompute();return result;};
 const args={memory_suite_server_url:url};let passed=0;
 try{
   const f=await createFixture({arguments:args,nativeFetch,source:policySource(fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8'))});
   try{
     const settings={...await f.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-64',hashDimensions:64};
     const scope=await f.api.resolveCurrentScope();
     const rows=['a','b'].map((id,index)=>({id,sourceType:'response',scopeKey:scope.scopeKey,text:'User: query\nAssistant: '+id,provider:'hash',model:'hash-64',vector:Array.from({length:64},(_,i)=>i===index?1:0)}));
     const query=rows[0].vector;
     const request=()=>({records:rows,queryText:'a',queryVector:query,settings,context:{queryProvider:'hash',queryModel:'hash-64'}});
     const before=JSON.stringify(rows),local=await f.api._test.generateRecallCandidateArms(request());
     f.context.__searchTestMode='prefer_server';
     const remote=await f.api._test.generateRecallCandidateArms(request());
     assert.deepEqual(plain(remote),plain(local));assert.equal(JSON.stringify(rows),before);
     // Hash vectors were retired from ordinary recall in the model-centric
     // recovery. They must not enter dense search or remote vector compute.
     assert.equal(local.dense.length,0);assert.equal(remote.dense.length,0);
     assert.equal(calls.length,0);passed++;
     // Non-hash embeddings use the same production candidate path, without provider generation.
     const nonHash={...settings,embeddingProvider:'openai',embeddingModel:'text-embedding-test',contextualRecall:true};
     const realRows=rows.map(r=>({...r,provider:'openai',model:'text-embedding-test',embeddingProfileId:f.api._test.embeddingProfileId(nonHash,64,'openai','text-embedding-test')}));
     f.context.__searchTestMode='local';const a=await f.api._test.generateRecallCandidateArms({records:realRows,queryText:'a',queryVector:query,settings:nonHash,context:{queryProvider:'openai',queryModel:'text-embedding-test'}});
     f.context.__searchTestMode='prefer_server';const unforced=calls.length;
     assert.deepEqual(plain(await f.api._test.generateRecallCandidateArms({records:realRows,queryText:'a',queryVector:query,settings:nonHash,context:{queryProvider:'openai',queryModel:'text-embedding-test'}})),plain(a));
     assert.equal(calls.length,unforced,'vectors stay local by default in prefer_server');passed++;
     f.context.__searchTestOffload={vectors:true,lexical:true};const count=calls.length;
     const b=await f.api._test.generateRecallCandidateArms({records:realRows,queryText:'a',queryVector:query,settings:nonHash,context:{queryProvider:'openai',queryModel:'text-embedding-test'}});
     assert(a.dense.length>0,"nonhash fixture must produce dense candidates");assert.deepEqual(plain(b),plain(a));assert(calls.length>count);passed++;
     afterCompute=()=>{f.currentChat.message=[{role:'user',data:'changed while searching',chatId:'changed'}];f.currentChat.messages=f.currentChat.message;afterCompute=null;};
     await assert.rejects(()=>f.api._test.generateRecallCandidateArms({records:realRows,queryText:'a',queryVector:query,settings:nonHash,context:{queryProvider:'openai',queryModel:'text-embedding-test'}}),/FLASHBACK_SEARCH_BINDING_STALE/);passed++;
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
     const unforced=calls.length;assert.deepEqual(plain(await t.searchIndexCompositeRecall(store,'Alice',s,owner)),plain(local));
     assert.equal(calls.length,unforced,'lexical stays local by default in prefer_server');passed++;
     h.context.__searchTestOffload={vectors:true,lexical:true};
     const remote=await t.searchIndexCompositeRecall(store,'Alice',s,owner);
     assert.deepEqual(plain(remote),plain(local));assert.equal(JSON.stringify(store._recallSourceRows),before);
     assert(calls.some(c=>c.operation==='hayaku.memory-search.v1'));passed++;
     afterCompute=()=>{h.setMessages([{role:'user',data:'changed while searching',chatId:'changed'}]);afterCompute=null;};
     await assert.rejects(()=>t.searchIndexCompositeRecall(store,'Alice',s,owner),/HAYAKU_SEARCH_BINDING_STALE/);passed++;
   }finally{await h.dispose();}
   // LIBRA no longer offers the old array-scoring compute bridge; the
   // native common-engine/provider path is covered by its replacement suite.
   const l=await createLibraVmHarness();try{assert.equal(l.api.debugRecallBm25fScoresLocal,undefined);assert.equal(l.api.debugRecallBm25fScoresWithCurrentOwner,undefined);assert.equal(l.api.getMemorySuiteComputeStatus().status,'retired');passed++;}finally{await l.cleanup();}
   console.log(JSON.stringify({test:'search_compute_owner_paths',passed,actualHttpOperations:calls.map(c=>c.operation),controlledBoundary:'storage policy only; production search functions and compute transport',externalModelCalls:0}));
 }finally{await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
