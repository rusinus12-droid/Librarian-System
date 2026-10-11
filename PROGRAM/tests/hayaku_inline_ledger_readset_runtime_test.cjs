'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {physicalStore,digest,observeInlineReturns}=require('./fixtures/hayaku_inline_physical_store.cjs');
const N=10,BASE='567630fda7df236e14e3feb4873e52366232b509',source=process.env.HAYAKU_INLINE_READSET_SOURCE||path.resolve(__dirname,'../plugins/HAYAKU_Locator_Continuity.js');
const evidence=process.env.HAYAKU_INLINE_READSET_EVIDENCE||fs.mkdtempSync(path.join(os.tmpdir(),'LIB-HAYAKU-Inline-Readset-'));
fs.mkdirSync(evidence,{recursive:true});const sourceSHA=digest(fs.readFileSync(source)),receipts=[];
function observeVerifiedWriterFrame(sourcePath,destination){
 const receipt=observeInlineReturns(sourcePath,destination),original=fs.readFileSync(destination,'utf8');
 const seam='    if (!await verifyHayakuReadset(readsetFrame)) return refused();';
 assert.equal(original.split(seam).length,3,'initial and pre-publication actual frame verification sites');
 const instrumented=original.replace(seam,seam+"\n    if(readsetFrame)globalThis.__HAYAKU_VERIFIED_WRITER_FRAMES__.push({requestId:readsetFrame.requestId,scopeKey:readsetFrame.scope.key,transcript:readsetFrame.transcript,body:readsetFrame.body});");
 fs.writeFileSync(destination,'globalThis.__HAYAKU_VERIFIED_WRITER_FRAMES__=[];\n'+instrumented);
 return {...receipt,observedSHA:digest(fs.readFileSync(destination)),writerFrameObservation:'existing successful private verifyHayakuReadset observed before persistence; no added await or changed decision'};
}
function packet(turn,changed=false){const summary=turn===1?(changed?'Aurora vault contains silver calibration spindle READSET_NEW.':'Aurora vault contains amethyst calibration spindle READSET_OLD.'):'Routine archive entry '+turn+' has been recorded.';const p=createValidPacket({turn,summary,subject:'Archivist',scene:'archive'});p.world.world_rules=[{id:'fact-'+turn,summary}];return p;}
function messages(){const rows=[];for(let turn=1;turn<=N;turn++){const p=packet(turn);rows.push({role:'user',chatId:'u'+turn,data:'Archive completed entry '+turn+'.'},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage(p.meta.summary_memory.summary,p)});}rows.push({role:'system',chatId:'unselected-tail',data:'Unselected whole-host control tail ORIGINAL'});return rows;}
function hostView(h){return {chat:JSON.parse(JSON.stringify(h.chat)),character:JSON.parse(JSON.stringify(h.character)),arguments:[...h.argumentsMap],settings:h.hayaku.settings(),owner:h.context.__HAYAKU_RUNTIME_OWNER_V1__,model:h.__diagnosticModel,readAvailable:h.__diagnosticReadAvailable,storageMode:h.__diagnosticStorageMode,pluginProviderRoot:h.host.pluginStorage.root,localProviderRoot:h.host.safeLocalStorage.root};}
async function enteredGate(gate){let timer;try{return await Promise.race([gate.entered,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('PHYSICAL_GATE_NOT_REACHED')),3000))]);}finally{clearTimeout(timer);}}
const cases=[
 ['positive evidence write','evidence','write','none'],
 ['positive ledger write','ledger','write','none'],
 ['positive ledger readback','ledger','readback','none'],
 ['same-scope body after evidence initial read','evidence','read','body'],
 ['same-scope body during evidence write','evidence','write','body'],
 ['unselected tail after evidence readback','evidence','readback','tail'],
 ['same-scope body during ledger write','ledger','write','body'],
 ['same-scope body after ledger readback','ledger','readback','body'],
 ['unselected tail after ledger readback','ledger','readback','tail'],
 ['selected scope after ledger readback','ledger','readback','scope'],
 ['model and budget after ledger readback','ledger','readback','model'],
 ['retrieval mode argument after ledger readback','ledger','readback','mode'],
 ['effective settings after ledger readback','ledger','readback','settings'],
 ['storage mode explicit authority after ledger readback','ledger','readback','storage-policy'],
 ['actual configure URL same provider after ledger readback','ledger','readback','url'],
 ['host read unavailable after ledger readback','ledger','readback','unavailable'],
 ['actual storage provider after ledger readback','ledger','readback','provider'],
 ['runtime owner after ledger readback','ledger','readback','owner'],
 ['canonical head rewrite after sampled readback','ledger','readback','head-drift'],
 ['canonical ledger write rejection and next attempt','ledger','write','head-failure']
 ,['positive late ledger settlement','ledger','write','late-none']
 ,['late ledger settlement after body edit','ledger','write','late-body']
 ,['settings read unavailable after ledger readback','ledger','readback','settings-unavailable']
 ,['storage authority metadata unavailable after ledger readback','ledger','readback','metadata-unavailable']
 ,['public source rule edit stays blocked during ledger readback','ledger','readback','source-rule']
 ,['persisted effective source policy after ledger readback','ledger','readback','source-pref']
 ,['fixed incoming render input after ledger readback','ledger','readback','input']
 ,['certified reset preference during held ledger write','ledger','write','reset-v2']
 ,['device certified reset preference during held ledger write','ledger','write','reset-device-v2']
];
for(const [name,targetFamily,op,mutation]of cases)test(name+' preserves inline whole-host readset authority',async()=>{
 const caseRoot=path.join(evidence,name.replace(/[^a-z0-9]+/gi,'-')),store=await physicalStore(path.join(caseRoot,'original')),safe=await physicalStore(path.join(caseRoot,'safe'));await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));const rows=messages();
 const observedSource=path.join(caseRoot,'observed-source.js'),observation=observeVerifiedWriterFrame(source,observedSource);
 const h=await createHayakuRuntime({pluginSourceFile:observedSource,pluginStorage:store,safeLocalStorage:safe,messages:rows,chatId:'readset-main',autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,failedRecoveryAutomation:'off',arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');}});
 let gate,pending,replacement,receipt,previousOwner,mutationResult;
 try{
  await waitFor(()=>h.host.unloadHandlers.length>0,'complete installation');h.hayaku._test.stopWorldlineTopologyObserver();h.__diagnosticModel='diagnostic-model-A';h.__diagnosticReadAvailable=true;const oldDatabase=h.host.getDatabase;let maxContext=128000;h.host.getDatabase=async fields=>({...await oldDatabase(fields),selectedModel:h.__diagnosticModel,model:h.__diagnosticModel,maxContext});
  h.__diagnosticStorageMode=JSON.parse(JSON.stringify(await h.context.__HAYAKU_DIAGNOSTIC_STORAGE_BRIDGE__.getScopeMode()));
  if(mutation==='settings'){const originalGet=h.host.getArgument;h.host.getArgument=async key=>{if(String(key)==='memory_suite_server_url')await new Promise(resolve=>setTimeout(resolve,65));return originalGet.call(h.host,key);};}
  const scope=await h.hayaku._test.currentChatScope(),beforeHost=hostView(h),initialInventory=await store.inventory(),input=[{role:'user',content:'What does Aurora vault contain?'}];gate=store.arm(targetFamily,op);pending=h.callBeforeRequest(input,'model');const gateEvent=await enteredGate(gate);
  const preMutation=h.hayaku.lastDebug().localRecallSourceIndex?.routing,verifiedWriterFrames=JSON.parse(JSON.stringify(h.context.__HAYAKU_VERIFIED_WRITER_FRAMES__)),mutatedAt=Date.now();
  if(mutation==='body'||mutation==='late-body'){const p=packet(1,true);rows[1]={role:'assistant',chatId:'a1',data:hiddenPacketMessage(p.meta.summary_memory.summary,p)};h.setMessages(rows);}
  if(mutation==='tail'){rows.at(-1).data='Unselected whole-host control tail CHANGED';h.setMessages(rows);}
  if(mutation==='scope'){h.chat.id=h.chat.chatId='readset-other';}
  if(mutation==='model'){h.__diagnosticModel='diagnostic-model-B';maxContext=64000;}
  if(mutation==='mode')h.argumentsMap.set('hayaku_mode','deep');
  if(mutation==='settings'){mutationResult=await h.hayaku.settingsControl.apply({hayaku_mode:'deep'});assert.equal(mutationResult.ok,true,'public settings transaction must actually apply');assert.equal(mutationResult.readbackVerified,true);assert.equal(h.hayaku.settings().mode,'deep');}
  if(mutation==='storage-policy'){assert.equal(h.__diagnosticStorageMode.explicit,false);mutationResult=await h.context.__HAYAKU_DIAGNOSTIC_STORAGE_BRIDGE__.setMode('plugin_only');h.__diagnosticStorageMode=JSON.parse(JSON.stringify(await h.context.__HAYAKU_DIAGNOSTIC_STORAGE_BRIDGE__.getScopeMode()));assert.equal(h.__diagnosticStorageMode.explicit,true);assert.equal(h.__diagnosticStorageMode.mode,'plugin_only');}
  if(mutation==='url'){
   const bridge=h.context.__HAYAKU_DIAGNOSTIC_STORAGE_BRIDGE__,before=await bridge.getConnectionSettings({force:true}),physicalBefore=await store.physicalValue(gateEvent.key),provider=h.host.pluginStorage;
   h.host.nativeFetch=async url=>{const target=new URL(url),body=target.pathname==='/bootstrap'?{ok:true,schema:'memory-suite.storage.bootstrap.v1',token:'diagnostic-opaque-token',url:target.origin,protocol:{major:1},namespaces:['hayaku'],capabilities:Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1'].map(key=>[key,true]))}:{ok:true,result:{ok:true,records:0}};return {ok:true,status:200,text:async()=>JSON.stringify(body)};};
   mutationResult=await bridge.configureConnection({url:'http://127.0.0.1:39281',mode:'plugin_only'});const after=await bridge.getConnectionSettings({force:true});assert.equal(mutationResult.ok,true);assert.notEqual(after.url,before.url);assert.equal(after.mode,before.mode);assert.equal(h.host.pluginStorage,provider);assert.equal(await store.physicalValue(gateEvent.key),physicalBefore,'identical ledger bytes and store cannot certify unchanged URL authority');
  }
  if(mutation==='unavailable'){h.__diagnosticReadAvailable=false;for(const method of ['getChat','getCurrentChat','getChatFromIndex','getCharacter','getChar','getCharacterFromIndex','getCurrentCharacterIndex','getCurrentChatIndex','getDatabase'])h.host[method]=async()=>{throw Error('CONTROLLED_HOST_READ_UNAVAILABLE');};}
  if(mutation==='settings-unavailable'){h.__diagnosticReadAvailable=false;h.host.getArgument=h.host.getArg=async()=>{throw Error('CONTROLLED_SETTINGS_READ_UNAVAILABLE');};}
  if(mutation==='metadata-unavailable'){h.__diagnosticReadAvailable=false;store.rejectMetadataReads=true;}
  if(mutation==='source-rule'){const oldRules=JSON.stringify(h.hayaku.getSourceEditRules());await assert.rejects(()=>h.hayaku.setSourceEditRules({version:1,ignoredTags:['lb-xnai','thoughts','diagnostic-ignored'],unwrapTags:[],sourceTags:[],controls:['html-comment','lbdata']}),/SOURCE_IGNORE_TAGS_BUSY/);assert.equal(JSON.stringify(h.hayaku.getSourceEditRules()),oldRules);mutationResult={blocked:true};}
  if(mutation==='source-pref'){const key='hayaku.v2.settings.source-tracking.v1',prefs=JSON.parse(await store.physicalValue(key));prefs.ignoredTags=['changed-during-write'];prefs.externalRulesVersion=1;await store.setItem(key,JSON.stringify(prefs));}
  if(mutation==='input')input[0].content='What does Borealis shelf contain?';
  if(mutation==='reset-v2'||mutation==='reset-device-v2'){const owner=mutation==='reset-v2'?store:safe;await owner.setItem('memory_suite_reset_choice.v2.hayaku',JSON.stringify({diagnostic:'opaque changed certified preference'}));h.__diagnosticStorageMode={...h.__diagnosticStorageMode,resetPreferenceChanged:true};}
  if(mutation==='provider'){replacement=await physicalStore(path.join(caseRoot,'replacement'));h.host.pluginStorage=replacement;}
  if(mutation==='owner'){previousOwner=h.context.__HAYAKU_RUNTIME_OWNER_V1__;h.context.__HAYAKU_RUNTIME_OWNER_V1__='readset-replacement-runtime';}
  if(mutation==='head-failure')store.rejectLedgerWrite=true;
  if(mutation==='head-drift'){const head=JSON.parse(await store.physicalValue(gateEvent.key));head.updatedAt+=1;await store.setItem(gateEvent.key,JSON.stringify(head));}
  const afterMutationHost=hostView(h);if(mutation.startsWith('late-'))await new Promise(resolve=>setTimeout(resolve,1700));gate.release();const output=await pending,debug=h.hayaku.lastDebug(),commit=debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit;const context=output.filter(row=>row.memo==='hayaku-runtime-context-v3').map(row=>String(row.content||'')).join('\n');
  if(mutation.startsWith('late-'))await waitFor(()=>h.context.__HAYAKU_EVENTUAL_LEDGER_RETURN_OBSERVATION__.length,'eventual ledger result');
  const inlineReturns=JSON.parse(JSON.stringify(h.context.__HAYAKU_INLINE_LEDGER_RETURN_OBSERVATION__));
  receipt={name,base:BASE,sourceSHA,observation,N,targetFamily,op,mutation,mutationResult:mutationResult?{ok:mutationResult.ok,changed:mutationResult.changed,readbackVerified:mutationResult.readbackVerified}:null,evidence:caseRoot,gateEvent,mutatedAt,hostChanged:digest(JSON.stringify(beforeHost))!==digest(JSON.stringify(afterMutationHost)),beforeHostSHA:digest(JSON.stringify(beforeHost)),afterHostSHA:digest(JSON.stringify(afterMutationHost)),inlineReturns,commit:commit?{saved:commit.saved,durable:commit.durable,storageState:commit.storageState,reason:commit.reason,ledgerWritePolicy:commit.ledgerWritePolicy}:null,outputOld:context.includes('READSET_OLD'),outputNew:context.includes('READSET_NEW'),preMutationValidation:preMutation,verifiedWriterFrames,finalValidation:debug.localRecallSourceIndex?.routing,initialInventory,finalInventory:await store.inventory(),replacementInventory:replacement?await replacement.inventory():null,events:store.events,transcriptSHA:digest(JSON.stringify(h.chat.message)),actualModelCalls:h.llmCalls.length,hostTransportCalls:h.fetchCalls.length};receipts.push(receipt);fs.writeFileSync(path.join(caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));
  if(mutation==='body'||mutation==='scope'||mutation==='head-failure'){
   store.rejectLedgerWrite=false;const nextOutput=await h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model'),nextDebug=h.hayaku.lastDebug(),nextContext=nextOutput.filter(row=>row.memo==='hayaku-runtime-context-v3').map(row=>String(row.content||'')).join('\n');receipt.nextAttempt={commit:nextDebug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,old:nextContext.includes('READSET_OLD'),new:nextContext.includes('READSET_NEW'),rawReads:nextDebug.localRecallSourceIndex?.routing?.validationRawReads};fs.writeFileSync(path.join(caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));assert.equal(receipt.nextAttempt.commit,true,'fresh next attempt still establishes a durable ledger');assert.equal(receipt.nextAttempt.rawReads,N);if(mutation==='body'){const persistedChoice=targetFamily==='ledger';assert.equal(receipt.nextAttempt.new,!persistedChoice,'fresh request uses live source only before an approved ledger head has been saved');assert.equal(receipt.nextAttempt.old,persistedChoice,'saved canonical choice is preserved until explicit replacement');}
  }
  assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);const frame=verifiedWriterFrames.find(row=>row.scopeKey===scope.key&&row.transcript===JSON.stringify(beforeHost.chat.message));assert.ok(frame,'actual writer verified exact entire accepted host transcript before persistence gate');assert.equal(JSON.parse(frame.transcript).filter(row=>row.role==='assistant').length,N);assert.ok(JSON.parse(frame.body).literal,'writer verified actual literal host authority');if(preMutation.validationRawReads!==undefined){assert.equal(preMutation.validationRawReads,N);assert.equal(preMutation.validationSources,N);assert.equal(preMutation.validationPolicy,'accepted_raw_source_scan_without_host_revision_certificate');}else{assert.equal(preMutation.scanned,N);assert.equal(preMutation.complete,true);assert.equal(preMutation.index.current,false);assert.equal(preMutation.index.durable,false);assert.equal(preMutation.index.status,'binding_unavailable','optional40ms posting binding timeout retains bounded lexical fallback and full writer certificate');}
  receipt.eventualReturns=JSON.parse(JSON.stringify(h.context.__HAYAKU_EVENTUAL_LEDGER_RETURN_OBSERVATION__));fs.writeFileSync(path.join(caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));
  if(mutation==='none'||mutation==='source-rule'){assert.equal(commit?.durable,true);assert.equal(receipt.outputOld,true);assert.equal(receipt.hostChanged,false);assert.equal(receipt.finalValidation.validationRawReads,N);}
  else if(mutation==='late-none'){assert.equal(commit?.durable,false);assert.equal(receipt.outputOld,true);assert.equal(receipt.hostChanged,false);assert.equal(receipt.eventualReturns.some(row=>row.durable),true,'unchanged late physical write remains eventually confirmable');}
  else if(mutation==='late-body'){assert.equal(receipt.eventualReturns.some(row=>row.durable),false,'late reconciliation must retain the original host readset fence');assert.equal(receipt.outputOld,false);}
  else if(mutation==='head-failure'){assert.equal(commit?.durable,false);assert.equal(commit?.saved,false);assert.equal(receipt.outputOld,true,'unchanged live primary source is still available when its secondary mirror write fails');}
  else{if(!['head-drift','input','source-pref'].includes(mutation))assert.equal(receipt.hostChanged,true);assert.equal(inlineReturns.some(row=>row.durable===true),false,'changed whole-host readset cannot receive an inline writer durable acknowledgement');assert.notEqual(commit?.durable,true,'changed whole-host readset cannot receive an inline durable commit acknowledgement');assert.equal(receipt.outputOld,false,'stale pre-await request cannot publish current-source recall');assert.notEqual(receipt.finalValidation?.index?.current,true);assert.notEqual(receipt.finalValidation?.index?.durable,true);}
 }finally{gate?.release();if(pending)await pending.catch(()=>{});if(previousOwner)h.context.__HAYAKU_RUNTIME_OWNER_V1__=previousOwner;await h.dispose();}
});
async function boundedRuntime(name,extra={}){
 const caseRoot=path.join(evidence,name),store=await physicalStore(path.join(caseRoot,'original')),safe=await physicalStore(path.join(caseRoot,'safe')),rows=messages();await store.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));const observed=path.join(caseRoot,'observed-source.js');observeInlineReturns(source,observed);
 const h=await createHayakuRuntime({pluginSourceFile:observed,pluginStorage:store,safeLocalStorage:safe,messages:rows,chatId:'readset-main',autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,failedRecoveryAutomation:'off',arguments:{hayaku_packet_recovery:'false',...extra.arguments},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');},...extra});await waitFor(()=>h.host.unloadHandlers.length>0,'complete installation');h.hayaku._test.stopWorldlineTopologyObserver();return {h,store,rows,caseRoot};
}
const recallBodies=output=>output.filter(row=>row.memo==='hayaku-runtime-context-v3').map(row=>String(row.content||'')).join('\n');
test('absent certified reset preference remains admissible without legacy authority upgrading',async()=>{
 const f=await boundedRuntime('absent-reset-v2');try{
  const key='memory_suite_reset_choice.v2.hayaku';assert.equal(await f.store.getItem(key),null);
  const output=await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model'),debug=f.h.hayaku.lastDebug();const receipt={name:'absent-reset-v2',base:BASE,sourceSHA,N,evidence:f.caseRoot,delivery:recallBodies(output).includes('READSET_OLD'),commit:debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,wholeRawReads:debug.localRecallSourceIndex?.routing?.validationRawReads,pluginValue:await f.store.getItem(key),deviceValue:await f.h.host.safeLocalStorage.getItem(key),models:f.h.llmCalls.length};receipts.push(receipt);fs.writeFileSync(path.join(f.caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));assert.equal(receipt.delivery,true);assert.equal(receipt.commit,true);assert.equal(receipt.wholeRawReads,N);assert.equal(receipt.pluginValue,null);assert.equal(receipt.deviceValue,null);assert.equal(receipt.models,0);
 }finally{await f.h.dispose();}
});
test('default first unchanged request avoids retired journals and fresh attempt retains current posting proof',async()=>{
 const caseRoot=path.join(evidence,'default-auto-fresh-attempt'),store=await physicalStore(path.join(caseRoot,'original')),safe=await physicalStore(path.join(caseRoot,'safe')),observed=path.join(caseRoot,'observed-source.js');observeInlineReturns(source,observed);
 const h=await createHayakuRuntime({pluginSourceFile:observed,pluginStorage:store,safeLocalStorage:safe,messages:messages(),chatId:'readset-main',autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,failedRecoveryAutomation:'off',arguments:{hayaku_packet_recovery:'false'},llmResponder:async()=>{throw Error('FORBIDDEN_MODEL');}});
 try{await waitFor(()=>h.host.unloadHandlers.length>0,'complete installation');h.hayaku._test.stopWorldlineTopologyObserver();const scope=await h.hayaku._test.currentChatScope(),journal='hayaku.v2.source-edit.'+scope.key;assert.equal(await store.getItem(journal),null);const input=[{role:'user',content:'What does Aurora vault contain?'}],first=await h.callBeforeRequest(input,'model'),firstDebug=h.hayaku.lastDebug();assert.equal(firstDebug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,true,'unchanged default first request must commit without a retry');assert.equal(recallBodies(first).includes('READSET_OLD'),true,'same first request must publish its verified current recall');assert.equal(firstDebug.localRecallSourceIndex?.routing?.validationRawReads,N);assert.equal(firstDebug.localRecallSourceIndex?.routing?.validationSources,N);assert.equal(h.llmCalls.length,0);assert.equal(await store.getItem(journal),null,'ordinary admission never initializes the retired automatic source journal');let output,index;for(let i=0;i<40;i++){output=await h.callBeforeRequest(input,'model');index=h.hayaku.lastDebug().localRecallSourceIndex?.routing?.index;if(index?.current&&index?.durable)break;await new Promise(resolve=>setTimeout(resolve,20));}const debug=h.hayaku.lastDebug(),receipt={name:'default-auto-fresh-attempt',base:BASE,sourceSHA,N,evidence:caseRoot,firstDelivery:recallBodies(first).includes('READSET_OLD'),firstCommit:firstDebug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,firstWholeRawReads:firstDebug.localRecallSourceIndex?.routing?.validationRawReads,nextDelivery:recallBodies(output).includes('READSET_OLD'),nextIndex:index,nextCommit:debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,wholeRawReads:debug.localRecallSourceIndex?.routing?.validationRawReads,inventory:await store.inventory(),models:h.llmCalls.length};receipts.push(receipt);fs.writeFileSync(path.join(caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));assert.equal(receipt.nextDelivery,true);assert.equal(receipt.nextCommit,true);assert.equal(index?.current,true);assert.equal(index?.durable,true,'fresh same-digest attempt retains its current durable posting proof');assert.equal(receipt.wholeRawReads,N);assert.equal(receipt.models,0);
 }finally{await h.dispose();}
});
test('literal structured physical ledger head remains admissible across fresh reads',async()=>{
 const f=await boundedRuntime('structured-head');try{
  await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model');const key=(await f.store.keys()).find(key=>key.startsWith('hayaku.v2.ledger.')),head=JSON.parse(await f.store.physicalValue(key));await f.store.setItem(key,head);
  const output=await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model'),debug=f.h.hayaku.lastDebug();const receipt={name:'structured-head',base:BASE,sourceSHA,N,evidence:f.caseRoot,delivery:recallBodies(output).includes('READSET_OLD'),commit:debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,inventory:await f.store.inventory(),models:f.h.llmCalls.length};receipts.push(receipt);fs.writeFileSync(path.join(f.caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));assert.equal(receipt.delivery,true);assert.equal(receipt.commit,true);assert.equal(receipt.models,0);
 }finally{await f.h.dispose();}
});
test('fresh admission refuses persisted source preferences that differ from loaded authority',async()=>{
 const f=await boundedRuntime('source-preference-admission');try{
  const key='hayaku.v2.settings.source-tracking.v1',prefs=JSON.parse(await f.store.physicalValue(key));prefs.ignoredTags=['different-loaded-policy'];prefs.externalRulesVersion=1;await f.store.setItem(key,JSON.stringify(prefs));const output=await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model'),returns=JSON.parse(JSON.stringify(f.h.context.__HAYAKU_INLINE_LEDGER_RETURN_OBSERVATION__));const receipt={name:'source-preference-admission',base:BASE,sourceSHA,N,evidence:f.caseRoot,delivery:recallBodies(output).includes('READSET_OLD'),returns,inventory:await f.store.inventory(),models:f.h.llmCalls.length};receipts.push(receipt);fs.writeFileSync(path.join(f.caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));assert.equal(receipt.delivery,false);assert.equal(returns.some(row=>row.durable),false);assert.equal(receipt.models,0);
 }finally{await f.h.dispose();}
});
test('fresh admission accepts unchanged explicit persisted source rules and full raw corpus',async()=>{
 const f=await boundedRuntime('explicit-source-policy');try{
  await f.h.hayaku.setSourceEditRules({version:1,ignoredTags:['lb-xnai','thoughts','diagnostic-ignored'],unwrapTags:[],sourceTags:[],controls:['html-comment','lbdata']});const policy=f.h.hayaku.getSourceEditRules();assert.equal(policy.version,1);assert.ok(policy.ignoredTags.includes('diagnostic-ignored'));assert.equal(JSON.parse(await f.store.getItem('hayaku.v2.settings.source-tracking.v1')).epoch,0,'saving input rules does not reenroll legacy tracking');
  const output=await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model'),debug=f.h.hayaku.lastDebug(),receipt={name:'explicit-source-policy',base:BASE,sourceSHA,N,evidence:f.caseRoot,delivery:recallBodies(output).includes('READSET_OLD'),commit:debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,wholeRawReads:debug.localRecallSourceIndex?.routing?.validationRawReads,inventory:await f.store.inventory(),models:f.h.llmCalls.length};receipts.push(receipt);fs.writeFileSync(path.join(f.caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));assert.equal(receipt.delivery,true);assert.equal(receipt.commit,true);assert.equal(receipt.wholeRawReads,N);assert.equal(receipt.models,0);
 }finally{await f.h.dispose();}
});
for(const change of ['body','scope'])test('newer simultaneous '+change+' request retains its writer and selected scope after old frame refusal',async()=>{
 const f=await boundedRuntime('concurrent-attempt-'+change);let gate,first,second;try{
  const oldScope=await f.h.hayaku._test.currentChatScope();
  gate=f.store.arm('evidence','write');first=f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model');await enteredGate(gate);
  if(change==='body'){const p=packet(1,true);f.rows[1]={role:'assistant',chatId:'a1',data:hiddenPacketMessage(p.meta.summary_memory.summary,p)};f.h.setMessages(f.rows);}else f.h.chat.id=f.h.chat.chatId='readset-new-scope';second=f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model');gate.release();const firstOutput=await first,secondOutput=await second,debug=f.h.hayaku.lastDebug(),returns=JSON.parse(JSON.stringify(f.h.context.__HAYAKU_INLINE_LEDGER_RETURN_OBSERVATION__));
  const receipt={name:'concurrent-attempt',base:BASE,sourceSHA,N,evidence:f.caseRoot,firstOld:recallBodies(firstOutput).includes('READSET_OLD'),secondOld:recallBodies(secondOutput).includes('READSET_OLD'),secondNew:recallBodies(secondOutput).includes('READSET_NEW'),returns,secondCommit:debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,wholeRawReads:debug.localRecallSourceIndex?.routing?.validationRawReads,inventory:await f.store.inventory(),events:f.store.events,models:f.h.llmCalls.length};receipts.push(receipt);fs.writeFileSync(path.join(f.caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));
  assert.equal(receipt.firstOld,false);if(change==='body'){assert.equal(returns.some(row=>row.containsOld&&row.durable),false);assert.equal(receipt.secondNew,true);assert.equal(receipt.secondOld,false);}else{assert.equal(returns.some(row=>row.scopeKey===oldScope.key&&row.durable),false,'old writer cannot acknowledge the source scope after a newer scope attempt starts');assert.equal(receipt.secondOld,true);}assert.equal(receipt.secondCommit,true);assert.equal(receipt.wholeRawReads,N);assert.equal(receipt.models,0);
 }finally{gate?.release();await first?.catch(()=>{});await second?.catch(()=>{});await f.h.dispose();}
});
test('supported storage mode cutover drains admitted physical write and fresh server request succeeds',async()=>{
 const {createMemorySuiteServer}=require('../server/server.cjs'),serverRoot=path.join(evidence,'supported-mode-server'),app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:serverRoot,autoBackup:false,computeEnabled:false});const address=await app.listen(),url='http://127.0.0.1:'+address.port;
 let f,gate,pending,cutover;try{
  f=await boundedRuntime('supported-mode',{arguments:{memory_suite_server_url:url,hayaku_packet_recovery:'false'},nativeFetch:async(target,init)=>fetch(target,init)});const bridge=f.h.context.__HAYAKU_DIAGNOSTIC_STORAGE_BRIDGE__;
  gate=f.store.arm('ledger','write');pending=f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model');await enteredGate(gate);let cutoverComplete=false;cutover=bridge.setMode('server_only').then(value=>{cutoverComplete=true;return value;});
  await waitFor(()=>bridge.status().transition?.phase==='draining','actual SDK owner IO drain');const during=await bridge.getScopeMode();assert.equal(during.mode,'plugin_only');assert.equal(during.transition.toMode,'server_only');assert.equal(cutoverComplete,false);gate.release();const oldOutput=await pending,change=await cutover;assert.equal(change.to,'server_only');assert.equal((await bridge.getScopeMode()).mode,'server_only');assert.equal(bridge.status().transition,null);
  const freshOutput=await f.h.callBeforeRequest([{role:'user',content:'What does Aurora vault contain?'}],'model'),debug=f.h.hayaku.lastDebug(),returns=JSON.parse(JSON.stringify(f.h.context.__HAYAKU_INLINE_LEDGER_RETURN_OBSERVATION__));const receipt={name:'supported-mode',base:BASE,sourceSHA,N,evidence:f.caseRoot,during:{mode:during.mode,phase:during.transition.phase},completedMode:change.to,oldDelivery:recallBodies(oldOutput).includes('READSET_OLD'),freshDelivery:recallBodies(freshOutput).includes('READSET_OLD'),freshCommit:debug.lastBeforeRequest?.authoritativeLedger?.reconcileCommit?.durable,wholeRawReads:debug.localRecallSourceIndex?.routing?.validationRawReads,returns,inventory:await f.store.inventory(),events:f.store.events,localRequests:f.h.fetchCalls.length,models:f.h.llmCalls.length};receipts.push(receipt);fs.writeFileSync(path.join(f.caseRoot,'receipt.json'),JSON.stringify(receipt,null,2));assert.equal(receipt.oldDelivery,false);assert.equal(receipt.freshDelivery,true);assert.equal(receipt.freshCommit,true);assert.equal(receipt.wholeRawReads,N);assert.equal(receipt.models,0);assert.ok(receipt.localRequests>0);
 }finally{gate?.release();await pending?.catch(()=>{});await cutover?.catch(()=>{});await f?.h.dispose();await app.close();}
});
test('saved same-slot choice requires explicit replacement and source deletion removes recall authority',async()=>{
 const f=await boundedRuntime('explicit-replacement-and-deletion');
 try{
  const input=[{role:'user',content:'What does Aurora vault contain?'}];
  const initial=await f.h.callBeforeRequest(input,'model');assert.ok(recallBodies(initial).includes('READSET_OLD'));
  await f.h.callAfterRequest('', 'model');
  const before=await f.h.hayaku.ledger.inspect({includeRecords:true});assert.ok(before.records.some(row=>JSON.stringify(row).includes('READSET_OLD')));
  const p=packet(1,true);f.rows[1]={role:'assistant',chatId:'a1',data:hiddenPacketMessage(p.meta.summary_memory.summary,p)};f.h.setMessages(f.rows);
  const retained=await f.h.callBeforeRequest(input,'model');assert.ok(recallBodies(retained).includes('READSET_OLD'));assert.ok(!recallBodies(retained).includes('READSET_NEW'));assert.equal(f.h.llmCalls.length,0);
  await f.h.callAfterRequest('', 'model');
  const ticket=await f.h.hayaku.previewSourceEdits(['1']);assert.equal(ticket.allowed,true,JSON.stringify(ticket));assert.equal(f.h.llmCalls.length,0);
  const grounded=packet(1,true),quote=grounded.meta.summary_memory.summary;
  for(const axis of ['entity','world','narrative','planner'])for(const [key,value] of Object.entries(grounded[axis]))if(Array.isArray(value))grounded[axis][key]=[];
  grounded.world.world_rules=[{summary:quote}];
  f.h.setLlmResponder(async()=>({type:'success',result:JSON.stringify({schema:'hayaku.native_repair_output.v1',packet:grounded,grounding:[{path:'world.world_rules[0]',source:'target',evidence:[quote]},{path:'meta.summary_memory.summary',source:'target',evidence:[quote]}]})}));
  const outcome=await f.h.hayaku.applySourceEdits(ticket);assert.equal(outcome.ok,true,JSON.stringify(outcome));assert.equal(f.h.llmCalls.length,1);
  assert.equal((await f.h.hayaku.applySourceEdits(ticket)).status,'blocked','spent preview cannot pay twice');
  const fresh=await f.h.callBeforeRequest(input,'model');assert.ok(recallBodies(fresh).includes('READSET_NEW'));assert.ok(!recallBodies(fresh).includes('READSET_OLD'));assert.equal(f.h.llmCalls.length,1);
  await f.h.callAfterRequest('', 'model');
  const visible=JSON.stringify(f.h.chat.message);assert.ok(visible.includes('READSET_NEW'));
  f.rows.splice(0,2);f.h.setMessages(f.rows);
  const deleted=await f.h.callBeforeRequest(input,'model');assert.ok(!recallBodies(deleted).includes('READSET_NEW'));assert.ok(!recallBodies(deleted).includes('READSET_OLD'));assert.equal(f.h.llmCalls.length,1,'deletion cannot silently reanalyze or revive a removed source');
  receipts.push({name:'explicit-replacement-and-deletion',evidence:f.caseRoot,selectedCalls:1,spentTicketRejected:true,sourceDeletionExcluded:true});
 }finally{await f.h.dispose();}
});
test.after(()=>{fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify({base:BASE,sourceSHA,evidence,N,receipts:receipts.map(row=>({name:row.name,mutation:row.mutation,commit:row.commit,old:row.outputOld,new:row.outputNew,wholeRawReads:row.preMutationValidation?.validationRawReads,caseEvidence:row.evidence})),limit:'small actual registered-hook physical IO diagnostic; no performance claim; product unchanged'},null,2));console.log(JSON.stringify({base:BASE,sourceSHA,evidence,cases:receipts.length}));});
