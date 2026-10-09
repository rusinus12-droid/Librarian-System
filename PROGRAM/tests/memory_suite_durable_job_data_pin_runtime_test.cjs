'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createMemorySuiteServer}=require('../server/server.cjs');
const sdkFiles=['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'];
const jobKey='__memory_suite_internal_sync_job_v1__:libra',rawKey='libra:pin:raw',privateKey='private-user-setting';
const scope={scopeId:'s01-pin-scope',scopeKey:'s01-pin-scope',characterId:'s01-char',chatId:'s01-chat',available:true};
const waitFor=async(predicate,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,15));}throw new Error('fixture wait timeout');};
async function fixture(file){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s01-durable-pin-')),servers=[],bridges=[],calls=[],args=new Map([['memory_suite_server_mode','server_only']]);
  const values=new Map([[privateKey,'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes'],['libra:pin:preserve','EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E']]);
  let intercept=null,storageHook=null,readHook=null,persistenceFailure='',rawRemovalFailure=false;
  const start=async(name,port=0)=>{
    const app=createMemorySuiteServer({host:'127.0.0.1',port,dataDir:path.join(dir,name),autoBackup:false,computeEnabled:false});
    const address=await app.listen(),server={app,url:`http://127.0.0.1:${address.port}`,port:address.port};servers.push(server);
    app.repositories.libra.mutate({kind:'set',space:'plugin',key:rawKey,value:'EXACT_ROOT_'+name+'\n\uD55C\uAE00\u3068\u65E5\u672C\u8A9E',operationId:'pin_seed_'+name,expectedRevision:0});
    return server;
  };
  const make=(overrides={})=>{
    const store={getItem:async k=>{if(readHook)await readHook(k);return values.has(k)?values.get(k):null;},setItem:async(k,v)=>{
      if(storageHook)await storageHook(k,v);
      if(k===jobKey&&persistenceFailure)return persistenceFailure==='false'?false:true;
      values.set(k,v);return true;
    },removeItem:async k=>{if(k===rawKey&&rawRemovalFailure)return false;values.delete(k);return true;},keys:async()=>[...values.keys()]};
    const host={getArgument:async k=>args.get(k)||'',setArgument:async(k,v)=>{args.set(k,v);return true;},nativeFetch:async(url,init)=>{
      calls.push({url,method:init.method});const response=await fetch(url,{...init,headers:{...init.headers,Connection:'close'}});
      return intercept?await intercept(url,init,response):response;
    }};
    const context={risuai:host,console:{log(){},warn(){}},URL,AbortController,TextEncoder,setTimeout,clearTimeout,crypto:crypto.webcrypto};
    vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk',file),'utf8')+'\nthis.create=createMemorySuiteStorageBridge;',context);
    const bridge=context.create({namespace:'libra',pluginId:'libra',pluginPrefixes:['libra:pin:'],currentScopeProvider:async()=>scope,
      resolveKeyScope:({currentScope})=>({kind:'scope',...(currentScope||scope)}),managementButton:false,startupDiagnostics:false,
      autoMigratePlugin:false,autoMigrateLocal:false,requestTimeoutMs:8000,bootstrapRequestTimeoutMs:8000,...overrides});
    bridges.push(bridge);bridge.createPluginStorageProxy(store);return bridge;
  };
  return {dir,start,make,args,values,calls,setIntercept(fn){intercept=fn;},setStorageHook(fn){storageHook=fn;},setReadHook(fn){readHook=fn;},failRawRemoval(){rawRemovalFailure=true;},failPersistence(kind){persistenceFailure=kind;},async close(){for(const b of bridges)await b.dispose();for(const s of servers)await s.app.close();
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(dir).startsWith('s01-durable-pin-'));fs.rmSync(dir,{recursive:true,force:true});}};
}
const pendingJob=(url,serverPins)=>({schema:'memory-suite.sync-job.v1',namespace:'libra',pluginId:'libra',pluginVersion:'test',jobId:'s01-persisted-restore',id:'s01-persisted-restore',kind:'server_restore',
  scopeId:scope.scopeId,scopeKey:scope.scopeKey,scopeLabel:'S01',sourceMode:'server_only',sourceUrl:url,requestedMode:'server_only',effectiveMode:'server_only',
  targetMode:'server_only',targetUrl:url,status:'paused',phase:'resume_pending',startedAt:Date.now(),updatedAt:Date.now(),retryCount:0,spaces:{},completedPasses:{},
  ...(serverPins?{serverPins}:{})});
const pinFor=(boot,url)=>({schema:'memory-suite.durable-server-pin.v1',namespace:'libra',url,serverUrl:boot.url,
  dataInstanceId:boot.dataInstanceId,dataIdentityContract:boot.dataIdentityContract,resetEpoch:Number(boot.resetEpochs?.libra||0)});
const stopped=async(bridge)=>{await bridge.resumePendingSyncJob();await waitFor(()=>{
  const job=bridge.getSyncJob();return ['completed','failed','cancelled'].includes(job?.status)
    || (job?.status==='paused'&&job.phase!=='resume_pending'&&!!job.error);
});return bridge.getSyncJob();};
for(const file of sdkFiles){
  test(file+': expired unfinished historical journal remains a stop fence for automatic migration',async()=>{
    const f=await fixture(file);try{
      const b=await f.start('B');f.args.set('memory_suite_server_url',b.url);const historical=pendingJob(b.url);historical.updatedAt=historical.startedAt=Date.now()-3*60*60*1000;
      f.values.set(jobKey,JSON.stringify(historical));const bridge=f.make({autoMigratePlugin:true,migrationDelayMs:250});await new Promise(r=>setTimeout(r,900));
      assert.equal(b.app.repositories.libra.get('plugin','libra:pin:preserve').exists,false,'expiry cannot turn unfinished old-root work into permission to migrate to a foreign DATA');
      assert.equal(bridge.getSyncJob()?.status,'paused');assert.match(bridge.getSyncJob()?.error||'',/SERVER_PIN_REQUIRED|RESUME_EXPIRED/);
      assert.equal(f.args.get('memory_suite_server_mode'),'server_only');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
      assert.ok(f.values.has(jobKey),'expired journal is preserved visibly');
    }finally{await f.close();}
  });
  test(file+': unreadable startup journal cannot be reported absent to automatic migration',async()=>{
    const f=await fixture(file);try{
      const b=await f.start('B');f.args.set('memory_suite_server_url',b.url);f.values.set(jobKey,JSON.stringify(pendingJob(b.url)));
      f.setReadHook(async key=>{if(key===jobKey)throw new Error('journal physical read unavailable');});
      f.make({autoMigratePlugin:true,migrationDelayMs:250});await new Promise(r=>setTimeout(r,900));
      assert.equal(b.app.repositories.libra.get('plugin','libra:pin:preserve').exists,false,'unknown persisted work cannot permit old owner raw upload');
      assert.equal(f.calls.length,0,'journal uncertainty is resolved before any server bootstrap or upload');
      assert.equal(f.args.get('memory_suite_server_mode'),'server_only');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
      assert.ok(f.values.has(jobKey),'unreadable job is retained for recovery');
    }finally{await f.close();}
  });
  test(file+': held startup journal read remains a fence for concurrent automatic migration',async()=>{
    const f=await fixture(file);let entered,release;const held=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});try{
      const b=await f.start('B');f.args.set('memory_suite_server_url',b.url);f.values.set(jobKey,JSON.stringify(pendingJob(b.url)));
      f.setReadHook(async key=>{if(key===jobKey){entered();await gate;}});
      const bridge=f.make({autoMigratePlugin:true,migrationDelayMs:250});await held;await new Promise(r=>setTimeout(r,900));
      assert.equal(b.app.repositories.libra.get('plugin','libra:pin:preserve').exists,false,'pending journal read cannot appear as no saved work to a concurrent startup timer');
      assert.equal(f.args.get('memory_suite_server_mode'),'server_only');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
      release();const job=await stopped(bridge);assert.equal(job.status,'paused');assert.match(job.error||'',/SERVER_PIN_REQUIRED/);
    }finally{release();await f.close();}
  });
  test(file+': default automatic migration cannot bypass the paused unpinned historical job',async()=>{
    const f=await fixture(file);try{
      const b=await f.start('B');f.args.set('memory_suite_server_url',b.url);f.values.set(jobKey,JSON.stringify(pendingJob(b.url)));
      const bridge=f.make({autoMigratePlugin:true,migrationDelayMs:250}),job=await stopped(bridge);
      assert.equal(job.status,'paused');assert.match(job.error||'',/SERVER_PIN_REQUIRED/);
      await new Promise(r=>setTimeout(r,900));
      const remote=await b.app.repositories.libra.get('plugin','libra:pin:preserve');
      assert.equal(remote.exists,false,'independent startup migration must not upload old local owner bytes to whichever DATA happens to be present');
      assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');assert.equal(f.values.get(privateKey),'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes');
      assert.equal(f.args.get('memory_suite_server_mode'),'server_only','rejected job cannot reset the historical private mode argument');
      assert.equal(bridge.getSyncJob().status,'paused');
    }finally{await f.close();}
  });
  test(file+': unpinned historical restore is paused before foreign DATA can populate local raw',async()=>{
    const f=await fixture(file);try{
      const b=await f.start('B');f.args.set('memory_suite_server_url',b.url);f.values.set(jobKey,JSON.stringify(pendingJob(b.url)));
      const bridge=f.make(),job=await stopped(bridge);
      assert.equal(f.values.has(rawKey),false,'old unpinned work cannot restore bytes from whichever DATA a fresh VM discovers');
      assert.equal(job.status,'paused');assert.match(job.error||job.reason||job.phase,/SERVER_PIN_REQUIRED|server_pin_required/);
      assert.equal(f.values.get(privateKey),'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
      assert.equal(f.args.get('memory_suite_server_mode'),'server_only');assert.ok(f.values.has(jobKey),'the old journal is preserved');
    }finally{await f.close();}
  });
  test(file+': new public restore persists verified physical DATA pins before completing exact raw restore',async()=>{
    const f=await fixture(file);try{
      const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);const bridge=f.make(),boot=await bridge.bootstrap();
      const job=await bridge.startRestoreJob();await bridge.waitForSyncJob(job.jobId,8000);
      const saved=JSON.parse(f.values.get(jobKey));
      assert.equal(saved.serverPins?.source?.dataInstanceId,boot.dataInstanceId,'source DATA is durably bound, not only the live connection');
      assert.equal(saved.serverPins?.target?.dataInstanceId,boot.dataInstanceId);assert.equal(saved.serverPins.source.namespace,'libra');
      assert.equal(f.values.get(rawKey),'EXACT_ROOT_A\n\uD55C\uAE00\u3068\u65E5\u672C\u8A9E');assert.equal(saved.status,'completed');
      assert.equal(f.values.get(privateKey),'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes');
    }finally{await f.close();}
  });
  test(file+': fresh VM rejects a saved foreign-root pin even when URL and owner scope match',async()=>{
    const f=await fixture(file);try{
      const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);const warm=f.make(),boot=await warm.bootstrap();await warm.dispose();
      await a.app.close();const b=await f.start('B',a.port);assert.equal(b.url,a.url);
      const pin=pinFor(boot,a.url);f.values.set(jobKey,JSON.stringify(pendingJob(a.url,{source:pin,target:pin})));
      const cold=f.make(),job=await stopped(cold);
      assert.equal(f.values.has(rawKey),false,'a same-address replacement cannot restore its foreign raw into the old journal');
      assert.equal(job.status,'paused');assert.match(job.error||job.reason||job.phase,/SERVER_PIN_CHANGED|server_pin_changed/);
      assert.equal(f.values.get(privateKey),'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
    }finally{await f.close();}
  });
  test(file+': a saved matching physical pin resumes in a fresh VM and preserves exact private/raw bytes',async()=>{
    const f=await fixture(file);try{
      const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);const warm=f.make(),boot=await warm.bootstrap();await warm.dispose();
      const pin=pinFor(boot,a.url);f.values.set(jobKey,JSON.stringify(pendingJob(a.url,{source:pin,target:pin})));
      const cold=f.make(),job=await stopped(cold);
      assert.equal(job.status,'completed',JSON.stringify({error:job.error,phase:job.phase,serverPins:job.serverPins}));assert.equal(f.values.get(rawKey),'EXACT_ROOT_A\n\uD55C\uAE00\u3068\u65E5\u672C\u8A9E');
      assert.equal(f.values.get(privateKey),'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
    }finally{await f.close();}
  });
  for(const variant of ['namespace','resetEpoch'])test(file+`: saved wrong ${variant} stops before local raw adoption`,async()=>{
      const f=await fixture(file);try{
        const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);const warm=f.make(),boot=await warm.bootstrap();await warm.dispose();
        const pin=pinFor(boot,a.url);if(variant==='namespace')pin.namespace='hayaku';else pin.resetEpoch+=1;
        f.values.set(jobKey,JSON.stringify(pendingJob(a.url,{source:pin,target:pin})));const cold=f.make(),job=await stopped(cold);
        assert.equal(f.values.has(rawKey),false,variant+': invalid durable boundary cannot restore raw');assert.equal(job.status,'paused');
        assert.match(job.error||job.reason||job.phase,/SERVER_PIN_REQUIRED|SERVER_PIN_CHANGED|server_pin_/);
      }finally{await f.close();}
  });
  for(const failure of ['false','lost'])test(file+`: ${failure} journal persistence cannot start raw transfer`,async()=>{
    const f=await fixture(file);try{
      const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);f.failPersistence(failure);const bridge=f.make();
      let error=null;try{await bridge.startRestoreJob();}catch(e){error=e;}
      await new Promise(r=>setTimeout(r,120));
      assert.equal(f.values.has(rawKey),false,'no transfer starts before the new DATA-bound journal is physically verified');
      assert.ok(error&&/JOB_PIN_PERSIST|job_pin_persist/.test(error.code||error.message),'a false or unreadable journal acknowledgement is refused visibly');
      assert.equal(f.values.get(privateKey),'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
    }finally{await f.close();}
  });
  test(file+': uncertified legacy reads remain available while new durable transfer stops',async()=>{
    const f=await fixture(file);try{
      const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);
      f.setIntercept(async(url,init,response)=>{const payload=await response.json();delete payload.dataInstanceId;
        if(url.endsWith('/bootstrap')){delete payload.dataIdentityContract;delete payload.capabilities['data-instance-binding.v1'];}
        return new Response(JSON.stringify(payload),{status:response.status});});
      const bridge=f.make();assert.equal((await bridge.serverGet('plugin',rawKey)).value,'EXACT_ROOT_A\n\uD55C\uAE00\u3068\u65E5\u672C\u8A9E');
      assert.equal(bridge.serverBinding().certified,false,'ordinary legacy compatibility is not durable DATA proof');
      let error=null;try{await bridge.startRestoreJob();}catch(e){error=e;}
      await new Promise(r=>setTimeout(r,120));
      assert.equal(f.values.has(rawKey),false,'uncertified server cannot advance a new durable transfer');
      assert.ok(error&&/SERVER_PIN_REQUIRED|server_pin_required/.test(error.code||error.message));
    }finally{await f.close();}
  });
  test(file+': missing namespace reset proof cannot be invented for a durable transfer',async()=>{
    const f=await fixture(file);try{
      const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);
      f.setIntercept(async(url,init,response)=>{const payload=await response.json();if(url.endsWith('/bootstrap'))delete payload.resetEpochs;
        return new Response(JSON.stringify(payload),{status:response.status});});
      const bridge=f.make();assert.equal((await bridge.serverGet('plugin',rawKey)).value,'EXACT_ROOT_A\n\uD55C\uAE00\u3068\u65E5\u672C\u8A9E');
      let error=null;try{await bridge.startRestoreJob();}catch(e){error=e;}
      await new Promise(r=>setTimeout(r,120));
      assert.equal(f.values.has(rawKey),false,'an absent namespace reset proof cannot be replaced with an invented zero');
      assert.ok(error&&/SERVER_PIN_REQUIRED/.test(error.code||error.message));
    }finally{await f.close();}
  });
  test(file+': a plugin-only public job retains zero server requests and exact existing raw/settings',async()=>{
    const f=await fixture(file);try{
      f.args.set('memory_suite_server_mode','plugin_only');f.args.set('memory_suite_server_url','http://127.0.0.1:17391');const bridge=f.make();
      const job=await bridge.startConnectionConfigurationJob({mode:'plugin_only'});const completed=await bridge.waitForSyncJob(job.jobId,8000);
      assert.equal(completed.status,'completed');assert.equal(f.calls.length,0,'local-only job creation/persistence/execution/startup never bootstraps a server');
      assert.equal(f.values.get(privateKey),'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
    }finally{await f.close();}
  });
  for(const operation of ['restore','configuration'])for(const rollbackFailure of [false,true])test(file+`: DATA switch during ${operation} local acknowledgement ${rollbackFailure?'retains a local integrity hold':'rolls back'} without recovery writes to the new root`,async()=>{
    const f=await fixture(file);let release,entered;const held=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
    try{
      const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);const bridge=f.make();
      f.setStorageHook(async(k,v)=>{if(k===rawKey&&v==='EXACT_ROOT_A\n\uD55C\uAE00\u3068\u65E5\u672C\u8A9E'){entered();await gate;}});
      const started=operation==='restore'?await bridge.startRestoreJob():await bridge.startConnectionConfigurationJob({mode:'plugin_only'});let reached=false;held.then(()=>{reached=true;});await waitFor(()=>reached);
      await a.app.close();const b=await f.start('B',a.port);
      assert.equal((await bridge.testConnection(b.url,{adoptDataInstance:true})).ok,true,'only the explicit verified probe accepts the new root');
      if(rollbackFailure)f.failRawRemoval();release();const job=await stopped(bridge);
      assert.equal(job.jobId,started.jobId);assert.equal(job.status,'paused');assert.match(job.error||'',/SERVER_PIN_CHANGED/);
      if(rollbackFailure){
        assert.equal(f.values.get(rawKey),'EXACT_ROOT_A\n\uD55C\uAE00\u3068\u65E5\u672C\u8A9E','unremovable candidate remains preserved for recovery');
        assert.equal((await bridge.getRecoveryState(scope))?.required,true,'failed local rollback retains an actual durable local integrity hold');
        assert.equal(job.recoveryRequired,true,'paused job truthfully reports local recovery is still required');
        await bridge.dispose();const cold=f.make(),resumed=await stopped(cold);
        assert.equal(resumed.recoveryRequired,true,'fresh restart cannot hide the durable incomplete rollback hold');
        assert.equal((await cold.getRecoveryState(scope))?.required,true,'local hold remains durable after fresh restart');
      }else assert.equal(f.values.has(rawKey),false,'old-root local candidate is rolled back after the held write settles');
      assert.equal((await bridge.getConnectionSettings()).mode,'server_only','source authority is retained when the saved physical pin changes');
      const foreignWrites=b.app.repositories.libra.database.prepare('SELECT key FROM kv WHERE deleted=0').all().filter(row=>row.key!==rawKey);
      assert.deepEqual(foreignWrites,[],'old-root recovery diagnostics cannot publish a scope registry/recovery lock to newly accepted DATA');
      assert.equal(f.values.get(privateKey),'PRIVATE_KEEP_\uD55C\uAE00\nexact bytes');assert.equal(f.values.get('libra:pin:preserve'),'EXISTING_RAW_KEEP\n\u65E5\u672C\u8A9E');
    }finally{release();await f.close();}
  });
}
test('LIBRA: prepared mutation from old DATA is rejected in a fresh VM at the identical URL',async()=>{
  const f=await fixture('MemorySuiteStorageClient.libra.source.js');try{
    const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);const warm=f.make();
    const prepared=await warm.prepareConditionalBatch({mutations:[{kind:'set',space:'plugin',key:'libra:pin:prepared',value:'EXACT_OLD_DATA_CANDIDATE',expected:{exists:false}}]});
    await warm.dispose();await a.app.close();const b=await f.start('B',a.port),cold=f.make();
    const outcome=await cold.commitConditionalBatch(JSON.parse(JSON.stringify(prepared))).then(value=>({value}),error=>({error}));
    const physical=b.app.repositories.libra.database.prepare("SELECT key FROM kv WHERE key='libra:pin:prepared'").get();
    console.log(JSON.stringify({case:'prepared_wrong_root',wrongRootMutationApplied:!!physical,realModelCalls:0}));
    assert.equal(physical,undefined,'wrong DATA never receives the old prepared mutation');
    assert.ok(outcome.error&&/BOUNDARY_CHANGED|SERVER_PIN_CHANGED/.test(outcome.error.code||outcome.error.message),'foreign DATA pin is rejected visibly');
    assert.equal(f.calls.filter(c=>c.url.endsWith('/v1/kv/batch')).length,0,'pin rejection precedes mutation dispatch');
  }finally{await f.close();}
});
test('LIBRA: valid-checksum legacy preparation without DATA proof is refused without mutation',async()=>{
  const f=await fixture('MemorySuiteStorageClient.libra.source.js');try{
    const a=await f.start('A');f.args.set('memory_suite_server_url',a.url);const bridge=f.make();
    const prepared=JSON.parse(JSON.stringify(await bridge.prepareConditionalBatch({mutations:[{kind:'set',space:'plugin',key:'libra:pin:legacy-prepared',value:'LEGACY_CANDIDATE',expected:{exists:false}}]})));
    const b=prepared.boundary;prepared.boundary={namespace:b.namespace,scopeId:b.scopeId,mode:b.mode,url:b.url,serverUrl:b.serverUrl};
    const {payloadDigest,...data}=prepared;prepared.payloadDigest=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    await assert.rejects(()=>bridge.commitConditionalBatch(prepared),/SERVER_PIN_REQUIRED|BOUNDARY_CHANGED/);
    assert.equal(a.app.repositories.libra.database.prepare("SELECT key FROM kv WHERE key='libra:pin:legacy-prepared'").get(),undefined);
  }finally{await f.close();}
});
