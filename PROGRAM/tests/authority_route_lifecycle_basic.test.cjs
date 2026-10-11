'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {DatabaseSync}=require('node:sqlite');
const {observationFixture}=require('./fixtures/authority_observation_fixture.cjs');
const {createMemorySuiteServer}=require('../server/server.cjs');
const C=require('../server/authority/contracts.cjs');
const config=f=>({dataDir:f.dataDir,authorityProfile:C.CORE3_AUTHORITY_PROFILE,autoBackup:false,computeEnabled:false,token:'synthetic-route-no-listener-token'});
function appFor(t,f){const app=createMemorySuiteServer(config(f));t.after(()=>app.close());return app;}
async function request(app,url,body={},headers={},method='POST'){
 const req=new EventEmitter(),res=new EventEmitter();let result;
 Object.assign(req,{url,method,headers,destroy(){},resume(){}});
 res.writeHead=(status,headers)=>{res.statusCode=status;res.headers=headers;};res.getHeader=k=>res.headers?.[k];
 res.end=bytes=>{result={status:res.statusCode,body:bytes?JSON.parse(String(bytes)):null};res.emit('finish');};
 const work=app.server.listeners('request')[0](req,res);req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');await work;assert(result);return result;
}
async function owner(app,f,plugin='libra'){
 const b=await request(app,'/bootstrap',{}, {'x-memory-suite-plugin':plugin},'GET');assert.equal(b.status,200);
 return {authorization:'Bearer '+b.body.token,'x-memory-suite-plugin':plugin,'x-memory-suite-data-instance':f.physicalBinding.dataInstanceId};
}
const transition=(operationId,expectedRoute=null,mode='server_only',scopeId='scope-a',scopeKey='scopeA')=>({operationId,expectedRoute,target:{scopeId,scopeKey,mode,overrideKind:'explicit'}});
const call=(app,headers,action,body)=>request(app,'/v1/authority/'+action,body,headers);

test('real authenticated transition is atomically retained, replayed, reopened and CAS protected',async t=>{
 const f=observationFixture(t),initial=f.control.readInitialQualification(),app=appFor(t,f),headers=await owner(app,f);
 const first=await call(app,headers,'route/transition',transition('route-first'));assert.equal(first.status,200,JSON.stringify(first.body));
 const receipt=first.body.result;assert.equal(receipt.schema,'memory-suite.authority-route-receipt.v1');assert.equal(receipt.route.modeEpoch,1);assert.equal(receipt.route.mode,'server_only');assert.equal(receipt.nativeAuthority,'unavailable');
 assert.deepEqual((await call(app,headers,'route/transition',transition('route-first'))).body.result,receipt);
 assert.equal((await call(app,headers,'route/transition',transition('wrong-cas'))).status,409);
 const second=await call(app,headers,'route/transition',transition('route-second',receipt.route,'plugin_only'));assert.equal(second.status,200);assert.equal(second.body.result.route.modeEpoch,2);
 const third=await call(app,headers,'route/transition',transition('route-third',second.body.result.route));assert.equal(third.status,200);assert.equal(third.body.result.route.modeEpoch,3);
 assert.deepEqual(f.control.readInitialQualification(),initial);await app.close();const reopened=appFor(t,f),again=await owner(reopened,f);
 const read=await call(reopened,again,'route/read',{scopeId:'scope-a',scopeKey:'scopeA'});assert.equal(read.status,200);assert.equal(read.body.result.route.modeEpoch,3);
 assert.deepEqual((await call(reopened,again,'route/transition',transition('route-first'))).body.result,receipt);
 assert.equal(reopened.server.listening,false);await assert.rejects(reopened.listen(),{code:'AUTHORITY_HOST_PROFILE_UNQUALIFIED'});
});
test('request to server route to mutation to bound immutable capture and currentness is connected',async t=>{
 const f=observationFixture(t),app=appFor(t,f),headers=await owner(app,f);
 const route=(await call(app,headers,'route/transition',transition('route-capture'))).body.result;
 assert(route,'route must be committed before observation');
 const capture=await call(app,headers,'libra/observe',{...f.request(),scopeId:'scope-a'});assert.equal(capture.status,200,JSON.stringify(capture.body));
 const {handle,summary}=capture.body.result,args={handle,requestId:'request1'};assert.equal(typeof handle,'string');assert.equal(summary.routeAuthority,'server-semantic-settings.v1');assert.equal(summary.semanticModeEpoch,1);assert.equal(summary.nativeAuthority,'unavailable');assert.equal(summary.recallEligibility,'unqualified');
 assert.equal((await call(app,headers,'libra/read',args)).body.result.items[0].text,f.memory.text);
 assert.equal((await call(app,headers,'libra/current',args)).body.result.status,'current');
 const write=await request(app,'/v1/kv/set',{namespace:'libra',space:'plugin',key:f.key,value:JSON.stringify({...f.memory,text:'changed through actual handler'}),operationId:'route-body-change'},headers);assert.equal(write.status,200,JSON.stringify(write.body));
 assert.equal((await call(app,headers,'libra/current',args)).body.error,'SOURCE_CHANGED');
 const fresh=await call(app,headers,'libra/observe',{...f.request('request2'),scopeId:'scope-a'});assert.equal(fresh.status,200);
 assert.equal((await call(app,headers,'libra/read',{handle:fresh.body.result.handle,requestId:'request2'})).body.result.items[0].text,'changed through actual handler');
 const switched=await call(app,headers,'route/transition',transition('route-fence',route.route,'plugin_only'));assert.equal(switched.status,200);
 assert.equal((await call(app,headers,'libra/current',{handle:fresh.body.result.handle,requestId:'request2'})).body.error,'SOURCE_CHANGED');
 assert.equal((await call(app,headers,'libra/observe',{...f.request('request3'),scopeId:'scope-a'})).body.error,'AUTHORITY_ROUTE_UNAVAILABLE');
});
test('authenticated observer refuses forged handles, wrong owner request and missing or changed DATA binding',async t=>{
 const f=observationFixture(t),app=appFor(t,f),headers=await owner(app,f),hayaku=await owner(app,f,'hayaku');
 const route=await call(app,headers,'route/transition',transition('auth-route'));assert.equal(route.status,200);
 const c=await call(app,headers,'libra/observe',{...f.request(),scopeId:'scope-a'});assert.equal(c.status,200);const args={handle:c.body.result.handle,requestId:'request1'};
 assert.equal((await call(app,{},'libra/read',args)).status,403);
 assert.equal((await call(app,hayaku,'libra/read',args)).status,403);
 assert.equal((await call(app,headers,'libra/read',{...args,handle:'forged'})).status,403);
 assert.equal((await call(app,headers,'libra/read',{...args,requestId:'other'})).status,403);
 assert.equal((await call(app,{...headers,'x-memory-suite-data-instance':''},'libra/read',args)).status,409);
 assert.equal((await call(app,{...headers,'x-memory-suite-data-instance':'different'},'libra/read',args)).status,409);
 assert.equal((await call(app,headers,'libra/release',args)).body.result.status,'OBSERVATION_RELEASED');
 assert.equal((await call(app,headers,'libra/read',args)).body.error,'OBSERVATION_RELEASED');
});
test('route publication holds all real owner locks and corruption never becomes valid lifecycle history',async t=>{
 const f=observationFixture(t),app=appFor(t,f),headers=await owner(app,f),exec=DatabaseSync.prototype.exec;let active=new Set(),observed=false;
 DatabaseSync.prototype.exec=function(sql){const n=Object.keys(f.ownerBindings).find(n=>this.prepare('PRAGMA database_list').get()?.file===f.ownerBindings[n].filePath);const result=exec.call(this,sql);if(n&&sql==='BEGIN IMMEDIATE'){active.add(n);if(active.size===3)observed=true;}if(n&&/^(COMMIT|ROLLBACK)$/.test(sql))active.delete(n);return result;};
 let first;try{first=await call(app,headers,'route/transition',transition('locks-route'));}finally{DatabaseSync.prototype.exec=exec;}assert.equal(first.status,200);assert.equal(observed,true);
 await app.close();const db=new DatabaseSync(f.controlPath);try{db.prepare('UPDATE authority_routes SET mode_epoch=9').run();}finally{db.close();}
 assert.throws(()=>createMemorySuiteServer(config(f)),/AUTHORITY_QUARANTINED/);
});

for(const namespace of ['libra','hayaku','flashback'])test(namespace+': actual SDK mode setter reaches genuine semantic authority; ordinary diagnostic stays unqualified',async t=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),f=observationFixture(t),app=appFor(t,f);
 const scope={scopeId:'scope-a',scopeKey:'scopeA',characterId:'characterA',chatId:'chatA'},key='__memory_suite_internal_scope_routes_v1__:'+namespace;
 const values=new Map([[key,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace,legacyGlobalModeImported:true,entries:{'scope-a':{...scope,mode:'server_only',origin:'inherited',updatedAt:1}}})]]),args=new Map([['memory_suite_server_mode','server_only'],['memory_suite_server_url','http://127.0.0.1:47630']]);
 const store={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>{values.set(k,v);return true;},removeItem:async k=>values.delete(k),keys:async()=>[...values.keys()]};
 let loseTransitionReply=false;
 const calls=[],host={pluginStorage:store,getLocalPluginStorage:async()=>store,getArgument:async n=>args.get(n)||'',setArgument:async(n,v)=>{args.set(n,v);return true;},nativeFetch:async(url,init={})=>{const u=new URL(url),headers=Object.fromEntries(Object.entries(init.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));calls.push(u.pathname);const result=await request(app,u.pathname+u.search,init.body?JSON.parse(init.body):{},headers,init.method||'GET');if(loseTransitionReply&&u.pathname==='/v1/authority/route/transition'){loseTransitionReply=false;throw Error('SIMULATED_RESPONSE_LOSS');}return new Response(JSON.stringify(result.body),{status:result.status,headers:{'content-type':'application/json'}});}};
 // Global publication requires the host catalog and owner discovery. The
 // Core3 fixture's literal seed belongs to this one synthetic HAYAKU chat.
 host.getDatabase=async()=>({characters:[{id:'characterA',chats:[{id:'chatA'}]}]});
 const discoverGlobalScopes=async({hostScopes,records})=>{
  assert.equal(JSON.stringify(hostScopes.map(row=>[row.characterId,row.chatId])),JSON.stringify([['characterA','chatA']]));
  for(const row of records){assert.equal(row.logicalKey,'seed');assert.equal(row.space,'plugin');assert.equal(row.value,'hayaku');}
  return {scopes:[scope],records:records.map(row=>({...row,classification:'scope',scopeId:scope.scopeId})),blockers:[],completeKnownScopes:true};
 };
 const context=vm.createContext({risuai:host,console:{log(){},warn(){},error(){},info(){}},setTimeout,clearTimeout,queueMicrotask,AbortController,URL,TextEncoder,TextDecoder,crypto:globalThis.crypto,performance,Response,Headers});
 const sdk=namespace==='libra'?'MemorySuiteStorageClient.libra.source.js':'MemorySuiteStorageClient.source.js';vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk',sdk),'utf8')+'\nglobalThis.create=createMemorySuiteStorageBridge;',context);
 const bridge=context.create({namespace,pluginId:namespace,pluginVersion:'basic',managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>scope,...(namespace==='hayaku'?{discoverGlobalScopes,pluginKeys:['seed'],resolveKeyScope:async({key})=>key==='seed'?{kind:'scope',...scope}:null}:{})});bridge.createPluginStorageProxy(store);t.after(()=>bridge.dispose());
 await bridge.serverGet('plugin','seed');await bridge.setScopeMode(scope,'server_only');
 assert(calls.includes('/v1/authority/route/transition'),'actual SDK setter must call real authority transition');
 const view=await bridge.inspectServerModeAuthority(scope);assert.equal(view.status,'observed');assert.equal(view.route.modeEpoch,1);assert.equal(view.nativeAuthority,'unavailable');
 const diagnostic=await bridge.inspectModePublication();assert.equal(diagnostic.semanticModeEpoch,null);assert.equal(diagnostic.authorityQualified,false);
 if(namespace==='hayaku'){
  const catalog=host.getDatabase,before=[...values.entries()],beforeCalls=calls.length;
  delete host.getDatabase;
  await assert.rejects(()=>bridge.setGlobalMode('server_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE');
  assert.deepEqual([...values.entries()],before,'missing host catalog cannot publish local routes or jobs');
  assert.equal(calls.length,beforeCalls,'incomplete discovery stops before server transitions');
  host.getDatabase=catalog;
  const preview=await bridge.previewGlobalMode('server_only');
  assert.equal(preview.completeKnownScopes,true,JSON.stringify(preview));assert.equal(preview.discoveredScopes,1);
  loseTransitionReply=true;
  let outcome;try{outcome=await bridge.setGlobalMode('server_only');}catch(error){assert.equal(error.code,'SERVER_MODE_OPERATION_INDETERMINATE');}
  const pending=[...values.keys()].filter(k=>k.startsWith('__memory_suite_internal_server_route_v1__'));
  if(pending.length){
   assert.equal(pending.length,1);const journal=JSON.parse(values.get(pending[0]));
   const h=await owner(app,f,'hayaku'),status=await call(app,h,'route/status',{operationId:journal.body.operationId});assert.equal(status.body.result.status,'committed');
   await bridge.setServerUrl('http://127.0.0.1:47630');await bridge.serverGet('plugin','seed');await bridge.setGlobalMode('server_only');
   assert.equal(values.has(pending[0]),false);
   const replay=await call(app,h,'route/status',{operationId:journal.body.operationId});assert.deepEqual(replay.body.result,status.body.result);
  }else assert(outcome,'the same-operation status read must have recovered the lost ACK');
  assert.equal(loseTransitionReply,false,'ACK-loss injection reached the actual authority transition');
  const global=await call(app,await owner(app,f,'hayaku'),'route/read',{scopeId:'__memory_suite_global__',scopeKey:'__memory_suite_global__'});
  assert.equal(global.status,200);assert.equal(global.body.result.route.mode,'server_only');
  assert.equal(global.body.result.route.modeEpoch,1,'ACK recovery does not replace the committed global operation');
 }
 const before=C.canonical(f.control.readRoutes());await bridge.setServerUrl('http://127.0.0.1:47630');assert.equal(C.canonical(f.control.readRoutes()),before,'connection URL publication must not manufacture semantic route transitions');
 if(namespace==='libra'){
  await assert.rejects(()=>bridge.observeServerCanonicalFacts({}),e=>e.code==='SERVER_MODE_AUTHORITY_UNAVAILABLE');
  await bridge.serverGet('plugin','seed');
  const capture=await bridge.observeServerCanonicalFacts({requestId:'sdk-request',scopeId:scope.scopeId,scopeKey:scope.scopeKey,starts:[1],durationMs:120000});
  assert.equal(capture.summary.nativeAuthority,'unavailable');assert.equal((await bridge.readServerObservation({handle:capture.handle,requestId:'sdk-request'})).items[0].text,f.memory.text);
  assert.equal((await bridge.assertServerObservationCurrent({handle:capture.handle,requestId:'sdk-request'})).status,'current');
  await assert.rejects(()=>bridge.readServerObservation({handle:{},requestId:'sdk-request'}),e=>e.code==='INVALID_SERVER_OBSERVATION_HANDLE');
  await bridge.releaseServerObservation({handle:capture.handle,requestId:'sdk-request'});
 }
});

test('authenticated stored-source closure uses the same route binding without claiming native corpus',async t=>{
 const f=require('./fixtures/authority_source_closure_fixture.cjs').sourceClosureFixture(t),app=appFor(t,f),headers=await owner(app,f);
 assert.equal((await call(app,headers,'route/transition',transition('closure-route'))).status,200);
 const captured=await call(app,headers,'libra/observe-closure',{...f.sourceRequest(),scopeId:'scope-a'});assert.equal(captured.status,200,JSON.stringify(captured.body));
 const args={handle:captured.body.result.handle,requestId:'closure1'},view=await call(app,headers,'libra/read',args);assert.equal(view.body.result.items.length,6);assert.equal(view.body.result.receipt.coverage.complete,true);
 assert.equal(captured.body.result.summary.nativeAuthority,'unavailable');assert.equal(captured.body.result.summary.recallEligibility,'unqualified');assert.equal((await call(app,headers,'libra/current',args)).body.result.status,'current');
});
test('route dependencies bind global fallback and reject semantic ABA while preserving unrelated observations',async t=>{
 const f=observationFixture(t),app=appFor(t,f),headers=await owner(app,f),global='__memory_suite_global__';
 const g=await call(app,headers,'route/transition',{operationId:'global-route',expectedRoute:null,target:{scopeId:global,scopeKey:global,mode:'server_only',overrideKind:'global'}});assert.equal(g.status,200);
 const c=await call(app,headers,'libra/observe',{...f.request(),scopeId:'scope-a'});assert.equal(c.status,200);const args={handle:c.body.result.handle,requestId:'request1'};
 assert.equal((await call(app,headers,'route/transition',transition('unrelated-route',null,'plugin_only','scope-other','scopeOther'))).status,200);
 assert.equal((await call(app,headers,'libra/current',args)).body.result.status,'current');
 const down=await call(app,headers,'route/transition',{operationId:'global-down',expectedRoute:g.body.result.route,target:{scopeId:global,scopeKey:global,mode:'plugin_only',overrideKind:'global'}});assert.equal(down.status,200);
 const up=await call(app,headers,'route/transition',{operationId:'global-up',expectedRoute:down.body.result.route,target:{scopeId:global,scopeKey:global,mode:'server_only',overrideKind:'global'}});assert.equal(up.status,200);
 assert.equal((await call(app,headers,'libra/current',args)).body.error,'SOURCE_CHANGED');
 assert.equal((await call(app,headers,'route/status',{operationId:'no-such-operation'})).body.result.status,'uncertain');
});

test('committed route ACK loss is recovered by retained status without a replacement operation',async t=>{
 const f=observationFixture(t),app=appFor(t,f),headers=await owner(app,f),input=transition('ack-loss-route');
 const exec=DatabaseSync.prototype.exec;let armed=true;
 DatabaseSync.prototype.exec=function(sql){const file=this.prepare('PRAGMA database_list').get()?.file,result=exec.call(this,sql);if(armed&&sql==='COMMIT'&&file===f.controlPath){armed=false;throw Error('synthetic committed route ACK loss');}return result;};
 let result;try{result=await call(app,headers,'route/transition',input);}finally{DatabaseSync.prototype.exec=exec;}
 assert.notEqual(result.status,200);const status=await call(app,headers,'route/status',{operationId:input.operationId});assert.equal(status.status,200);assert.equal(status.body.result.status,'committed');
 const replay=await call(app,headers,'route/transition',input);assert.equal(replay.status,200);assert.deepEqual(replay.body.result,status.body.result.receipt);assert.equal(replay.body.result.route.modeEpoch,1);
});
