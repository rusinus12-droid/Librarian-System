'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
// This root stays in one host scope. The branch-selectable wrapper initializes
// its host only after startup; frozen-manifest startup requires an available host.
async function lineageFixture(options){const l=await fixture(options);return {...l,manifest:l.getManifest};}
async function observeSource(l){return bounded(l.control.hooks.beforeRequest([{role:'user',content:'Continue.'}],'model'),'LIBRA source observation');}
const {countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const memoryCalls=f=>countCalls(f.control).canonical;
async function replaceSelected(l,start=1){const inventory=await l.r.api.listCanonicalBatchRanges();return l.r.api.startSelectedCanonicalBatches({scopeKey:inventory.scopeKey,mode:'source_edit',ranges:inventory.ranges.filter(r=>r.startTurn===start)});}
async function bounded(promise,label,ms=8000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error(label+' timed out')),ms))]);}finally{clearTimeout(timer);}}
const hash=s=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),0x01000193);return(h>>>0).toString(36);};
function repairEnvelope(sourceText){const p=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:sourceText});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[sourceText];const grounding=[];const walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:path+'['+i+']',source:'target',evidence:[sourceText]});});return;}if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};for(const a of ['entity','world','narrative','planner'])walk(p[a],a);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[sourceText]});return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};}
// Keep Node alive through awaited owner jobs; the official root deadline is unchanged.
const pendingRoot=setInterval(()=>{},1000);
(async()=>{
 const failures=[];
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
  const chat=await f.host.getChat();chat.message=[{role:'user',chatId:'u1',data:'Where is Alice?'},{role:'assistant',chatId:'a1',data:'Alice waits in the office.'}];chat.messages=chat.message;
  await f.api.saveSettings({...await f.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',autoEpisodeIndex:false});
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await f.api.resolveCurrentScope();const original=await t.loadScopeRecords(scope.scopeKey);
  const oldRaw=original.records.filter(r=>r.sourceType==='response');assert.ok(oldRaw.length);
  const frozen=JSON.stringify(oldRaw);const initial=await t.flashbackSourceEditSnapshot();assert.ok(initial.units[0].identity&&initial.units[0].sourceDigest);
  chat.message[1].data='Alice leaves the office.';
  const edited=await t.flashbackSourceEditSnapshot();assert.equal(edited.units[0].identity,initial.units[0].identity);assert.notEqual(edited.units[0].sourceDigest,initial.units[0].sourceDigest);
  assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records.filter(r=>r.sourceType==='response')),frozen,'observation does not rewrite raw');
  const inventory=await f.api.listReanalysisRanges();const selected=await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')});assert.equal(selected.ok,true,JSON.stringify(selected));
  const replaced=await t.loadScopeRecords(scope.scopeKey);assert.ok(replaced.records.some(r=>r.text.includes('Alice leaves')));
  const history=await t.loadTurnWorldline(scope.scopeKey);assert.ok(history.retiredRecords.some(r=>r.text.includes('Alice waits')),'previous raw retained in inactive history');
  for(const old of oldRaw)assert.ok(history.retiredRecords.some(r=>r.id===old.id&&r.text===old.text&&r.sourceHash===old.sourceHash),'old raw identity/text/hash immutable');
  chat.message[1].data='Alice waits in the office.';
  const restored=await t.flashbackSourceEditSnapshot();assert.equal(restored.units[0].sourceDigest,initial.units[0].sourceDigest,'known revision projects to its original digest');
  const replacementRecord=replaced.records.find(r=>r.text.includes('Alice leaves'));assert.ok(replacementRecord);
  chat.message.splice(1);const gap=await t.flashbackSourceEditSnapshot();assert.equal(gap.units.length,0,'an incomplete pair has no selectable source');
  const gapInventory=await f.api.listReanalysisRanges();assert.equal(gapInventory.ranges.length,0);
  const refused=await f.api.reanalyzeSelectedRanges(inventory);assert.equal(refused.ok,false,'selection from before observed gap is refused');
  chat.message.push({role:'assistant',chatId:'a1',data:'Alice returns to the office.'});const generated=await t.flashbackSourceEditSnapshot();assert.equal(generated.units.length,1);assert.notEqual(generated.units[0].sourceDigest,initial.units[0].sourceDigest);
  assert.equal(JSON.stringify((await t.loadTurnWorldline(scope.scopeKey)).retiredRecords),JSON.stringify(history.retiredRecords),'projection and refused selection preserve old raw history');
  console.log('PASS Flashback current source projection, explicit raw replacement and generation-gap selection refusal preserve previous raw');
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
  await observe();assert.equal(b.llmCalls.length,0,'generation-gap observation never creates paid analysis');
  const gapInventory=await b.hayaku.listReanalysisRanges();assert.equal(gapInventory.ranges.length,1,'new complete response is explicitly selectable');
  b.chat.message[1].data='Alice directly edits this source.';await observe();b.setLlmResponder(async()=>({type:'success',result:JSON.stringify(repairEnvelope('Alice directly edits this source.'))}));
  await b.callBeforeRequest([{role:'user',data:'Continue after the direct edit.'}],'model');
  assert.equal(b.llmCalls.length,0,'registered hook does not analyze direct edits implicitly');await b.callAfterRequest('','model');
  const inventory=await b.hayaku.listReanalysisRanges();const result=await b.hayaku.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')});assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(b.llmCalls.length,1,'explicit selected reanalysis makes exactly one actual Other Ax call');
  const ledger=await b.hayaku.ledger.inspect({includeRecords:true});assert.ok(ledger.records.some(r=>r.recordState==='active'&&JSON.stringify(r).includes('Alice directly edits this source.')),'actual selected native packet is durably active');
  assert.equal(b.chat.message[1].data,'Alice directly edits this source.','host source immutable');
  console.log('PASS HAYAKU observed generation gap and direct edits remain model-free until explicit selected native analysis');
 }finally{await bounded(b.dispose(),'HAYAKU disposal');}
 const l=await bounded(lineageFixture({snapshot:require('./fixtures/legacy_v3_frozen_1_batches.json')}),'frozen legacy fixture initialization');
 try{
  const ref=l.manifest().memories['1'],old=l.r.values.get(ref.key),oldSource=l.chat.message[9].data;l.chat.message[9].data+=' A new source revision.';
  const callsBefore=memoryCalls(l);await observeSource(l);assert.equal(memoryCalls(l),callsBefore,'request source observation is model-free');assert.equal(l.manifest().memories['1'].key,ref.key);
  const result=await bounded(replaceSelected(l),'LIBRA explicit selected replacement');assert.equal(result.ok,true,JSON.stringify(result));assert.equal(memoryCalls(l),callsBefore+1,'explicit selected source replacement calls canonical provider once');
  assert.notEqual(l.manifest().memories['1'].sourceDigest,ref.sourceDigest);assert.notEqual(l.manifest().memories['1'].key,ref.key);
  assert.equal(l.r.values.get(ref.key),old,'old canonical bytes remain immutable through explicit selected replacement');
  console.log('PASS explicit selected source edit replaces legacy canonical and preserves original bytes');
  const calls=memoryCalls(l),selectedKey=l.manifest().memories['1'].key;l.chat.message[9].data=oldSource;
  await observeSource(l);
  assert.equal(l.manifest().memories['1'].key,selectedKey,'same-slot text edits preserve the explicitly selected canonical');
  // Known native rerolls are distinguished by an observed generation gap. A
  // direct text restoration alone no longer switches selected canonical memory.
  const knownMessage=l.chat.message.pop();await observeSource(l);
  assert.equal(l.manifest().memories['1'].inactiveReason,'rollback_or_incomplete_batch');
  l.chat.message.push(knownMessage);await observeSource(l);
  assert.equal(memoryCalls(l),calls,'known original revision reuses canonical without generation');
  assert.equal(l.manifest().memories['1'].sourceDigest,ref.sourceDigest);
  assert.equal(l.r.values.get(ref.key),old,'known revision reuse retains immutable original canonical');
  console.log('PASS LIBRA known response revision reactivates old canonical without source-edit prompt or model call');
  const oldMessage=l.chat.message.pop();await observeSource(l);await bounded(l.r.api.startManualCanonicalScan(),'manual scan after generation gap');
  assert.equal(l.manifest().memories['1'].inactiveReason,'rollback_or_incomplete_batch');
  l.chat.message.push({...oldMessage,data:oldSource+' A generated new response.'});
  await observeSource(l);const manual=await bounded(l.r.api.startManualCanonicalScan(),'manual scan for new generated response');
  assert.equal(manual.failed,1,'legacy state replay requires an explicit current-format source selection');
  assert.ok(manual.failures.some(row=>row.message.includes('UNIFIED_REPLAY_REQUIRES_MIGRATION')),JSON.stringify(manual));
  assert.equal(memoryCalls(l),calls,'refused legacy replay does not call the provider');
  const branch=await bounded(replaceSelected(l),'explicit selected generation-gap legacy refusal');assert.equal(branch.ok,false,JSON.stringify(branch));
  assert.ok(branch.job.failures.some(row=>row.message.includes('UNIFIED_EDIT_HEAD_UNSUPPORTED')),JSON.stringify(branch));
  assert.equal(memoryCalls(l),calls,'unsupported legacy Head never authorizes a provider call');
  assert.equal(l.r.values.get(ref.key),old,'unsupported legacy replay preserves original canonical bytes');
  console.log('PASS LIBRA restored legacy Head generation-gap writes remain explicitly unsupported and preserve raw');
 }finally{await l.r.cleanup();}
 // The supported current native Head retains the original positive generation-gap
 // contract. This does not claim historical legacy-Head writer compatibility.
 const nativeChat=JSON.parse(JSON.stringify(require('./fixtures/legacy_v3_frozen_1_batches.json').chat));nativeChat.id=nativeChat.chatId='native-gap-scope';
 const g=await bounded(lineageFixture({snapshot:{chat:nativeChat,values:[]}}),'current native fixture');
 try{
  await bounded(g.r.api.runManualColdStart(),'current native canonical baseline');
  const prefix=g.manifest().memories['1'];
  const second=g.chat.message.slice(0,10).map((m,i)=>({...m,chatId:'t'+(6+Math.floor(i/2))+'-'+(i%2?'a':'u')}));g.chat.message.push(...second);
  const nextArtifact=JSON.parse(JSON.stringify(g.control.artifact));for(const x of [...nextArtifact.entities,...nextArtifact.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\d+)/,(_,v)=>'t'+(Number(v)+5));g.control.artifact=nextArtifact;
  const suffix=await bounded(g.r.api.startManualCanonicalScan(),'current native second canonical batch');assert.equal(suffix.completed,1,JSON.stringify(suffix));
  const prefixBytes=g.r.values.get(prefix.key),ref=g.manifest().memories['6'],old=g.r.values.get(ref.key),calls=memoryCalls(g),message=g.chat.message.pop();
  await observeSource(g);assert.equal(g.manifest().memories['6'].inactiveReason,'rollback_or_incomplete_batch');
  g.chat.message.push({...message,data:message.data+' A generated new response.'});await observeSource(g);
  assert.equal(memoryCalls(g),calls,'current native generation-gap observation stays model-free');
  const result=await bounded(replaceSelected(g,6),'current native generation-gap selected canonical');assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(memoryCalls(g),calls+1,'actual selected native generation-gap canonical makes one provider call');
  assert.notEqual(g.manifest().memories['6'].sourceDigest,ref.sourceDigest);assert.equal(g.r.values.get(ref.key),old);assert.equal(g.manifest().memories['1'].key,prefix.key);const before=JSON.parse(prefixBytes),after=JSON.parse(g.r.values.get(prefix.key));
  console.log('PASS LIBRA native selected generation-gap paid canonical and immutable selected prior revision');
  // Passive retrieval annotation settles independently of canonical analysis.
  // Every other persisted field, including source/raw/artifact identity, is exact.
  const pendingEmbedding={status:'pending',projectionVersion:'libra.retrieval_projection.v2'},disabledEmbedding={status:'disabled',reason:'API Key',projectionVersion:'libra.retrieval_projection.v2',vectorCount:0};
  assert.deepEqual(before.embedding,before.embedding.status==='pending'?pendingEmbedding:disabledEmbedding);
  assert.deepEqual(after.embedding,disabledEmbedding,'unconfigured passive embedding only settles to disabled/API Key with no vector');
  const {embedding:beforeEmbedding,...beforeCanonical}=before,{embedding:afterEmbedding,...afterCanonical}=after;
  assert.deepEqual(afterCanonical,beforeCanonical,'every unselected prefix field except the exact passive embedding annotation remains immutable');
  console.log('PASS LIBRA current native observed generation gap explicitly analyzes new response through canonical pipeline');
 }catch(error){failures.push({case:'current native generation gap',message:error.message.split('\n')[0]});console.error('FAIL current native generation gap:',error.message.split('\n')[0]);}finally{await g.r.cleanup();}
 for(const failure of ['provider','migration_readback']){
  const l=await bounded(lineageFixture({snapshot:require('./fixtures/legacy_v3_frozen_1_batches.json')}),'frozen legacy fixture initialization');
  try{const ref=l.manifest().memories['1'],old=l.r.values.get(ref.key);let injectedWrites=0,injectedCalls=0;
   if(failure==='provider')l.control.onCall=async()=>{injectedCalls++;return {type:'error',result:'synthetic_provider_failure'};};
   else{const store=l.r.context.risuai.pluginStorage,write=store.setItem;store.setItem=async(k,v)=>{if(String(k).includes(':unified-migration:')){injectedWrites++;return true;}return write(k,v);};}
   l.chat.message[9].data+=' A revised source.';await observeSource(l);assert.equal(memoryCalls(l),0,'failure fixture request observation remains model-free');const result=await bounded(replaceSelected(l),'LIBRA explicit selected replacement');
   assert.equal(result.ok,false,JSON.stringify({failure,result,job:await l.r.api.getCanonicalJobStatus()}));
   assert.ok(result.job.failures.some(row=>row.message.includes(failure==='provider'?'UNIFIED_PROVIDER_FAILED:canonical_artifact_not_one_json_object':'UNIFIED_MIGRATION_WRITE_READBACK_FAILED')),JSON.stringify({failure,result}));
   if(failure==='migration_readback')assert.ok(injectedWrites>0,'negative reaches the intended physical migration write');
   assert.equal(l.r.values.get(ref.key),old);assert.equal(l.manifest().memories['1'].key,ref.key);
   if(failure==='provider'){assert.equal(injectedCalls,1,'negative reaches the intended actual provider failure');assert.equal(memoryCalls(l),1,'explicit provider failure is actually attempted before returning');}
   console.log('PASS legacy source edit '+failure+' failure preserves canonical');
  }catch(error){failures.push({case:failure,message:error.message.split('\n')[0]});console.error('FAIL '+failure+':',error.message.split('\n')[0]);}finally{await l.r.cleanup();}
 }
 assert.equal(failures.length,0,JSON.stringify(failures));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearInterval(pendingRoot));
