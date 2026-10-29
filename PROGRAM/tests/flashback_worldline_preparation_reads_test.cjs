'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
test('worldline record reads overlap at most four shards, preserve records, and stop on cancellation',async()=>{
  const h=await createFlashback(path.resolve(__dirname,'..'));
  try{
    const t=h.api._test,cfg=t.normalizeSettings({embeddingProvider:'hash',hashDimensions:8,autoEpisodeIndex:false,episodeIndexEnabled:false});
    await h.api.saveSettings(cfg);const scope=await h.api.resolveCurrentScope(false);
    const sources=Array.from({length:260},(_,i)=>({sourceType:'response',sourceId:'parallel-'+i,sourceHash:'parallel-hash-'+i,
      origin:'live_chat',role:'turn_pair',turnIndex:i+1,pairIndex:i+1,
      text:`User:\nInspect parcel ${i}.\n\n---\n\nAssistant:\nParcel ${i} is sealed beside the eastern cabinet.`}));
    await t.saveAllRecords(await t.buildRecordsFromSources(sources,cfg,scope),cfg,scope);
    const serial=await t.loadScopeRecords(scope.scopeKey,{readOnly:true});
    assert.ok(serial.manifest.shardCount>4);
    t.invalidateRecallShardCache(scope.scopeKey);
    const read=h.pluginStorage.getItem.bind(h.pluginStorage);let active=0,peak=0,reads=0,cancel=false,abort=false;
    // Observe this operation's actual physical reader, excluding independent
    // host monitors that can read the same scope while this await is held.
    const readPlugin=async key=>{
      if(!String(key).includes(':records:')||!/:shard:\d+$/.test(String(key)))return read(key);
      reads++;active++;peak=Math.max(peak,active);
      if(abort)cancel=true;
      try{await new Promise(resolve=>setTimeout(resolve,15));return await read(key);}finally{active--;}
    };
    const parallel=await t.loadScopeRecords(scope.scopeKey,{readOnly:true,shardReadConcurrency:4,useCache:false,readPlugin});
    assert.deepEqual(JSON.parse(JSON.stringify(parallel.records)),JSON.parse(JSON.stringify(serial.records)));
    assert.ok(peak>1&&peak<=4,`bounded shard overlap: ${peak}`);
    assert.equal(reads,serial.manifest.shardCount);
    reads=0;abort=true;t.invalidateRecallShardCache(scope.scopeKey);
    await assert.rejects(()=>t.loadScopeRecords(scope.scopeKey,{readOnly:true,shardReadConcurrency:4,useCache:false,readPlugin,
      assertCurrent:()=>{if(cancel)throw Error('CONTROLLED_PREPARATION_DEADLINE');}}),/CONTROLLED_PREPARATION_DEADLINE/);
    assert.ok(reads<=4,'no later shard batch begins after cancellation');
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(active,0);
  }finally{await h.cleanup();}
});
