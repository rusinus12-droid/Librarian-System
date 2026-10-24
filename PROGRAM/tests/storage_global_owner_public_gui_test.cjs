'use strict';
// Whole unmodified owner artifact, real mounted GUI, existing in-process handlers.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {create,pause,until,META}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const {createHandlerFixture}=require('./fixtures/shared_reanalysis_handler_fixture.cjs');
const {createBucketFixture}=require('./fixtures/flashback_bucketed_v1_fixture.cjs');
const owners={LIBRA:'libra',HAYAKU:'hayaku',Flashback:'flashback'};
const artifactRoot=process.env.GLOBAL_MODE_ARTIFACT_ROOT;
const kinds=artifactRoot?['Full','Min']:['Full'];
const cleanupOperation=async task=>{let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('cleanup GUI operation timed out')),20000);})]);}finally{clearTimeout(timer);}};
const hash=value=>{let h=0x811c9dc5;for(const c of value)h=Math.imul(h^c.charCodeAt(0),0x01000193);return (h>>>0).toString(36);};
const hash64=value=>{let h=0xcbf29ce484222325n;for(const c of value)h=BigInt.asUintN(64,(h^BigInt(c.charCodeAt(0)))*0x100000001b3n);return 'h64'+h.toString(36);};
const seedRoots=name=>{const roots=Array.from({length:2},(_,i)=>{
 const characterId='preserved-character-'+i,chatId='inactive-chat-'+i;
 if(name==='LIBRA'){const scopeKey='preserved-index-'+i;return [`libra:v1:scope:${scopeKey}:manifest`,JSON.stringify({schema:'libra.manifest.v1',scopeKey,characterId,chatId,memories:{},inheritedMemories:[],note:'exact root bytes '+i})];}
 if(name==='HAYAKU'){const scopeKey='chat_'+hash64(characterId+'\n'+chatId);return ['hayaku.v2.ledger.'+scopeKey,JSON.stringify({version:'hayaku_storage_ledger_v2',scopeKey,identity:{schema:'hayaku.scope_identity.v1',scopeKey,characterId,chatId},records:[],slotHeads:[],tombstones:[],note:'exact root bytes '+i})];}
 const scopeKey=`char:${hash(characterId)}|chat:${hash(chatId)}`,storageHash=hash(scopeKey);return [`vector_rag_memory:scope:${storageHash}:manifest:v2`,JSON.stringify({schema:'vector_rag_memory.scope_manifest.v2',version:2,scopeKey,storageHash,characterId,chatId,canonicalCharacterId:characterId,canonicalChatId:chatId,canonicalScopeId:scopeKey,shardCount:0,count:0,shardSummaries:[],note:'exact root bytes '+i})];
});
 if(name==='LIBRA'){
  const archiveId='migration-regression',scopeKey='preserved-index-0',canonicalId='memory:6282',memoryId='arc_memory:6282';
  const archive=`libra:v1:shared-archive:${archiveId}:manifest`,memory=`libra:v1:shared-archive:${archiveId}:memory:${canonicalId}:r2`;
  const vector=`libra:v1:scope:archive:${archiveId}:vector:${memoryId}:r2:old-profile`;
  const ref={key:memory,memoryId,revision:2,sourceDigest:'source-proof',status:'committed',vectorKey:`libra:v1:shared-archive:${archiveId}:vector:${canonicalId}:r2:retired-profile`};
  const root=JSON.parse(roots[0][1]);root.archiveRef={archiveId,manifestKey:archive};root.inheritedMemories=[ref];roots[0][1]=JSON.stringify(root);
  roots.push([archive,JSON.stringify({schema:'libra.shared_archive.v1',archiveId,memoryRefs:[ref]})],
   [memory,JSON.stringify({schema:'libra.canonical_memory.v1',scopeKey:`archive:${archiveId}`,archiveId,archiveCanonicalId:canonicalId,memoryId,revision:2,sourceDigest:'source-proof',embedding:{status:'ready',vectorKey:vector}})],
   [vector,JSON.stringify({scopeKey:`archive:${archiveId}`,memoryId,revision:2,profileId:'old-profile',entries:{global:{vector:[1,0]}}})]);
  const variantScope='preserved-index-1',variantMemory=`libra:v1:scope:${variantScope}:memory:1:r1`;
  const currentVector=`libra:v1:scope:${variantScope}:vector:mem_000011:r1:current-profile`;
  const variant={schema:'libra.canonical_memory.v1',scopeKey:variantScope,turnRange:{start:1,end:5},key:variantMemory,memoryId:'mem_000011',revision:1,sourceDigest:'variant-proof',status:'inactive',deltaStatus:'missing_legacy',
   embedding:{status:'ready',vectorKey:`libra:v1:scope:${variantScope}:vector:mem_000011:r1:lep_ftk24b`}};
  roots.push([`libra:v1:scope:${variantScope}:canonical-variants:v1`,JSON.stringify({schema:'libra.canonical_variant_index.v1',scopeKey:variantScope,slots:{1:{variants:[variant]}}})],
   [variantMemory,JSON.stringify({schema:'libra.canonical_memory.v1',scopeKey:variantScope,memoryId:variant.memoryId,revision:1,sourceDigest:variant.sourceDigest,status:'committed',turnRange:{start:1,end:5},embedding:{status:'ready',vectorKey:currentVector}})],
   [currentVector,JSON.stringify({scopeKey:variantScope,memoryId:variant.memoryId,revision:1,entries:{global:{vector:[1,0]}}})]);
  // The canonical body explicitly has no vector after quarantine cleanup,
  // while immutable inherited/archive indexes retain their old profile hint.
  const pendingKey=`libra:v1:shared-archive:${archiveId}:memory:pending:1:r1`;
  const pendingRef={key:pendingKey,memoryId:'arc_pending:1',revision:1,sourceDigest:'pending-proof',status:'committed',
   embeddingStatus:'rebuild_required',vectorCount:0,vectorKey:`libra:v1:shared-archive:${archiveId}:vector:pending:1:r1:retired-profile`};
  for(const key of [roots[0][0],archive]){
   const entry=roots.find(row=>row[0]===key),body=JSON.parse(entry[1]);
   (key===archive?body.memoryRefs:body.inheritedMemories).push(pendingRef);entry[1]=JSON.stringify(body);
  }
  roots.push([pendingKey,JSON.stringify({schema:'libra.canonical_memory.v1',scopeKey:`archive:${archiveId}`,archiveId,
   archiveCanonicalId:'pending:1',memoryId:pendingRef.memoryId,revision:1,sourceDigest:'pending-proof',status:'committed',
   embedding:{status:'rebuild_required',vectorKey:'',vectorCount:0}})]);
  // Preserve the same explicit pending state for a normal current-scope memory
  // whose canonical variant index still names the removed vector.
  const currentPendingKey=`libra:v1:scope:${variantScope}:memory:6:r1`;
  const currentPendingRef={key:currentPendingKey,memoryId:'mem_000006',revision:1,sourceDigest:'current-pending-proof',status:'committed',
   embeddingStatus:'rebuild_required',vectorCount:0,deltaStatus:'missing_legacy',vectorKey:`libra:v1:scope:${variantScope}:vector:mem_000006:r1:retired-profile`};
  const currentPendingManifestRef={...currentPendingRef};delete currentPendingManifestRef.vectorKey;
  const currentRoot=JSON.parse(roots[1][1]);currentRoot.memories={6:currentPendingManifestRef};roots[1][1]=JSON.stringify(currentRoot);
  const indexEntry=roots.find(row=>row[0]===`libra:v1:scope:${variantScope}:canonical-variants:v1`),indexBody=JSON.parse(indexEntry[1]);
  const currentPendingSnapshot={...currentPendingRef,schema:'libra.canonical_memory.v1',scopeKey:variantScope,turnRange:{start:6,end:10},
   embedding:{status:'ready',vectorKey:currentPendingRef.vectorKey}};
  delete currentPendingSnapshot.vectorKey;
  indexBody.slots[6]={variants:[currentPendingSnapshot]};indexEntry[1]=JSON.stringify(indexBody);
  roots.push([currentPendingKey,JSON.stringify({schema:'libra.canonical_memory.v1',scopeKey:variantScope,memoryId:currentPendingRef.memoryId,
   revision:1,sourceDigest:currentPendingRef.sourceDigest,status:'committed',turnRange:{start:6,end:10},
   text:'synthetic retained source',embedding:{status:'rebuild_required',vectorKey:'',vectorCount:0,provider:'voyageai',model:'voyage-4-large',
    dimensions:1024,profileId:'retired-profile',quarantinedProfileId:'retired-profile',reason:'previous quarantined vector deleted'}})]);
 }
 if(name==='Flashback'){
  const first=JSON.parse(roots[0][1]);first.commitId='retained-commit';first.shardCount=1;first.count=1;first.stats={recordTotal:1,charTotal:7,tokenTotal:2,byType:{response:{records:1,chars:7,tokens:2}}};first.shardSummaries=[{shardIndex:0,recordCount:1}];roots[0][1]=JSON.stringify(first);
  roots.push([`vector_rag_memory:scope:${first.storageHash}:records:shard:0000`,JSON.stringify({scopeKey:first.scopeKey,commitId:first.commitId,shard:0,records:[{id:'durable-record',scopeKey:first.scopeKey,sourceType:'response',type:'response',text:'durable',dim:4,vector:[],vectorPayloadMissing:true,
   vectorRef:{schema:'flashback_memory.local_vector_ref.v1',storage:'local',storageKey:`vector_rag_memory:local-vector-shard:v1:${first.storageHash}:retired:0000`,recordId:'durable-record',offset:0,length:4,digest:'fixture',mode:'local_float32_shard_v1'}}]})]);
  const second=JSON.parse(roots[1][1]),archiveId='fb_135rcsu',scopeKey='flashback_archive_v1:'+archiveId,storageHash=hash(scopeKey);
  const pointer={schema:'flashback_memory.archive_ref.v1',archiveId,archiveScopeKey:scopeKey,generation:1,depth:1,deltaCount:0,recordCount:0,digest:hash(''),responseTurnMax:0,createdAt:'',updatedAt:'',parentRef:null};
  const bucketFixture=createBucketFixture(second.scopeKey,second,{count:0,missingShards:32,commitId:'historical-label'});second.archiveRef=pointer;
  roots[1][1]=JSON.stringify({...bucketFixture.manifest,archiveRef:pointer});roots.push(...bucketFixture.buckets);
  roots.push([`vector_rag_memory:scope:${storageHash}:manifest:v2`,JSON.stringify({schema:'vector_rag_memory.scope_manifest.v2',version:2,scopeKey,storageHash,archiveOwner:true,archiveId,archiveGeneration:1,archiveRecordCount:0,archiveDigest:hash(''),archiveMemberCatalogVersion:1,archiveDeltaCount:0,archiveDeltaMemberIds:[],archiveDeltaDigest:hash(''),count:0,shardCount:0,shardSummaries:[]})],
   ['vector_rag_memory:scope_registry:v2',JSON.stringify({version:2,scopes:[{scopeKey,storageHash}]})]);
 }
 return roots;
};
const seedDevice=name=>{
 if(name!=='LIBRA')return [];
 const storageKey='libra:v1:scope:preserved-index-0:vector:mem_000006:r1:retired-profile';
 const comparable=storageKey.toLowerCase().replace(/[\s.,!?…。，、！？:;'"“”‘’()[\]{}<>#*_=`~|\\/—–-]+/g,'');
 const localKey='libra:v1:local-vector:'+parseInt(hash(comparable),36).toString(16).padStart(8,'0');
 return [[localKey,JSON.stringify({schema:'libra.local_vector_payload.v1',localKey,storageKey,keys:['global'],lengths:[1],byteLength:4,data:'AACAPw=='})]];
};
async function settleOwnerStore(s){let before=JSON.stringify([...s.values]),stable=0;for(let i=0;i<30;i++){await pause(100);const next=JSON.stringify([...s.values]);stable=next===before?stable+1:0;if(stable===3)return;before=next;}throw Error('owner startup store did not settle');}
function captureSeededRoots(s,name){return seedRoots(name).map(([key,seed])=>{
 const value=s.values.get(key);assert.equal(typeof value,'string');const body=JSON.parse(value);
 for(const [field,expected]of Object.entries(JSON.parse(seed))){
  if(key==='vector_rag_memory:scope_registry:v2'&&field==='scopes'){
   for(const entry of expected){const retained=body.scopes.find(row=>row.scopeKey===entry.scopeKey);assert.ok(retained,'startup retains historical archive registry entry');for(const [name,value]of Object.entries(entry))assert.deepEqual(retained[name],value,'startup preserves historical archive identity '+name);}
  }else assert.deepEqual(body[field],expected,'startup preserves seeded field '+key+'/'+field);
 }
 return [key,value];
});}
async function openPanel(s){
 await s.open();await pause(180);
 if(s.name==='LIBRA'){await settleOwnerStore(s);const firstRun=s.doc.querySelector('[data-libra-quick-dialog] .dialog__actions button');if(firstRun)await s.click('[data-libra-quick-dialog] .dialog__actions button');}
 if(s.name==='LIBRA'){await s.click('.topbar [data-go="settings"]');await until(()=>s.doc.querySelector('.setnav [data-subtab="store"]'),'settings room');await s.click('.setnav [data-subtab="store"]');}
 else if(s.name==='HAYAKU')await s.click('[data-hayaku-viewer-goto="server"]');
 else {await s.click('[data-go="connect"]');await s.click('button[data-group="c"][data-subtab="srv"]');}
 await until(()=>s.doc.querySelector('[data-apply]'),'global panel mounted',10000);
 assert(!s.doc.querySelector('[data-scope-perchat]'),'public owner artifact renders global-only selection');
 if(s.name==='Flashback'){
  // Await the real owner upgrade instead of assuming a brief quiet interval
  // means its deferred startup sweep has finished. Otherwise a reload can
  // legitimately upgrade only the authoritative server copy before reversal.
  for(const [key,value]of seedRoots(s.name))if(/:manifest:v2$/.test(key)){
   const manifest=JSON.parse(value);
   if(manifest.storageMode!=='bucketed_v1')await s.api.retireExternalSources(manifest.scopeKey);
  }
 }
 await settleOwnerStore(s);
}
async function apply(s,mode){
 let approvedWarningCount=0;
 const input=s.doc.querySelector(`input[value="${mode}"]`);assert(input);input.checked=true;input.dispatchEvent(new s.dom.window.Event('change',{bubbles:true}));
 s.context.confirm=()=>{throw Error('Native confirmation forbidden');};
 const approve=async button=>{const pending=button.onclick();await until(()=>s.doc.querySelector('[data-mode-confirm-approve]')?.onclick||s.doc.querySelector('[data-status]')?.textContent.includes('inventory_changed_during_preview'),'migration approval or fresh preview');const node=s.doc.querySelector('[data-mode-confirm-approve]');if(node?.onclick){
  if(s.name==='Flashback'){
   const preview=JSON.parse(s.doc.querySelector('[data-preview-diagnostics-text]').value);approvedWarningCount=preview.warningCount;
   assert.ok(approvedWarningCount>0);assert.equal(preview.warnings[0].code,'flashback_global_vector_payload_absent');
   assert.equal(s.doc.querySelector('[data-preview-diagnostics]').hidden,false);
   assert.match(s.doc.querySelector('[data-mode-confirm-text]').textContent,/경고 .*건.*키워드/);
  }
  node.click();}await pending;};
 const button=s.doc.querySelector('[data-apply]');await approve(button);
 // A read-only preview may observe the owner's own startup schema write. Exercise
 // the documented fresh confirmation path once, never skip an unknown-data blocker.
 if(s.doc.querySelector('[data-status]')?.textContent.includes('inventory_changed_during_preview')){s.globalInventoryRefreshes=(s.globalInventoryRefreshes||0)+1;await settleOwnerStore(s);const selected=s.doc.querySelector(`input[value="${mode}"]`);selected.checked=true;selected.dispatchEvent(new s.dom.window.Event('change',{bubbles:true}));await approve(s.doc.querySelector('[data-apply]'));}
 // Successful recovery may return the owner to its ordinary screen before the
 // awaiting click handler returns. Observe durable completion, then reopen the
 // real server panel rather than asserting against an already-removed view.
 await until(()=>{try{const job=JSON.parse(s.values.get(`__memory_suite_internal_sync_job_v1__:${owners[s.name]}`));return job?.status==='completed'&&job.targetMode===mode;}catch(_){return false;}},'durable global job completion',10000);
 if(!s.doc.querySelector('[data-status]'))await openPanel(s);
 await until(()=>s.doc.querySelector('[data-job].terminal'),'completed global job card',4000);
 const text=[s.doc.querySelector('[data-status]').textContent,s.doc.querySelector('[data-job-title]').textContent,s.doc.querySelector('[data-job-count]').textContent].join('\n');
 const diagnostics=JSON.parse(s.doc.querySelector('[data-job-diagnostics]').value);assert.equal(diagnostics.result.completeKnownScopes,true,text);assert.equal(diagnostics.result.mode,mode,text);assert.equal(diagnostics.result.verifiedScopes,3);assert.match(s.doc.querySelector('[data-job-count]').textContent,/3 \/ 3/,text);
 assert.equal(diagnostics.result.warningCount,approvedWarningCount,'completion retains the approved warning count');
 if(s.name==='Flashback'){assert.match(text,/경고 .*건.*키워드/);assert.match(s.doc.querySelector('[data-job-result]').textContent,/경고 .*건.*키워드/);}
 return text;
}
(async()=>{const results=[];for(const name of (process.env.GLOBAL_MODE_OWNER?[process.env.GLOBAL_MODE_OWNER]:Object.keys(owners)))for(const kind of kinds){
 const handler=createHandlerFixture(),namespace=owners[name],pluginPath=artifactRoot?path.join(artifactRoot,kind,META[name][0]):path.resolve(__dirname,'../plugins',META[name][0]);let s,restart,admittedSource;
 try{
  s=await create(name,kind,{pluginPath,separateLocalStorage:true,initialValues:seedRoots(name),initialDeviceValues:seedDevice(name),args:{memory_suite_server_url:handler.url},nativeFetch:handler.nativeFetch,beforeWrite:async(key,value)=>{
   if(!admittedSource&&s&&key===`__memory_suite_internal_sync_job_v1__:${namespace}`&&typeof value==='string'){
    const job=JSON.parse(value);
    // The prepared journal follows the owner writer drain and closes admission.
    // Startup normalization before that boundary is not a migration mutation.
    if(job.kind==='global_mode'&&job.phase==='prepared'&&job.status==='queued'&&job.targetMode==='server_only')admittedSource={roots:captureSeededRoots(s,name),values:[...s.values.entries()].filter(([key])=>!key.startsWith('__memory_suite_'))};
   }
  }});
  await openPanel(s);
  let before=[...s.values.entries()].filter(([key])=>!key.startsWith('__memory_suite_'));
  // Ordinary startup may normalize a minimal legacy manifest before confirmation.
  // Freeze the actual durable source while requiring every seeded identity/data field.
  let frozenRoots=captureSeededRoots(s,name);
  if(name==='LIBRA'||name==='HAYAKU')assert.equal(s.doc.querySelector('[data-scope-manager]'),null,'scope data management is separate from server settings');
  const forward=await apply(s,'server_only');const forwardRefreshes=s.globalInventoryRefreshes||0;
  assert.ok(admittedSource,'the public migration persisted its prepared journal before copying');
  frozenRoots=admittedSource.roots;before=admittedSource.values;
  console.log('FROZEN_OWNER_ROOTS',JSON.stringify({name,kind,roots:frozenRoots.map(([key,value])=>({key,bytes:Buffer.byteLength(value),sha256:require('node:crypto').createHash('sha256').update(value).digest('hex')}))}));
  const rows=handler.app.repositories[namespace].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all();
  for(const [key,value]of [...frozenRoots,...seedDevice(name)])assert(rows.some(row=>row.key===key&&JSON.parse(row.value_json)===value),'actual owner root transferred '+key);
  assert(rows.some(row=>row.key===`__memory_suite_scope_routes_v1__:${namespace}`),'global policy published to actual handler');
  for(const [key,value]of before)assert.equal(s.values.get(key),value,'forward preserves local source '+key);
  const saved=[...s.values],savedDevice=[...s.deviceValues];await s.close();s=null;
  restart=await create(name,kind,{pluginPath,separateLocalStorage:true,initialValues:saved,initialDeviceValues:savedDevice,args:{memory_suite_server_url:handler.url},nativeFetch:handler.nativeFetch});
  await openPanel(restart);
  if(name==='Flashback')assert.match(restart.doc.querySelector('[data-job-result]').textContent,/경고 .*건.*키워드/,'completed warnings survive plugin restart');
  assert.equal(restart.doc.querySelector('input[value="server_only"]').checked,true,'restart sees committed global policy');
  const reverseRows=handler.app.repositories[namespace].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all();
  console.log('REVERSE_PREFLIGHT_DIAGNOSTIC',JSON.stringify({name,kind,differences:reverseRows.filter(row=>restart.values.has(row.key)&&JSON.stringify(restart.values.get(row.key))!==row.value_json).map(row=>({key:row.key,local:restart.values.get(row.key),server:JSON.parse(row.value_json)}))}));
  const reverse=await apply(restart,'plugin_only');
  for(const [key,value]of frozenRoots)assert.equal(restart.values.get(key),value,'exact pre-confirmation native root survives roundtrip '+key);
  for(const [key,value]of seedDevice(name))assert.equal(restart.deviceValues.get(key),value,'retained local vector payload survives roundtrip '+key);
  const registry=JSON.parse(restart.values.get(`__memory_suite_internal_scope_routes_v1__:${namespace}`));assert.equal(registry.entries.__memory_suite_global__.mode,'plugin_only');
  assert(Object.values(registry.entries).filter(row=>row.scopeId!=='__memory_suite_global__').every(row=>row.origin==='inherited'));
  // Exercise the real owner resolvers and shared archive/index classification,
  // not only synthetic per-scope keys. The GUI may refresh while this runs.
  await pause(100);
  await cleanupOperation(restart.doc.querySelector('[data-server-delete]').onclick());
  assert.equal(restart.doc.querySelector('[data-cleanup-dialog]').hidden,false,'the review survives owner GUI hydration');
  assert.equal(restart.doc.querySelector('[data-cleanup-continue]').disabled,false,'verified shared and scoped payloads can be selected after moving back');
  const tombstonesBefore=handler.app.repositories[namespace].database.prepare('SELECT COUNT(*) AS n FROM kv WHERE deleted=1').get().n;
  await cleanupOperation(restart.doc.querySelector('[data-cleanup-continue]').onclick());
  const cleanupSummary=restart.doc.querySelector('[data-cleanup-summary]').textContent;
  assert.match(cleanupSummary,/정리 완료 · [1-9]\d*개 항목 삭제/);
  assert.match(cleanupSummary,/서버 삭제 전 백업:/);
  assert.equal(handler.app.repositories[namespace].database.prepare('SELECT COUNT(*) AS n FROM kv WHERE deleted=1').get().n,tombstonesBefore,'physical replica cleanup cannot introduce tombstones');
  for(const [key,value]of frozenRoots)assert.equal(restart.values.get(key),value,'server cleanup retains the actual native plugin root '+key);
  for(const [key,value]of seedDevice(name))assert.equal(restart.deviceValues.get(key),value,'server cleanup retains device vectors '+key);
  assert.equal(restart.wire.length,0,'no external network/model fallback');
  const result={name,kind,sourceSha256:restart.sourceSha256,status:'PASS',forward,reverse,handlerRequests:handler.trace.length,readOnlyPreviewRefreshes:forwardRefreshes+(restart.globalInventoryRefreshes||0)};results.push(result);console.log(JSON.stringify(result));
 }catch(error){const active=restart||s;if(active)console.error(JSON.stringify({name,kind,keys:[...active.values.keys()],localValues:[...active.values],deviceValues:[...active.deviceValues],serverRows:handler.app.repositories[namespace].database.prepare('SELECT key,value_json FROM kv WHERE deleted=0').all(),journal:active.values.get(`__memory_suite_internal_sync_job_v1__:${namespace}`),registry:active.values.get(`__memory_suite_internal_scope_routes_v1__:${namespace}`),status:active.doc.querySelector('[data-status]')?.textContent,errors:active.errors,logs:active.logs.slice(-8)},null,2));throw error;}
 finally{await restart?.close();await s?.close();await handler.close();}
}console.log(JSON.stringify({flows:results.length,results},null,2));})().catch(error=>{console.error(error);process.exitCode=1;});
