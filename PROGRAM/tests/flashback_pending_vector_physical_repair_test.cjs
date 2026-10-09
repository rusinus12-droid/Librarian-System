'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {test}=require('node:test');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM=path.resolve(__dirname,'..');
const source=i=>({sourceType:'response',sourceId:`physical-${i}`,sourceHash:`physical-hash-${i}`,origin:'live_chat',role:'turn_pair',turnIndex:i+1,pairIndex:i+1,text:`User:\nWhere is parcel ${i}?\n\n---\n\nAssistant:\nParcel ${i} remains in the eastern cabinet beside the marble clock.`});
const success=init=>({ok:true,status:200,async json(){return {data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))}}});
async function setup(count=2,fixtureOptions={}){
 const h=await createFlashback(PROGRAM,fixtureOptions);const cfg=h.api._test.normalizeSettings({embeddingProvider:'openai_compat',embeddingModel:'physical-model',embeddingDimensions:3,embeddingUrl:'https://provider.invalid/v1',embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,embeddingBatchSize:1,autoEpisodeIndex:false,episodeIndexEnabled:false});
 await h.api.saveSettings(cfg);const scope=await h.api.resolveCurrentScope(false);
 const records=await h.api._test.buildRecordsFromSources(Array.from({length:count},(_,i)=>source(i)),cfg,scope,{deferEmbedding:true});
 await h.api._test.saveAllRecords(records,cfg,scope);await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
 return {h,cfg,scope,read:async()=>(await h.api._test.loadScopeRecords(scope.scopeKey)).records};
}
test('physical preview is read-only and a one-shot execution preserves raw sources',async()=>{
 const x=await setup();try{
  let writes=0,requests=0,hidden=0;const store=x.h.host.pluginStorage,local=x.h.host.safeLocalStorage,write=store.setItem.bind(store),localWrite=local.setItem.bind(local),arg=x.h.host.setArgument.bind(x.h.host);
  store.setItem=async(k,v)=>{writes++;if(/settings|secret/.test(k))hidden++;return write(k,v)};
  local.setItem=async(k,v)=>{if(/secret|settings/.test(k))hidden++;return localWrite(k,v)};x.h.host.setArgument=async(...a)=>{hidden++;return arg(...a)};
  x.h.host.nativeFetch=async(_url,init)=>{requests++;return success(init)};
  const before=(await x.read()).map(r=>[r.id,r.text,r.sourceHash]);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();
  assert.equal(ticket.allowed,true,JSON.stringify(ticket));assert.equal(ticket.actionKind,'physical_storage_repair');assert.equal(ticket.counts.eligibleSources,2);assert.equal(writes,0);assert.equal(requests,0);
  const a=x.h.api.healthRecovery.repair(ticket),b=x.h.api.healthRecovery.repair(ticket);const [result,duplicate]=await Promise.all([a,b]);
  assert.deepEqual(result,duplicate);assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(result.counts.completed,2);assert.equal(result.provider.requests.length,3);assert.equal(requests,3);assert.equal(hidden,0);
  assert.equal(result.journal.state,'verified');assert.equal(result.publication.state,'verified');assert.equal(result.finalVerification.complete,true);
  assert.deepEqual((await x.read()).map(r=>[r.id,r.text,r.sourceHash]),before);
  assert.equal((await x.h.api.healthRecovery.repair(ticket)).status,'blocked');assert.equal(requests,3);
 }finally{await x.h.cleanup()}
});
test('mixed durable pending and failed/legacy/uncertain groups leave exclusions untouched',async()=>{
 const x=await setup(4);try{
  const rows=await x.read();for(const [i,status] of [[1,'failed'],[2,'uncertain']]){const w=rows[i].embeddingWork;w.status=status;w.attempt={id:'prior-'+i,runtimeId:'prior-runtime',startedAt:1,sourceRevision:w.sourceRevision,profileFingerprint:w.targetProfile.profileFingerprint,storageBinding:'prior-local',sourceSet:'prior-source'};}delete rows[3].embeddingWork;Object.assign(rows[3],{vector:[1,0,0],dim:3,provider:'hash',embeddingProvider:'hash',model:'hash-3',embeddingModel:'hash-3'});
  await x.h.api._test.saveAllRecords(rows,x.cfg,x.scope);const before=(await x.read()).slice(1).map(r=>[r.id,r.text,r.embeddingWork?.status,r.embeddingProvider]);
  let requests=0;x.h.host.nativeFetch=async(_u,init)=>{requests++;return success(init)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();assert.equal(ticket.allowed,true);assert.equal(ticket.counts.eligibleSources,1);assert.equal(ticket.counts.failedSources,1);assert.equal(ticket.counts.uncertainSources,1);assert.equal(ticket.counts.legacySources,1);
  const result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.counts.completed,1,JSON.stringify(result));assert.equal(requests,2);assert.equal(result.counts.excludedSources,3);
  assert.deepEqual((await x.read()).slice(1).map(r=>[r.id,r.text,r.embeddingWork?.status,r.embeddingProvider]),before);
 }finally{await x.h.cleanup()}
});
test('clear after journal issuance preserves journal evidence and stops provider',async()=>{
 const x=await setup(1);try{
  const store=x.h.host.pluginStorage,write=store.setItem.bind(store);let calls=0;
  store.setItem=async(k,v)=>{const ok=await write(k,v);if(k.includes('maintenance_journal'))x.h.api.healthRecovery.clear();return ok};x.h.host.nativeFetch=async(_u,i)=>{calls++;return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.status,'blocked',JSON.stringify(result));assert.equal(result.writeIssued,true);assert.equal(result.journal.state,'verified');assert.equal(result.publication.state,'none');assert.equal(calls,0);assert(Object.isFrozen(result));
 }finally{await x.h.cleanup()}
});
test('clear after previous-manifest preservation stops reservation publication',async()=>{
 const x=await setup(1);try{
  const store=x.h.host.pluginStorage,write=store.setItem.bind(store);let main=0,calls=0;
  store.setItem=async(k,v)=>{if(k.endsWith(':manifest:v2'))main++;const ok=await write(k,v);if(k.endsWith(':manifest:v2:previous:v1'))x.h.api.healthRecovery.clear();return ok};x.h.host.nativeFetch=async(_u,i)=>{calls++;return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(main,0);assert.equal(calls,1);assert.equal(result.publication.state,'none');assert.equal(result.counts.completed,0);assert.equal((await x.read())[0].embeddingWork.status,'pending');
 }finally{await x.h.cleanup()}
});
test('lost reservation acknowledgement preserves commit evidence and never submits documents',async()=>{
 const x=await setup(1);try{
  const store=x.h.host.pluginStorage,write=store.setItem.bind(store);let calls=0,lost=false;
  store.setItem=async(k,v)=>{const ok=await write(k,v);if(k.endsWith(':manifest:v2')&&!lost){lost=true;throw Error('private exception must not escape')}return ok};x.h.host.nativeFetch=async(_u,i)=>{calls++;return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.status,'uncertain',JSON.stringify(result));assert.equal(result.publication.state,'unknown');assert.equal(result.publication.commits.length,1);assert(result.publication.commits[0].commitId);assert.equal(calls,1);assert(!JSON.stringify(result).includes('private exception'));
  assert.equal((await x.h.api.healthRecovery.previewPhysicalRepair()).allowed,false);assert.equal(calls,1);
 }finally{await x.h.cleanup()}
});
test('cancellation during issued completion preserves verified completion without rollback',async()=>{
 const x=await setup(1);try{
  const store=x.h.host.pluginStorage,write=store.setItem.bind(store);let main=0;
  store.setItem=async(k,v)=>{const ok=await write(k,v);if(k.endsWith(':manifest:v2')&&++main===3)x.h.api.healthRecovery.clear();return ok};x.h.host.nativeFetch=async(_u,i)=>success(i);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.status,'partial_success',JSON.stringify(result));assert.equal(result.counts.completed,1);assert.equal(result.publication.state,'verified');assert.equal(result.finalVerification.complete,false);assert.equal((await x.read())[0].embeddingReceipt.status,'ready');
 }finally{await x.h.cleanup()}
});
test('one success then a definitive provider rejection is partial success',async()=>{
 const x=await setup(2);try{
  let calls=0;x.h.host.nativeFetch=async(_u,i)=>++calls===3?{ok:false,status:400,async json(){return {error:{message:'rejected'}}},async text(){return 'rejected'}}:success(i);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.status,'partial_success',JSON.stringify(result));assert.equal(result.counts.completed,1);assert.equal(result.counts.failed,1);assert.equal(result.counts.unknown,0);assert.equal(calls,3);
 }finally{await x.h.cleanup()}
});
test('all definitive provider failures are failed, never uncertain',async()=>{
 const x=await setup(1);try{
  let calls=0;x.h.host.nativeFetch=async(_u,i)=>++calls===2?{ok:false,status:400,async json(){return {error:{message:'rejected'}}},async text(){return 'rejected'}}:success(i);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(result.counts.failed,1);assert.equal(result.counts.unknown,0);assert.equal(calls,2);
 }finally{await x.h.cleanup()}
});
test('a false journal write is definite failure without provider or manifest submission',async()=>{
 const x=await setup(1);try{
  const store=x.h.host.pluginStorage,write=store.setItem.bind(store);let calls=0;
  store.setItem=async(k,v)=>k.includes('maintenance_journal')?false:write(k,v);x.h.host.nativeFetch=async(_u,i)=>{calls++;return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(result.publication.state,'none');assert.equal(calls,0);assert.equal(result.writeIssued,true);
 }finally{await x.h.cleanup()}
});
test('legacy public queue cannot enter a common physical execution in flight',async()=>{
 const x=await setup(1);let release;try{
  let started;const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);let calls=0;
  x.h.host.nativeFetch=async(_u,i)=>{calls++;started();await gate;return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),work=x.h.api.healthRecovery.repair(ticket);await entered;
  const legacy=await Promise.race([x.h.api.processPendingEmbeddingQueue(),new Promise(r=>setTimeout(()=>r({reason:'incorrectly_entered_queue'}),1000))]);assert.equal(legacy.reason,'FLASHBACK_REPAIR_ACTION_BUSY');
  x.h.api.healthRecovery.clear();assert.equal((await x.h.api.healthRecovery.previewPhysicalRepair()).allowed,false);release();await work;assert.equal(calls,1);
 }finally{release?.();await x.h.cleanup()}
});
for(const change of ['host','settings','credential','manifest','server'])test(`a ${change} change invalidates the ticket before any write or request`,async()=>{
 const x=await setup(1);try{
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),store=x.h.host.pluginStorage;
  if(change==='host')(await x.h.host.getCurrentChat()).message.push({role:'user',chatId:'new',data:'Different source'});
  if(change==='settings'){const k=[...store.values.keys()].find(k=>k.endsWith(':settings:v2'));const v=JSON.parse(store.values.get(k));v.overrides={...v.overrides,embeddingModel:'other-model'};store.values.set(k,JSON.stringify(v));}
  if(change==='credential')x.h.argumentValues.set('embedding_key','changed-private-key');
  if(change==='server'){const k=[...store.values.keys()].find(k=>k.includes('scope_routes_v1__:flashback'));const v=JSON.parse(store.values.get(k));v.entries[x.scope.scopeKey]={scopeId:x.scope.scopeKey,mode:'server_only',origin:'user_explicit',updatedAt:Date.now()+100000};store.values.set(k,JSON.stringify(v));x.h.host.safeLocalStorage.values.set(k,JSON.stringify(v));}
  if(change==='manifest'){const k=[...store.values.keys()].find(k=>k.endsWith(':manifest:v2'));const v=JSON.parse(store.values.get(k));v.updatedAt='changed';store.values.set(k,JSON.stringify(v));}
  let writes=0,requests=0;store.setItem=async()=>{writes++;return true};x.h.host.nativeFetch=async()=>{requests++;throw Error('forbidden')};
  const result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.status,'blocked',JSON.stringify(result));assert.equal(writes,0);assert.equal(requests,0);assert.equal(result.writeIssued,false);
 }finally{await x.h.cleanup()}
});
test('physical provider receipts identify each real request and only its own durable attempt',async()=>{
 const x=await setup(2);try{
  x.h.host.nativeFetch=async(_u,i)=>success(i);const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.provider.requests[0].purpose,'preflight');assert.equal(result.provider.requests[0].attemptIds,undefined);
  for(const r of result.provider.requests.slice(1)){assert.equal(r.attemptIds.length,1);assert.equal(r.jobIds.length,1)}
  assert.notEqual(result.provider.requests[1].attemptIds[0],result.provider.requests[2].attemptIds[0]);assert.equal(new Set(result.provider.requests.map(r=>r.id)).size,3);
 }finally{await x.h.cleanup()}
});
test('unknown document outcome is not retried or resumed by a later physical preview',async()=>{
 const x=await setup(1);try{
  let calls=0;x.h.host.nativeFetch=async(_u,i)=>{if(++calls===2)throw Error('private transport failure');return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.status,'uncertain',JSON.stringify(result));assert.equal(result.provider.requests[1].state,'unknown');assert.equal(calls,2);assert.equal((await x.h.api.healthRecovery.previewPhysicalRepair()).allowed,false);assert.equal(calls,2);
 }finally{await x.h.cleanup()}
});
test('legacy settings execution does not migrate settings or synchronize credentials',async()=>{
 const x=await setup(1);try{
  const store=x.h.host.pluginStorage,key=[...store.values.keys()].find(k=>k.endsWith(':settings:v2'));store.values.set(key,JSON.stringify({version:1,settings:x.cfg}));
  const original=store.values.get(key),write=store.setItem.bind(store);let hidden=0;
  store.setItem=async(k,v)=>{if(/settings|secret/.test(k))hidden++;return write(k,v)};x.h.host.setArgument=async()=>{hidden++;return true};x.h.host.nativeFetch=async(_u,i)=>success(i);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();assert.equal(ticket.allowed,true,JSON.stringify(ticket));const result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(hidden,0);assert.equal(store.values.get(key),original);
 }finally{await x.h.cleanup()}
});
test('unknown preflight is retained as unresolved and prevents an automatic fresh request',async()=>{
 const x=await setup(1);try{
  let calls=0;x.h.host.nativeFetch=async()=>{calls++;throw Error('unconfirmed preflight')};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);
  assert.equal(result.status,'uncertain',JSON.stringify(result));assert.equal(calls,1);assert.equal((await x.h.api.healthRecovery.previewPhysicalRepair()).allowed,false);
  const row=[...x.h.pluginStorage.values].find(([k])=>k.endsWith(':maintenance_journal:v1'));assert.equal(JSON.parse(row[1]).physicalRepair.state,'active');
  const resumed=await x.h.api.processPendingEmbeddingQueue({automatic:true});assert.equal(resumed.reason,'FLASHBACK_PHYSICAL_OUTCOME_UNRESOLVED');assert.equal(calls,1);
 }finally{await x.h.cleanup()}
});
test('fresh runtime retains interrupted physical preflight fence without a job ID',async()=>{
 const x=await setup(1);let fresh;try{
  x.h.host.nativeFetch=async()=>{throw Error('preflight response lost')};const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();assert.equal((await x.h.api.healthRecovery.repair(ticket)).status,'uncertain');
  await x.h.cleanup();fresh=await createFlashback(PROGRAM,{pluginStorage:x.h.pluginStorage,safeLocalStorage:x.h.safeLocalStorage,waitForLoaded:true});let calls=0;fresh.host.nativeFetch=async()=>{calls++;throw Error('forbidden retry')};
  assert.equal((await fresh.api.healthRecovery.previewPhysicalRepair()).allowed,false);const result=await fresh.api.processPendingEmbeddingQueue({automatic:true});assert.equal(result.reason,'FLASHBACK_PHYSICAL_OUTCOME_UNRESOLVED');assert.equal(calls,0);
 }finally{await fresh?.cleanup();await x.h.cleanup()}
});
test('candidate storage exceptions never expose raw private messages in the public receipt',async()=>{
 const x=await setup(1);try{
  const store=x.h.host.pluginStorage,write=store.setItem.bind(store);store.setItem=async(k,v)=>{if(k.includes(':records:'))throw Error('PRIVATE_SENTINEL_STORAGE_CREDENTIAL_DETAILS');return write(k,v)};x.h.host.nativeFetch=async(_u,i)=>success(i);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.status,'uncertain');assert(!JSON.stringify(result).includes('PRIVATE_SENTINEL'),JSON.stringify(result));
 }finally{await x.h.cleanup()}
});
test('cancellation during checkpoint digest prevents the checkpoint host write',async()=>{
 const x=await setup(1,{transformSource:script=>script.replace('  const embeddingCheckpointDigest = async value => {','  const embeddingCheckpointDigest = async value => { if(value?.vectors && globalThis.__cancelCheckpoint){globalThis.__cancelCheckpoint=false;publicApi.healthRecovery.clear();}')});try{
  let checkpoints=0;const local=x.h.host.safeLocalStorage,write=local.setItem.bind(local);local.setItem=async(k,v)=>{if(k.startsWith('flashback:embedding_checkpoint:'))checkpoints++;return write(k,v)};
  x.h.host.nativeFetch=async(_u,i)=>{if(!JSON.parse(i.body).input[0].startsWith('Flashback maintenance'))x.h.context.__cancelCheckpoint=true;return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);assert.equal(checkpoints,0);assert.equal(result.counts.completed,0);assert.equal(result.provider.requests.length,2);assert.equal(result.status,'uncertain');assert.equal(result.counts.unknown,0);assert.equal(result.counts.pending,1);
 }finally{await x.h.cleanup()}
});
test('strict reservation never seeds excluded legacy uncertain registry entries',async()=>{
 const x=await setup(2);try{
  const rows=await x.read(),w=rows[1].embeddingWork;w.status='uncertain';w.attempt={id:'excluded-old-attempt',runtimeId:'old-runtime',startedAt:1,sourceRevision:w.sourceRevision,profileFingerprint:w.targetProfile.profileFingerprint,storageBinding:'old-local',sourceSet:'old-source'};
  await x.h.api._test.saveAllRecords(rows,x.cfg,x.scope);const store=x.h.pluginStorage,k=[...store.values.keys()].find(k=>k.endsWith(':manifest:v2')),m=JSON.parse(store.values.get(k));delete m.embeddingAttemptRegistry;store.values.set(k,JSON.stringify(m));
  x.h.host.nativeFetch=async(_u,i)=>success(i);const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();assert.equal(ticket.allowed,true);assert.equal(ticket.counts.uncertainSources,1);
  const result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.counts.completed,1,JSON.stringify(result));assert.equal(JSON.parse(store.values.get(k)).embeddingAttemptRegistry.entries['excluded-old-attempt'],undefined);
 }finally{await x.h.cleanup()}
});
for(const restart of [false,true])test(`unresolved preflight fences all public legacy entry points${restart?' after restart':''}`,async()=>{
 const x=await setup(1);let fresh;try{
  let calls=0;x.h.host.nativeFetch=async()=>{calls++;throw Error('preflight lost')};const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();assert.equal((await x.h.api.healthRecovery.repair(ticket)).status,'uncertain');
  let h=x.h;if(restart){await h.cleanup();fresh=await createFlashback(PROGRAM,{pluginStorage:h.pluginStorage,safeLocalStorage:h.safeLocalStorage,waitForLoaded:true});h=fresh;}
  h.host.nativeFetch=async(_u,i)=>{calls++;return success(i)};let writes=0;const write=h.pluginStorage.setItem.bind(h.pluginStorage);h.pluginStorage.setItem=async(k,v)=>{writes++;return write(k,v)};
  const entries=[()=>h.api.runMemoryMaintenance('reembed',{signal:new AbortController().signal}),()=>h.api.processPendingEmbeddingQueue(),()=>h.api.processPendingEmbeddingWork({sourceHash:source(0).sourceHash}),()=>h.api.reembedAllRecords(),()=>h.api.progressivelyReembedRecords()];
  for(const entry of entries){const result=await entry().catch(e=>({reason:e.code}));assert.equal(result.reason,'FLASHBACK_PHYSICAL_OUTCOME_UNRESOLVED',JSON.stringify(result));}
  assert.equal(calls,1);assert.equal(writes,0);assert.equal((await h.api.healthRecovery.previewPhysicalRepair()).allowed,false);
 }finally{await fresh?.cleanup();await x.h.cleanup()}
});
test('a later concurrent candidate success cannot erase an earlier lost acknowledgement',async()=>{
 const x=await setup(2,{transformSource:s=>s.replace('shardSize: 64','shardSize: 1')});try{
  let issued=0;const store=x.h.pluginStorage,write=store.setItem.bind(store);store.setItem=async(k,v)=>{if(k.includes(':records:')){const n=++issued;if(n===1){await write(k,v);throw Error('lost first candidate ack')}if(n===2){await new Promise(r=>setTimeout(r,30));return write(k,v)}}return write(k,v)};x.h.host.nativeFetch=async(_u,i)=>success(i);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);assert.equal(issued,2);assert.equal(result.status,'uncertain',JSON.stringify(result));assert.equal(result.candidates.state,'unknown');assert.equal(result.finalVerification.complete,false);assert.equal(result.candidates.receipts.filter(r=>r.state==='unknown').length,1);assert.equal(result.candidates.receipts.filter(r=>r.state==='verified').length,1);
 }finally{await x.h.cleanup()}
});
test('physical execution never enters ordinary routed storage readers or server writer admission',async()=>{
 const x=await setup(1,{transformSource:s=>s.replace('  const scopedGetImpl = async (space, key, legacyGet = null, legacySet = null, legacyRemove = null, operationOptions = {}) => {','  const scopedGetImpl = async (space, key, legacyGet = null, legacySet = null, legacyRemove = null, operationOptions = {}) => {if(globalThis.__strictRouteTrap)throw Error("ORDINARY_ROUTED_READ_FORBIDDEN");').replace('  const withFlashbackWriter = async (key, fn, writerOptions = {}) => {','  const withFlashbackWriter = async (key, fn, writerOptions = {}) => {if(globalThis.__strictRouteTrap)throw Error("GENERIC_WRITER_ADMISSION_FORBIDDEN");')});try{
  x.h.host.nativeFetch=async(_u,i)=>success(i);const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();x.h.context.__strictRouteTrap=true;
  const result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.status,'verified',JSON.stringify(result));assert.equal(result.counts.completed,1);
 }finally{x.h.context.__strictRouteTrap=false;await x.h.cleanup()}
});
for(const scenario of ['preflight','first_source','first_chunk'])test(`unknown target counts are exact and disjoint for ${scenario}`,async()=>{
 const x=await setup(2);try{
  if(scenario==='first_chunk'){const cfg=x.h.api._test.normalizeSettings({...x.cfg,chunkChars:400,chunkOverlap:0});await x.h.api.saveSettings(cfg);const text=Array.from({length:12},(_,i)=>source(i).text+' Segment '+i).join('\n');const rows=await x.h.api._test.buildRecordsFromSources([{...source(0),text}],cfg,x.scope,{deferEmbedding:true});await x.h.api._test.saveAllRecords(rows,cfg,x.scope);assert(rows.length>2);}
  let calls=0;x.h.host.nativeFetch=async(_u,i)=>{if(++calls===(scenario==='preflight'?1:2))throw Error('response lost');return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.status,'uncertain');const unknown=scenario==='preflight'?0:1;
  assert.equal(result.counts.unknown,unknown,JSON.stringify(result));assert.equal(result.counts.pending,ticket.counts.eligibleRecords-unknown);assert.equal(result.counts.completed+result.counts.failed+result.counts.pending+result.counts.unknown,ticket.counts.eligibleRecords);
  if(scenario!=='preflight')assert.equal(result.provider.requests[1].jobIds.length,1);
 }finally{await x.h.cleanup()}
});
test('late physical manifest cannot overwrite a later ordinary capture',async()=>{
 const x=await setup(1,{transformSource:s=>s.replace('  const STORAGE_IO_TIMEOUT_MS = 60000;','  const STORAGE_IO_TIMEOUT_MS = 200;').replace('  globalThis.__FlashbackMemory = publicApi;','  globalThis.__ordinaryUpsert=upsertRecords;globalThis.__FlashbackMemory = publicApi;')});let release;try{
  const store=x.h.pluginStorage,write=store.setItem.bind(store);let held=false;store.setItem=async(k,v)=>{if(k.endsWith(':manifest:v2')&&!held){held=true;return new Promise(resolve=>{release=async()=>{await write(k,v);resolve(true)}})}return write(k,v)};x.h.host.nativeFetch=async(_u,i)=>success(i);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.status,'uncertain');
  const newRows=await x.h.api._test.buildRecordsFromSources([source(9)],x.cfg,x.scope,{deferEmbedding:true});let blocked=false;
  try{await x.h.context.__ordinaryUpsert(newRows,x.cfg,x.scope,{deferEmbedding:true})}catch(e){blocked=e.storageMutationIndeterminate===true}
  assert.equal(blocked,true,'ordinary capture must observe the existing same-key physical mutation tail');await release();await new Promise(r=>setTimeout(r,10));
  await x.h.context.__ordinaryUpsert(newRows,x.cfg,x.scope,{deferEmbedding:true});assert((await x.read()).some(r=>r.sourceId==='physical-9'));assert.equal(result.publication.state,'unknown');assert(Object.isFrozen(result));
 }finally{await release?.();await x.h.cleanup()}
});
test('queued but unissued physical journal cannot run after the execution has settled',async()=>{
 const x=await setup(1,{transformSource:s=>s.replace('  const STORAGE_IO_TIMEOUT_MS = 60000;','  const STORAGE_IO_TIMEOUT_MS = 100;').replace('  const MAINTENANCE_JOURNAL_WRITE_TIMEOUT_MS = 1500;','  const MAINTENANCE_JOURNAL_WRITE_TIMEOUT_MS = 20;').replace('  globalThis.__FlashbackMemory = publicApi;','  globalThis.__storageTails=globalThis[Symbol.for("rusinus12.flashback.storage-mutation-coordinator.v1")].tails;globalThis.__journalKey=STORAGE.maintenanceJournal;globalThis.__FlashbackMemory = publicApi;')});let release;try{
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair(),prior=new Promise(r=>release=r);x.h.context.__storageTails.set(x.h.context.__journalKey,prior);let journalWrites=0,calls=0;const store=x.h.pluginStorage,write=store.setItem.bind(store);store.setItem=async(k,v)=>{if(k===x.h.context.__journalKey)journalWrites++;return write(k,v)};x.h.host.nativeFetch=async(_u,i)=>{calls++;return success(i)};
  const result=await x.h.api.healthRecovery.repair(ticket);assert.equal(result.writeIssued,false,JSON.stringify(result));assert.equal(result.journal.writes.length,0);release();await new Promise(r=>setTimeout(r,30));assert.equal(journalWrites,0);assert.equal(calls,0);assert(Object.isFrozen(result));
 }finally{release?.();await x.h.cleanup()}
});
test('an individually timed-out candidate factory cannot issue while siblings keep execution alive',async()=>{
 const x=await setup(2,{transformSource:s=>s.replace('shardSize: 64','shardSize: 1').replace('  const STORAGE_IO_TIMEOUT_MS = 60000;','  const STORAGE_IO_TIMEOUT_MS = 100;').replace('.then(() => operationFactory());','.then(async()=>{if(globalThis.__holdCandidateFactory&&label==="physical repair candidate write"&&String(key).includes(":records:")){globalThis.__holdCandidateFactory=false;await globalThis.__firstFactoryGate;}return operationFactory();});').replace('async writeCandidate(key,value,local=false){','async writeCandidate(key,value,local=false){if(globalThis.__holdSecondCandidate&&String(key).includes(":records:")&&++globalThis.__candidateStarts===2)await globalThis.__secondCandidateGate;')});let releaseFirst,releaseSecond,work;try{
  x.h.context.__firstFactoryGate=new Promise(r=>releaseFirst=r);x.h.context.__secondCandidateGate=new Promise(r=>releaseSecond=r);x.h.context.__holdCandidateFactory=true;x.h.context.__holdSecondCandidate=true;x.h.context.__candidateStarts=0;
  let writes=0;const store=x.h.pluginStorage,write=store.setItem.bind(store);store.setItem=async(k,v)=>{if(k.includes(':records:'))writes++;return write(k,v)};x.h.host.nativeFetch=async(_u,i)=>success(i);
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();work=x.h.api.healthRecovery.repair(ticket);while(x.h.context.__candidateStarts<2)await new Promise(r=>setTimeout(r,5));await new Promise(r=>setTimeout(r,150));releaseFirst();await new Promise(r=>setTimeout(r,30));assert.equal(writes,0,'expired factory must be closed before whole-execution finally');releaseSecond();await work;
 }finally{releaseFirst?.();releaseSecond?.();await work;await x.h.cleanup()}
});
test('journal candidate and manifest mutation admission share the queued/boundary/issued timeout matrix',async()=>{
 const x=await setup(1,{transformSource:s=>s.replace('physicalRecoveryContexts.add(recovery);','physicalRecoveryContexts.add(recovery);globalThis.__physicalMutationContext=recovery;globalThis.__storageTails=globalThis[Symbol.for("rusinus12.flashback.storage-mutation-coordinator.v1")].tails;')});let releaseProvider,work;try{
  let enter;const entered=new Promise(r=>enter=r),providerGate=new Promise(r=>releaseProvider=r);let calls=0;x.h.host.nativeFetch=async(_u,i)=>{if(++calls===1){enter();await providerGate}return success(i)};
  const ticket=await x.h.api.healthRecovery.previewPhysicalRepair();work=x.h.api.healthRecovery.repair(ticket);await entered;const r=x.h.context.__physicalMutationContext,tails=x.h.context.__storageTails,originalBoundary=r.boundary;
  for(const kind of ['journal','candidate','manifest'])for(const stage of ['queued','boundary','issued']){
    const key='synthetic-tail-'+kind+'-'+stage;let release,writes=0,issued=0,stored=false;const gate=new Promise(resolve=>release=resolve);
    if(stage==='queued')tails.set(key,gate);if(stage==='boundary')r.boundary=async()=>{await gate;return originalBoundary.call(r)};
    const store={async setItem(){writes++;if(stage==='issued')await gate;stored=true;return true}};
    const error=await r.mutate(key,store,'value','physical repair '+kind+' write',20,()=>issued++).then(()=>null,e=>e);assert.equal(error?.code,'FLASHBACK_DEADLINE');const tail=tails.get(key);assert(tail,'physical tail remains until real settlement');
    assert.equal(issued,stage==='issued'?1:0);assert.equal(writes,stage==='issued'?1:0);r.boundary=originalBoundary;release();await tail;
    assert.equal(writes,stage==='issued'?1:0,kind+' '+stage+' must not issue after admission expiry');assert.equal(stored,stage==='issued');
  }
  releaseProvider();assert.equal((await work).status,'verified');
 }finally{releaseProvider?.();await work;await x.h.cleanup()}
});
