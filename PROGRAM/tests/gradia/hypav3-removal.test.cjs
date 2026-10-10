'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const {JSDOM}=require('../../tools/gradia/load-dev-dependency.cjs')('jsdom');
const aliases=['hypaV3Data','hypa_v3_data','hypaV3','hypa_v3'];
const summary='HYPA_AGGREGATE_MUST_NOT_REACH_GRADIA';
const raw='HYPA_RAW_MUST_NOT_REACH_GRADIA';
const messages=()=>[
 {role:'system',content:'SYSTEM_RULE_KEEP\n<Past Events Summary>'+summary+'</Past Events Summary>\nSECOND_RULE_KEEP'},
 {role:'developer',content:'<Past Events Summary>'+summary+'_DEVELOPER</Past Events Summary>'},
 {role:'system',memo:'hypaMemory',content:summary+'_MEMO_ONLY'},
 {role:'user',messageId:'u1',content:'PREVIOUS_USER_KEEP opens the library.'},
 {role:'assistant',messageId:'a1',content:'PREVIOUS_ASSISTANT_KEEP waits beside the brass key.'},
 {role:'user',messageId:'u2',content:'CURRENT_USER_KEEP examines the key.'}
];
async function fixture(t,{poison=false,gui=false,sourceFile}={}){
 const input=messages(),chat={id:'hypa-removal-chat',message:input.filter(m=>['user','assistant'].includes(m.role))};
 const character={id:'hypa-removal-character',chaId:'hypa-removal-character',name:'Archivist',desc:'CHARACTER_KEEP',chats:[chat],chatPage:0};
 let rawReads=0;for(const name of aliases)Object.defineProperty(chat,name,{enumerable:false,get(){rawReads++;if(poison)throw Error('RETIRED_HYPA_READ:'+name);return {summaries:[{id:'old',text:raw}],metrics:{lastImportantSummaries:[0]}};}});
 const prompts=[],unloads=[],recentViews=[];const dom=gui?new JSDOM('<body></body>',{pretendToBeVisual:true,url:'https://offline.invalid/'}):null;
 const h=await load({sourceFile,transformSource:s=>s.replaceAll('    applyActualChatContextToRecent(recent, source.actualChatContext, settings);','    applyActualChatContextToRecent(recent, source.actualChatContext, settings);\n    globalThis.__observeRecent(recent, settings);').replace('  const publicApi = Object.freeze({','  globalThis.__testPipeline = runPipeline;\n  globalThis.__testBuildRecent = buildRecentChat;\n  const publicApi = Object.freeze({'),api:{
 getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async()=>character,getChatFromIndex:async()=>chat,getCharacter:async()=>character,
 onUnload:async fn=>unloads.push(fn),showContainer:async()=>{},hideContainer:async()=>{},
 nativeFetch:async(url,init)=>{assert.equal(url,'https://offline.invalid/v1/chat/completions');const body=JSON.parse(init.body);prompts.push(body);const system=body.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
 const content=system.includes('patch JSON')||system.includes('serial RP draft analysis-and-patch agent')?JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',stage:(system.match(/Return the compact (aide_\w+) patch JSON/)||[])[1],ok:true,domain:{},analysis:{summary:'Keep the scene',constraints:[],risks:[]},edits:[]}):'DRAFT_KEEP The archivist remained beside the brass key. Warm lamplight fell across the table while he inspected its markings and waited without changing the current scene.';
 return {ok:true,status:200,json:async()=>({choices:[{message:{content},finish_reason:'stop'}]}),text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})};}},
 testGlobals:{__observeRecent:(recent,settings)=>recentViews.push({stage:settings.activeStageName,...Object.fromEntries(['latestUser','latestAssistantRaw','latestAssistant','previousTurnUser','previousTurnAssistant','previousTurnText','earlierTurnsText','completeTurnsText','text','visibleText','visibleMessages','recentTurnCount','turnEligibility'].map(k=>[k,JSON.parse(JSON.stringify(recent[k]??null))]))}),...(dom?{window:dom.window,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}:{})}});
 t.after(async()=>{if(dom)await h.plugin.closeSettingsGui();for(const fn of unloads)await fn();dom?.window.close();});
 await h.hooks.beforeRequest(input,'model');
 const settings={...h.plugin.getRuntime().settings,inputAssistMode:'off',enableShadowAct:true,enableCharacterAide:true,enableWorldAide:true,enablePlotAide:true,multiPipelineMode:'lightweight',mode:'normal',failureMode:'hard',loreActivationMode:'off',stagePresetNames:{},defaultPresetName:'offline',presets:{offline:{provider:'custom',url:'https://offline.invalid/v1/chat/completions',model:'synthetic',max_tokens:4096,timeout_ms:1000,stream:false}},skillRouterEnabled:false};
 return {h,input,chat,prompts,recentViews,settings,dom,rawReads:()=>rawReads,run:()=>h.pipeline(input,'model',settings)};
}
test('actual SHADOW and AIDE pipeline never dereferences any retired raw chat alias',async t=>{
 const f=await fixture(t,{poison:true});let result,error;try{result=await f.run();}catch(e){error=e;}
 assert.equal(f.rawReads(),0,'zero raw Hypa getter reads through the live pipeline');if(error)throw error;
 assert.equal(result.ok,true);assert.equal(f.prompts.length,4);assert(f.prompts.every(p=>JSON.stringify(p).includes('CURRENT_USER_KEEP')));
 assert.equal(f.h.getCalls(),0);result.closeEvidence();
});
test('system summary fallback never reaches live stage payloads, and ordinary conversation remains intact',async t=>{
 const f=await fixture(t);const before=JSON.stringify(f.input),result=await f.run();assert.equal(result.ok,true);assert.equal(f.prompts.length,4);
 for(const [i,prompt]of f.prompts.entries()){const body=JSON.stringify(prompt);assert(!body.includes(summary),'aggregate absent from stage '+i);assert(!body.includes(raw),'raw summary absent from stage '+i);for(const marker of ['CURRENT_USER_KEEP','PREVIOUS_ASSISTANT_KEEP'])assert(body.includes(marker),marker+' in stage '+i);}
 const native=await f.h.plugin.debugNativeRecentContext('CURRENT_USER_KEEP examines the key.','u2');assert.equal(native.recentTurnCount,1);assert(native.completeTurnsText.includes('PREVIOUS_USER_KEEP'));assert(native.completeTurnsText.includes('PREVIOUS_ASSISTANT_KEEP'));assert(f.recentViews.length>=4);for(const view of f.recentViews){assert.equal(view.recentTurnCount,1);assert(view.completeTurnsText.includes('PREVIOUS_USER_KEEP'));assert(view.completeTurnsText.includes('PREVIOUS_ASSISTANT_KEEP'));}
 const recent=f.h.buildRecent(f.input,f.settings);assert(recent.systemContext.includes('SYSTEM_RULE_KEEP'));assert(recent.systemContext.includes('SECOND_RULE_KEEP'));assert(!recent.systemContext.includes(summary));
 assert.equal(JSON.stringify(f.input),before);assert.equal(f.rawReads(),0);assert.equal(f.h.getCalls(),0);result.closeEvidence();
});
test('retired settings and public API cannot reactivate Hypa, while user records remain untouched',async()=>{
 const saved='["old-record"]',h=await load({storage:{'serial_gradation_agents_for_rp:excluded_hypa_record_ids':saved}});
 for(const name of ['getExcludedHypaRecordIds','listHypaV3Records','debugBuildHypaContinuity','debugBuildHypaV3Catalog'])assert.equal(h.plugin[name],undefined,name);
 const before=[...h.store];for(const legacy of [{excluded_hypa_record_ids:['old-record']},{excludedHypaRecordIds:['old-record']}]){const imported=h.plugin.debugImportedRuntimeToGui(legacy,{});assert.equal(imported.excludedHypaRecordIds,undefined);assert.equal(imported.excluded_hypa_record_ids,undefined);}
 assert.equal(h.plugin.getRuntime().settings?.excludedHypaRecordIds,undefined);assert.deepEqual([...h.store],before);assert.equal(h.getCalls(),0);
});
test('canonical references and final engine planning ignore stale Hypa packets',async()=>{
 const {plugin}=await load();const stale={records:[{id:'old',body:raw,selectionGroups:['important'],sourceOrder:0}],selectedCount:1};
 const built=plugin.debugBuildCanonicalReferencePacket({hypaContinuity:stale,source:{character:{desc:'CHARACTER_KEEP'}},recent:{latestUser:'CURRENT_USER_KEEP'}});
 assert(!JSON.stringify(built).includes(raw));assert.equal(built.packet.references.hypa,undefined);
 for(const writingMode of ['novel','rp']){const out=plugin.debugBuildRisuEnginePromptBundle({latestUser:'CURRENT_USER_KEEP',referencePacket:{references:{hypa:[{id:'old',content:raw,optional:false,sourceOrder:0}]}}},'DRAFT_KEEP',[],{writingMode});assert(!JSON.stringify(out).includes(raw));}
});
test('Materials navigation never reads raw Hypa and exposes only current supported sources',async t=>{
 const f=await fixture(t,{poison:true,gui:true});await f.h.plugin.openSettingsGui();await f.h.plugin.debugNavigateGui('references','flow');
 const body=f.dom.window.document.body.textContent;assert(!body.includes('HypaV3'));assert(body.includes('LIBRA'));assert(body.includes('HAYAKU'));assert(body.includes('Flashback'));assert.equal(f.rawReads(),0);assert.equal(f.h.getCalls(),0);
});
test('ordinary user content mentioning the legacy summary tag is preserved',async()=>{
 const {plugin}=await load();const value='Explain <Past Events Summary>literal user text</Past Events Summary> please.';
 const out=plugin.debugBuildRecentChat([{role:'user',messageId:'literal-user',content:value}]);assert.equal(out.latestUser,value);
});
