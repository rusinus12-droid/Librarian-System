'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {test}=require('node:test');
const {createArchiveReportingFixture,enableDefaultControls}=require('./fixtures/archive_issued_tail_fixture.cjs');
enableDefaultControls();
const sourcePath=path.join(__dirname,'../plugins/Flashback_Memory.js');
const clone=value=>JSON.parse(JSON.stringify(value));
async function setup(){
 const f=await createArchiveReportingFixture();
 const cfg=f.api._test.normalizeSettings({...f.fixtureSettings,embeddingDimensions:6});await f.api.saveSettings(cfg);
 const ownerKey=[...f.pluginStorage.values.keys()].find(k=>k.endsWith(':manifest:v2')&&f.parseStoredValue(f.pluginStorage.values.get(k))?.scopeKey===f.scope.scopeKey);
 if(typeof f.api.archiveRecovery?.preview!=='function'){await f.dispose();assert.equal(typeof f.api.archiveRecovery?.preview,'function','separate public archive controller must exist');}
 return Object.assign(f,{cfg,ownerKey,controller:f.api.archiveRecovery,owner:()=>f.parseStoredValue(f.pluginStorage.values.get(ownerKey))});
}
const requestState=value=>Object.values(value?.embeddingAttemptRegistry?.entries||{}).find(x=>x.archiveBinding)?.state;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const within=async(p,ms=2000)=>Promise.race([p,delay(ms).then(()=>{throw Error('bounded public action or injection seam did not settle')})]);
for(const phase of ['reserved','submitted'])for(const failure of ['reject','lost_ack'])test(`archive ${phase} ${failure} never crosses the document wire`,async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));
  const write=f.pluginStorage.setItem.bind(f.pluginStorage);let hit=false,wires=0;
  f.host.nativeFetch=async()=>{wires++;throw Error('forbidden document wire')};
  f.pluginStorage.setItem=async(k,v)=>{
   if(k===f.ownerKey&&requestState(f.parseStoredValue(v))===phase&&!hit){hit=true;if(failure==='reject')return false;await write(k,v);throw Error('synthetic lost acknowledgement');}
   return write(k,v);
  };
  const result=await f.controller.repair(preview.ticket);assert(hit,'target durable phase was exercised');assert.equal(wires,0);assert.equal(result.archiveReembedded,0);assert.notEqual(result.status,'verified');
  assert.equal(JSON.stringify(f.owner().archiveRef),JSON.stringify(f.ref));
  if(failure==='lost_ack'){
   f.pluginStorage.setItem=write;await f.restart(sourcePath);
   const next=await f.api.archiveRecovery.preview();assert.equal(next.allowed,false);assert.equal(wires,0,'restart cannot bypass unresolved history');
  }
 }finally{await f.dispose()}
});
for(const fault of ['provider_reject','provider_unknown','candidate_reject','candidate_lost_ack','head_reject','head_lost_ack'])test(`archive independent effect receipts retain ${fault}`,async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));
  const provider=f.host.nativeFetch.bind(f.host),write=f.pluginStorage.setItem.bind(f.pluginStorage);let wires=0,hit=false;
  f.host.nativeFetch=async(u,i)=>{wires++;assert.equal(requestState(f.owner()),'submitted','durable submission exists at actual provider boundary');
   if(fault==='provider_reject')return {ok:false,status:400,async json(){return {error:{message:'rejected'}}}};
   if(fault==='provider_unknown')throw Error('synthetic unknown outcome');return provider(u,i);
  };
  f.pluginStorage.setItem=async(k,v)=>{
   const parsed=f.parseStoredValue(v),candidate=String(k).includes(':scope:')&&k!==f.ownerKey&&!f.protectedArchive.has(k),head=k===f.ownerKey&&parsed?.archiveRepairReceipt?.status==='complete';
   if(!hit&&((fault.startsWith('candidate_')&&candidate)||(fault.startsWith('head_')&&head))){hit=true;if(fault.endsWith('reject'))return false;await write(k,v);throw Error('synthetic lost acknowledgement');}return write(k,v);
  };
  const result=await f.controller.repair(preview.ticket);assert.equal(wires,1,'one request only, no preflight or hidden retry');
  assert(result.provider&&result.candidates&&result.publication&&result.journal,'independent effects are reported');assert.equal(result.writeIssued,true);
  if(fault.startsWith('candidate_')||fault.startsWith('head_'))assert(hit,'the named physical write fault was actually reached');
  assert.equal(result.provider.state,fault==='provider_reject'?'rejected':fault==='provider_unknown'?'unknown':'completed');
  if(fault.startsWith('provider_')){assert.equal(result.candidates.state,'none');assert.equal(result.publication.state,'none');assert.equal(result.journal.state,'verified');}
  if(fault.startsWith('candidate_')){assert.equal(result.candidates.state,fault.endsWith('reject')?'rejected':'unknown');assert.equal(result.publication.state,'none');}
  if(fault==='head_reject'){assert.equal(result.candidates.state,'verified');assert.equal(result.publication.state,'rejected');}
  if(fault==='head_lost_ack'){assert(hit);assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(result.archiveReembedded,1);}
  else {assert.equal(result.archiveReembedded,0);assert.notEqual(result.status,'verified');assert.equal(JSON.stringify(f.owner().archiveRef),JSON.stringify(f.ref));}
  f.assertMapSubsetUnchanged(f.protectedArchive,f.pluginStorage.values,'retained archive bytes');f.assertMapSubsetUnchanged(f.archiveVectors,f.safeLocalStorage.values,'retained sidecars');
  f.pluginStorage.setItem=write;await f.restart(sourcePath);const again=await f.api.archiveRecovery.preview();
  if(fault!=='head_lost_ack')assert.equal(again.allowed,false,'all unresolved effects are restart fences');assert.equal(wires,1);
 }finally{await f.dispose()}
});
for(const changed of ['settings_aba','credential','owner_manifest','ancestor_manifest','ancestor_sidecar'])test(`archive frozen authority rejects ${changed} before reservation and wire`,async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));
  if(changed==='settings_aba'){await f.api.saveSettings({...f.cfg,embeddingDimensions:7});await f.api.saveSettings(f.cfg);}
  if(changed==='credential'){const get=f.host.getArgument.bind(f.host);f.host.getArgument=async k=>String(k).includes('embedding_key')?'different-fixture-key':get(k);}
  if(changed==='owner_manifest'){const value=f.owner();value.updatedAt='2099-01-01';f.pluginStorage.values.set(f.ownerKey,JSON.stringify(value));}
  if(changed==='ancestor_manifest'){const key=[...f.protectedArchive.keys()].find(k=>k.endsWith(':manifest:v2')),value=f.parseStoredValue(f.pluginStorage.values.get(key));value.archiveDeltaMemberIds=[];f.pluginStorage.values.set(key,JSON.stringify(value));}
  if(changed==='ancestor_sidecar'){const key=[...f.archiveVectors.keys()][0];assert(key);const value=f.parseStoredValue(f.safeLocalStorage.values.get(key));value.data='damaged';f.safeLocalStorage.values.set(key,value);}
  let writes=0,wires=0;f.pluginStorage.setItem=async()=>{writes++;return true};f.host.nativeFetch=async()=>{wires++;throw Error('forbidden')};
  const result=await f.controller.repair(preview.ticket);assert.equal(result.status,'blocked',JSON.stringify(result));assert.equal(writes,0);assert.equal(wires,0);
 }finally{await f.dispose()}
});
for(const limits of [{maxRequests:0},{maxRecords:0},{maxChars:1},{maxCandidateBytes:1}])test(`archive predictable bound ${JSON.stringify(limits)} has no writes or requests`,async()=>{
 const f=await setup();try{let writes=0,wires=0;const write=f.pluginStorage.setItem.bind(f.pluginStorage);f.pluginStorage.setItem=async(...a)=>{writes++;return write(...a)};f.host.nativeFetch=async()=>{wires++;throw Error('forbidden')};
  const preview=await f.controller.preview(limits);assert.equal(preview.allowed,false,JSON.stringify(preview));assert.equal(writes,0);assert.equal(wires,0);
 }finally{await f.dispose()}
});
test('archive clear during provider wire retains lifetime ownership and never adopts a late response',async()=>{
 const f=await setup();let release;try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));
  let entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),provider=f.host.nativeFetch.bind(f.host);let wires=0;
  f.host.nativeFetch=async(u,i)=>{wires++;entered();await gate;return provider(u,i)};
  const pending=f.controller.repair(preview.ticket);await within(started,10000);f.controller.clear();
  assert.equal((await within(f.api.healthRecovery.previewPhysicalRepair())).allowed,false,'local preview blocked while archive physical tail is outstanding');
  assert.equal((await within(f.controller.preview())).allowed,false,'archive cannot reuse a cleared physical owner');
  release();const result=await pending;assert.notEqual(result.status,'verified');assert.equal(result.archiveReembedded,0);assert.equal(wires,1);assert.equal(JSON.stringify(f.owner().archiveRef),JSON.stringify(f.ref));
 }finally{release?.();await f.dispose()}
});
test('local and archive previews synchronously share admission in both directions',async()=>{
 const f=await setup();let release;try{
  for(const first of ['local','archive']){
   const get=f.pluginStorage.getItem.bind(f.pluginStorage);let entered,hit=false;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
   f.pluginStorage.getItem=async k=>{if(!hit&&k===f.ownerKey){hit=true;entered();await gate}return get(k)};
   const pending=first==='local'?f.api.healthRecovery.previewPhysicalRepair():f.controller.preview();await within(started,10000);
   const denied=await within(first==='local'?f.controller.preview():f.api.healthRecovery.previewPhysicalRepair());assert.equal(denied.allowed,false,'competing preview cannot start while admission is leased');
   release();await pending;f.pluginStorage.getItem=get;f.controller.clear();
  }
 }finally{release?.();await f.dispose()}
});
test('archive physical action never touches checkpoint inventory or ordinary settings reconciliation',async()=>{
 const f=await setup();try{
  const get=f.pluginStorage.getItem.bind(f.pluginStorage),localGet=f.safeLocalStorage.getItem.bind(f.safeLocalStorage),write=f.pluginStorage.setItem.bind(f.pluginStorage);
  f.pluginStorage.getItem=async k=>{assert.doesNotMatch(String(k),/embedding[_:-]?checkpoint/);return get(k)};
  f.safeLocalStorage.getItem=async k=>{assert.doesNotMatch(String(k),/embedding[_:-]?checkpoint/);return localGet(k)};
  f.pluginStorage.keys=async()=>{throw Error('no inventory listing allowed')};f.safeLocalStorage.keys=async()=>{throw Error('no inventory listing allowed')};
  f.pluginStorage.removeItem=async()=>{throw Error('no deletion allowed')};f.safeLocalStorage.removeItem=async()=>{throw Error('no deletion allowed')};
  f.host.setArgument=async()=>{throw Error('no credential reconciliation allowed')};
  f.pluginStorage.setItem=async(k,v)=>{assert.doesNotMatch(String(k),/settings|secret|checkpoint|scope_routes/);return write(k,v)};
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));const result=await f.controller.repair(preview.ticket);assert.equal(result.status,'verified',JSON.stringify(result));
 }finally{await f.dispose()}
});

for(const seam of ['submitted_readback','provider_return','candidate_verified'])test(`archive settings ABA at ${seam} prevents stale publication`,async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));
  const get=f.pluginStorage.getItem.bind(f.pluginStorage),provider=f.host.nativeFetch.bind(f.host);let hit=false,wires=0;
  const change=async()=>{hit=true;await f.api.saveSettings({...f.cfg,embeddingDimensions:7});await f.api.saveSettings(f.cfg)};
  f.pluginStorage.getItem=async k=>{const raw=await get(k),value=f.parseStoredValue(raw);
   if(!hit&&seam==='submitted_readback'&&k===f.ownerKey&&requestState(value)==='submitted')await change();
   if(!hit&&seam==='candidate_verified'&&k!==f.ownerKey&&value?.archiveOwner&&value?.archiveRepairReceipt?.operationId)await change();
   return raw;
  };
  f.host.nativeFetch=async(u,i)=>{wires++;const response=await provider(u,i);if(seam==='provider_return'&&!hit)await change();return response};
  const result=await f.controller.repair(preview.ticket);assert(hit,'named awaited authority seam reached');assert.equal(wires,seam==='submitted_readback'?0:1);assert.equal(result.archiveReembedded,0);assert.notEqual(result.status,'verified');assert.equal(JSON.stringify(f.owner().archiveRef),JSON.stringify(f.ref));
 }finally{await f.dispose()}
});
test('archive candidate host-write timeout retains physical owner through clear until actual settlement',{timeout:15000},async()=>{
 const f=await setup();let release;try{
  const preview=await f.controller.preview({timeoutMs:2000});assert.equal(preview.allowed,true,JSON.stringify(preview));
  const write=f.pluginStorage.setItem.bind(f.pluginStorage);let entered,hit=false;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.pluginStorage.setItem=async(k,v)=>{if(!hit&&String(k).includes(':records:commit:')&&!f.protectedArchive.has(k)){hit=true;entered();await gate;}return write(k,v)};
  const pending=f.controller.repair(preview.ticket);await within(Promise.race([started,pending.then(result=>{throw Error('candidate write seam was not reached: '+JSON.stringify(result))})]),10000);const result=await within(pending,6000);assert.equal(result.status,'uncertain');assert.equal(result.candidates.state,'unknown');assert.equal(result.archiveReembedded,0);
  f.controller.clear();assert.equal((await within(f.controller.preview())).allowed,false);assert.equal((await within(f.api.healthRecovery.previewPhysicalRepair())).allowed,false,'a late host write still owns the shared action domain');
  assert.equal(f.controller.getState().busy,true);release();await delay(40);assert.equal(f.controller.getState().busy,false);assert.equal(JSON.stringify(f.owner().archiveRef),JSON.stringify(f.ref));
  assert.equal(result.status,'uncertain','late settlement cannot mutate the sealed result');
 }finally{release?.();await f.dispose()}
});
for(const first of ['archive','local'])test(`archive and existing physical execution share admission when ${first} starts first`,async()=>{
 const f=await setup();let release;try{
  await f.seedMixed(f.cfg);const local=await f.api.healthRecovery.previewPhysicalRepair(),archive=await f.controller.preview();
  assert.equal(local.allowed,true,JSON.stringify(local));assert.equal(archive.allowed,true,JSON.stringify(archive));
  const provider=f.host.nativeFetch.bind(f.host);let entered,wires=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.host.nativeFetch=async(u,i)=>{wires++;entered();await gate;return provider(u,i)};
  const pending=first==='archive'?f.controller.repair(archive.ticket):f.api.healthRecovery.repair(local);await within(started,10000);
  const denied=await within(first==='archive'?f.api.healthRecovery.repair(local):f.controller.repair(archive.ticket));assert.equal(denied.status,'blocked');assert.equal(wires,1,'competing action never reaches a model');
  f.controller.clear();release();await pending;
 }finally{release?.();await f.dispose()}
});
test('portable export admission prevents archive preview while its owner read is pending',async()=>{
 const f=await setup();let release;try{
  const get=f.pluginStorage.getItem.bind(f.pluginStorage);let entered,hit=false;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.pluginStorage.getItem=async k=>{if(!hit&&k===f.ownerKey){hit=true;entered();await gate}return get(k)};
  const pending=f.context.__FlashbackPortableMemoryBackup.exportCurrentScope();await within(started,10000);
  assert.equal((await within(f.controller.preview())).allowed,false);release();await pending;
 }finally{release?.();await f.dispose()}
});
test('pre-existing operation candidate collision blocks before durable reservation or provider',async()=>{
 const f=await setup();try{
  const get=f.pluginStorage.getItem.bind(f.pluginStorage),before=new Set(f.pluginStorage.values.keys());let hit=false,wires=0,writes=0;
  f.pluginStorage.getItem=async k=>{if(!before.has(k)&&String(k).endsWith(':manifest:v2')){hit=true;return JSON.stringify({schema:'collision'})}return get(k)};
  f.pluginStorage.setItem=async()=>{writes++;return true};f.host.nativeFetch=async()=>{wires++;throw Error('forbidden')};
  const preview=await f.controller.preview();assert(hit,'new candidate namespace was collision checked');assert.equal(preview.allowed,false);assert.match(preview.reason,/collision/i);assert.equal(wires,0);assert.equal(writes,0);
 }finally{await f.dispose()}
});
test('candidate readback corruption retains submitted attempt without publishing',async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));
  const get=f.pluginStorage.getItem.bind(f.pluginStorage);let hit=false;
  f.pluginStorage.getItem=async k=>{const raw=await get(k);if(raw!=null&&String(k).includes(':records:commit:')&&!f.protectedArchive.has(k)){hit=true;return String(raw)+'tampered'}return raw};
  const result=await f.controller.repair(preview.ticket);assert(hit,'candidate physical readback was tested');assert.equal(result.archiveReembedded,0);assert.equal(result.provider.state,'completed');assert.notEqual(result.candidates.state,'verified');assert.equal(result.publication.state,'none');assert.equal(requestState(f.owner()),'submitted');assert.equal(JSON.stringify(f.owner().archiveRef),JSON.stringify(f.ref));
 }finally{await f.dispose()}
});
for(const malformed of ['count','dimension','nan','zero'])test(`archive malformed ${malformed} output cannot create or publish a candidate`,async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));let wires=0;
  f.host.nativeFetch=async(_u,i)=>{wires++;const input=JSON.parse(i.body).input,dimensions=malformed==='dimension'?5:6;
   const data=input.map((_,index)=>({index,embedding:Array.from({length:dimensions},(_,i)=>malformed==='nan'&&i===0?NaN:malformed==='zero'?0:Number(i===0))}));if(malformed==='count')data.pop();return {ok:true,status:200,async json(){return {data}}};};
  const result=await f.controller.repair(preview.ticket);assert.equal(wires,1);assert.equal(result.archiveReembedded,0);assert.equal(result.candidates.state,'none');assert.equal(result.publication.state,'none');assert.notEqual(result.status,'verified');assert.equal(JSON.stringify(f.owner().archiveRef),JSON.stringify(f.ref));
 }finally{await f.dispose()}
});
test('complete multi-chunk archive group exceeding configured provider batch refuses without shrinking it',async()=>{
 const {createArchiveOwnerFixture}=require('./fixtures/archive_issued_tail_fixture.cjs');const f=await createArchiveOwnerFixture();try{
  await f.api.saveSettings({...f.targetSettings,embeddingBatchSize:1});f.startObservation();const preview=await f.archive().preview();assert.equal(preview.allowed,false);assert.match(preview.reason,/batch|budget|capacity/i);assert.equal(f.observation.requests.length,0);assert.equal(f.observation.writes.length,0);
 }finally{await f.dispose()}
});

for(const conflict of ['unavailable','changed'])test(`lost head acknowledgement with ${conflict} reconciliation stays uncertain`,async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true,JSON.stringify(preview));
  const write=f.pluginStorage.setItem.bind(f.pluginStorage),get=f.pluginStorage.getItem.bind(f.pluginStorage);let hit=false;
  f.pluginStorage.setItem=async(k,v)=>{const parsed=f.parseStoredValue(v);if(k===f.ownerKey&&parsed?.archiveRepairReceipt?.status==='complete'){
   hit=true;await write(k,v);if(conflict==='changed'){parsed.archiveRepairReceipt.operationId='foreign-operation';await write(k,JSON.stringify(parsed));}throw Error('lost owner ack');}return write(k,v)};
  f.pluginStorage.getItem=async k=>{if(hit&&conflict==='unavailable'&&k===f.ownerKey)throw Error('readback unavailable');return get(k)};
  const result=await f.controller.repair(preview.ticket);assert(hit);assert.equal(result.status,'uncertain',JSON.stringify(result));assert.equal(result.archiveReembedded,0);assert.equal(result.provider.state,'completed');assert.equal(result.candidates.state,'verified');assert.equal(result.publication.state,'unknown');assert.equal(result.writeIssued,true);
 }finally{await f.dispose()}
});
for(const route of ['local_preview','queue','full','progressive','auto'])test(`restart unresolved archive submission fences existing ${route} model route`,async()=>{
 const f=await setup();try{
  await f.seedMixed(f.cfg);const ticket=(await f.controller.preview()).ticket;assert(ticket);f.host.nativeFetch=async()=>{throw Error('unknown archive submission')};
  assert.equal((await f.controller.repair(ticket)).status,'uncertain');await f.restart(sourcePath);
  let wires=0;f.host.nativeFetch=async()=>{wires++;throw Error('old route must retain archive fence')};let result;
  try{result=route==='local_preview'?await f.api.healthRecovery.previewPhysicalRepair():route==='queue'?await f.api.processPendingEmbeddingQueue():route==='full'?await f.api.reembedAllRecords({scope:f.scope}):route==='progressive'?await f.api.progressivelyReembedRecords(f.scope):await f.api.runMemoryMaintenance('auto');}
  catch(error){result={reason:error.code||error.message};}
  assert.equal(wires,0,'unknown archive outcome cannot be bypassed by an old model entrypoint');if(route==='local_preview')assert.equal(result.allowed,false);assert.match(result.reason,/ARCHIVE.*(?:UNRESOLVED|HISTORY|UNCERTAIN)/i,JSON.stringify(result));
 }finally{await f.dispose()}
});
test('local physical host-write tail retains shared owner after logical timeout and clear',async()=>{
 const f=await setup();let release;try{
  await f.seedMixed(f.cfg);const local=await f.api.healthRecovery.previewPhysicalRepair();assert.equal(local.allowed,true);
  const timer=f.context.setTimeout;f.context.setTimeout=(fn,ms,...args)=>timer(fn,ms===60000?50:ms,...args);
  const write=f.pluginStorage.setItem.bind(f.pluginStorage);let entered,hit=false;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.pluginStorage.setItem=async(k,v)=>{if(!hit&&String(k).includes(':records:commit:')&&!f.protectedArchive.has(k)){hit=true;entered();await gate}return write(k,v)};
  const pending=f.api.healthRecovery.repair(local);await within(started,10000);const result=await within(pending);assert.equal(result.status,'uncertain');
  f.api.healthRecovery.clear();assert.equal(f.controller.getState().busy,true,'existing local repair physical tail retains the shared admission lease');assert.equal((await f.controller.preview()).allowed,false);release();await delay(40);assert.equal(f.controller.getState().busy,false);
 }finally{release?.();await f.dispose()}
});
for(const malformed of ['worldline','completed-journal','completed-history'])test(`archive ${malformed} integrity is validated before admission`,async()=>{
 const {createArchiveOwnerFixture}=require('./fixtures/archive_issued_tail_fixture.cjs');const f=await createArchiveOwnerFixture();try{
  const m=f.physicalManifest(f.scope.scopeKey);
  if(malformed==='worldline')f.pluginStorage.values.set(f.ownerKey.replace('manifest:v2','turn_worldline:v1'),JSON.stringify({version:'flashback_turn_worldline_v1',scopeKey:f.scope.scopeKey,nodes:'CORRUPT',retiredRecords:[]}));
  if(malformed==='completed-journal')f.pluginStorage.values.set(f.ownerKey,JSON.stringify({...m,archiveRepairJournal:{state:'complete',schema:'wrong',operationId:'foreign'}}));
  if(malformed==='completed-history')f.pluginStorage.values.set(f.ownerKey,JSON.stringify({...m,archiveRepairHistory:[null,{schema:'wrong'}]}));
  f.startObservation();const preview=await f.archive().preview();assert.equal(preview.allowed,false,JSON.stringify(preview));assert.equal(f.requests,0);assert.equal(f.observation.writes.length,0);
 }finally{await f.dispose()}
});
test('clear and replacement preview release private proof even while caller retains stale tickets',async()=>{
 const {createArchiveOwnerFixture}=require('./fixtures/archive_issued_tail_fixture.cjs');const f=await createArchiveOwnerFixture();try{
  const first=await f.archive().preview();assert(first.ticket);assert(f.audit.archiveRepairOffers.has(first.ticket));f.archive().clear();assert.equal(f.audit.archiveRepairOffers.has(first.ticket),false,'clear drops private source and credential proof');
  const second=await f.archive().preview(),third=await f.archive().preview();assert(second.ticket&&third.ticket);assert.equal(f.audit.archiveRepairOffers.has(second.ticket),false,'replacement preview drops previous private proof');assert(f.audit.archiveRepairOffers.has(third.ticket));
 }finally{await f.dispose()}
});
test('completion history rejects prospective entry 1025 before reservation or provider',async()=>{
 const {createArchiveOwnerFixture,plain}=require('./fixtures/archive_issued_tail_fixture.cjs');const f=await createArchiveOwnerFixture();try{
  const first=await f.archive().preview();assert.equal((await f.archive().repair(first.ticket)).status,'verified');
  const owner=f.physicalManifest(f.scope.scopeKey),receipt=owner.archiveRepairReceipt;
  const history=Array.from({length:1023},(_,i)=>({...plain(receipt),operationId:'previous-operation-'+i,attemptId:'previous-attempt-'+i}));history.push(receipt);assert.equal(history.length,1024);
  f.pluginStorage.values.set(f.ownerKey,JSON.stringify({...owner,archiveRepairHistory:history}));f.startObservation();
  const preview=await f.archive().preview();assert.equal(preview.allowed,false,JSON.stringify(preview));assert.match(preview.reason,/CAPACITY/);assert.equal(f.requests,0);assert.equal(f.observation.writes.length,0);assert.equal(f.physicalManifest(f.scope.scopeKey).archiveRepairHistory.length,1024);
 }finally{await f.dispose()}
});
test('public GUI close invalidates archive-only controller before its first health action',async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert.equal(preview.allowed,true);await f.api.closeUi();
  let writes=0,wires=0;f.pluginStorage.setItem=async()=>{writes++;return true};f.host.nativeFetch=async()=>{wires++;throw Error('closed ticket cannot submit')};
  const result=await f.controller.repair(preview.ticket);assert.equal(result.status,'blocked');assert.equal(writes,0);assert.equal(wires,0);assert.equal(f.controller.getState().previewAvailable,false);
 }finally{await f.dispose()}
});
test('oversized provider response is rejected before any candidate persistence',async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert(preview.ticket);let wires=0;
  f.host.nativeFetch=async(_u,i)=>{wires++;const input=JSON.parse(i.body).input;return {ok:true,status:200,async json(){return {padding:'x'.repeat(2*1024*1024),data:input.map((_,index)=>({index,embedding:[1,0,0,0,0,0]}))}}};};
  const result=await f.controller.repair(preview.ticket);assert.equal(wires,1);assert.equal(result.archiveReembedded,0);assert.equal(result.candidates.state,'none');assert.equal(result.publication.state,'none');assert.notEqual(result.status,'verified');
 }finally{await f.dispose()}
});
test('archive admission refuses an uncertified global fetch fallback',async()=>{
 const f=await setup();try{
  delete f.host.nativeFetch;delete f.host.risuFetch;let fallback=0;f.context.fetch=async()=>{fallback++;throw Error('uncertified fetch')};
  const preview=await f.controller.preview();assert.equal(preview.allowed,false);assert.match(preview.reason,/HOST|PROVIDER|TRANSPORT/);assert.equal(fallback,0);
 }finally{await f.dispose()}
});
test('supported current-scope switch discards archive-only preview lifetime',async()=>{
 const f=await setup();try{
  const preview=await f.controller.preview();assert(preview.ticket);const old=await f.host.getCurrentChat(),changed={...old,id:'other-active-scope',chatId:'other-active-scope'};
  f.host.getChat=f.host.getCurrentChat=f.host.getChatFromIndex=async()=>changed;const next=await f.api.resolveCurrentScope(false);assert.notEqual(next.scopeKey,f.scope.scopeKey);
  assert.equal(f.controller.getState().previewAvailable,false);assert.equal((await f.controller.repair(preview.ticket)).status,'blocked');
 }finally{await f.dispose()}
});
for(const corrupt of ['members','jobs'])test(`candidate completed receipt ${corrupt} must match actual frozen layer records`,async()=>{
 const {createArchiveOwnerFixture,plain}=require('./fixtures/archive_issued_tail_fixture.cjs');const f=await createArchiveOwnerFixture();try{
  const first=await f.archive().preview();assert.equal((await f.archive().repair(first.ticket)).status,'verified');
  const owner=f.physicalManifest(f.scope.scopeKey),candidate=f.physicalManifest(owner.archiveRef.archiveScopeKey),receipt=plain(candidate.archiveRepairReceipt);
  if(corrupt==='members')receipt.memberIds[0]='foreign-member-id';
  else {const job=receipt.jobs[0];job.sourceRevision='foreign-source-revision';job.logicalJobId='fb_logical_'+f.audit.MemorySuiteExecutionContract.hash({originScopeKey:job.originScopeKey,sourceRevision:job.sourceRevision,targetProfile:job.targetProfile});job.jobId='fb_embed_'+f.audit.MemorySuiteExecutionContract.hash({scopeKey:receipt.ownerScopeKey,sourceRevision:job.sourceRevision,targetProfile:job.targetProfile,originScopeKey:job.originScopeKey});}
  f.pluginStorage.values.set(f.manifestKeyFor(candidate.scopeKey),JSON.stringify({...candidate,archiveRepairReceipt:receipt}));
  f.pluginStorage.values.set(f.ownerKey,JSON.stringify({...owner,archiveRepairReceipt:receipt,archiveRepairHistory:[receipt]}));f.startObservation();
  const preview=await f.archive().preview();assert.equal(preview.allowed,false,JSON.stringify(preview));assert.match(preview.reason,/HISTORY|RECEIPT|MEMBER/);assert.equal(f.requests,0);assert.equal(f.observation.writes.length,0);
 }finally{await f.dispose()}
});
test('short identity hash collision cannot authorize changed exact settings bytes',async()=>{
 const {createArchiveOwnerFixture}=require('./fixtures/archive_issued_tail_fixture.cjs');
 const accelerator="authorityBinding:MemorySuiteExecutionContract.hash([beforeHost,[...routes],globalSettingsProof.binding,settingsWitness,argumentWitness,generation,key,credentialStatus])";
 const f=await createArchiveOwnerFixture({transformSource:source=>{assert(source.includes(accelerator));return source.replace(accelerator,"authorityBinding:'forced-collision-accelerator'")}});try{
  const preview=await f.archive().preview();assert(preview.ticket);const key=[...f.pluginStorage.values.keys()].find(k=>k==='vector_rag_memory:settings:v2');assert(key);
  const settings=JSON.parse(f.pluginStorage.values.get(key));settings.exactAuthorityNote='changed storage bytes without changing the normalized embedding model';f.pluginStorage.values.set(key,JSON.stringify(settings));f.startObservation();
  const result=await f.archive().repair(preview.ticket);assert.equal(result.status,'blocked',JSON.stringify(result));assert.equal(f.requests,0);assert.equal(f.observation.writes.length,0);
 }finally{await f.dispose()}
});
