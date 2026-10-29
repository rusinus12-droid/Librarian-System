'use strict';
// Basic fake host only. Dropping the production issuer, brands, native identity
// checks, route checks or the honest unavailable admission must fail these cases.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const ROUTE='__memory_suite_internal_scope_routes_v1__:libra', REG='libra:v1:scope-registry:v1';
async function fixture(options={}){
 const chat={id:'native-chat',fmIndex:-1,message:[{role:'user',chatId:'native-u',data:'Final user source'},{role:'char',chatId:'native-a',data:'Final assistant source'}]};
 const character={chaId:'native-character',chatPage:0,chats:[chat]};let calls=0,fetches=0;
 const registry={'native-character::native-chat':{characterId:character.chaId,chatId:chat.id,scopeKey:'registered-scope'}};
 const routes={schema:'memory-suite.scope-routing.v1',namespace:'libra',pluginId:'LIBRA',legacyGlobalModeImported:true,entries:{'registered-scope':{scopeId:'registered-scope',scopeKey:'registered-scope',mode:options.mode||'plugin_only',origin:'user_explicit',updatedAt:1}}};
 const r=await createLibraVmHarness({}, {}, {transformSource:options.exposeBridge?(source=>source.replace("  const RisuCompat = (() => {","  globalThis.__testReadBridge = MemorySuiteStorageBridge;\n  const RisuCompat = (() => {")):undefined,initialValues:[[REG,JSON.stringify(registry)],[ROUTE,JSON.stringify(routes)]],contextGlobals:{setTimeout:(fn,ms,...args)=>ms<=120?setTimeout(fn,ms,...args):({unref(){}}),clearTimeout,setInterval:()=>({unref(){}}),clearInterval(){}}});
 await new Promise(resolve=>setImmediate(resolve));
 r.context.risuai.getCharacter=async()=>{calls++;if(options.readHost)return options.readHost(character);return character;};
 r.context.risuai.nativeFetch=async()=>{fetches++;throw Error('network forbidden');};
 const api=r.api,issue=(id='read-request-1',durationMs=30000)=>api.captureReadonlySourceContext({requestId:id,durationMs});
 const request=issued=>({handle:issued.handle,requestId:issued.summary.requestId});
 return {r,api,chat,character,routes,registry,issue,request,calls:()=>calls,fetches:()=>fetches,saveRoutes:()=>r.values.set(ROUTE,JSON.stringify(routes)),close:()=>r.cleanup()};
}
test('owner captures one native snapshot and the selected stored route without writes or network',async()=>{const f=await fixture();try{
 const writes=f.r.storageWrites.length,removes=f.r.storageRemovals.length,issued=await f.issue();
 assert.equal(f.calls(),1);assert.equal(issued.summary.usage,'request-local-source-snapshot');assert.equal(issued.summary.scope.scopeKey,'registered-scope');
 assert.equal(issued.summary.route.mode,'plugin_only');assert.equal(issued.summary.route.semanticModeEpoch,null);assert.equal(issued.summary.actualHostQualified,false);
 const value=f.api.readCapturedReadonlySource(f.request(issued));assert.equal(value.pairs.length,1);assert.equal(value.pairs[0].assistant.text,'Final assistant source');
 assert.equal(f.calls(),1);assert.equal(f.r.storageWrites.length,writes);assert.equal(f.r.storageRemovals.length,removes);assert.equal(f.fetches(),0);
 assert.ok(Object.isFrozen(value));assert.equal(issued.handle.scopeKey,undefined);
}finally{await f.close();}});
test('explicit currentness ignores text and tags, preserves the captured source, and new capture gets final text',async()=>{const f=await fixture();try{
 const one=await f.issue();f.chat.message[1].data='New final source<lb-xnai>{{inlay::image}}</lb-xnai>';
 const current=await f.api.assertReadonlySourceContextCurrent(f.request(one));assert.equal(current.status,'request-local-current');assert.equal(f.calls(),2);
 assert.equal(f.api.readCapturedReadonlySource(f.request(one)).pairs[0].assistant.text,'Final assistant source');
 const two=await f.issue('explicit-reanalysis');assert.match(f.api.readCapturedReadonlySource(f.request(two)).pairs[0].assistant.text,/New final source/);assert.equal(f.calls(),3);
}finally{await f.close();}});
test('dispatch currentness never reads ordinary source bodies',async()=>{const f=await fixture();try{
 const one=await f.issue();for(const row of f.chat.message)Object.defineProperty(row,'data',{get(){throw Error('body reread forbidden');},configurable:true});
 assert.equal((await f.api.assertReadonlySourceContextCurrent(f.request(one))).status,'request-local-current');
}finally{await f.close();}});
test('native replacement and deletion revoke a request even with unchanged text',async()=>{for(const change of ['replace','delete']){const f=await fixture();try{
 const one=await f.issue();if(change==='replace')f.chat.message[1].chatId='new-native-a';else f.chat.message.pop();
 await assert.rejects(()=>f.api.assertReadonlySourceContextCurrent(f.request(one)),/NATIVE_IDENTITY_CHANGED/);
 assert.throws(()=>f.api.readCapturedReadonlySource(f.request(one)),/NATIVE_IDENTITY_CHANGED/);
}finally{await f.close();}}});
test('opaque handles reject forged, cloned, cross-request and cross-owner values',async()=>{const f=await fixture(),g=await fixture();try{
 const one=await f.issue();for(const handle of [{},clone(one.handle),{...one.summary}])assert.throws(()=>f.api.readCapturedReadonlySource({handle,requestId:one.summary.requestId}),/INVALID_READ_CONTEXT_HANDLE/);
 assert.throws(()=>f.api.readCapturedReadonlySource({handle:one.handle,requestId:'other'}),/INVALID_READ_CONTEXT_HANDLE/);
 assert.throws(()=>g.api.readCapturedReadonlySource(f.request(one)),/INVALID_READ_CONTEXT_HANDLE/);
 await assert.rejects(()=>f.api.captureReadonlySourceContext({requestId:'forged-context',durationMs:30000,character:f.character,modeEpoch:99}),/READ_CONTEXT_REQUEST_INVALID/);
}finally{await f.close();await g.close();}});
test('missing native IDs and duplicate native IDs never become fallback proof',async()=>{for(const kind of ['character','chat','message','duplicate']){const f=await fixture();try{
 if(kind==='character')delete f.character.chaId;if(kind==='chat')delete f.chat.id;if(kind==='message')delete f.chat.message[1].chatId;if(kind==='duplicate')f.chat.message[1].chatId=f.chat.message[0].chatId;
 await assert.rejects(()=>f.issue(),/NATIVE_IDENTITY_UNAVAILABLE/);
}finally{await f.close();}}});
test('missing or invalid stored routing stays unsupported without initializing defaults',async()=>{for(const kind of ['absent','unknown','transition','removed','reset']){const f=await fixture();try{
 if(kind==='absent')f.r.values.delete(ROUTE);if(kind==='unknown')f.routes.entries['registered-scope'].mode='invented';if(kind==='transition')f.routes.entries['registered-scope'].origin='transition_pending';if(kind==='removed')f.routes.entries['registered-scope'].removed=true;if(!['absent','reset'].includes(kind))f.saveRoutes();if(kind==='reset')f.r.values.set('memory_suite_reset_choice.v2.libra','{}');
 const writes=f.r.storageWrites.length;await assert.rejects(()=>f.issue(),/READ_ROUTE_/);assert.equal(f.r.storageWrites.length,writes);assert.equal(f.fetches(),0);
}finally{await f.close();}}});
test('stored route changes invalidate handles; unrelated registry entries do not',async()=>{const f=await fixture();try{
 const one=await f.issue();f.routes.entries.unrelated={scopeId:'unrelated',mode:'server_only',updatedAt:2};f.saveRoutes();
 assert.equal((await f.api.assertReadonlySourceContextCurrent(f.request(one))).status,'request-local-current');
 f.routes.entries['registered-scope'].updatedAt=3;f.routes.entries['registered-scope'].mode='server_only';f.saveRoutes();
 await assert.rejects(()=>f.api.assertReadonlySourceContextCurrent(f.request(one)),/READ_ROUTE_CHANGED/);
}finally{await f.close();}});
test('server route is observed without bootstrap and cannot admit strong source capture',async()=>{const f=await fixture({mode:'server_only'});try{
 const one=await f.issue();assert.equal(one.summary.route.mode,'server_only');
 const admission=await f.api.admitReadonlySourceCapture(f.request(one));assert.equal(admission.status,'unsupported');assert.equal(admission.code,'SOURCE_PROOF_UNAVAILABLE');
 assert.ok(admission.reasons.includes('semantic_mode_epoch_unavailable'));assert.ok(admission.reasons.includes('host_mutation_authority_unavailable'));assert.equal(f.fetches(),0);
}finally{await f.close();}});
test('release and bounded admission prevent reusable or unlimited request state',async()=>{const f=await fixture();try{
 const issued=[];for(let i=0;i<4;i++)issued.push(await f.issue('request-'+i));await assert.rejects(()=>f.issue('overflow'),/READ_CONTEXT_LIMIT/);
 assert.equal(f.api.releaseReadonlySourceContext(f.request(issued[0])).status,'READ_CONTEXT_RELEASED');assert.throws(()=>f.api.readCapturedReadonlySource(f.request(issued[0])),/READ_CONTEXT_RELEASED/);
 assert.ok(await f.issue('replacement'));
}finally{await f.close();}});
test('native branch binds structural lineage without comparing edited or tag-decorated parent text',async()=>{const f=await fixture();try{
 const parent=clone(f.chat);parent.id='native-parent';parent.message[1].data='Different prior raw parent source';
 f.chat.message[1].data+=' <lb-xnai>{{inlay::new-tag}}</lb-xnai>';
 f.chat.message.push({role:'char',chatId:'branch-marker',disabled:true,isComment:true,data:'{{specialcomment::branchedfrom::native-parent::Parent::native-a::}}'});
 f.character.chats.push(parent);
 const one=await f.issue(),view=f.api.readCapturedReadonlySource(f.request(one));
 assert.equal(view.lineage.status,'identity-observed');assert.equal(view.lineage.sourcePrefixVerified,false);assert.equal(view.lineage.inheritanceEligible,false);
 Object.defineProperty(parent.message[1],'data',{get(){throw Error('parent text must not be compared');},configurable:true});
 assert.equal((await f.api.assertReadonlySourceContextCurrent(f.request(one))).status,'request-local-current');
 parent.message[1].chatId='replacement-fork';await assert.rejects(()=>f.api.assertReadonlySourceContextCurrent(f.request(one)),/NATIVE_IDENTITY_CHANGED/);
}finally{await f.close();}});
test('pending cancellation retains its physical slot and drops late host completion',async()=>{
 let release;const wait=new Promise(resolve=>{release=resolve;});const f=await fixture({readHost:async character=>{await wait;return character;}});try{
 const pending=[0,1,2,3].map(i=>f.issue('pending-'+i));for(const p of pending)p.catch(()=>{});
 assert.equal(f.api.cancelReadonlySourceContext({requestId:'pending-0'}).status,'READ_CONTEXT_CANCELLED');
 await assert.rejects(()=>f.issue('fifth-pending'),/READ_CONTEXT_LIMIT/);release();await assert.rejects(()=>pending[0],/READ_CONTEXT_CANCELLED/);
 await Promise.all(pending.slice(1));assert.ok(await f.issue('after-physical-settled'));
}finally{release();await f.close();}});
test('disposed and expired contexts reject late source reads without a timer',async()=>{const f=await fixture();try{
 const one=await f.issue('short-lived',50);await new Promise(resolve=>setTimeout(resolve,60));assert.throws(()=>f.api.readCapturedReadonlySource(f.request(one)),/READ_CONTEXT_EXPIRED/);
 const two=await f.issue('disposed');await f.close();assert.throws(()=>f.api.readCapturedReadonlySource(f.request(two)),/READ_CONTEXT_DISPOSED/);
}finally{await f.close();}});
test('source size and malformed Unicode fail before projection and storage reads',async()=>{for(const body of ['x'.repeat(2*1024*1024+1),'invalid\ud800']){const f=await fixture();try{
 f.chat.message[1].data=body;const reads=f.r.storageReads.length;await assert.rejects(()=>f.issue(),/READ_CONTEXT_SOURCE_LIMIT|NATIVE_SOURCE_UNSUPPORTED/);assert.equal(f.r.storageReads.length,reads);
}finally{await f.close();}}});
test('pair accumulation matches production for consecutive user/assistant rows',async()=>{const f=await fixture();try{
 f.chat.message.unshift({role:'assistant',chatId:'orphan-a',data:'Orphan'});f.chat.message.splice(2,0,{role:'user',chatId:'extra-u',data:'Extra user'});f.chat.message.push({role:'assistant',chatId:'extra-a',data:'Continued assistant'},{role:'user',chatId:'pending-u',data:'Pending'});
 const one=await f.issue(),captured=f.api.readCapturedReadonlySource(f.request(one)).pairs,normal=f.api.debugBuildPairs(f.chat,'ordinary-control');
 assert.equal(captured.length,normal.length);for(let i=0;i<normal.length;i++)for(const role of ['user','assistant']){assert.equal(captured[i][role].text,normal[i][role].text);assert.deepEqual(Array.from(captured[i][role].chatIds),Array.from(normal[i][role].chatIds));}
}finally{await f.close();}});
test('late route completion after cancellation is retired without leaking an SDK slot',async()=>{const f=await fixture();let release;try{
 const gate=new Promise(resolve=>{release=resolve;}),storage=f.r.context.risuai.pluginStorage,original=storage.getItem;let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});let delayed=true;
 storage.getItem=async key=>{if(key===ROUTE&&delayed){delayed=false;enteredResolve();await gate;}return original.call(storage,key);};
 const pending=f.issue('cancel-in-route');pending.catch(()=>{});await entered;f.api.cancelReadonlySourceContext({requestId:'cancel-in-route'});release();await assert.rejects(()=>pending,/READ_CONTEXT_CANCELLED/);
 for(let i=0;i<4;i++)assert.ok(await f.issue('clean-slot-'+i));
}finally{release?.();await f.close();}});
test('real SDK configuration admission changes its instance generation even if route rows are unchanged',async()=>{const f=await fixture({exposeBridge:true});try{
 const one=await f.issue();await f.r.context.__testReadBridge.setServerUrl('http://127.0.0.1:47630');
 await assert.rejects(()=>f.api.assertReadonlySourceContextCurrent(f.request(one)),/READ_ROUTE_CHANGED/);assert.equal(f.fetches(),0);
 const two=await f.issue('new-owner-generation');assert.ok(two.summary.route.routeEpoch.generation>one.summary.route.routeEpoch.generation);assert.equal(two.summary.route.semanticModeEpoch,null);
}finally{await f.close();}});
test('missing stored scope mapping does not create one and unknown proof fields are not trusted',async()=>{const f=await fixture();try{
 f.r.values.delete(REG);const before=f.r.storageWrites.length;await assert.rejects(()=>f.issue(),/READ_ROUTE_STORAGE_UNAVAILABLE/);assert.equal(f.r.storageWrites.length,before);assert.equal(f.r.values.has(REG),false);
 f.r.values.set(REG,JSON.stringify(f.registry));f.routes.entries['registered-scope'].modeEpoch=999;f.routes.entries['registered-scope'].authorityQualified=true;f.saveRoutes();const one=await f.issue();assert.equal(one.summary.route.semanticModeEpoch,null);assert.equal(one.summary.route.authorityQualified,false);
}finally{await f.close();}});
test('escaped native identity metadata is bounded before the whole descriptor is serialized',async()=>{const f=await fixture();try{
 f.chat.message=Array.from({length:250},(_,i)=>({role:i%2?'char':'user',chatId:String(i)+'\u0001'.repeat(400),data:'x'}));
 const reads=f.r.storageReads.length;await assert.rejects(()=>f.issue(),/READ_CONTEXT_METADATA_LIMIT/);assert.equal(f.r.storageReads.length,reads);
}finally{await f.close();}});
test('request context binds observed persisted publication across independent SDK instances without granting semantic proof',async()=>{const f=await fixture({exposeBridge:true});try{
 await f.r.context.__testReadBridge.setServerUrl('http://127.0.0.1:47630');const one=await f.issue('durable-diagnostic');
 assert.equal(one.summary.route.modePublication.status,'observed');assert.equal(one.summary.route.modePublication.atomicOwnerQualified,false);assert.equal(one.summary.route.semanticModeEpoch,null);
 const fs=require('node:fs'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteStorageClient.libra.source.js'),'utf8');
 const create=new Function('risuai',source+'\nreturn createMemorySuiteStorageBridge;')(f.r.context.risuai);
 const other=create({namespace:'libra',pluginId:f.r.context.__testReadBridge.pluginId,managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false});
 try {await other.setServerUrl('http://127.0.0.1:47630');}finally{await other.dispose();}
 await assert.rejects(()=>f.api.assertReadonlySourceContextCurrent(f.request(one)),/READ_ROUTE_CHANGED/);
 const two=await f.issue('new-publication');assert.equal(two.summary.route.semanticModeEpoch,null);assert.equal((await f.api.admitReadonlySourceCapture(f.request(two))).code,'SOURCE_PROOF_UNAVAILABLE');
}finally{await f.close();}});
test('pending and tampered persisted mode publications refuse request context without writes',async()=>{const f=await fixture({exposeBridge:true});try{
 await f.r.context.__testReadBridge.setServerUrl('http://127.0.0.1:47630');const saved=JSON.parse(f.r.values.get(ROUTE)),before=f.r.storageWrites.length;
 saved.modePublication.phase='pending';f.r.values.set(ROUTE,JSON.stringify(saved));await assert.rejects(()=>f.issue('pending-record'),error=>error.code==='READ_ROUTE_MODE_PUBLICATION_UNAVAILABLE'&&error.modePublicationStatus==='unsettled'&&error.modePublicationAttempts===9);
 saved.modePublication.phase='settled';saved.modePublication.routeDigest='0'.repeat(64);f.r.values.set(ROUTE,JSON.stringify(saved));await assert.rejects(()=>f.issue('tampered-record'),/READ_ROUTE_MODE_PUBLICATION_UNAVAILABLE/);
 assert.equal(f.r.storageWrites.length,before);assert.equal(f.fetches(),0);
}finally{await f.close();}});

test('a briefly pending publication is reread only after both copies settle, without any writes',async()=>{
 const f=await fixture({exposeBridge:true});try{
  await f.r.context.__testReadBridge.setServerUrl('http://127.0.0.1:47630');
  const settled=f.r.values.get(ROUTE),pending=JSON.parse(settled);pending.modePublication.phase='pending';
  f.r.values.set(ROUTE,JSON.stringify(pending));const writes=f.r.storageWrites.length;
  setTimeout(()=>f.r.values.set(ROUTE,settled),20);
  const result=await f.issue('settled-after-observation');
  assert.equal(result.summary.scope.scopeKey,'registered-scope');
  assert.equal(result.summary.route.mode,'plugin_only');
  assert.equal(JSON.parse(f.r.values.get(ROUTE)).modePublication.phase,'settled');
  assert.equal(f.r.storageWrites.length,writes);assert.equal(f.fetches(),0);
 }finally{await f.close();}
});
