'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM=path.resolve(__dirname,'..');
const source={sourceType:'response',sourceId:'slow-preparation',sourceHash:'slow-preparation-hash',origin:'live_chat',role:'turn_pair',turnIndex:1,pairIndex:1,
  text:'User:\nWhere is the parcel?\n\n---\n\nAssistant:\nThe parcel remains beside the clock in the eastern cabinet.'};

for(const scenario of [{stage:'reserved'},{stage:'submitted'},{stage:'submitted',expire:true},{stage:'reserved',lateProvider:true}])test(`slow ${scenario.stage} persistence: ${scenario.expire?'explicit operation deadline stays authoritative':scenario.lateProvider?'physical provider timeout stays authoritative':'preparation does not consume provider timeout'}`,async()=>{
  const {stage}=scenario;
  const h=await createFlashback(PROGRAM);try{
    const cfg=h.api._test.normalizeSettings({embeddingProvider:'openai_compat',embeddingModel:'slow-preparation',embeddingUrl:'https://provider.invalid/v1',
      embeddingDimensions:3,embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,embeddingTimeoutMs:30000,autoEpisodeIndex:false,episodeIndexEnabled:false});
    await h.api.saveSettings(cfg);const scope=await h.api.resolveCurrentScope(false);
    await h.api._test.saveAllRecords(await h.api._test.buildRecordsFromSources([source],cfg,scope,{deferEmbedding:true}),cfg,scope);
    let now=Date.now(),advanced=false,calls=0;const NativeDate=Date;
    h.context.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
    const write=h.pluginStorage.setItem.bind(h.pluginStorage);
    h.pluginStorage.setItem=async(key,value)=>{
      const result=await write(key,value);
      if(!advanced&&String(key).endsWith(':manifest:v2')){
        const parsed=typeof value==='string'?JSON.parse(value):value;
        if(Object.values(parsed?.embeddingAttemptRegistry?.entries||{}).some(entry=>entry.state===stage)){now+=31000;advanced=true;}
      }
      return result;
    };
    h.host.nativeFetch=async(_url,init)=>{calls++;if(scenario.lateProvider)now+=31000;return new Response(JSON.stringify({data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});};
    const result=await h.api.processPendingEmbeddingQueue({maxRequests:2,maxSources:1,...(scenario.expire?{deadlineAt:now+1000}:{})});
    assert.equal(advanced,true,'inject 31 seconds into durable reservation, before any wire request');
    const rows=(await h.api._test.loadScopeRecords(scope.scopeKey)).records;
    assert.equal(rows[0].text,source.text);
    if(scenario.expire){
      assert.equal(calls,0);assert.equal(result.failed,0,'never-sent work must remain retryable');
      assert.equal(rows[0].embeddingWork.status,'pending');
      assert.equal(Object.keys((await h.api._test.loadScopeManifest(scope)).embeddingAttemptRegistry.entries).length,0);
    }else if(scenario.lateProvider){
      assert.equal(calls,1);assert.equal(result.ready,0);assert.equal(result.uncertain,true,JSON.stringify({result,work:rows[0].embeddingWork}));
      assert.equal(rows[0].embeddingWork.status,'uncertain');
      await h.api.processPendingEmbeddingQueue({retryFailed:true});assert.equal(calls,1,'unknown physical outcome cannot be resent automatically');
    }else{assert.equal(result.ready,1,JSON.stringify(result));assert.equal(calls,1);assert.equal(rows[0].embeddingReceipt.status,'ready');}
  }finally{await h.cleanup();}
});

test('slow automatic scope discovery does not consume the request budget before submission',async()=>{
  // 2026-10-29 debug: TIMEOUT after 2ms with 11 records left pending. Loading the scope
  // took longer than embeddingTimeoutMs*(maxRequests+1) and that budget started at pass start.
  const h=await createFlashback(PROGRAM);try{
    const cfg=h.api._test.normalizeSettings({embeddingProvider:'openai_compat',embeddingModel:'slow-discovery',embeddingUrl:'https://provider.invalid/v1',
      embeddingDimensions:3,embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,embeddingTimeoutMs:30000,autoEpisodeIndex:false,episodeIndexEnabled:false});
    await h.api.saveSettings(cfg);const scope=await h.api.resolveCurrentScope(false);
    await h.api._test.saveAllRecords(await h.api._test.buildRecordsFromSources([source],cfg,scope,{deferEmbedding:true}),cfg,scope);
    let now=Date.now(),armed=false,advanced=false,calls=0;const NativeDate=Date;
    h.context.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
    const read=h.pluginStorage.getItem.bind(h.pluginStorage);
    h.pluginStorage.getItem=async key=>{const value=await read(key);if(armed&&!advanced){now+=120000;advanced=true;}return value;};
    h.host.nativeFetch=async(_url,init)=>{calls++;return new Response(JSON.stringify({data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});};
    armed=true;
    const result=await h.api.processPendingEmbeddingQueue({maxRequests:2,maxSources:1});
    assert.equal(advanced,true,'120 seconds pass during discovery, beyond the old 90-second pass budget');
    assert.equal(calls,1,JSON.stringify(result));assert.equal(result.ready,1,JSON.stringify(result));
  }finally{await h.cleanup();}
});

test('reservation authority checks do not repeatedly download unrelated ready vectors',async()=>{
  const measured=[];
  for(const rawAuthority of [false,true]){
    // Measure a cold sidecar path in both runs; warm in-memory vectors would
    // conceal the repeated downloads seen on a remote storage route.
    const h=await createFlashback(PROGRAM,{transformSource:s=>{
      s=s.replace('const cached = Runtime.localVectorShardCache.get(cacheKey);','const cached = null;');
      return rawAuthority?s:s.replace('rawTextOnly:options.rawTextOnly===true','rawTextOnly:false');
    }});
    try{
      const cfg=h.api._test.normalizeSettings({embeddingProvider:'openai_compat',embeddingModel:'read-volume',embeddingUrl:'https://provider.invalid/v1',embeddingDimensions:3,
        embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,autoEpisodeIndex:false,episodeIndexEnabled:false});
      await h.api.saveSettings(cfg);const scope=await h.api.resolveCurrentScope(false);
      h.host.nativeFetch=async(_url,init)=>new Response(JSON.stringify({data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});
      await h.api._test.saveAllRecords(await h.api._test.buildRecordsFromSources([source],cfg,scope,{deferEmbedding:true}),cfg,scope);
      assert.equal((await h.api.processPendingEmbeddingQueue()).ready,1);
      const ready=(await h.api._test.loadScopeRecords(scope.scopeKey)).records;
      const pending=await h.api._test.buildRecordsFromSources([{...source,sourceId:'other',sourceHash:'other-hash',turnIndex:2,pairIndex:2,text:source.text+' Another parcel is on the desk.'}],cfg,scope,{deferEmbedding:true});
      await h.api._test.saveAllRecords([...ready,...pending],cfg,scope);
      const sidecars=new Set((await h.api._test.loadScopeRecords(scope.scopeKey)).records.map(r=>r.vectorRef?.storageKey).filter(Boolean));
      assert(sidecars.size>0);let reads=0,beforeWire=0;const get=h.safeLocalStorage.getItem.bind(h.safeLocalStorage);
      h.safeLocalStorage.getItem=async key=>{if(String(key).includes(':local-vector-shard:v1:'))reads++;return get(key);};
      const provider=h.host.nativeFetch;h.host.nativeFetch=async(...args)=>{beforeWire=reads;return provider(...args);};
      assert.equal((await h.api.processPendingEmbeddingQueue()).ready,1);
      measured.push({rawAuthority,beforeWire,reads});
    }finally{await h.cleanup();}
  }
  console.log(JSON.stringify({test:'embedding_authority_vector_read_volume',measured}));
  assert(measured[1].beforeWire<measured[0].beforeWire,'source and reservation proofs need raw bytes before wire submission');
  assert(measured[1].reads<measured[0].reads/2,'full mutation/readback still hydrate vectors while redundant authority hydration is removed');
});
