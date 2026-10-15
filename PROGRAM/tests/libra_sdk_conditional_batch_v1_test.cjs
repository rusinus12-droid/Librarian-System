'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createMemorySuiteServer}=require('../server/server.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'libra-sdk-batch-'));
const sdk=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.libra.source.js'),'utf8');
const createBridge=new Function(sdk+'\nreturn createMemorySuiteStorageBridge;')();
const results=[];async function test(name,fn){await fn();results.push(name);console.log('PASS',name);}
(async()=>{let app,bridge,prior=globalThis.risuai;let mode='server_only',scope={scopeId:'sdk-batch-scope',scopeKey:'sdk-batch-scope',available:true},fault='',calls=[],holdBootstrap=null;
try{
 app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:root,autoBackup:false});const addr=await app.listen(),url=`http://127.0.0.1:${addr.port}`;
 globalThis.risuai={getArgument:async n=>n==='memory_suite_server_url'?url:n==='memory_suite_server_mode'?mode:'',nativeFetch:async(u,i)=>{calls.push([u,i]);if(u.endsWith('/bootstrap')&&holdBootstrap){holdBootstrap.enter();await holdBootstrap.wait;}const out=await fetch(u,i);if(fault==='lost'&&u.endsWith('/v1/kv/batch')){fault='';throw Error('network_response_lost_after_server_commit');}if(fault==='old-projection'&&u.endsWith('/bootstrap')){const j=await out.json();delete j.capabilities['libra-graph-projection-pages.v1'];return new Response(JSON.stringify(j),{status:200});}if(fault==='bad-cap'&&u.endsWith('/bootstrap')){const j=await out.json();delete j.capabilities['conditional-batch.v1'];return new Response(JSON.stringify(j),{status:200});}return out;}};
 bridge=createBridge({namespace:'libra',pluginId:'libra',pluginPrefixes:['libra:'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,currentScopeProvider:async()=>scope,
  resolveKeyScope:({key,currentScope})=>key.startsWith('libra:foreign:')?{kind:'scope',scopeId:'other-scope'}:{kind:'scope',...currentScope}});
 const mem={map:new Map(),async getItem(k){return this.map.get(k)??null;},async setItem(k,v){this.map.set(k,v);return true;},async removeItem(k){return this.map.delete(k);},async keys(){return [...this.map.keys()];}};
 const proxy=bridge.createPluginStorageProxy(mem),absent={exists:false},expected=async key=>{const r=await bridge.serverGet('plugin',key);return {exists:r.exists,...(r.exists?{value:r.value}:{})};};
 const set=(key,value,exp=absent)=>({space:'plugin',key,kind:'set',value,expected:exp});
 await test('current binding waits for a pending certified bootstrap refresh without dropping route/reset checks',async()=>{
  await bridge.bootstrap();let enter,release;const started=new Promise(r=>enter=r),wait=new Promise(r=>release=r);holdBootstrap={enter,wait};
  const refresh=bridge.bootstrap(true);await started;let settled=false;
  const captured=bridge.captureServerBinding().then(value=>{settled=true;return value;});await Promise.resolve();assert.equal(settled,false);
  holdBootstrap=null;release();await refresh;const binding=await captured;
  assert.equal(binding.resetEpochCertified,true);assert.equal(binding.current,true);assert.equal(binding.dataInstanceId,bridge.serverBinding().dataInstanceId);
 });
 await test('real SDK prepares and atomically commits multiple exact values and read conditions',async()=>{
  await proxy.setItem('libra:basis','approved');const p=await bridge.prepareConditionalBatch({mutations:[set('libra:head',{t:5}),set('libra:registry',{person:'Mina'})],conditions:[{key:'libra:basis',expected:await expected('libra:basis')}]});
  const r=await bridge.commitConditionalBatch(p);assert.equal(r.endToEndVerified,true);assert.equal(r.receipts.length,2);assert.deepEqual(await proxy.getItem('libra:head'),{t:5});assert.equal(mem.map.has('libra:head'),false);
 });
 await test('stale preparation rejects every mutation without overwriting the external writer',async()=>{
  const p=await bridge.prepareConditionalBatch({mutations:[set('libra:head','old-candidate',await expected('libra:head')),set('libra:never','never')],conditions:[{key:'libra:basis',expected:await expected('libra:basis')}]});
  await proxy.setItem('libra:basis','new-approved');await assert.rejects(()=>bridge.commitConditionalBatch(p),e=>e.status===409);assert.equal((await bridge.serverGet('plugin','libra:never')).exists,false);assert.deepEqual(await proxy.getItem('libra:head'),{t:5});
 });
 await test('ABA restoring the same value still invalidates a pinned revision',async()=>{
  const p=await bridge.prepareConditionalBatch({mutations:[set('libra:head','candidate',await expected('libra:head'))]});
  await proxy.removeItem('libra:head');await proxy.setItem('libra:head',{t:5});await assert.rejects(()=>bridge.commitConditionalBatch(p),e=>e.status===409);assert.deepEqual(await proxy.getItem('libra:head'),{t:5});
 });
 await test('response loss resolves the original durable operation, not a new mutation',async()=>{
  const p=await bridge.prepareConditionalBatch({mutations:[set('libra:lost','once')]});fault='lost';const r=await bridge.commitConditionalBatch(p);assert.equal(r.endToEndVerified,true);assert.equal((await bridge.serverGet('plugin','libra:lost')).revision,1);
  await bridge.commitConditionalBatch(p);assert.equal((await bridge.serverGet('plugin','libra:lost')).revision,1);
 });
 await test('old receipt is not proof of current values after a later writer advances',async()=>{
  const p=await bridge.prepareConditionalBatch({mutations:[set('libra:advanced','first')]});await bridge.commitConditionalBatch(p);await proxy.setItem('libra:advanced','second');await assert.rejects(()=>bridge.commitConditionalBatch(p),e=>e.code==='MEMORY_SUITE_BATCH_COMMITTED_BUT_ADVANCED'&&e.storageMutationCommitted===true);assert.equal(await proxy.getItem('libra:advanced'),'second');
 });
 await test('tampered prepared payload and expired operation cannot be applied',async()=>{
  const p=await bridge.prepareConditionalBatch({mutations:[set('libra:tamper','first')]});p.body.mutations[0].value='modified';const n=calls.length;await assert.rejects(()=>bridge.commitConditionalBatch(p),/PREPARED_INVALID/);assert.equal(calls.length,n);
  const q=await bridge.prepareConditionalBatch({mutations:[set('libra:expired','first')]});q.preparedAt=1;await assert.rejects(()=>bridge.commitConditionalBatch(q),/EXPIRED/);assert.equal((await bridge.serverGet('plugin','libra:expired')).exists,false);
 });
 await test('wrong expected value, foreign scope and unowned key are rejected',async()=>{
  await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[set('libra:head','x',{exists:true,value:'wrong'})]}),/EXPECTED_VALUE_CHANGED/);
  await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[set('libra:foreign:key','x')]}),/ROUTE_UNSUPPORTED/);
  await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[set('foreign:key','x')]}),/KEY_NOT_OWNED/);
 });
 await test('duplicate keys, missing expectations and 64-key/4MiB bounds fail without writes',async()=>{
  await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[set('libra:dup',1),set('libra:dup',2)]}),/DUPLICATE/);
  await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[{kind:'set',key:'libra:noexp',value:1}]}),/EXPECTATION/);
  await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:Array.from({length:65},(_,i)=>set('libra:limit'+i,i))}),/ITEM_LIMIT/);
  await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[set('libra:large','x'.repeat(4*1024*1024))]}),/BODY_LIMIT/);assert.equal((await bridge.serverGet('plugin','libra:large')).exists,false);
 });
 await test('current scope change rejects the prepared transaction',async()=>{
  const p=await bridge.prepareConditionalBatch({mutations:[set('libra:scopechange','x')]});scope={scopeId:'changed',scopeKey:'changed',available:true};await assert.rejects(()=>bridge.commitConditionalBatch(p),/BOUNDARY_CHANGED|REQUIRES_SERVER_ONLY/);scope={scopeId:'sdk-batch-scope',scopeKey:'sdk-batch-scope',available:true};assert.equal((await bridge.serverGet('plugin','libra:scopechange')).exists,false);
 });
 await test('SQLite write failure rolls back SDK batch and exact same payload can retry',async()=>{
  const p=await bridge.prepareConditionalBatch({mutations:[set('libra:rollback-one',1),set('libra:rollback-two',2)]});app.repositories.libra.database.exec("CREATE TEMP TRIGGER sdk_fail BEFORE INSERT ON kv WHEN NEW.key='libra:rollback-two' BEGIN SELECT RAISE(ABORT,'sdk_batch_failure'); END;");
  await assert.rejects(()=>bridge.commitConditionalBatch(p));assert.equal((await bridge.serverGet('plugin','libra:rollback-one')).exists,false);app.repositories.libra.database.exec('DROP TRIGGER sdk_fail');assert.equal((await bridge.commitConditionalBatch(p)).endToEndVerified,true);
 });
 await test('read set is pinned before model wait and rejects same-value ABA or omitted keys',async()=>{
  const readSet=await bridge.captureConditionalReadSet(['libra:head']);assert.equal(await bridge.assertConditionalReadSet(readSet),true);
  await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[set('libra:pinmissing',1)],readSet}),/PIN_NOT_BOUND/);
  await proxy.setItem('libra:head',{t:5});await assert.rejects(()=>bridge.assertConditionalReadSet(readSet),/READ_SET_CHANGED/);
 });
 await test('read observers reserve before actual read and always release without replacing route or body validation',async()=>{
  let active=0,stages=0,seen=0;
  const readObserver=()=>{active++;return {accept(){seen++;},prepare(){stages++;return{release(){stages--;}};},release(){active--;}};};
  const pin=await bridge.captureConditionalReadSet(['libra:head'],{readObserver});
  assert.equal(await bridge.assertConditionalReadSet(pin,{readObserver}),true);assert.equal(seen,2);assert.equal(active,0);assert.equal(stages,0);
  await assert.rejects(()=>bridge.captureConditionalReadSet(['libra:head'],{readObserver:()=>{active++;return{accept(){throw Error('admission_refused');},release(){active--;}};}}),/admission_refused/);
  assert.equal(active,0);assert.equal(stages,0);
  await proxy.setItem('libra:head',{t:9});
  await assert.rejects(()=>bridge.assertConditionalReadSet(pin,{readObserver}),/READ_SET_CHANGED/);assert.equal(active,0);assert.equal(stages,0);
  await assert.rejects(()=>bridge.captureConditionalReadSet(['libra:head'],{readObserver:'invalid'}),/READ_OBSERVER_INVALID/);
 });
 await test('build refuses an older GC owner that cannot retain paged projections, while old reads remain available',async()=>{
  fault='old-projection';await bridge.bootstrap(true);
  await assert.rejects(()=>bridge.acquireGraphStorageLease(scope.scopeKey,'build'),/PROJECTION_UPGRADE_REQUIRED/);
  const read=await bridge.acquireGraphStorageLease(scope.scopeKey,'read');assert.ok(read);await read.release();
  fault='';await bridge.bootstrap(true);
  const build=await bridge.acquireGraphStorageLease(scope.scopeKey,'build');assert.ok(build);await build.release();
 });
 await test('unsupported capability and plugin-only mode do not silently downgrade to sequential writes',async()=>{
  await bridge.dispose();fault='bad-cap';bridge=createBridge({namespace:'libra',pluginId:'libra',pluginPrefixes:['libra:'],managementButton:false,startupDiagnostics:false,currentScopeProvider:async()=>scope});bridge.createPluginStorageProxy(mem);await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[set('libra:unsupported',1)]}),/CAPABILITY_MISSING/);fault='';await bridge.dispose();mode='plugin_only';bridge=createBridge({namespace:'libra',pluginId:'libra',pluginPrefixes:['libra:'],managementButton:false,startupDiagnostics:false,currentScopeProvider:async()=>scope});bridge.createPluginStorageProxy({...mem,map:new Map()});const n=calls.length;await assert.rejects(()=>bridge.prepareConditionalBatch({mutations:[set('libra:offline',1)]}),/REQUIRES_SERVER_ONLY/);assert.equal(calls.length,n);
 });
 console.log(JSON.stringify({test:'libra_sdk_conditional_batch_v1',passed:results.length,results,boundary:'real deployed LIBRA SDK, local HTTP/SQLite; no external model or actual RisuAI'}));
}finally{await bridge?.dispose();globalThis.risuai=prior;await app?.close();fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
