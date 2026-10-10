'use strict';
// FEATURE-FIRST nominal ledger and queue flows only. No real provider, listener or host.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const helper=path.join(__dirname,'libra_management_gui_integration_test.cjs');
const harness=new Module(helper,module);harness.filename=helper;harness.paths=Module._nodeModulePaths(__dirname);
harness._compile(fs.readFileSync(helper,'utf8').replace('EntityManager,TimeEngine,EntityCandidateCore','EntityManager,TimeEngine,IntegratedAnalysisJournal,TurnMaintenanceOptimizer,runTurnMaintenanceRecord,EntityCandidateCore'),helper);
const {loadGui}=harness.exports,observations=[];
const packet=(turn=1)=>({meta:{turn,sourceMessageIds:['m'+turn]},memory:{},entity:{characters:[{name:'Mira',currentState:'Mira is ready.'}]},world:{},narrative:{},guards:{},importance:{}});
const context=(scope,turn=1)=>({turn,turnKey:'t'+turn,scopeKey:scope,sourceMessageIds:['m'+turn]});
const cfg=a=>({...a.MemoryEngine.CONFIG,useLLM:true,worldAdditionalEnabled:false,worldAdditionalMode:'off',debug:false,rpLongTermMemoryEnabled:false});
function tracker(a,id){return a.UserDlcCore.registerEntityTracker({id,targetIds:['Mira'],displayName:'Mira',label:id,instruction:'Track explicitly confirmed readiness.',valueType:'status',allowedValues:['unknown','ready'],currentValue:'unknown',enabled:true,trackingEnabled:true,updateMode:'every_turn'}).item;}
async function maintenance(f,turn,p=packet(turn)){
 const a=f.api,scope=a.getChatRuntimeScopeKey(f.control.chat,f.control.char);
 return a.runTurnMaintenanceRecord({char:f.control.char,chat:f.control.chat,chatId:f.control.chat.id,scopeKey:scope,aiResponse:'RAW_NOT_EXTENSION_EVIDENCE',turnForMaintenance:turn,m_id:'m'+turn,maintenanceConfig:cfg(a),targetContext:{chatId:f.control.chat.id,characterId:f.control.char.id,characterIndex:0,chatIndex:0,scopeKey:scope},turnState:{m_id:'m'+turn,anchorMeta:{turnKey:'t'+turn},analysisPending:false,involvedEntities:[],entitiesToConsolidate:[],precomputedMaintenance:{canonicalPacket:p,entityExtraction:null,worldAdditional:null,userDlcTrackerUpdates:[],correctionReviewed:true,correction:null}}});
}
test('processed event survives display-journal eviction and a new runtime without renewed authority',async()=>{
 const f=await loadGui({observeCommonAnalysis:true});let fresh;try{
  const a=f.api,j=a.IntegratedAnalysisJournal,lore=[],scope=a.getChatRuntimeScopeKey(f.control.chat,f.control.char);
  const first=j.recordPacket(lore,packet(),context(scope));await j.saveState(lore);
  const saved=await a.persistLoreToActiveChat(f.control.chat,lore,{reason:'synthetic-extension-event'});assert(saved.canonicalVerified);
  const token=j.issueCommittedSource(lore,first.entry.extensionSource,saved);assert(token);assert(j.markExtensionApplied(lore,token));await j.saveState(lore);
  for(let turn=2;turn<=51;turn++){j.recordPacket(lore,packet(turn),context(scope,turn));await j.saveState(lore)}
  assert.equal(j.getState().entries.length,48);assert(!j.getState().entries.some(x=>x.turn===1));
  await a.persistLoreToActiveChat(f.control.chat,lore,{reason:'synthetic-eviction'});
  fresh=await loadGui({store:f.store,observeCommonAnalysis:true});const b=fresh.api,loaded=b.MemoryEngine.getLorebook(fresh.control.char,fresh.control.chat),state=b.IntegratedAnalysisJournal.readExtensionEvent(loaded,first.entry.extensionSource);
  assert.equal(state.status,'processed');assert.equal(JSON.stringify(state.source),JSON.stringify(first.entry.extensionSource));
  const repeated=b.IntegratedAnalysisJournal.recordPacket(loaded,packet(),context(scope));await b.IntegratedAnalysisJournal.saveState(loaded);
  const persisted=await b.persistLoreToActiveChat(fresh.control.chat,loaded,{reason:'synthetic-repeated-event'});assert(persisted.canonicalVerified);
  assert.equal(b.IntegratedAnalysisJournal.issueCommittedSource(loaded,repeated.entry.extensionSource,persisted),null);
  const page=b.IntegratedAnalysisJournal.listPendingExtensions(loaded,scope);assert.equal(page.events.length,48);assert(page.nextCursor);
  const next=b.IntegratedAnalysisJournal.listPendingExtensions(loaded,scope,{cursor:page.nextCursor});assert.equal(next.events.length,2);
  observations.push({case:'event receipt outlives 48-row journal and runtime',pendingPages:[48,2],processedNotReissued:true});
 }finally{fresh?.close();f.close()}
});
test('oversized whole batch remains pending and resumes from its unchanged packet after runtime reload',async()=>{
 const f=await loadGui({observeCommonAnalysis:true});let fresh;try{
  const a=f.api,scope=a.getChatRuntimeScopeKey(f.control.chat,f.control.char);tracker(a,'ready_a');const off=tracker(a,'ready_b');a.UserDlcCore.getState().settings.maxTrackersPerAnalysis=1;
  const lore=[];await a.UserDlcCore.saveState(lore);a.MemoryEngine.setLorebook(f.control.char,f.control.chat,lore);await a.persistLoreToActiveChat(f.control.chat,lore,{reason:'synthetic-queue-seed'});
  let calls=0;f.common.LLMProvider.isConfigured=()=>true;f.common.LLMProvider.call=async()=>{calls++;throw Error('oversized batch must not call')};
  const held=await maintenance(f,1);assert.equal(held.status,'done');assert.equal(held.extension.status,'waiting');assert.equal(calls,0);
  const stored=a.MemoryEngine.getLorebook(f.control.char,f.control.chat),queued=a.IntegratedAnalysisJournal.listPendingExtensions(stored,scope).events[0];assert.equal(queued.status,'waiting');assert.equal(queued.reason,'tracker_batch_item_limit');const immutable=JSON.stringify(queued.source);
  fresh=await loadGui({store:f.store,observeCommonAnalysis:true});const b=fresh.api,nextLore=b.MemoryEngine.getLorebook(fresh.control.char,fresh.control.chat);b.UserDlcCore.loadState(nextLore,{scopeKey:scope});b.UserDlcCore.setTrackerEnabled(off.id,false);await b.UserDlcCore.saveState(nextLore);await b.persistLoreToActiveChat(fresh.control.chat,nextLore,{reason:'synthetic-existing-tracker-setting'});
  const seen=[];fresh.common.LLMProvider.isConfigured=()=>true;fresh.common.LLMProvider.call=async(_cfg,_system,user)=>{const source=JSON.parse(user.split('[Committed canonical packet — sole update evidence]\n')[1].split('\n\n')[0]);seen.push(source.packetId);return{content:JSON.stringify({userDlcTrackerUpdates:[]})}};
  const result=await maintenance(fresh,2);assert.equal(result.extension.status,'done',JSON.stringify(result));assert.equal(seen.length,1);assert.equal(seen[0],queued.source.packetId);
  const current=b.MemoryEngine.getLorebook(fresh.control.char,fresh.control.chat),done=b.IntegratedAnalysisJournal.readExtensionEvent(current,queued.source);assert.equal(done.status,'processed');assert.equal(JSON.stringify(done.source),immutable);assert.equal(b.IntegratedAnalysisJournal.listPendingExtensions(current,scope).events.length,1);
  observations.push({case:'oversized queue restart and nominal resume',beforeFakeCalls:0,afterFakeCalls:1,sourceUnchanged:true});
 }finally{fresh?.close();f.close()}
});
test('revised occurrence fences the old pending revision while retaining its immutable record',async()=>{
 const f=await loadGui();try{const a=f.api,j=a.IntegratedAnalysisJournal,lore=[],scope=a.getChatRuntimeScopeKey(f.control.chat,f.control.char),old=j.recordPacket(lore,packet(),context(scope));await j.saveState(lore);const revised=packet();revised.entity.characters[0].currentState='Mira is resting.';const next=j.recordPacket(lore,revised,context(scope));await j.saveState(lore);assert.notEqual(old.entry.extensionSource.revision,next.entry.extensionSource.revision);assert.equal(j.readExtensionEvent(lore,old.entry.extensionSource).status,'superseded');assert.equal(j.readExtensionEvent(lore,next.entry.extensionSource).status,'pending');assert.equal(JSON.stringify(j.readExtensionEvent(lore,old.entry.extensionSource).source),JSON.stringify(old.entry.extensionSource));observations.push({case:'revision fencing',oldRetained:true,newPending:true})}finally{f.close()}
});
test.after(()=>{if(process.env.WM_BASIC_CHECKPOINT)fs.writeFileSync(path.join(process.env.WM_BASIC_CHECKPOINT,'BASIC-SMOKE-OBSERVATIONS.json'),JSON.stringify({observations,limits:'Nominal synthetic receipt/queue/revision cases only; no multi-runtime, full replay, storage failure or real-host qualification.'},null,2)+'\n')});
