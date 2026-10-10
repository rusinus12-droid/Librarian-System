'use strict';
// FEATURE-FIRST: nominal synthetic committed-evidence flow only. No provider transport or actual host.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const helper=path.join(__dirname,'libra_management_gui_integration_test.cjs');
const harness=new Module(helper,module);harness.filename=helper;harness.paths=Module._nodeModulePaths(__dirname);
harness._compile(fs.readFileSync(helper,'utf8').replace('EntityManager,TimeEngine,EntityCandidateCore','EntityManager,TimeEngine,IntegratedAnalysisJournal,TurnMaintenanceOptimizer,runTurnMaintenanceRecord,EntityCandidateCore'),helper);
const {loadGui}=harness.exports, observations=[];
const packet={meta:{turn:1,sourceMessageIds:['m1']},memory:{events:['Mira is ready for the journey.']},entity:{characters:[{name:'Mira',currentState:'Mira is ready for the journey.'}]},world:{},narrative:{},guards:{},importance:{}};
const tracker=api=>api.UserDlcCore.registerEntityTracker({id:'ready',targetIds:['Mira'],displayName:'Mira',label:'readiness',instruction:'Track explicitly confirmed readiness.',valueType:'status',allowedValues:['unknown','ready'],currentValue:'unknown',enabled:true,trackingEnabled:true,updateMode:'every_turn'}).item;
const configured=api=>({...api.MemoryEngine.CONFIG,useLLM:true,worldAdditionalEnabled:true,worldAdditionalMode:'on',debug:false,rpLongTermMemoryEnabled:false});
function mock(f, item, events){
 f.common.LLMProvider.isConfigured=()=>true;
 f.common.LLMProvider.call=async(_config,system,user,options)=>{
  const label=options.label;events.push(label);
  if(label.startsWith('afterrequest-canonical'))return {content:JSON.stringify({canonicalPacket:packet})};
  assert(!user.includes('RAW_RESPONSE_CANARY'));assert.match(user,/Committed canonical packet/);
  if(label.startsWith('world-additional'))return {content:JSON.stringify({worldAdditional:{sceneInterventions:[],worldDeltas:[],characterAdditions:[],manifestations:[]}})};
  if(label.startsWith('user-dlc-tracker')){
   const source=JSON.parse(user.split('[Committed canonical packet — sole update evidence]\n')[1].split('\n\n')[0]);
   const evidence=source.evidence.find(e=>e.targets.includes('Mira')&&e.text.includes('ready'));
   return {content:JSON.stringify({userDlcTrackerUpdates:[{trackerId:item.id,packetId:source.packetId,packetRevision:source.revision,evidenceRefs:[evidence.id],value:'ready',confidence:'confirmed',dbCompatibility:'compatible'}]})};
  }
  throw Error('unexpected fake call '+label);
 };
}
test('canonical strategies emit no extension calls; verified journal packet supplies producer and consumer evidence',async()=>{
 const f=await loadGui({observeCommonAnalysis:true});try{
  const a=f.api,j=a.IntegratedAnalysisJournal,t=tracker(a),events=[];mock(f,t,events);const cfg=configured(a);
  const analyzed=await a.TurnMaintenanceOptimizer.runUnified(1,{m_id:'m1',involvedEntities:['Mira']},'RAW_RESPONSE_CANARY',[],cfg);
  assert(analyzed.canonicalPacket,JSON.stringify({analyzed,events}));assert.equal(events.length,1);assert.equal(analyzed.parallel,false);assert.equal(analyzed.maintenance.worldAdditional,null);
  const lore=[];await a.UserDlcCore.saveState(lore);const scope=a.getChatRuntimeScopeKey(f.control.chat,f.control.char);
  const recorded=j.recordPacket(lore,packet,{turn:1,turnKey:'t1',scopeKey:scope,sourceMessageIds:['m1']});await j.saveState(lore);
  assert.equal(j.issueCommittedSource(lore,recorded.entry.extensionSource,{ok:false}),null);
  const saved=await a.persistLoreToActiveChat(f.control.chat,lore,{reason:'synthetic-e03-canonical'});assert(saved.ok&&saved.canonicalVerified);
  const token=j.issueCommittedSource(lore,recorded.entry.extensionSource,saved);assert(token);
  const result=await a.TurnMaintenanceOptimizer.runCommittedExtensions(token,cfg);assert.equal(events.length,3);
  const applied=a.UserDlcCore.applyTrackerUpdates(result.userDlcTrackerUpdates,{turn:1,scopeKey:scope,lorebook:lore,committedSourceToken:token});assert.equal(applied.evaluated,1);assert.equal(applied.applied[0].currentValue,'ready');
  assert((await a.TurnMaintenanceOptimizer.runCommittedExtensions(token,cfg)).skipped);assert.equal(events.length,3);
  assert(j.markExtensionApplied(lore,token));await j.saveState(lore);assert.equal(j.verifyCommittedSource(token,lore,scope),false);
  observations.push({case:'canonical analysis, verified packet, extension producer/consumer',fakeCalls:events,providerTransport:0,realHostWrites:0});
 }finally{f.close()}
});
test('existing maintenance lifecycle saves canonical before automatic extension analysis and routes the second save',async()=>{
 const f=await loadGui({observeCommonAnalysis:true});try{
  const a=f.api,t=tracker(a),events=[];mock(f,t,events);const cfg=configured(a);cfg.useLLM=false;
  const lore=[];await a.UserDlcCore.saveState(lore);a.MemoryEngine.setLorebook(f.control.char,f.control.chat,lore);
  await a.persistLoreToActiveChat(f.control.chat,lore,{reason:'synthetic-e03-seed'});
  cfg.useLLM=true;
  let canonicalAtCalls=false;const original=f.common.LLMProvider.call;
  f.common.LLMProvider.call=async(...args)=>{
   const stored=JSON.parse(f.store.get(f.key));
   canonicalAtCalls=JSON.stringify(stored).includes('wm.extension-source.v1');assert(canonicalAtCalls,'packet committed before extension model seam');return original(...args);
  };
  const scope=a.getChatRuntimeScopeKey(f.control.chat,f.control.char);
  const result=await a.runTurnMaintenanceRecord({char:f.control.char,chat:f.control.chat,chatId:f.control.chat.id,scopeKey:scope,aiResponse:'RAW_RESPONSE_CANARY',turnForMaintenance:1,m_id:'m1',maintenanceConfig:cfg,targetContext:{chatId:f.control.chat.id,characterId:f.control.char.id,characterIndex:0,chatIndex:0,scopeKey:scope},
   turnState:{m_id:'m1',anchorMeta:{turnKey:'t1'},analysisPending:false,involvedEntities:[],entitiesToConsolidate:[],precomputedMaintenance:{canonicalPacket:packet,entityExtraction:null,worldAdditional:null,userDlcTrackerUpdates:[],correctionReviewed:true,correction:null}}});
  assert.equal(result.status,'done',JSON.stringify(result));assert.equal(result.extension.status,'done',JSON.stringify(result));assert(canonicalAtCalls);assert.equal(events.length,2);
  assert(JSON.stringify(f.canonicalPayload()).includes('extensionAppliedRevision'));assert(JSON.stringify(f.canonicalPayload()).includes('ready'));
  observations.push({case:'maintenance verified save before extension and second routed save',status:result.status,extension:result.extension.status,fakeCalls:events,providerTransport:0,realHostWrites:0});
 }finally{f.close()}
});
test.after(()=>{if(process.env.WM_BASIC_CHECKPOINT)fs.writeFileSync(path.join(process.env.WM_BASIC_CHECKPOINT,'BASIC-SMOKE-OBSERVATIONS.json'),JSON.stringify({observations,limits:'Two nominal synthetic cases only; no broad regressions, replay/failure/privacy matrices, real host or release qualification.'},null,2)+'\n')});
