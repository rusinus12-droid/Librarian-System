'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const {DEFINITIONS,executeOperation}=require('../server/compute/registry.cjs');
const {digestJson}=require('../server/compute/contracts.cjs');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const kernel=require('../sdk/MemorySuiteSearchKernel.source.cjs'),client=require('../sdk/MemorySuiteSearchClient.source.cjs');
const compute=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteComputeClient.source.js'),'utf8');
const plain=v=>JSON.parse(JSON.stringify(v));
const make=new Function(`${compute}\nconst createMemorySuiteSearchKernel=${kernel.toString()};\nconst MEMORY_SUITE_SEARCH_FINGERPRINT='${DEFINITIONS['flashback.memory-search.v1'].fingerprint}';\nreturn (${client.toString()});`)();
(async()=>{
 let passed=0;const previous=globalThis.risuai;
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'search-compute-expansion-'));
 assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false,computeWorkers:2});
 const address=await app.listen(),base=`http://127.0.0.1:${address.port}`,requests=[];
 const values=new Map();let mode='plugin_only',offline=false;
 globalThis.risuai={pluginStorage:{getItem:async k=>values.get(k)??null,setItem:async(k,v)=>values.set(k,v)},getArgument:async key=>key==='memory_suite_server_url'?base:'',
   nativeFetch:async(url,init={})=>{if(url.includes('/compute/execute'))requests.push(JSON.parse(init.body));if(offline)throw Error('offline');return fetch(url,init);}};
 const storage={getScopeExecutionPolicy:async()=>({computeMode:mode==='plugin_only'?'local':'prefer_server'})};
 try{
   const h=await createHayakuRuntime({autoRepair:false});
   try{
     const rows=[{id:'a',publicText:'민수는 도서관에서 수정구슬을 찾았다.'},{id:'b',publicText:'붉은 망토는 성문에 있다.'},{id:'c',publicText:'東京 library 수정구슬'}];
     const t=h.hayaku._test;
     for(const queries of [['수정구슬'],['붉은 망토'],['東京','도서관'],['없는기억'],['민수 도서관','수정구슬']]){
       const input={kind:'lexical',owner:'hayaku',corpus:{rankingPolicy:'hayaku.evidence-lexical.v1',documents:rows.map(row=>({key:[row.packetHash||row.locator?.sourceHash||'',row.axis||'',row.id||row.publicRef||'',row.publicText||''].join('\u0001'),body:row.publicText,evidenceBody:row.publicText}))},queries:[queries]};
       const expected=t.localRecallRank(rows,queries).map(r=>r.id);
       assert.deepEqual(executeOperation('hayaku.memory-search.v1',input).rankings[0].map(r=>rows[r.index].id),plain(expected));passed++;
     }
   }finally{await h.dispose();}
   for(const namespace of ['flashback','libra','hayaku']){
     const c=make({namespace,pluginId:{flashback:'flashback_memory',libra:'libra',hayaku:'hayaku_locator_continuity'}[namespace],pluginVersion:'test',storage,offload:{vectors:true,lexical:true}});
     const input=namespace==='hayaku'?{kind:'lexical',owner:namespace,corpus:{documents:[{key:'a',body:'blue gem in the library'},{key:'b',body:'red cloak at the gate'}]},queries:[['gem']]}:
       {kind:'vectors',owner:namespace,corpus:{vectors:[[1,0],[0,1],[0,0],[-1,0]]},queries:[[1,0],[0,1]]};
     const before=JSON.stringify(input),binding={scopeKey:'test-scope',revision:1};
     mode='plugin_only';const count=requests.length;
     const local=await c.execute(input,{},binding);assert.equal(requests.length,count);passed++;
     for(const selected of ['mirror','server_only']){
       mode=selected;const result=await c.execute(input,{},binding,async()=>true);
       assert.equal(typeof result.corpusId,'string',namespace+' must use actual server');
       const copy={...result};delete copy.corpusId;assert.deepEqual(copy,local);passed++;
     }
     assert(requests.at(-1).input.corpusId);assert(!requests.at(-1).input.corpus);passed++;
     app.computePlane.searchCorpora.clear();app.computePlane.searchCorpusBytes=0;
     const start=requests.length;assert((await c.execute(input,{},binding,async()=>true)).corpusId);
     assert.equal(requests.length-start,2,'one ref miss then full upload');passed++;
     offline=true;const fallback=await c.execute(input,{},binding,async()=>true);offline=false;
     assert.deepEqual(fallback,local);assert.equal(JSON.stringify(input),before);passed++;
     await c.dispose();await assert.rejects(()=>c.execute(input,{},binding),/search_client_disposed/);passed++;
   }
   // Pure math must preserve each owner's rounding order, missing dimensions and zero vectors.
   for(const owner of ['flashback','libra']){
     const input={kind:'vectors',owner,corpus:{vectors:[[.1,.2,.3],[0,0,0],[],[1]]},queries:[[.7,.8,.9]]};
     const result=executeOperation(owner+'.memory-search.v1',input);
     const a=.7*.7+.8*.8+.9*.9,b=.1*.1+.2*.2+.3*.3,dot=.7*.1+.8*.2+.9*.3;
     assert.equal(result.values[0][0],dot/(owner==='libra'?Math.sqrt(a*b):Math.sqrt(a)*Math.sqrt(b)));
     assert.deepEqual(result.values.slice(1),[[0],[0],[0]]);passed++;
   }
   const principal={namespace:'flashback',roles:['compute']},operation='flashback.memory-search.v1';
   const input={kind:'vectors',owner:'flashback',corpus:{vectors:[[1,0]]},queries:[[1,0]]};
   const body={namespace:'flashback',operation,algorithmFingerprint:DEFINITIONS[operation].fingerprint,operationId:'search-audit-unique-0001',input,inputDigest:digestJson(input),binding:{scopeKey:'a'},deadlineMs:1000};
   const first=await app.computePlane.execute(principal,body);const id=first.result.corpusId;
   assert(id);const ref={kind:'vectors',owner:'flashback',queries:[[1,0]],corpusId:id};
   assert.throws(()=>app.computePlane._normalizeSubmission(principal,{...body,operationId:'search-audit-unique-0002',input:ref,binding:{scopeKey:'b'}},'execute'),/corpus_missing/);passed++;
   assert.throws(()=>app.computePlane._normalizeSubmission(principal,{...body,inputDigest:'bad'},'execute'),/input_digest_mismatch/);passed++;
   console.log(JSON.stringify({test:'search_compute_expansion',passed,externalModelCalls:0,realHttp:true}));
 }finally{globalThis.risuai=previous;await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
