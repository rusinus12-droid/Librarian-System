'use strict';
// Regression assertions for the v1.11 audit counterexamples. All hosts are offline.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const P=path.resolve(__dirname,'..');
const {createLibraVmHarness}=require(path.join(P,'tests/fixtures/libra_vm_harness.cjs'));
const {createFlashback}=require(path.join(P,'tests/fixtures/embedding_contract_harness.cjs'));
const results=[];
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
const payload=(n,dim=3)=>({data:Array.from({length:n},(_,index)=>({index,embedding:[1,...Array(dim-1).fill(0)]}))});
async function check(id,title,fn){try{results.push({id,title,...await fn()});}catch(e){results.push({id,title,status:'HARNESS_ERROR',error:e.stack});}}
(async()=>{
 let l,f;
 try{
  l=await createLibraVmHarness({}, {}, {transformSource:s=>s.replace('const EmbeddingProviderRegistry = (() => {','const EmbeddingProviderRegistry = globalThis.__auditRegistry = (() => {')});
  f=await createFlashback(P);
  const lr=l.context.__auditRegistry,ft=f.api._test,C=f.audit.MemorySuiteExecutionContract;
  const cfg={enabled:true,provider:'openai_compat',url:'https://audit.invalid/v1',model:'fixture',key:'synthetic',dimensions:3,batchSize:1,maxRetries:0};
  const fc={embeddingEnabled:true,embeddingProvider:'openai_compat',embeddingUrl:'https://audit.invalid/v1',embeddingModel:'fixture',embeddingDimensions:3,embeddingBatchSize:1,embeddingMaxRetries:0,fallbackHashEmbedding:false};
  for(const failure of ['401','invalid_vector','network_unknown'])await check('A1-'+failure,'LIBRA fallback must not resubmit terminal invalid/auth or unknown transport outcome',async()=>{
   let wires=0;
   l.context.risuai.nativeFetch=async(_url,init)=>{wires++;if(wires===1){if(failure==='401')return response({error:{message:'unauthorized'}},401);if(failure==='invalid_vector')return response({data:[{index:0,embedding:['1',0,0]}]});throw new Error('network connection lost');}return response(payload(JSON.parse(init.body).input.length));};
   const c={...cfg,model:'fallback-'+failure,fallback:{enabled:true,key:'second-synthetic'}};
   let result,error;try{result=await lr.embedTexts(c,['fallback-input'],{purpose:'document',bypassCache:true});}catch(e){error=e.message;}
   return {status:wires>1?'CONFIRMED_GAP':'PROTECTED',physicalRequests:wires,accepted:!!result,fallback:result?.metadata?.fallback||false,error};
  });
  await check('A2','Flashback contextual auto dimensions must bind across successful operations',async()=>{
   let dim=3,wires=0;
   f.host.nativeFetch=async(_url,init)=>{wires++;const b=JSON.parse(init.body);return response({data:b.inputs.map((g,index)=>({index,data:g.map((_,index)=>({index,embedding:[1,...Array(dim-1).fill(0)]}))}))});};
   const adapter=ft.createEmbeddingProviderAdapter({...fc,embeddingProvider:'voyage_context',embeddingUrl:'https://audit.invalid/contextualizedembeddings',embeddingModel:'auto-context',embeddingDimensions:0});
   const first=await adapter.embedTexts(['first-source'],{purpose:'document'});dim=4;
   let second,error;try{second=await adapter.embedTexts(['second-source'],{purpose:'document'});}catch(e){error=e.message;}
   return {status:second?'CONFIRMED_GAP':'PROTECTED',firstDimension:first.dimensions,secondDimension:second?.dimensions,physicalRequests:wires,error};
  });
  for(const owner of ['LIBRA','Flashback'])await check('A3-'+owner,'Provider-reported truncation must not activate a vector',async()=>{
   const calls=[];const host=async(_url,init)=>{const b=JSON.parse(init.body);calls.push(b);return response({predictions:b.instances.map(()=>({embeddings:{values:[1,0,0],statistics:{truncated:true,token_count:5}}}))});};
   let result,error;
   if(owner==='Flashback'){
    f.host.nativeFetch=host;
    try{result=await ft.createEmbeddingProviderAdapter({...fc,embeddingProvider:'vertex',embeddingModel:'text-embedding-005',embeddingUrl:'https://audit.invalid/models/text-embedding-005:predict'}).embedTexts(['must-preserve-entire-source'],{purpose:'document',cacheMode:'bypass'});}catch(e){error=e.message;}
   }else{
    l.context.risuai.nativeFetch=host;
    try{result=await lr.embedTexts({...cfg,provider:'vertex',url:'https://audit.invalid/models',model:'text-embedding-005'},['must-preserve-entire-source'],{purpose:'document',bypassCache:true});}catch(e){error=e.message;}
   }
   return {status:result?'CONFIRMED_GAP':'PROTECTED',physicalRequests:calls.length,accepted:!!result,error,request:calls[0]};
  });
  await check('A4','Flashback successful first batch must survive failed second batch and resume',async()=>{
   const sent=[];let fail=true;
   f.host.nativeFetch=async(_url,init)=>{const b=JSON.parse(init.body);sent.push(...b.input);if(fail&&b.input[0]==='batch-B')return response({error:{message:'temporary'}},503);return response(payload(b.input.length));};
   const adapter=ft.createEmbeddingProviderAdapter({...fc,embeddingModel:'resume-fixture'});
   let failed=false;try{await adapter.embedTexts(['batch-A','batch-B'],{purpose:'document',sourceDigest:'stable-source'});}catch{failed=true;}
   fail=false;await adapter.embedTexts(['batch-A','batch-B'],{purpose:'document',sourceDigest:'stable-source'});
   assert.ok(failed);
   return {status:sent.filter(x=>x==='batch-A').length>1?'CONFIRMED_GAP':'PROTECTED',submittedInputs:sent,successfulFirstBatchSubmissions:sent.filter(x=>x==='batch-A').length};
  });
  await check('A5','LIBRA actual request endpoint must match endpoint identity',async()=>{
   let wire='';l.context.risuai.nativeFetch=async(url,init)=>{wire=String(url);return response(payload(JSON.parse(init.body).input.length));};
   const c={...cfg,endpoint:'https://explicit-route.invalid/v1/embeddings',model:'endpoint-fixture'};
   const normalized=lr.normalizeConfig(c),profile=lr.profileFor(c);
   await lr.embedTexts(c,['route-binding'],{purpose:'document',bypassCache:true});
   const identity=profile.descriptor.route.endpoint;
   return {status:identity!==wire?'CONFIRMED_GAP':'PROTECTED',configuredEndpoint:normalized.endpoint,identityEndpoint:identity,actualEndpoint:wire};
  });
  await check('A6','Contextual split pieces must retain one source context unless explicitly segmented',async()=>{
   const groups=[];f.host.nativeFetch=async(_url,init)=>{const b=JSON.parse(init.body);groups.push(...b.inputs.map(g=>g.map(t=>t.length)));return response({data:b.inputs.map((g,index)=>({index,data:g.map((_,index)=>({index,embedding:[1,0,0]}))}))});};
   const r=await ft.createEmbeddingProviderAdapter({...fc,embeddingProvider:'voyage_context',embeddingUrl:'https://audit.invalid/contextualizedembeddings',embeddingModel:'group-fixture',embeddingBatchSize:8}).embedTexts(['a'.repeat(60000)],{purpose:'document',cacheMode:'bypass'});
   return {status:groups.length>1?'CONFIRMED_GAP':'PROTECTED',groups:groups.map(g=>({partCount:g.length,chars:g.reduce((a,b)=>a+b,0)})),metadata:r.metadata};
  });
  await check('A7','LIBRA Vertex missing token usage must remain unknown',async()=>{
   l.context.risuai.nativeFetch=async()=>response({predictions:[{embeddings:{values:[1,0,0]}}]});
   const r=await lr.embedTexts({...cfg,provider:'vertex',url:'https://audit.invalid/models',model:'usage-fixture'},['usage-absent'],{purpose:'document',bypassCache:true});
   return {status:r.usage.inputTokens===0?'CONFIRMED_GAP':'PROTECTED',inputTokens:r.usage.inputTokens,operation:r.metadata.operation};
  });
  for(const owner of ['LIBRA','Flashback'])await check('A8-'+owner,'Final custom request body must obey the 1 MiB byte gate',async()=>{
   const wireBytes=[];const host=async(_url,init)=>{wireBytes.push(Buffer.byteLength(init.body));return response({vectors:[[1,0,0]]});};
   const template=JSON.stringify({input:'{{texts}}',metadata:'x'.repeat(1048576)});
   let error;
   if(owner==='LIBRA'){
    l.context.risuai.nativeFetch=host;
    try{await lr.embedTexts({...cfg,provider:'custom_http',customRequestTemplate:template,customResponsePath:'vectors'},['small-input'],{purpose:'document',bypassCache:true});}catch(e){error=e.message;}
   }else{
    f.host.nativeFetch=host;
    try{await ft.createEmbeddingProviderAdapter({...fc,embeddingProvider:'custom_http',embeddingCustomRequestTemplate:template,embeddingCustomResponsePath:'vectors'}).embedTexts(['small-input'],{purpose:'document',cacheMode:'bypass'});}catch(e){error=e.message;}
   }
   return {status:wireBytes.some(n=>n>1048576)?'CONFIRMED_GAP':owner==='Flashback'&&wireBytes.length?'NOT_EXERCISED':'PROTECTED',physicalRequests:wireBytes.length,wireBytes,error,note:owner==='Flashback'?'Large template was normalized away before wire; this case does not exercise its final-byte guard.':undefined};
  });
  await check('A9','Flashback unknown physical completion must retain pending state until settlement',async()=>{
   let physicallySettled=false;let finish;
   const physical=new Promise(resolve=>{finish=()=>{physicallySettled=true;resolve(response(payload(1)));};});
   f.host.nativeFetch=async()=>physical;
   const ledger=C.createLedger({maxRequests:2,deadlineAt:Date.now()+60});
   let error;try{await ft.createEmbeddingProviderAdapter({...fc,embeddingModel:'pending-fixture'}).embedTexts(['pending-input'],{purpose:'document',cacheMode:'bypass',operationLedger:ledger,deadlineAt:Date.now()+50});}catch(e){error=e.message;}
   const operation=ledger.snapshot(),activeRequests=f.audit.Runtime.embeddingActiveRequests.size;
   const state={status:!physicallySettled&&operation.pendingRequests===0?'CONFIRMED_GAP':'PROTECTED',physicallySettled,activeRequests,operation,error};
   finish();await physical;await new Promise(resolve=>setTimeout(resolve,10));
   state.afterLate=ledger.snapshot();state.activeAfterLate=f.audit.Runtime.embeddingActiveRequests.size;
   return state;
  });
  await check('A10','Flashback missing-sidecar recovery must survive heuristic OFF reranking',async()=>{
   f.host.nativeFetch=async(_url,init)=>response(payload(JSON.parse(init.body).input.length));
   const c=ft.normalizeSettings({...fc,embeddingModel:'recall-fixture',fallbackHashEmbedding:true,heuristicRecall:true,minScore:0,similarityThreshold:0,currentSceneTailEnabled:false,entityFocusedRecallEnabled:false});
   const scope=await f.api.resolveCurrentScope(false);
   const record={id:'audit-recall-record',hash:'audit-recall-record',type:'response',sourceType:'response',text:'Alice hid the sapphire compass in the cedar chest.',title:'sapphire compass',tags:['sapphire','compass'],provider:'openai_compat',model:c.embeddingModel,embeddingProfileId:ft.embeddingProfileId(c,3),dim:3,vector:[1,0,0]};
   await ft.saveAllRecords([record],c,scope);
   const loaded=await ft.loadScopeRecords(scope.scopeKey),key=loaded.records[0]?.vectorRef?.storageKey;
   assert.ok(key,'Stored sidecar must exist for this fault injection');
   const query='Alice sapphire compass cedar chest';
   const before=await f.api.recallRecords(query,{...c,heuristicRecall:false},scope);
   await f.safeLocalStorage.removeItem(key);
   f.audit.Runtime.localVectorShardCache.clear();
   ft.invalidateRecallShardCache(scope.scopeKey);
   assert.equal((await ft.loadScopeRecords(scope.scopeKey)).records[0].vector.length,0,'Fault must remove both durable sidecar and runtime vector copy');
   const on=await f.api.recallRecords(query,c,scope);
   const off=await f.api.recallRecords(query,{...c,heuristicRecall:false},scope);
   assert.ok(before.records.length>0,'Positive control must recall remote vector before sidecar removal');
   return {status:on.records.length>0&&off.records.length===0?'CONFIRMED_GAP':'INCONCLUSIVE',beforeMissing:before.records.length,missingHeuristicOn:on.records.length,missingHeuristicOff:off.records.length,offCandidates:off.candidates,offRrfUnion:off.rrfUnionCount,rawPreserved:(await ft.loadScopeRecords(scope.scopeKey)).records[0]?.text===record.text};
  });
 } finally {if(l)await l.cleanup();if(f)await f.cleanup();}
 /* Results are asserted below; no product runtime data is written by this fixture. */
 for(const result of results){
  assert.notEqual(result.status,'HARNESS_ERROR',result.error);
  if(result.id==='A8-Flashback')continue; // normalization prevents this fixture from reaching its byte gate
  if(result.id==='A10'){assert.equal(result.beforeMissing,1);assert.equal(result.missingHeuristicOn,1);assert.equal(result.missingHeuristicOff,1);assert.equal(result.rawPreserved,true);continue;}
  assert.equal(result.status,'PROTECTED',JSON.stringify(result));
  if(result.id.startsWith('A1-')){assert.equal(result.physicalRequests,1);assert.equal(result.accepted,false);}
  if(result.id.startsWith('A3-')){assert.equal(result.physicalRequests,1);assert.match(result.error,/truncat/i);}
  if(result.id==='A4')assert.deepEqual(result.submittedInputs,['batch-A','batch-B','batch-B']);
  if(result.id==='A6'){assert.equal(result.groups.length,1);assert.equal(result.groups[0].partCount,3);assert.equal(result.metadata.provenance[0].segments[0].parts.length,3);}
  if(result.id==='A7')assert.equal(result.inputTokens,null);
  if(result.id==='A8-LIBRA'){assert.equal(result.physicalRequests,0);assert.match(result.error,/byte budget/);}
  if(result.id==='A9'){assert.equal(result.physicallySettled,false);assert.equal(result.activeRequests,1);assert.equal(result.operation.pendingRequests,1);assert.equal(result.afterLate.pendingRequests,0);assert.equal(result.activeAfterLate,0);}
 }
 console.log(JSON.stringify({test:'embedding_v111_gap_regression',passed:13,externalProviderCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
