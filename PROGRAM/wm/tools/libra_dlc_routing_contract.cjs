'use strict';
const assert=require('node:assert/strict');
const {load}=require('./libra_management_storage_verified_test.cjs');
async function verifyDlcRouting(options={}){
 const f=await load({artifact:true,extraExports:'TurnMaintenanceOptimizer,LLMProvider,getLLMProfileConfig,MemoryEngine',transformCode:options.transformCode});
 const timers=new Set();
 f.testGlobals.setTimeout=(fn,ms,...args)=>{const t=setTimeout(fn,ms,...args);timers.add(t);return t;};
 f.testGlobals.setInterval=(fn,ms,...args)=>{const t=setInterval(fn,ms,...args);timers.add(t);return t;};
 try {
 let externalAttempts=0;const block=async()=>{externalAttempts++;throw Error('external call forbidden in routing fixture')};
 f.runtime.nativeFetch=block;f.testGlobals.fetch=block;
 const calls=[];
 f.api.LLMProvider.call=async(config,system,user,opts)=>{
  const selected=f.api.getLLMProfileConfig(config,opts.profile);
  calls.push({reason:opts.reason,profile:opts.profile,model:selected.config.llm.model,system,user});
  return {content:JSON.stringify(opts.reason==='user-dlc-tracker-analysis'?{userDlcTrackerUpdates:[{trackerId:'fixture-tracker',value:'observed',confidence:'confirmed',dbCompatibility:'compatible',evidence:'The beacon was lit.'}]}:{narrativeBrief:'A beacon was lit.',correction:{shouldCorrect:false,reasons:[]}})};
 };
 const config={useLLM:true,debug:false,rpLongTermMemoryEnabled:false,storyAuthorEnabled:false,directorEnabled:false,worldAdditionalEnabled:false,
  llm:{provider:'openai',url:'https://primary.invalid',key:'synthetic',model:'primary-fixture',stream:false},
  auxLlm:{enabled:true,provider:'openai',url:'https://aux.invalid',key:'synthetic',model:'aux-fixture',stream:false},
  llmRouting:{turnMaintenanceBundle:'primary',userDlcTrackerAnalysis:'aux'}};
 const payload={turn:1,aiResponse:'The beacon was lit.',assistantEvidenceText:'The beacon was lit.',evidenceText:'The beacon was lit.',evidenceLabel:'assistant',extracted:{},userDlcTrackersActive:true,userDlcTrackerPrompt:'fixture-tracker: beacon state; values observed/unknown',entityTexts:[],relationTexts:[],charStateTexts:[],recentTurns:[],memoryEntries:[],focusedEntities:[]};
 for(const [maintenanceProfile,trackerProfile] of [['primary','aux'],['aux','primary']]){
  calls.length=0;config.llmRouting={turnMaintenanceBundle:maintenanceProfile,userDlcTrackerAnalysis:trackerProfile};
  const out=await f.api.TurnMaintenanceOptimizer.run(1,{},payload.aiResponse,[],config,{preparedPayload:payload});
  assert.equal(calls.length,2,'exactly one maintenance and one dedicated tracker call');
  const maintenance=calls.find(c=>c.reason==='turn-maintenance-bundle'),tracker=calls.find(c=>c.reason==='user-dlc-tracker-analysis');
  assert(maintenance&&tracker,'both dedicated routes execute');
  assert.equal(maintenance.profile,maintenanceProfile,'maintenance keeps its route');assert.equal(tracker.profile,trackerProfile,'tracker keeps dedicated profile');
  assert.equal(maintenance.model,maintenanceProfile+'-fixture','maintenance model selection');assert.equal(tracker.model,trackerProfile+'-fixture','dedicated tracker model selection');
  assert(!maintenance.system.includes('userDlcTrackerUpdates'),'general maintenance must not request tracker output');
  assert(tracker.system.includes('userDlcTrackerUpdates'),'dedicated tracker prompt requests its output');
  assert(out.userDlcTrackerUpdates.some(u=>u.trackerId==='fixture-tracker'&&u.value==='observed'),'dedicated tracker result reaches caller');
 }
 calls.length=0;await f.api.TurnMaintenanceOptimizer.run(1,{},payload.aiResponse,[],config,{preparedPayload:{...payload,userDlcTrackersActive:false}});
 assert.equal(calls.length,1,'disabled tracker adds no call');assert.equal(calls[0].reason,'turn-maintenance-bundle');
 assert.equal(externalAttempts,0,'no external model/network attempt');
 return {dedicatedProfilesAndModels:true,generalOutputExcludesTracker:true,activeCalls:2,disabledCalls:1,externalAttempts};
 } finally {for(const timer of timers){clearTimeout(timer);clearInterval(timer);}}
}
module.exports={verifyDlcRouting};
