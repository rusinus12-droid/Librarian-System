'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createLibraVmHarness,waitFor}=require('./fixtures/libra_vm_harness.cjs');
const source=fs.readFileSync(path.resolve(__dirname,'../plugins/LIBRA.js'),'utf8');
console.log('sourceSha256 '+require('node:crypto').createHash('sha256').update(source).digest('hex'));
const acorn=require('acorn');
const syntax=acorn.parse(source,{ecmaVersion:'latest'}),bindings=new Set();
function collectBindings(n){if(!n||!n.type)return;if(n.type==='VariableDeclarator'&&n.id.type==='Identifier')bindings.add(n.id.name);if(n.type==='FunctionDeclaration')bindings.add(n.id.name);for(const [k,v]of Object.entries(n)){if(Array.isArray(v))for(const c of v)collectBindings(c);else if(v&&v.type)collectBindings(v);}}
collectBindings(syntax);
const exclusive=/^(?:sga(?:_|[A-Z])|gradia(?:_|[A-Z])|planner(?:_|[A-Z])|input_writer(?:_|[A-Z])|inputWriter[A-Z])/;
test('retired helper executors and declared host controls are removed; core memory entrypoints remain',()=>{
 for(const name of ['runTurnPlanner','runSgaPipeline','runExplicitLibraInputWriter','generateLibraInputWriterChoices'])assert(!bindings.has(name),'retired executable remains '+name);
 const controls=[...source.matchAll(/^\/\/@arg\s+(\S+)/gm)].map(m=>m[1]);assert(!controls.some(k=>exclusive.test(k)),'retired host settings remain');
 for(const name of ['readCompletedReceiptSet','produceMicroForTurn','renderClassicBlock','assertConsumerEvidenceCurrent','captureUnifiedResponseBoundary'])assert(source.includes(name),'retained core missing '+name);
});
test('all legacy response selections resolve to retained default recall without retired output routes',async()=>{
 const r=await createLibraVmHarness();try{for(const old of [{injectionMode:'planner'},{injection_mode:'sga'},{responseFamily:'gradia',gradiaWritingMode:'author'},{response_family:'gradia',input_writer_enabled:true}]){
  const state=r.api.debugResolveResponseModeState(old);assert.equal(state.injectionMode,'classic');assert.equal(state.responseFamily,'libra');assert.equal(state.libraResponseMode,'classic');
 }}finally{await r.cleanup();}
});
test('legacy settings import and fresh runtime cannot restore retired assignments or public execution APIs',async()=>{
 const r=await createLibraVmHarness();let rows;try{
  await r.api.debugWriteRuntimeSettings({injection_mode:'sga',response_family:'gradia',sga_shadow_enabled:true,sga_shadow_preset:'fixture-retired',planner_preset:'fixture-retired',input_writer_enabled:true,input_writer_mode:'author',live_context_enabled:true,live_tail_max_turns:3,recall_max_memories:11});
  const settings=(await r.api.debugReadRuntimeSettings()).settings;for(const k of Object.keys(settings))assert(!exclusive.test(k),'retired imported field remains '+k);assert.equal(settings.injection_mode,'classic');assert.equal(settings.live_tail_max_turns,3);assert.equal(settings.recall_max_memories,11);
  rows=[...r.values.entries()];
 }finally{await r.cleanup();}
 const fresh=await createLibraVmHarness({input_writer_enabled:'true',injection_mode:'planner',response_family:'gradia'}, {}, {initialValues:rows});try{
  for(const name of ['writeInput','prepareInputWriterEvidence','debugGenerateInputWriterChoices','getLastTurnPlanner','getLastSgaRun','cancelGradiaPipeline'])assert.equal(typeof fresh.api[name],'undefined','retired API remains '+name);
  const settings=(await fresh.api.debugReadRuntimeSettings()).settings;assert.equal(settings.injection_mode,'classic');for(const k of Object.keys(settings))assert(!exclusive.test(k),'retired field returned after restart '+k);
 }finally{await fresh.cleanup();}
});

test('retirement settings save/restart preserve historic raw memory and draft storage bytes',async()=>{
 const entries=[['libra-historic-raw-fixture','\u0000 exact historic raw\r\n '+ 'R'.repeat(1024)],['libra-historic-draft-fixture',JSON.stringify({schema:'libra.sga_run.v1',draft:'Historic user draft',scopeKey:'historic-scope'})]];
 const r=await createLibraVmHarness({}, {}, {initialValues:entries});let snapshot;
 try{await r.api.debugWriteRuntimeSettings({response_family:'gradia',injection_mode:'planner',input_writer_enabled:true,recall_max_memories:17});for(const [key,value]of entries)assert.equal(r.values.get(key),value);assert(!r.storageRemovals.some(key=>entries.some(([owned])=>owned===key)));snapshot=[...r.values.entries()];}
 finally{await r.cleanup();}
 const fresh=await createLibraVmHarness({}, {}, {initialValues:snapshot});try{for(const [key,value]of entries)assert.equal(fresh.values.get(key),value);assert.equal((await fresh.api.debugReadRuntimeSettings()).settings.recall_max_memories,17);}finally{await fresh.cleanup();}
});

test('actual settings DOM retains all six pages and memory import/save/restart while excluding retired helper actions',async()=>{
 const {JSDOM}=require('jsdom');
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/retirement'}),window=dom.window,registrations=[],logs=[];
 const chat={id:'retirement-gui-chat',chatId:'retirement-gui-chat',message:[]};chat.messages=chat.message;
 const character={id:'retirement-gui-char',chaId:'retirement-gui-char',name:'Fixture',chatPage:0,chats:[chat]};
 const globals={window,document:window.document,navigator:window.navigator,HTMLElement:window.HTMLElement,Node:window.Node,Event:window.Event,MutationObserver:window.MutationObserver,getComputedStyle:window.getComputedStyle.bind(window),requestAnimationFrame:fn=>setTimeout(()=>fn(performance.now()),0),cancelAnimationFrame:clearTimeout,console:Object.fromEntries(['log','info','warn','error','debug'].map(k=>[k,(...args)=>logs.push([k,...args.map(a=>String(a?.stack||a))])]))};
 const importAccess=value=>{const anchor='    async openSettingsGui() {';assert(value.includes(anchor));return value.replace(anchor,`    async retirementImportPromptProfile(payload) {await ensureGuiState();Gui.promptStudioImportText=JSON.stringify(payload);return importPromptStudioJson();},\n`+anchor);};
 const r=await createLibraVmHarness({enable_gui:'true'},{getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getChar:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getDatabase:async()=>({characters:[character],personas:[],selectedPersona:'',plugins:[]}),registerSetting:async(...args)=>{registrations.push({type:'settings',args});return{id:'fixture-setting'};},registerButton:async(...args)=>{registrations.push({type:'button',args});return{id:args[0].id};},showContainer:async()=>true,hideContainer:async()=>true},{contextGlobals:globals,transformSource:importAccess});
 try{
  await r.api.openSettingsGui();assert(window.document.querySelector('#sga-rp-gui-root'),'actual settings root rendered');
  try{await waitFor(()=>window.document.querySelector('.page.is-active[data-page] [data-libra-product-detail]'),4000);}catch(error){throw Error('Actual retained book page failed: '+JSON.stringify(logs));}
  for(const page of ['desk','memory','people','world','story','settings']){
   const button=window.document.querySelector('.sidebar [data-go="'+page+'"]');assert(button,'actual retained navigation button '+page);button.click();
   try{await waitFor(()=>window.document.querySelector('.page.is-active[data-page="'+page+'"] [data-libra-product-detail="'+page+'"]'),4000);}catch(error){throw Error('Actual page '+page+' failed: '+JSON.stringify(logs));}
   const text=window.document.body.textContent;assert(!/GRADIA|Input Writer|Planner/.test(text),'retired feature label on '+page+': '+(text.match(/.{0,80}(?:GRADIA|Input Writer|Planner).{0,80}/g)||[]).join(' | '));
  }
  assert(registrations.some(row=>row.type==='settings'),'settings entry retained');assert(!registrations.some(row=>JSON.stringify(row.args).includes('input-writer')),'retired input writer host action registered');
  const profile={schema:'libra.memory_prompt_profile.v1',name:'retained-import-fixture',version:3,stages:{librarian:{sections:{custom_addendum:{mode:'append',text:'Retained exact memory instruction'}}}}};
  await r.api.retirementImportPromptProfile({schema:'libra.prompt_profiles.export.v1',scope:'selected',domain:'memory',active:true,profile});
  const saved=await r.api.debugReadPromptOverrides();assert.equal(saved.prompts.activeMemoryProfile,profile.name);assert.equal(saved.prompts.memoryProfiles[profile.name].stages.librarian.sections.custom_addendum.text,'Retained exact memory instruction');
  const promptKey='libra:v1:prompt-overrides',raw=r.values.get(promptKey),settingsRaw=r.values.get('libra:v1:settings');
  for(const payload of [{schema:'libra.prompt_profiles.export.v1',scope:'selected',domain:'planner',active:true,profile:{...profile,name:'must-not-be-memory'}},{schema:'libra.planner_prompt_profile.v1',name:'must-not-be-memory'}]){
   await assert.rejects(r.api.retirementImportPromptProfile(payload),/Retired|retired/);assert.equal(r.values.get(promptKey),raw,'rejected retired profile keeps exact prompt bytes');assert.equal(r.values.get('libra:v1:settings'),settingsRaw,'rejected retired profile keeps exact settings bytes');
  }
  const fresh=await createLibraVmHarness({}, {}, {initialValues:[...r.values.entries()]});try{const restored=await fresh.api.debugReadPromptOverrides();assert.equal(restored.prompts.activeMemoryProfile,profile.name);assert.equal(restored.prompts.memoryProfiles[profile.name].stages.librarian.sections.custom_addendum.text,'Retained exact memory instruction');assert.equal(restored.prompts.memoryProfiles['must-not-be-memory'],undefined);}finally{await fresh.cleanup();}
 }
 finally{await r.api.closeSettingsGui();await r.cleanup();window.close();}
});

test('default Classic actually recalls admitted gold without invoking any retired helper provider',async()=>{
 const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');const f=await fixture();
 try{await f.run();assert(f.getMemory(),'canonical producer committed admitted memory');const count=f.control.calls.length;f.control.onCall=async()=>{throw new Error('RETIRED_HELPER_PROVIDER_SUBMISSION');};
  const output=await f.control.hooks.beforeRequest([{role:'user',content:'황동 열쇠의 소유자와 현재 소지자는 누구인가?'}],'model');
  assert(JSON.stringify(output).includes('황동 열쇠'),'real default Classic final output carries gold source');assert.equal(f.control.calls.length,count,'default recall submits no extra helper model call');assert.equal(f.r.api.getRuntime().lastInjectionMode,'classic');
 }finally{await f.r.cleanup();}
});
