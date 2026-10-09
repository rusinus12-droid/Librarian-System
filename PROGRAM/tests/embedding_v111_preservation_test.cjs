'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const P=path.resolve(__dirname,'..');
const {createLibraVmHarness}=require(path.join(P,'tests/fixtures/libra_vm_harness.cjs'));
const {createFlashback}=require(path.join(P,'tests/fixtures/embedding_contract_harness.cjs'));
const checks=[],plain=x=>JSON.parse(JSON.stringify(x));
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
const data=(n,dim=3)=>({data:Array.from({length:n},(_,index)=>({index,embedding:[3,4,...Array(dim-2).fill(0)]}))});
async function test(id,title,fn){try{await fn();checks.push({id,title,status:'PASS'});}catch(e){checks.push({id,title,status:'FAIL',error:e.stack});}}
(async()=>{let l,f;try{
 l=await createLibraVmHarness({}, {}, {transformSource:s=>s.replace('const EmbeddingProviderRegistry = (() => {','const EmbeddingProviderRegistry = globalThis.__auditRegistry = (() => {')});f=await createFlashback(P);
 const lr=l.context.__auditRegistry,ft=f.api._test;
 const cfg={enabled:true,provider:'openai_compat',url:'https://a.invalid/v1',model:'fixture',key:'synthetic',dimensions:3,batchSize:8,maxRetries:0};
 const fc={embeddingEnabled:true,embeddingProvider:'openai_compat',embeddingUrl:'https://a.invalid/v1',embeddingModel:'fixture',embeddingDimensions:3,embeddingBatchSize:8,embeddingMaxRetries:0,fallbackHashEmbedding:false};
 await test('EID-01/09','LIBRA endpoint change and key rotation separate runtime query cache',async()=>{
  let wires=0;l.context.risuai.nativeFetch=async()=>{wires++;return response(data(1));};
  lr.clearQueryCache();const a=await lr.embedTexts(cfg,['route-cache-query'],{purpose:'query'});
  const b={...cfg,url:'https://b.invalid/v1'};await lr.embedTexts(b,['route-cache-query'],{purpose:'query'});assert.equal(wires,2);assert.notEqual(lr.profileFor(cfg).profileId,lr.profileFor(b).profileId);
  const c={...b,key:'rotated-synthetic'};await lr.embedTexts(c,['route-cache-query'],{purpose:'query'});assert.equal(wires,3);assert.equal(lr.profileFor(b).profileId,lr.profileFor(c).profileId);assert.ok(a.vectors.length);
 });
 await test('EIV-01','LIBRA actual adapter normalization keeps auto idempotent',async()=>{const a=lr.normalizeConfig({...cfg,dimensions:'auto'});assert.equal(a.dimensions,'auto');assert.equal(lr.normalizeConfig(a).dimensions,'auto');assert.equal(lr.normalizeConfig({...cfg,dimensions:0}).dimensions,'auto');});
 for(const owner of ['LIBRA','Flashback'])for(const kind of ['duplicate','numeric','dimension'])await test('EIV-02/05/07',owner+' rejects '+kind+' without retry',async()=>{
  let wires=0;const host=async()=>{wires++;return response(kind==='duplicate'?{data:[{index:0,embedding:[1,0,0]},{index:0,embedding:[0,1,0]}]}:kind==='numeric'?{data:[{index:0,embedding:[null,'1',0]}]}:data(1,4));};
  const texts=kind==='duplicate'?['one','two']:['one'];let failed=false;
  try{if(owner==='LIBRA'){l.context.risuai.nativeFetch=host;await lr.embedTexts({...cfg,model:kind},texts,{purpose:'document',bypassCache:true});}else{f.host.nativeFetch=host;await ft.createEmbeddingProviderAdapter({...fc,embeddingModel:kind}).embedTexts(texts,{purpose:'document',cacheMode:'bypass'});}}catch{failed=true;}
  assert.ok(failed);assert.equal(wires,1);
 });
 await test('EIV-03','Flashback standard route rejects cached and fresh dimensional mismatch',async()=>{
  let dim=3;f.host.nativeFetch=async(_url,init)=>response(data(JSON.parse(init.body).input.length,dim));
  const a=ft.createEmbeddingProviderAdapter({...fc,embeddingDimensions:0,embeddingModel:'cache-dim-positive'});await a.embedTexts(['cached'],{purpose:'document'});dim=4;await assert.rejects(()=>a.embedTexts(['cached','fresh'],{purpose:'document'}));
 });
 for(const owner of ['LIBRA','Flashback'])await test('EIN-01/02/03/07',owner+' preserves long tail, prefixes every split, and preserves unnormalized pooling',async()=>{
  const sent=[];const host=async(_url,init)=>{const b=JSON.parse(init.body);sent.push(...b.input);return response(data(b.input.length,256));};
  const original='x'.repeat(24000)+'TAIL_MUST_SURVIVE';let result;
  if(owner==='LIBRA'){l.context.risuai.nativeFetch=host;result=await lr.embedTexts({...cfg,provider:'lmstudio',model:'nomic-embed-text',dimensions:256,normalizeVectors:false},[original],{purpose:'document',bypassCache:true});}
  else{f.host.nativeFetch=host;result=await ft.createEmbeddingProviderAdapter({...fc,embeddingProvider:'lmstudio',embeddingModel:'nomic-embed-text',embeddingDimensions:256,embeddingNormalize:false}).embedTexts([original],{purpose:'document',cacheMode:'bypass'});}
  assert.ok(sent.length>1);assert.ok(sent.every(s=>s.startsWith('search_document:')));assert.equal(sent.map(s=>s.replace(/^search_document:\s*/, '')).join(''),original);assert.ok(Math.abs(Math.hypot(...result.vectors[0])-5)<1e-6);
 });
 for(const owner of ['LIBRA','Flashback'])await test('EIV-06',owner+' rejects nested contextual duplicate index',async()=>{
  const host=async()=>response({data:[{index:0,data:[{index:0,embedding:[1,0,0]},{index:0,embedding:[0,1,0]}]}]});
  if(owner==='LIBRA'){l.context.risuai.nativeFetch=host;await assert.rejects(()=>lr.embedTexts({...cfg,provider:'voyage_context',model:'context-fixture'},['one','two'],{purpose:'document',bypassCache:true,contextGroupKeys:['same','same']}));}
  else{f.host.nativeFetch=host;await assert.rejects(()=>ft.createEmbeddingProviderAdapter({...fc,embeddingProvider:'voyage_context',embeddingModel:'context-fixture'}).embedTexts(['one','two'],{purpose:'document',cacheMode:'bypass',contextGroupIds:['same','same']}));}
 });
 await test('EIO-01/02','LIBRA physical ledger counts retry and blocks second wire at maxRequests one',async()=>{
  let wires=0;l.context.risuai.nativeFetch=async(_url,init)=>{wires++;return wires%2?response({error:{message:'temporary'}},503):response(data(JSON.parse(init.body).input.length));};
  const c={...cfg,maxRetries:1,model:'retry-positive'};const r=await lr.embedTexts(c,['retry-positive'],{purpose:'document',bypassCache:true});assert.equal(wires,2);assert.equal(r.metadata.requestCount,2);assert.equal(r.metadata.batchCount,1);
  wires=0;await assert.rejects(()=>lr.embedTexts(c,['bound-positive'],{purpose:'document',bypassCache:true,maxRequests:1}));assert.equal(wires,1);
 });
 await test('EIV-04','Flashback query/document probe rejects dimensional disagreement',async()=>{
  let wires=0;f.host.nativeFetch=async(_url,init)=>{wires++;return response(data(JSON.parse(init.body).input.length,wires===1?3:4));};
  await assert.rejects(()=>ft.createEmbeddingProviderAdapter({...fc,embeddingProvider:'voyageai',embeddingModel:'probe-fixture',embeddingDimensions:0}).testConnection(),/dimension mismatch/i);
 });
}finally{if(l)await l.cleanup();if(f)await f.cleanup();}
console.log(JSON.stringify(checks,null,2));process.exitCode=checks.some(r=>r.status==='FAIL')?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
