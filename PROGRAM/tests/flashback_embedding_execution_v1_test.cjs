'use strict';
// Actual Flashback adapter and recall helpers, with a controlled offline host.
const assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
(async()=>{
 const f=await createFlashback(path.resolve(__dirname,'..'));let count=0;const checks=[];
 const pass=name=>{count++;checks.push(name);console.log('PASS '+name);};
 try{
  const t=f.api._test,C=f.audit.MemorySuiteExecutionContract;
  const cfg=t.normalizeSettings({embeddingEnabled:true,embeddingProvider:'openai_compat',embeddingModel:'fixture-model',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:3,embeddingMaxRetries:0,embeddingNormalize:false,fallbackHashEmbedding:true,embeddingBatchSize:8});
  const expanded=t.normalizeSettings({...cfg,embeddingUrl:'https://fixture.invalid/v1/embeddings'});
  assert.equal(t.embeddingEndpointIdentity(cfg),t.embeddingEndpointIdentity(expanded));
  assert.equal(f.audit.embeddingProfileSettingsFingerprint(cfg),f.audit.embeddingProfileSettingsFingerprint(expanded));
  assert.notEqual(t.embeddingEndpointIdentity({...cfg,embeddingUrl:'https://fixture.invalid/v1?deployment=A'}),t.embeddingEndpointIdentity({...cfg,embeddingUrl:'https://fixture.invalid/v1?deployment=B'}));
  pass('resolved base/full endpoint identity; meaningful route query remains distinct');
  let wires=0;
  f.host.nativeFetch=async()=>{wires++;return new Response(JSON.stringify({output:{embeddings:[{text_index:1,embedding:[0,4,0]},{text_index:0,embedding:[3,0,0]}]}}),{status:200});};
  const dash=t.normalizeSettings({...cfg,embeddingProvider:'dashscope',embeddingModel:'fixture-model'});
  const result=await t.createEmbeddingProviderAdapter(dash).embedTexts(['alpha','beta'],{purpose:'document',cacheMode:'bypass'});
  assert.deepEqual(plain(result.vectors),[[3,0,0],[0,4,0]]);assert.equal(wires,1);
  pass('actual DashScope adapter preserves exact indexed order without forced normalization');
  f.host.nativeFetch=async()=>new Response(JSON.stringify({output:{embeddings:[{text_index:0,embedding:[1,0,0]},{text_index:0,embedding:[0,1,0]}]}}),{status:200});
  await assert.rejects(()=>t.createEmbeddingProviderAdapter(dash).embedTexts(['duplicate-a','duplicate-b'],{purpose:'document',cacheMode:'bypass'}));
  pass('actual DashScope duplicate index rejected');
  for(const kind of ['invalid-numeric','authentication']){
   wires=0;f.host.nativeFetch=async()=>{wires++;return kind==='authentication'?new Response('{"error":{"message":"unauthorized"}}',{status:401}):new Response('{"data":[{"index":0,"embedding":["1",0,0]}]}',{status:200});};
   await assert.rejects(()=>t.embedTexts(['guard-'+kind],cfg,{purpose:'query',allowHashFallback:true,cacheMode:'bypass'}));assert.equal(wires,1);
   pass('owner '+kind+' rejection cannot silently become a hash result');
  }
  wires=0;f.host.nativeFetch=async(_url,init)=>{wires++;const body=JSON.parse(init.body);return new Response(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});};
  const ledger=C.createLedger({maxRequests:1});
  await assert.rejects(()=>t.createEmbeddingProviderAdapter(cfg).testConnection({operationLedger:ledger}));assert.equal(wires,1);
  pass('query/document connection probe shares a one-wire physical request budget');
  // Recovery F01 intentionally retires the old runtime hash-overlay contract.
  // Source/ref preservation remains required, but only a configured model vector
  // may authorize candidates; dimension matches alone do not repair a raw row.
  const raw={id:'recover-one',sourceType:'response',origin:'live_chat',text:'alpha beta 회복 원문',sourceHash:'source-revision-one',provider:'openai_compat',model:'fixture-model',vector:[],vectorRef:{storageKey:'missing-payload',offset:0,length:3,dim:3}};
  const before=JSON.stringify(raw),scope={scopeKey:'scope-a',queryProvider:cfg.embeddingProvider,queryModel:cfg.embeddingModel,queryProfileId:t.embeddingProfileId(cfg,3)};
  const arms=await t.generateRecallCandidateArms({records:[raw],queryText:'alpha beta',queryVector:[1,0,0],settings:cfg,context:scope});
  assert(Object.values(arms).every(rows=>rows.length===0));assert.equal(JSON.stringify(raw),before);
  pass('missing dense sidecar remains raw and cannot produce alternate candidates');
  const restored={...raw,vector:[1,0,0],embeddingProfileId:t.embeddingProfileId(cfg,3)};
  const ready=await t.generateRecallCandidateArms({records:[restored],queryText:'alpha beta',queryVector:[1,0,0],settings:cfg,context:scope});
  assert.equal(ready.dense.length,1);assert.equal(ready.hashRecovery.length,0);
  pass('compatible model replacement supplies dense candidates without an overlay');
  const many=Array.from({length:300},(_,i)=>({...raw,id:'bounded-'+i}));
  const tail=await t.generateRecallCandidateArms({records:[...many,restored],queryText:'alpha beta',queryVector:[1,0,0],settings:cfg,context:scope});
  assert.equal(tail.dense.length,1);assert.equal(tail.dense[0].record.id,'recover-one');
  assert.equal(t.hashEmbedding,undefined);assert.equal(t.hashEmbeddingBatch,undefined);
  pass('model-ready tail survives a large unindexed prefix and no hash API ships');
  console.log(JSON.stringify({test:'flashback_embedding_execution_v1',passed:count,checks,externalModelCalls:0}));
 }finally{await f.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
