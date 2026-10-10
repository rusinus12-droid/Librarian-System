'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const P=path.resolve(__dirname,'..'),frames=[];let passed=0;
const pass=name=>{passed++;console.log('PASS '+name);};
const open=async stores=>{const f=await createFlashback(P,stores);frames.push(f);return f;};
const cfg={embeddingEnabled:true,embeddingProvider:'openai_compat',embeddingModel:'checkpoint-fixture',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:3,embeddingBatchSize:1,embeddingMaxRetries:0,fallbackHashEmbedding:false};
const payload=n=>({data:Array.from({length:n},(_,index)=>({index,embedding:[1,0,0]}))});
const wire=(f,calls,failText='')=>{f.host.nativeFetch=async(_url,init)=>{const b=JSON.parse(init.body);calls.push(...b.input);return new Response(JSON.stringify(b.input.includes(failText)?{error:{message:'temporary'}}:payload(b.input.length)),{status:b.input.includes(failText)?503:200});};};
(async()=>{try{
 const f=await open(),texts=['checkpoint-private-A','checkpoint-private-B'],calls=[];wire(f,calls,texts[1]);
 await assert.rejects(()=>f.api._test.createEmbeddingProviderAdapter(cfg).embedTexts(texts,{purpose:'document',sourceDigest:'revision-one'}));
 const stores={pluginStorage:f.pluginStorage,safeLocalStorage:f.safeLocalStorage};
 const keys=(await f.safeLocalStorage.keys()).filter(key=>key.startsWith('flashback:embedding_checkpoint:'));
 assert.equal(keys.length,1);const snapshot=JSON.stringify(await f.safeLocalStorage.getItem(keys[0]));
 assert.ok(!snapshot.includes(texts[0])&&!snapshot.includes('test-secret-not-for-output'));
 await f.cleanup();const resumed=await open(stores),resumeCalls=[];wire(resumed,resumeCalls);
 const result=await resumed.api._test.createEmbeddingProviderAdapter(cfg).embedTexts(texts,{purpose:'document',sourceDigest:'revision-one'});
 assert.deepEqual(resumeCalls,[texts[1]]);assert.equal(result.metadata.resumedBatches,1);assert.equal(result.vectors.length,2);
 pass('verified successful batch survives VM restart without storing raw input/key');
 await resumed.cleanup();

 const rotated=await open(stores),rotatedCalls=[];await rotated.api._test.readEmbeddingKey({force:true});await new Promise(resolve=>setTimeout(resolve,25));await rotated.api._test.saveEmbeddingKeyLocal('rotated-test-credential');assert.equal(await rotated.api._test.readEmbeddingKey(),'rotated-test-credential');wire(rotated,rotatedCalls);
 await rotated.api._test.createEmbeddingProviderAdapter(cfg).embedTexts(texts,{purpose:'document',sourceDigest:'revision-one'});assert.deepEqual(rotatedCalls,texts);
 pass('key rotation cannot reuse checkpoints from an earlier authority');
 await rotated.cleanup();
 const changed=await open(stores),changedCalls=[];await changed.api._test.readEmbeddingKey({force:true});await new Promise(resolve=>setTimeout(resolve,25));await changed.api._test.saveEmbeddingKeyLocal('test-secret-not-for-output');wire(changed,changedCalls);
 await changed.api._test.createEmbeddingProviderAdapter(cfg).embedTexts(texts,{purpose:'document',sourceDigest:'revision-two'});assert.deepEqual(changedCalls,texts);
 pass('source revision change invalidates checkpoint reuse');

 const corrupt=await open(stores),corruptCalls=[];wire(corrupt,corruptCalls);
 const bad=JSON.parse(snapshot);bad.vectors[0][0]=null;await corrupt.safeLocalStorage.setItem(keys[0],bad);
 await assert.rejects(()=>corrupt.api._test.createEmbeddingProviderAdapter(cfg).embedTexts(texts,{purpose:'document',sourceDigest:'revision-one'}),/CHECKPOINT_CORRUPT/);assert.equal(corruptCalls.length,0);
 await corrupt.safeLocalStorage.setItem(keys[0],JSON.parse(snapshot));
 pass('corrupt checkpoint is rejected before any resubmission');

 for(const fault of ['read-reject','write-drop','readback-reject']){
  const faulted=await open(),faultCalls=[];wire(faulted,faultCalls);let wrote=false;
  const originalGet=faulted.safeLocalStorage.getItem.bind(faulted.safeLocalStorage),originalSet=faulted.safeLocalStorage.setItem.bind(faulted.safeLocalStorage);
  faulted.safeLocalStorage.getItem=async key=>{if(String(key).startsWith('flashback:embedding_checkpoint:')&&(fault==='read-reject'||fault==='readback-reject'&&wrote))throw new Error('checkpoint read fault');return originalGet(key);};
  faulted.safeLocalStorage.setItem=async(key,value)=>{if(String(key).startsWith('flashback:embedding_checkpoint:')){wrote=true;if(fault==='write-drop')return true;}return originalSet(key,value);};
  await assert.rejects(()=>faulted.api._test.createEmbeddingProviderAdapter(cfg).embedTexts(['fault-'+fault],{purpose:'document'}));
  assert.equal(faultCalls.length,fault==='read-reject'?0:1);assert.equal(faulted.audit.Runtime.documentEmbeddingCache.size,0);
  pass('checkpoint '+fault+' fails closed without corpus cache activation');
 }

 const body=await open();let finishBody,wires=0;
 const deferred=new Promise(resolve=>{finishBody=resolve;});
 body.host.nativeFetch=async()=>{wires++;return {ok:true,status:200,json:()=>deferred};};
 const ledger=body.audit.MemorySuiteExecutionContract.createLedger({maxRequests:2});
 await assert.rejects(()=>body.api._test.createEmbeddingProviderAdapter(cfg).embedTexts(['pending-body'],{purpose:'query',cacheMode:'bypass',deadlineAt:Date.now()+50,operationLedger:ledger}));
 assert.equal(ledger.snapshot().pendingRequests,1);assert.equal(body.audit.Runtime.embeddingActiveRequests.size,1);
 body.audit.abortEmbeddingJobs('credential_changed');
 assert.equal(body.audit.Runtime.embeddingActiveRequests.size,1,'credential cancellation retains physical pending');
 await assert.rejects(()=>body.api._test.createEmbeddingProviderAdapter(cfg).embedTexts(['overlapping-query'],{purpose:'query',cacheMode:'bypass'}),/physically pending/);assert.equal(wires,1);
 finishBody(payload(1));await deferred;await new Promise(resolve=>setTimeout(resolve,15));
 assert.equal(ledger.snapshot().pendingRequests,0);assert.equal(body.audit.Runtime.embeddingActiveRequests.size,0);assert.equal(body.audit.Runtime.queryEmbeddingCache.size,0);
 pass('pending body and credential cancellation block overlapping wire until late settlement; late vector never cached');

 const contextual=await open(),scope=await contextual.api.resolveCurrentScope(false);
 const cc=contextual.api._test.normalizeSettings({...cfg,embeddingProvider:'voyage_context',embeddingModel:'context-fixture',embeddingBatchSize:2,chunkSize:400});
 contextual.host.nativeFetch=async(_url,init)=>{const b=JSON.parse(init.body);return new Response(JSON.stringify({data:b.inputs.map((g,index)=>({index,data:g.map((_,index)=>({index,embedding:[1,0,0]}))}))}),{status:200});};
 const records=await contextual.audit.buildRecordsFromSources([{sourceType:'response',sourceId:'context-source',sourceHash:'context-hash',title:'Context',text:'Alice carried a sapphire compass to the cedar house. '.repeat(40),sanitizeMemory:false}],cc,scope,{allowHashFallback:false});
 assert.ok(records.length>1);assert.ok(records.every(r=>r.embeddingProvenance?.segments?.length));
 await contextual.api._test.saveAllRecords(records,cc,scope);
 const durable=(await contextual.api._test.loadScopeRecords(scope.scopeKey)).records;
 for(const record of records)assert.equal(JSON.stringify(durable.find(row=>row.id===record.id)?.embeddingProvenance),JSON.stringify(record.embeddingProvenance));
 assert.ok(durable.every(r=>r.embeddingProvenance.groupingVersion==='source-groups.bounded.v3'));
 pass('actual source-to-record commit preserves contextual segment provenance after readback');
 console.log(JSON.stringify({test:'embedding_checkpoint_pending',passed,externalProviderCalls:0}));
}finally{for(const f of frames.reverse())await f.cleanup();}})().catch(e=>{console.error(e);process.exitCode=1;});
