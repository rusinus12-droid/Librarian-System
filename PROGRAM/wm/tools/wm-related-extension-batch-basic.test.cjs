'use strict';
// FEATURE-FIRST nominal source-only synthetic checks; no provider transport or real host.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const helper=path.join(__dirname,'libra_management_gui_integration_test.cjs');
const harness=new Module(helper,module);harness.filename=helper;harness.paths=Module._nodeModulePaths(__dirname);
harness._compile(fs.readFileSync(helper,'utf8').replace('EntityManager,TimeEngine,EntityCandidateCore','EntityManager,TimeEngine,IntegratedAnalysisJournal,TurnMaintenanceOptimizer,runTurnMaintenanceRecord,EntityCandidateCore'),helper);
const {loadGui}=harness.exports, observations=[];
const basePacket=()=>({meta:{turn:1,sourceMessageIds:['m1']},memory:{},entity:{},world:{},narrative:{},guards:{},importance:{}});
const tracker=(a,id,target,label=id,mode='every_turn')=>a.UserDlcCore.registerEntityTracker({id,targetIds:[target],displayName:target,label,instruction:'Track explicitly confirmed '+label+'.',valueType:'status',allowedValues:['unknown','ready'],currentValue:'unknown',enabled:mode!=='manual',trackingEnabled:mode!=='manual',updateMode:mode}).item;
const config=a=>({...a.MemoryEngine.CONFIG,useLLM:true,worldAdditionalEnabled:false,worldAdditionalMode:'off',debug:false,rpLongTermMemoryEnabled:false});
async function commit(f,packet){
 const a=f.api,lore=[],scope=a.getChatRuntimeScopeKey(f.control.chat,f.control.char);
 await a.UserDlcCore.saveState(lore);
 const record=a.IntegratedAnalysisJournal.recordPacket(lore,packet,{turn:1,turnKey:'t1',scopeKey:scope,sourceMessageIds:['m1']});await a.IntegratedAnalysisJournal.saveState(lore);
 const saved=await a.persistLoreToActiveChat(f.control.chat,lore,{reason:'synthetic-e04-canonical'});assert(saved.ok&&saved.canonicalVerified);
 const token=a.IntegratedAnalysisJournal.issueCommittedSource(lore,record.entry.extensionSource,saved);assert(token);return{lore,scope,token};
}
test('related every-turn and relevant trackers share one whole batch and committed evidence; unrelated definitions stay out',async()=>{
 const f=await loadGui({observeCommonAnalysis:true});try{
  const a=f.api,t1=tracker(a,'mira_ready','Mira','readiness'),t2=tracker(a,'mira_equipped','Mira','equipment','relevant');
  const unrelated=tracker(a,'offscreen_canary','Nora','UNRELATED_DEFINITION_CANARY');tracker(a,'manual_canary','Mira','MANUAL_DEFINITION_CANARY','manual');
  const packet=basePacket();packet.entity.characters=[{name:'Mira',currentState:'Mira is ready and equipped for the journey.'},{name:'Nora',currentState:'UNRELATED_EVIDENCE_CANARY'}];
  // Nora has a tracker but is disabled, so her definition and linked evidence are not eligible.
  a.UserDlcCore.setTrackerEnabled(unrelated.id,false);
  const saved=await commit(f,packet),calls=[];f.common.LLMProvider.isConfigured=()=>true;
  f.common.LLMProvider.call=async(_cfg,_system,user,options)=>{
   calls.push(options.label);assert.match(options.label,/^user-dlc-tracker/);
   assert(!user.includes('UNRELATED_DEFINITION_CANARY'));assert(!user.includes('UNRELATED_EVIDENCE_CANARY'));assert(!user.includes('MANUAL_DEFINITION_CANARY'));
   const source=JSON.parse(user.split('[Committed canonical packet — sole update evidence]\n')[1].split('\n\n')[0]);
   const definitions=user.split('[User DLC tracker definitions and current values — non-canonical]\n')[1];assert(definitions.includes(t1.id)&&definitions.includes(t2.id));
   const ref=source.evidence.find(item=>item.text.includes('ready and equipped'));assert(ref);assert.equal(source.evidence.filter(item=>item.id===ref.id).length,1);
   return{content:JSON.stringify({userDlcTrackerUpdates:[t1,t2].map(t=>({trackerId:t.id,packetId:source.packetId,packetRevision:source.revision,evidenceRefs:[ref.id],value:'ready',confidence:'confirmed',dbCompatibility:'compatible'}))})};
  };
  const result=await a.TurnMaintenanceOptimizer.runCommittedExtensions(saved.token,config(a));assert.equal(calls.length,1);assert.deepEqual([...result.trackerIds].sort(),[t1.id,t2.id].sort());
  const applied=a.UserDlcCore.applyTrackerUpdates(result.userDlcTrackerUpdates,{turn:1,scopeKey:saved.scope,lorebook:saved.lore,committedSourceToken:saved.token});assert.equal(applied.evaluated,2);assert(applied.applied.every(t=>t.currentValue==='ready'));
  observations.push({case:'two related trackers, one shared batch, exact evidence subset',fakeCalls:calls,applied:2});
 }finally{f.close()}
});
test('time-only canonical maintenance saves a no-model receipt and preserves existing tracker state',async()=>{
 const f=await loadGui({observeCommonAnalysis:true});try{
  const a=f.api,t=tracker(a,'mira_clock','Mira','readiness'),cfg=config(a);cfg.worldAdditionalEnabled=true;cfg.worldAdditionalMode='on';
  const lore=[];await a.UserDlcCore.saveState(lore);a.MemoryEngine.setLorebook(f.control.char,f.control.chat,lore);await a.persistLoreToActiveChat(f.control.chat,lore,{reason:'synthetic-e04-seed'});
  const before=JSON.stringify(a.UserDlcCore.getState().entityTrackers),packet=basePacket();packet.world={state:{time:'2030-06-20 18:00'}};
  let calls=0;f.common.LLMProvider.isConfigured=()=>true;f.common.LLMProvider.call=async()=>{calls++;throw Error('time-only packet must not request model interpretation')};
  const scope=a.getChatRuntimeScopeKey(f.control.chat,f.control.char);
  const result=await a.runTurnMaintenanceRecord({char:f.control.char,chat:f.control.chat,chatId:f.control.chat.id,scopeKey:scope,aiResponse:'RAW_RESPONSE_MUST_NOT_DRIVE_EXTENSIONS',turnForMaintenance:1,m_id:'m1',maintenanceConfig:cfg,targetContext:{chatId:f.control.chat.id,characterId:f.control.char.id,characterIndex:0,chatIndex:0,scopeKey:scope},turnState:{m_id:'m1',anchorMeta:{turnKey:'t1'},analysisPending:false,involvedEntities:[],entitiesToConsolidate:[],precomputedMaintenance:{canonicalPacket:packet,entityExtraction:null,worldAdditional:null,userDlcTrackerUpdates:[],correctionReviewed:true,correction:null}}});
  assert.equal(result.status,'done',JSON.stringify(result));assert.equal(result.extension.status,'done',JSON.stringify(result));assert.equal(calls,0);assert.equal(JSON.stringify(a.UserDlcCore.getState().entityTrackers),before);assert(JSON.stringify(f.canonicalPayload()).includes('extensionAppliedRevision'));
  observations.push({case:'time-only maintenance, both model roles enabled',fakeCalls:0,unchangedTracker:t.id,verifiedReceipt:true});
 }finally{f.close()}
});
test('active every-turn tracker without linked target evidence makes no tracker call',async()=>{
 const f=await loadGui({observeCommonAnalysis:true});try{
  const a=f.api;tracker(a,'mira_unrelated','Mira','UNRELATED_ACTIVE_CANARY');const packet=basePacket();packet.entity.characters=[{name:'Miran',currentState:'Miran is ready.'}];
  const saved=await commit(f,packet);let calls=0;f.common.LLMProvider.isConfigured=()=>true;f.common.LLMProvider.call=async()=>{calls++;throw Error('no related tracker')};
  const result=await a.TurnMaintenanceOptimizer.runCommittedExtensions(saved.token,config(a));assert.equal(calls,0);assert.equal(result.trackerIds.length,0);assert.equal(result.userDlcTrackerUpdates.length,0);
  observations.push({case:'exact target association, active unrelated tracker excluded',fakeCalls:0});
 }finally{f.close()}
});
test.after(()=>{if(process.env.WM_BASIC_CHECKPOINT)fs.writeFileSync(path.join(process.env.WM_BASIC_CHECKPOINT,'BASIC-SMOKE-OBSERVATIONS.json'),JSON.stringify({observations,limits:'Three nominal synthetic source cases only. No persistent-budget/replay, permission matrix, real host or full regression qualification.'},null,2)+'\n')});
