'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {fixture,installedSdkVariants:variants} = require('./storage_global_allchat_job_test.cjs');
const transport = require('./helpers/inprocess-review-transport.cjs');

for (const variant of variants) {
  const [namespace] = variant;
  test(`${namespace}: all-chat migration reads bounded batches and passes only metadata to discovery`, async () => {
    const payload = 'x'.repeat(390 * 1024);
    const keys = Array.from({length:9}, (_, index) => namespace + '.A.' + index);
    const bodies = new Map(keys.map(key => [key,payload]));
    if (namespace === 'flashback') bodies.set(namespace + '.A.oversized','y'.repeat(1200 * 1024));
    const sizes = new Map([...bodies].map(([key,value]) => [key,value.length + 2]));
    const scopeFor = key => key.slice(namespace.length + 1).split('.')[0];
    let scopedReads = 0, boundedBatches = 0, discoveryPasses = 0, singlePayloadReads = 0;
    const uploadBatches = [], oversizedUploads = [];
    const f = await fixture(variant, {
      bridgeOptions:{resolveKeyScope:async ({key}) => ({kind:'scope',scopeId:scopeFor(key)}),
        ...(namespace==='flashback'?{getManyResponseBudgetBytes:1024*1024}:{})},
      transportFactory:base => async (url, init={}) => {
        const parsed = new URL(url);
        const size = sizes.get(parsed.searchParams.get('key'));
        if (parsed.pathname === '/v1/kv/batch') {
          const mutations = JSON.parse(init.body).mutations.filter(row => sizes.has(row.key));
          if (mutations.length) uploadBatches.push(mutations.map(row => row.key));
        }
        if (parsed.pathname === '/v1/kv/set') {
          const {key} = JSON.parse(init.body);
          if (sizes.has(key)) oversizedUploads.push(key);
        }
        if (parsed.pathname === '/v1/kv/get' && size && size <= 1024 * 1024) singlePayloadReads++;
        if (parsed.pathname === '/v1/kv/get-many') {
          const requested = JSON.parse(init.body).keys;
          if (requested.some(key => sizes.has(key))) {
            assert.ok(requested.length === 1 || requested.reduce((sum,key) => sum + (sizes.get(key) || 0),0) <= 1024 * 1024);
            boundedBatches++;
          }
        }
        return base(url,init);
      },
      adapter:async ({hostScopes,records,readRecord}) => {
        discoveryPasses++;
        assert.ok(records.every(row => !Object.hasOwn(row,'value')), 'corpus bodies are not retained in the inventory');
        for (const row of records) if (sizes.has(row.key)) {
          assert.equal((await readRecord(row)).length,bodies.get(row.key).length);
          scopedReads++;
        }
        return {scopes:hostScopes.map(scope => ({...scope,scopeId:scope.chatId,scopeKey:scope.chatId})),
          records:records.map(row => ({...row,classification:'scope',scopeId:scopeFor(row.logicalKey)})),
          blockers:[],completeKnownScopes:true};
      }
    });
    try {
      for (const [key,value] of bodies) f.values.set(key,value);
      await f.bridge.setGlobalMode('server_only');
      assert.ok(uploadBatches.length > 1, 'payloads are distributed across multiple batches');
      for (const batch of uploadBatches) {
        assert.ok(batch.reduce((bytes,key) => bytes + sizes.get(key),0) <= 1024 * 1024,
          'each upload batch respects the 1 MiB aggregate payload budget');
      }
      assert.deepEqual(oversizedUploads, [...sizes].filter(([,bytes]) => bytes > 1024 * 1024).map(([key]) => key));
      assert.deepEqual([...uploadBatches.flat(),...oversizedUploads].sort(), [...bodies.keys()].sort());
      for (const key of bodies.keys()) f.values.delete(key);
      const before={discoveryPasses,singlePayloadReads};
      const preview=await f.bridge.previewGlobalMode('plugin_only');
      assert.equal(preview.completeKnownScopes,true);
      assert.equal(discoveryPasses-before.discoveryPasses,1,'preview classifies the inventory once');
      assert.equal(singlePayloadReads-before.singlePayloadReads,0,'preview classifies normal remote payloads through bounded get-many');
      await f.bridge.setGlobalMode('plugin_only');
      for (const [key,value] of bodies) assert.equal(f.values.get(key),value);
      assert.ok(scopedReads >= bodies.size * 2);
      assert.ok(boundedBatches > 0);
    } finally {
      await f.close();
    }
  });
}

for (const variant of variants) test(`${variant[0]} can resume post-reset restore without uploading pre-reset local data`, async () => {
  const [namespace] = variant;
  const key = namespace + '.A', localOnly = namespace + '.B';
  const f = await fixture(variant);
  const cacheKey = namespace + '.A.cache', cache = new Map([[cacheKey,'PRESERVED_VECTOR_CACHE']]);
  const ownerHasDeviceVectors = namespace === 'libra' || namespace === 'flashback';
  let matchingCacheBinding = true;
  const cacheStore = {getItem:async key=>cache.get(key)??null,setItem:async(key,value)=>{cache.set(key,value);return true;},
    removeItem:async key=>{cache.delete(key);return true;},keys:async()=>[...cache.keys()]};
  const reopen = async writeFault => {
    const cacheOptions = ownerHasDeviceVectors ? {
      bridgeOptions:{localPrefixes:[namespace+'.']},
      adapter:async ({hostScopes,records}) => ({
        scopes:hostScopes.map(scope=>({...scope,scopeId:scope.chatId,scopeKey:scope.chatId})),
        records:records.map(row=>row.space==='local' && row.key===cacheKey
          ? {...row,classification:'shared',dependencyScopeIds:['A'],retainDeviceCacheAfterReset:true,
            vectorCacheStorageKey:row.location==='server'&&!matchingCacheBinding?'projection.B':'projection.A'}
          : {...row,classification:'scope',scopeId:row.logicalKey.slice(namespace.length+1)}),
        blockers:[],completeKnownScopes:true
      })
    } : {};
    const runtime = await fixture(variant,{app:f.app,values:f.values,writeFault,...cacheOptions});
    if (ownerHasDeviceVectors) runtime.bridge.createLocalStorageProxy(cacheStore);
    return runtime;
  };
  let cold;
  try {
    await f.bridge.setGlobalMode('server_only');
    const request = transport(f.app);
    const base = 'http://127.0.0.1:47631';
    const headers = {'X-Memory-Suite-Plugin':'flashback_hayaku_bridge','Content-Type':'application/json'};
    const bootstrap = await (await request(base+'/bootstrap',{headers})).json();
    headers.Authorization = 'Bearer '+bootstrap.token;
    const post = async (route, body) => {
      const response = await request(base+route,{method:'POST',headers,body:JSON.stringify(body)});
      const data = await response.json();
      assert.equal(response.status,200,JSON.stringify(data));
      return data.result;
    };
    const plan = await post('/v1/manager/reset/plan',{namespaces:[namespace]});
    await post('/v1/manager/reset/execute',{planId:plan.id,confirmation:plan.confirmation,withoutBackup:true});
    await f.bridge.acceptServerReset('empty');
    await f.bridge.dispose();
    f.values.delete(key);
    f.values.delete(localOnly);
    const repository = f.app.repositories[namespace];
    repository.mutate({kind:'set',space:'plugin',key,value:'AFTER_RESET',operationId:'after_reset'});
    if (namespace === 'libra') repository.mutate({kind:'set',space:'local',key:cacheKey,value:'SERVER_VECTOR_CACHE',operationId:'after_reset_cache'});
    cold = await reopen(async writtenKey=>{
      if(writtenKey===key)throw Error('simulated_restore_write_interruption');
    });
    assert.equal((await cold.bridge.getScopeMode({scopeId:'A'})).mode,'server_only');
    f.values.set(localOnly,'PRE_RESET_LOCAL_ONLY');
    await assert.rejects(()=>cold.bridge.setGlobalMode('plugin_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE'
      &&error.details.blockers.some(row=>row.code==='MEMORY_SUITE_GLOBAL_RESET_LOCAL_ONLY_RECORD'));
    assert.equal(f.values.get(localOnly),'PRE_RESET_LOCAL_ONLY');
    assert.equal(repository.get('plugin',localOnly).exists,false);
    f.values.delete(localOnly);
    if (namespace === 'libra') {
      matchingCacheBinding=false;
      await assert.rejects(()=>cold.bridge.setGlobalMode('plugin_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT'
        &&error.details.key===cacheKey&&error.details.replicaWitness==='unavailable');
      assert.equal(cache.get(cacheKey),'PRESERVED_VECTOR_CACHE');
      matchingCacheBinding=true;
    }
    await assert.rejects(()=>cold.bridge.setGlobalMode('plugin_only'),error=>error.code==='MEMORY_SUITE_TRANSFER_INCOMPLETE'
      &&error.details.failures.some(row=>row.key===key));
    const pending = cold.bridge.getSyncJob();
    assert.equal(pending.status,'failed');
    assert.equal((await cold.bridge.getGlobalMode()).mode,'server_only');
    assert.equal(JSON.parse(f.values.get('memory_suite_reset_choice.v2.'+namespace)).choice,'empty');
    assert.equal(pending.verifiedScopes,0);
    await cold.close();
    cold = await reopen();
    const result = await cold.bridge.setGlobalMode('plugin_only');
    assert.equal(result.verifiedScopes,3);
    assert.equal((await cold.bridge.getScopeMode({scopeId:'A'})).mode,'plugin_only');
    assert.equal(await cold.proxy.getItem(key),'AFTER_RESET');
    assert.equal(repository.get('plugin',key).value,'AFTER_RESET');
    assert.notEqual(cold.bridge.getSyncJob().jobId,pending.jobId);
    assert.equal(repository.get('plugin',localOnly).exists,false);
    assert.equal(JSON.parse(f.values.get('memory_suite_reset_choice.v2.'+namespace)).choice,'restored');
    if (ownerHasDeviceVectors) {
      assert.equal(cache.get(cacheKey),namespace==='libra'?'SERVER_VECTOR_CACHE':'PRESERVED_VECTOR_CACHE');
      assert.equal(repository.get('local',cacheKey).exists,namespace==='libra');
    }
  } finally {
    await cold?.close();
    await f.close();
  }
});
