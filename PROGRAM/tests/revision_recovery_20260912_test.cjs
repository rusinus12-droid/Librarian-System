'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {lineageFixture}=require('./fixtures/libra_unified_lineage_fixture.cjs');
const memoryCalls=f=>f.control.calls.filter(args=>args[0]?.messages?.some(m=>m.role==='system'&&m.content.includes('LIBRA LONG-TERM MEMORY EXTRACTION'))).length;
async function bounded(promise,label,ms=8000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error(label+' timed out')),ms))]);}finally{clearTimeout(timer);}}
const hash=s=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),0x01000193);return(h>>>0).toString(36);};
function repairEnvelope(sourceText){const p=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:sourceText});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[sourceText];const grounding=[];const walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:path+'['+i+']',source:'target',evidence:[sourceText]});});return;}if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};for(const a of ['entity','world','narrative','planner'])walk(p[a],a);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[sourceText]});return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};}
(async()=>{
 const f=await createFlashback(path.resolve(__dirname,'..'));
 try{const t=f.api._test,cfg=t.normalizeSettings({embeddingProvider:'voyageai',embeddingModel:'voyage-4-large',embeddingDimensions:0});
  const descriptor=JSON.parse(JSON.stringify(t.embeddingProfileDescriptor(cfg,3)));delete descriptor.executionDescriptor;
  const old='emb_'+hash(JSON.stringify(descriptor));
  const record={provider:'voyageai',model:'voyage-4-large',vector:[1,0,0],embeddingProfileId:old};
  assert.equal(t.recordEmbeddingCompatibility(record,cfg,{dimensions:3}).comparable,true);
  assert.equal(t.recordEmbeddingCompatibility({...record,embeddingProfileId:'unknown-profile'},cfg,{dimensions:3}).comparable,false);
  assert.equal(t.recordEmbeddingCompatibility(record,{...cfg,embeddingModelRevision:'changed'},{dimensions:3}).comparable,false);
  assert.equal(t.recordEmbeddingCompatibility(record,{...cfg,embeddingDocumentPrefix:'changed'},{dimensions:3}).comparable,false);
  assert.equal(t.recordEmbeddingCompatibility(record,cfg,{dimensions:4}).comparable,false);
  assert.ok(t.recordEmbeddingCompatibility({...record,vector:[]},cfg,{dimensions:3}).reasons.includes('missing_vector'));
  const arms=await t.generateRecallCandidateArms({records:[{...record,id:'legacy',sourceType:'response',text:'Alice waits in the office.',turnIndex:1}],queryText:'Alice',queryVector:[1,0,0],settings:cfg,context:{queryProvider:'voyageai',queryModel:'voyage-4-large',queryProfileId:t.embeddingProfileId(cfg,3)}});
  assert.equal(arms.dense.length,1,'legacy vector actually enters dense search');
  const oldRecord={id:'old',sourceHash:'old',sourceType:'response',text:'Alice waits.',turnIndex:1,pairIndex:1,sourceMessageIds:['u','a'],lifecycleStatus:'inactive_variant'};
  const newRecord={...oldRecord,id:'new',sourceHash:'new',text:'Alice leaves.',lifecycleStatus:'active'};
  const pair={pairIndex:1,userText:'',assistantText:'Alice waits.',userMessageId:'u',assistantMessageIds:['a']};
  let units=t.flashbackSourceEditUnits({scopeKey:'fixture'}, {pairs:[pair]},[newRecord],{nodes:[],retiredRecords:[oldRecord]});
  assert.equal(units[0].changed,false,'known retired response is reactivated, not an edit');
  const nextPair={...pair,assistantText:'Alice returns.'};
  units=t.flashbackSourceEditUnits({scopeKey:'fixture'}, {pairs:[nextPair]},[newRecord],{nodes:[]});assert.equal(units[0].changed,true);
  const identity=t.flashbackPairIdentity('fixture',pair);
  units=t.flashbackSourceEditUnits({scopeKey:'fixture'}, {pairs:[nextPair]},[newRecord],{nodes:[{...identity,status:'quarantined',lastMissingObservationHash:'observed-gap'}]});assert.equal(units[0].changed,false);
  console.log('PASS Flashback known variant and observed generation gap bypass edit; direct edit remains detected');
  console.log('PASS exact shipped legacy Voyage profile compatibility; changed profiles/dimensions remain excluded');
 }finally{await f.cleanup();}
 const h=await createHayakuRuntime({autoRepair:false});
 try{const t=h.hayaku._test;const store=t.emptyStore?t.emptyStore():null;
  assert.ok(store,'emptyStore exported');
  const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:'Alice is in the office.'});
  assert.doesNotThrow(()=>t.ingestPacket(store,JSON.stringify(packet),'fixture-packet'));
  console.log('PASS full HAYAKU ingest executes without undefined meta');
 }finally{await h.dispose();}
 const b=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'What next?'},{role:'assistant',chatId:'a1',data:hiddenPacketMessage('Alice waits.',createValidPacket({turn:1,subject:'Alice',summary:'Alice waits.'}))}]});
 try{const t=b.hayaku._test;
  const observe=async()=>{const scope=await t.currentChatScope();await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'reroll_regression',{prompt:false});return scope;};
  await observe();const original=b.chat.message[1];b.chat.message.splice(1);await observe();
  b.chat.message.push({...original,data:'Alice leaves the office.'});let scope=await observe();
  let sync=b.hayaku.getSourceEditSyncStatus();assert.ok(sync.tasks.every(x=>['applied','superseded'].includes(x.state)),JSON.stringify(sync));
  await observe();sync=b.hayaku.getSourceEditSyncStatus();assert.ok(sync.tasks.every(x=>['applied','superseded'].includes(x.state)),JSON.stringify(sync));
  assert.equal(b.llmCalls.length,0,'observation never creates a paid analysis');
  b.chat.message[1].data='Alice directly edits this source.';await observe();b.setLlmResponder(async()=>({type:'success',result:JSON.stringify(repairEnvelope('Alice directly edits this source.'))}));
  await b.callBeforeRequest([{role:'user',data:'Continue after the direct edit.'}],'model');sync=b.hayaku.getSourceEditSyncStatus();
  assert.ok(sync.tasks.some(x=>x.state==='applied'),JSON.stringify(sync));assert.equal(b.llmCalls.length,1,'registered beforeRequest automatically analyzes the direct edit');
  console.log('PASS observed reroll gap stays settled; a later direct edit is automatically reanalyzed at beforeRequest');
 }finally{await b.dispose();}
 const l=await lineageFixture({snapshot:require('./fixtures/legacy_v3_frozen_1_batches.json')});
 try{
  const ref=l.manifest().memories['1'],old=l.r.values.get(ref.key),oldSource=l.chat.message[9].data;l.chat.message[9].data+=' A new source revision.';
  const callsBefore=memoryCalls(l);await l.r.sourceEditBoundary();const sync=l.r.api.getSourceEditSyncStatus();
  assert.equal(sync.tasks[0].state,'applied',JSON.stringify(sync));assert.equal(memoryCalls(l),callsBefore+1,'beforeRequest automatically analyzes the new source');
  assert.notEqual(l.manifest().memories['1'].sourceDigest,ref.sourceDigest);assert.notEqual(l.manifest().memories['1'].key,ref.key);
  assert.equal(l.r.values.get(ref.key),old,'old canonical bytes remain immutable through automatic replacement');
  console.log('PASS automatic source edit replaces legacy canonical and preserves original bytes');
  const calls=memoryCalls(l);l.chat.message[9].data=oldSource;
  await l.r.sourceEditBoundary();
  assert.equal(memoryCalls(l),calls,'known original revision reuses canonical without generation');
  assert.equal(l.manifest().memories['1'].sourceDigest,ref.sourceDigest);
  assert.ok(l.r.api.getSourceEditSyncStatus().tasks.every(t=>['applied','superseded'].includes(t.state)));
  console.log('PASS LIBRA known response revision reactivates old canonical without source-edit prompt or model call');
  const oldMessage=l.chat.message.pop();await l.r.sourceEditBoundary();await bounded(l.r.api.startManualCanonicalScan(),'manual scan after generation gap');
  assert.equal(l.manifest().memories['1'].inactiveReason,'rollback_or_incomplete_batch');
  l.chat.message.push({...oldMessage,data:oldSource+' A generated new response.'});
  await l.r.sourceEditBoundary();const branch=await bounded(l.r.api.startManualCanonicalScan(),'manual scan for new generated response');
  assert.equal(memoryCalls(l),calls+1,JSON.stringify({branch,job:await l.r.api.getCanonicalJobStatus(),sync:l.r.api.getSourceEditSyncStatus()}));
  assert.notEqual(l.manifest().memories['1'].sourceDigest,ref.sourceDigest);
  console.log('PASS LIBRA observed generation gap analyses new response through canonical pipeline');
 }finally{await l.r.cleanup();}
 for(const failure of ['provider','migration_readback']){
  const l=await lineageFixture({snapshot:require('./fixtures/legacy_v3_frozen_1_batches.json')});
  try{const ref=l.manifest().memories['1'],old=l.r.values.get(ref.key);
   if(failure==='provider')l.control.modelFails=true;
   else{const store=l.r.context.risuai.pluginStorage,write=store.setItem;store.setItem=async(k,v)=>String(k).includes(':unified-migration:')?true:write(k,v);}
   l.chat.message[9].data+=' A revised source.';await l.r.sourceEditBoundary();const sync=l.r.api.getSourceEditSyncStatus();
   assert.equal(sync.tasks[0].state,'failed',JSON.stringify({failure,sync,job:await l.r.api.getCanonicalJobStatus()}));
   assert.equal(l.r.values.get(ref.key),old);assert.equal(l.manifest().memories['1'].key,ref.key);
   if(failure==='provider')assert.equal(memoryCalls(l),1,'provider failure is attempted automatically before returning');
   console.log('PASS legacy source edit '+failure+' failure preserves canonical');
  }finally{await l.r.cleanup();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
