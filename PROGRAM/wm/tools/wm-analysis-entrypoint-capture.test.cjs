'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),acorn=require('acorn');
const {fixture,profile}=require('./wm-analysis-preset-test-support.cjs');
const {fixture:historicalGui}=require('./libra_historical_health_dispatch_test.cjs');
const source=fs.readFileSync(process.env.WM_CHECKSUM_DIST,'utf8');
function emittedFunction(name){const stack=[acorn.parse(source,{ecmaVersion:'latest'})];let found;while(stack.length){const n=stack.pop();if(!n||typeof n!=='object')continue;const fn=n.type==='VariableDeclarator'&&n.id?.name===name?n.init:n.type==='Property'&&n.key?.name===name?n.value:null;if(fn&&['ArrowFunctionExpression','FunctionExpression'].includes(fn.type)){assert(!found,'unique emitted '+name);found=source.slice(fn.start,fn.end);}for(const v of Object.values(n)){if(Array.isArray(v))stack.push(...v);else if(v&&typeof v==='object')stack.push(v);}}assert(found,'real emitted '+name);return found;}
function selectA(api){const c=api.MemoryEngine.CONFIG;Object.assign(c,{useLLM:true,llm:profile('legacy'),llmPresets:{a:profile('A'),b:profile('B')},llmDefaultPreset:'a'});return c;}
for(const change of ['switch','edit-delete'])test('registered_historical_health_action_keeps_A_after_'+change,async()=>{
 const f=await historicalGui();try{const c=selectA(f.api),models=[];
 const chunk=f.trace.chunk;f.trace.chunk=async options=>{models.push(options.config?.llm?.model);return chunk(options);};
 const synthesis=f.trace.synthesis;f.trace.synthesis=async(...args)=>{models.push(args[2]?.analysisConfig?.llm?.model);return synthesis(...args);};
 const verify=f.trace.verify;f.trace.verify=async(...args)=>{models.push(args[3]?.analysisConfig?.llm?.model);return verify(...args);};
 let changed=false;f.trace.onStage=async stage=>{if(stage==='chunk'&&!changed){changed=true;if(change==='switch')c.llmDefaultPreset='b';else{c.llmPresets.a.model='edited-A';delete c.llmPresets.a;}}};
 const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();
 assert(changed,'real admitted chunk reached');assert.equal(f.applyResult()?.state,'committed','model-only change must not invalidate already admitted historical work');assert.equal(f.trace.persistenceCalls,1);assert(models.length>=3);assert(models.every(x=>x==='A'),'chunk/synthesis/verification receive one A');
 }finally{f.close();}
});
for(const change of ['non-model','source','scope','close'])test('registered_historical_health_action_retains_'+change+'_guard',async()=>{
 const f=await historicalGui();try{const c=selectA(f.api);let changed=false;f.trace.onStage=async stage=>{if(stage==='chunk'&&!changed){changed=true;if(change==='non-model')c.maxLimit=Number(c.maxLimit||180)+1;else f.mutate(change==='source'?'source-first':change);}};const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();assert(changed);assert.notEqual(f.applyResult()?.state,'committed');assert.equal(f.trace.mergeCalls,0);assert.equal(f.trace.persistenceCalls,0);assert.equal(f.trace.modelCalls,1);
 }finally{f.close();}
});
test('session_transition_captures_A_before_first_async_source_read',async()=>{
 const r=await fixture(),c=selectA(r.ai),calls=[];const chat={id:'synthetic-chat',message:[{role:'char',data:'A synthetic scene.'}]},char={id:'synthetic-char',chats:[chat]};
 const sandbox={_transitionInFlight:false,_lastBlockedReason:'',VersionedCanonicalBridge:{mode:'local'},MemoryEngine:r.ai.MemoryEngine,captureWmAnalysisConfig:r.ai.captureWmAnalysisConfig,
 resolveActiveChatContext:async()=>{await Promise.resolve();c.llmDefaultPreset='b';return {char,chat,charIdx:0,personaAdmission:{ok:true}};},normalizeRisuIndex:x=>x,LMAI_GUI:{toast(){}},getChatMessages:x=>x.message,getMessageSignature:()=>'',MemoryState:{ignoredGreetingSignature:null},getComparableMessageText:x=>x.data,buildAssistantCanonicalTranscript:()=> 'Synthetic canonical scene',
 // Min inlines the transcript helper into this exact emitted function. Supply
 // the same synthetic canonical-text dependencies; do not alter its AI capture.
 normalizeLegacyMemoryTurnAnchor:x=>Number(x)||0,getAssistantCanonicalTextFromMessage:x=>x.msg.data,truncateForLLM:x=>x,
 LLMProvider:{call:async cfg=>{calls.push(r.ai.resolveCommonAnalysisPreset(cfg).profile.model);return {content:'Summary'};}},TransitionSummaryPrompt:'Synthetic summary',Utils:{stripLLMThinkingTags:x=>x},recordRuntimeDebug(){},isLibraRuntimeEpochActive:()=>true,getChatRuntimeScopeKey:()=> 'synthetic-scope',ScopedRuntimeTransaction:{begin(){throw Error('synthetic-stop-before-any-transition-write');}},Date};
 vm.createContext(sandbox);vm.runInContext('this.execute='+emittedFunction('executeTransition'),sandbox);assert.equal(await sandbox.execute(),false);assert.deepEqual(calls,['A']);assert.equal(sandbox._transitionInFlight,false);
});
test('source_reflection_passes_admission_A_after_async_CBS_work',async()=>{
 const r=await fixture(),c=selectA(r.ai);Object.assign(c,{cbsEnabled:true,characterSourceReflectionEnabled:true,personaBindingSyncEnabled:false});let imported;
 const sandbox={MemoryEngine:r.ai.MemoryEngine,captureWmAnalysisConfig:r.ai.captureWmAnalysisConfig,getScopeKey:()=> 'synthetic-scope',loadState:()=>({signatures:{}}),CharacterLoreCbsPreResolver:{resolve:async()=>{await Promise.resolve();c.llmDefaultPreset='b';return {entries:[]};}},collectSources:()=>({character_card:['Synthetic adult character source']}),trimCombined:x=>x,computeSignature:()=> 'new-source',SOURCE_LABELS:{character_card:'Character'},notifyLibraTask(){},ColdStartManager:{integrateImportedKnowledge:async(text,label,options)=>{imported=options;throw Error('synthetic-stop-before-publication');}}};
 vm.createContext(sandbox);vm.runInContext('this.reflect='+emittedFunction('reflectIfNeeded'),sandbox);await assert.rejects(()=>sandbox.reflect({}, {}, [], {}, {}),/synthetic-stop-before-publication/);assert(imported,'real reflection reaches public import');assert(imported.analysisConfig,'reflection threads its logical job capture');assert.equal(r.ai.resolveCommonAnalysisPreset(imported.analysisConfig).profile.model,'A');assert(r.ai.isWmAnalysisConfigCurrent(imported.analysisConfig,c),'capture is branded rather than forged plain fields');
});
