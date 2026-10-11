'use strict';
// Read-only product audit: all writes below target isolated in-memory fixture stores.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const {createFixture}=require(path.join(root,'tests/fixtures/flashback_native_runtime_fixture.cjs'));
const currentPath=path.join(root,'plugins/Flashback_Memory.js');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const plain=x=>JSON.parse(JSON.stringify(x));
const initialHash=sha(currentPath),results=[];
async function mixedStore(version){
 const file=currentPath;
 const f=await createFixture({source:fs.readFileSync(file,'utf8'),arguments:{hook_recall_timeout_ms:'10000'}});
 try{
  const t=f.api._test,sel=f.api._selectionTest;
  const cfg=t.normalizeSettings({...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'engine-audit',embeddingDimensions:3,
   embeddingEnabled:true,embeddingUrl:'https://fixture.invalid/v1',embeddingMaxRetries:0,fallbackHashEmbedding:false,
   contextualRecall:true,autoEpisodeIndex:false,episodeIndexEnabled:false,currentSceneTailEnabled:false,topK:2,minScore:.1,mmrEnabled:false,recallContextMessages:0});
  await t.saveEmbeddingKeyLocal('offline-fixture-key');await f.api.saveSettings(cfg);
  const target='Alice left the brass key inside the blue cabinet.';
  const irrelevant='Rain fell over the harbor as the empty boats drifted away.';
  let requests=0;
  f.host.nativeFetch=async(url,init)=>{
   requests++;const body=JSON.parse(init.body),inputs=Array.isArray(body.input)?body.input:[body.input];
   return new Response(JSON.stringify({data:inputs.map((x,index)=>({index,embedding:(String(x).includes(irrelevant)||String(x).includes('WEATHER_FIXTURE_QUERY'))?[0,1,0]:[1,0,0]}))}),{status:200});
  };
  f.currentChat.message=[{role:'user',chatId:'u1',data:'A key was moved.'},{role:'assistant',chatId:'a1',data:target},
   {role:'user',chatId:'u2',data:'Describe the weather.'},{role:'assistant',chatId:'a2',data:irrelevant}];
  f.currentChat.messages=f.currentChat.message;
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await f.api.resolveCurrentScope(),loaded=(await t.loadScopeRecords(scope.scopeKey)).records;
  assert.equal(loaded.filter(r=>r.text.includes(target)).length,1);
  const mixed=loaded.map(r=>r.text.includes(target)?{...r,provider:'hash',model:`hash-${cfg.hashDimensions}`,dim:cfg.hashDimensions,
   vector:Array.from({length:cfg.hashDimensions},(_,i)=>i===0?1:0),embeddingProfileId:''}:r);
  await t.saveAllRecords(mixed,cfg,scope);
  const stored=(await t.loadScopeRecords(scope.scopeKey)).records,before=JSON.stringify(stored);
  assert.ok(requests>0&&stored.some(r=>r.provider==='openai_compat')&&stored.some(r=>r.provider==='hash'),'Exercise an actual mixed vector store');
  const query='Where did Alice leave the brass key?';
  const options={currentUser:query,currentPairIndex:4};
  const raw=await sel.prepareFlashbackRecall(query,cfg,scope,options),plan=sel.selectFlashbackEvidencePlan(raw,cfg,3000);
  assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records),before);
  // The mixed store must also retain positive model recall through the actual
  // hook; exclusion alone must never make an empty engine look correct.
  const weatherQuery='WEATHER_FIXTURE_QUERY What happened to the empty boats?';
  f.currentChat.message.push({role:'user',chatId:'u3',data:weatherQuery});
  await t.beforeRequest([{role:'user',chatId:'u3',content:weatherQuery}],'model');
  const delivered=await t.beforeRequest([{role:'user',chatId:'u4',content:weatherQuery}],'model');
  assert.ok(delivered.some(message=>String(message.content||'').includes(irrelevant)),'actual beforeRequest delivers the comparable remote source');
  assert.ok(!delivered.some(message=>String(message.content||'').includes(target)),'actual beforeRequest excludes preserved legacy hash source');
  assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records),before);
  return {version,sourceHash:sha(file),stored:stored.map(r=>({id:r.id,provider:r.provider,isTarget:r.text.includes(target)})),
   loaded:raw.loadedTotal,arms:plain(raw.diagnostics?.candidateArms),selected:plan.items.map(i=>i.record.id),targetDelivered:plan.text.includes(target),
   targetStillStored:stored.some(r=>r.text.includes(target)),sourceAndVectorsUnchanged:true,remoteProfile:stored.find(r=>r.provider==='openai_compat').embeddingProfileId,simulatedEmbeddingRequests:requests};
 }finally{await f.dispose();}
}
(async()=>{
 results.push({case:'mixed_hash_remote_store',...(await mixedStore('current'))});
 assert.equal(results[0].targetDelivered,false,'Legacy hash vectors are preserved but excluded from model-only recall');
 assert.equal(results[0].targetStillStored,true,'Model-only filtering never deletes immutable legacy source');
 const f=await createFixture();
 try{
  const t=f.api._test,sel=f.api._selectionTest;
  const cfg=t.normalizeSettings({...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'engine-audit',embeddingDimensions:3,
   embeddingEnabled:true,embeddingUrl:'https://fixture.invalid/v1',embeddingMaxRetries:0,fallbackHashEmbedding:false,
   contextualRecall:true,topK:2,minScore:.1,mmrEnabled:false,contradictionBundleEnabled:true,recallFullScanThreshold:1,recallShardLimit:2});
  const query='Where did Alice leave the brass key?';
  const rows=Array.from({length:10},(_,i)=>({id:`hash-${i}`,sourceHash:`src-${i}`,sourceType:'response',scopeKey:'fixture',lifecycleStatus:'active',
   text:i===8?'Alice left the brass key inside the blue cabinet.':`Harbor inventory batch ${i} contained ropes and timber.`,
   responseTurnIndex:i+1,pairIndex:i+1,provider:'hash',model:'hash-512',vector:Array.from({length:512},(_,j)=>j===0?1:0)}));
  const summaries=rows.map((r,i)=>t.buildRecallShardSummary([r],i,cfg));
  const manifest={scopeKey:'fixture',shardCount:10,shardIndexVersion:8,shardSummaries:summaries,responseTurnMax:10};
  const route=t.selectRecallShardIndexes(manifest,query,[1,0,0],'openai_compat','fact',cfg,'engine-audit');
  const legacy=t.selectRecallShardIndexes(manifest,query,[1,0,0],'openai_compat','fact',{...cfg,contextualRecall:false},'engine-audit');
  results.push({case:'no_compatible_shard_centroid',targetShard:8,semantic:plain(route),legacy:plain(legacy)});
  assert.ok(route.indexes.includes(8),'Unknown centroid relevance uses bounded compatibility routing');
  assert.ok(route.indexes.length<=cfg.recallShardLimit);
  assert.equal(route.routing.mode,'embedding_index_compatibility');
  assert.equal(route.routing.scopeCoverage,'partial');
  const mixedSummaries=plain(summaries);
  mixedSummaries[0].centroids=[{provider:'openai_compat',model:'engine-audit',profileId:results[0].remoteProfile,dim:3,vector:[0,1,0]}];
  const mixedRoute=t.selectRecallShardIndexes({...manifest,shardSummaries:mixedSummaries},query,[1,0,0],'openai_compat','context',cfg,'engine-audit');
  assert.equal(mixedRoute.routing.compatibleShards,1);
  assert.ok(mixedRoute.indexes.includes(8),'Partial model coverage cannot hide the remaining Hash-only shards');
  const wrongProfile=plain(mixedSummaries);wrongProfile[0].centroids[0].profileId='another-endpoint-profile';
  const mismatch=t.selectRecallShardIndexes({...manifest,shardSummaries:wrongProfile},query,[1,0,0],'openai_compat','context',cfg,'engine-audit');
  assert.equal(mismatch.routing.compatibleShards,0,'Same model name in another endpoint is not a comparable centroid');
  const make=(id,turn,value,body,score,semantic)=>({record:{id,sourceType:'response',text:body,sourceHash:id,scopeKey:'fixture',
   turnIndex:turn,pairIndex:turn,responseTurnIndex:turn,turnRange:{start:turn,end:turn},structuredStateFacts:value?[{entity:'Alice',property:'location',
    value,turn,evidenceText:body,evidenceStart:0,evidenceEnd:body.length}]:[]},score,components:semantic?{contextualSemantic:true,semanticCosine:score}:{}});
  for(const semantic of [false,true]){
   const input={scopeKey:'fixture',queryText:'Compare Alice before and now.',temporalIntent:'compare',truthIntent:'disputed',currentStateFacts:[],
    records:[make('before',1,'tower','Alice was in the tower.',.75,semantic),make('after',2,'garden','Alice moved into the garden.',.75,semantic),
     make('other',3,'','A bell sounded across the harbor.',.95,semantic)]};
   const plan=sel.selectFlashbackEvidencePlan(input,cfg,3000);
   results.push({case:'explicit_comparison_priority',semantic,selected:plan.items.map(i=>i.record.id),requirements:plain(plan.requirements),discarded:plain(plan.discarded)});
   assert.deepEqual(Array.from(plan.items,i=>i.record.id).sort(),['after','before']);
   assert.ok(plan.requirements.length&&plan.requirements.every(r=>r.status==='complete'));
   const capped=sel.selectFlashbackEvidencePlan(input,{...cfg,topK:1},3000);
   assert.ok(capped.items.length<=1&&capped.requirements.every(r=>r.status!=='complete'),'A required pair cannot raise the user cap');
   const ordinary=sel.selectFlashbackEvidencePlan({...input,queryText:'Describe the scene.',temporalIntent:'unspecified',truthIntent:'normal'},cfg,3000);
   assert.equal(ordinary.requirements.length,0,'No forced pair for an ordinary contextual request');
   assert.ok(ordinary.items.some(i=>i.record.id==='other'));
  }
 }finally{await f.dispose();}
 assert.equal(sha(currentPath),initialHash,'Product file unchanged');
 const result={at:new Date().toISOString(),sourceHash:initialHash,productUnchanged:true,realRisuAI:'NOT_RUN',realProvider:'NOT_RUN',results};
 
 console.log('flashback_context_engine_compatibility_runtime_test: PASS (isolated storage and controlled vectors; real provider NOT_RUN)');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
