'use strict';
// Bounded fake-pipeline integration: actual emitted GUI, shared health dispatcher,
// source capture and historical method; analysis/merge/persistence are synthetic.
// This does not exercise or validate ordinary host mirroring or latest-turn atomicity.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Module=require('node:module');
const artifact=path.resolve(process.env.LIBRA_GUI_TEST_DIST||path.join(__dirname,'../dist/LIBRA World Manager Full.js'));
const source=fs.readFileSync(artifact,'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,label){const until=Date.now()+6000;while(Date.now()<until){if(predicate())return;await delay(5);}assert.fail(label);}
function installTrace(){
 const trace={instances:[],calls:[],adapters:[],stages:[],dialogs:[],mutationStarted:0,modelCalls:0,mergeCalls:0,persistenceCalls:0,receipt:{ok:true,canonicalVerified:true}};
 trace.wrapFactory=factory=>options=>{
  const index=trace.instances.length,config={...options};
  for(const [name,kind] of [['derivedCache','refresh_derived_cache'],['reanalysis','explicit_reanalysis']]){
   if(!options[name])continue;config[name]={...options[name]};
   for(const method of ['preview','apply','clear'])if(typeof options[name][method]==='function')config[name][method]=function(...args){
    const call={instance:index,kind,method,args};trace.adapters.push(call);
    const result=options[name][method].apply(options[name],args);
    if(result&&typeof result.then==='function')result.then(value=>call.result=value,error=>call.error=String(error));else call.result=result;
    return result;
   };
  }
  const raw=factory(config),dispatcher={};trace.instances.push({index,raw,dispatcher});
  for(const method of ['inspect','preview','apply','clear'])dispatcher[method]=function(...args){
   const call={instance:index,method,kind:method==='preview'?args[0]:args[0]?.actionKind,args};trace.calls.push(call);trace.onCall?.(call);
   const result=raw[method](...args);
   if(result&&typeof result.then==='function')result.then(async value=>{call.result=value;await trace.onResult?.(call);},error=>call.error=String(error));else call.result=result;
   return result;
  };return Object.freeze(dispatcher);
 };
 trace.chunk=async options=>{trace.modelCalls++;trace.stages.push({kind:'chunk',label:options?.label,user:options?.user});await trace.onStage?.('chunk');return {content:JSON.stringify({events:['Mira found an old notebook.'],characters:[],relationships:[],world_rules:[]})};};
 trace.synthesis=async(summaries,label)=>{trace.modelCalls++;trace.stages.push({kind:'synthesis',label,count:summaries.length});await trace.onStage?.('synthesis');return {narrative:'Mira found an old notebook.',entities:[],relations:[],world:{rules:['The archive is open.']}};};
 trace.verify=async(current,candidate,label)=>{trace.modelCalls++;trace.stages.push({kind:'verify',label});await trace.onStage?.('verify');return candidate;};
 trace.additional=async(data,messages,char,chat,label)=>{trace.stages.push({kind:'additional',label});await trace.onStage?.('additional');return null;};
 trace.merge=async(data,options)=>{
  trace.mergeCalls++;trace.stages.push({kind:'merge',options});await trace.onStage?.('merge-entry',options);
  if(typeof options?.selectionCurrent==='function'&&!await options.selectionCurrent())throw new Error('synthetic_selection_changed_before_mutation');
  trace.mutationStarted++;options?.onMutationStarted?.();await trace.onStage?.('mutation',options);
  trace.persistenceCalls++;trace.stages.push({kind:'persistence'});await trace.onStage?.('persistence',options);
  if(trace.mergeError)throw Object.assign(new Error(trace.mergeError),trace.errorPersistence?{persistence:{...trace.errorPersistence}}:{});
  return {persistence:{...trace.receipt},...trace.receipt};
 };
 globalThis.__WM_HISTORICAL_TRACE__=trace;
}
let instrumented='('+installTrace.toString().replace(/\n/g,' ')+')();\n'+source.replace(/MemorySuiteHealthRecovery\.createOrchestrator/g,'globalThis.__WM_HISTORICAL_TRACE__.wrapFactory(MemorySuiteHealthRecovery.createOrchestrator)');
// Min may inline the synthesis helper. Locate call expressions structurally,
// retaining the real analyzer/chunker and historical orchestration in both builds.
const acorn=require('acorn'),edits=[],matched=new Set();
let managerReturn=null,inlineSynthesisSource=null,namedSynthesisSource=null,readSelectedSource=null;
const hooks={callColdStartLLMWithPreflight:'chunk',synthesizeChunkSummariesHierarchically:'synthesis',verifyMergedStructuredKnowledge:'verify',analyzeHistoricalWorldAdditional:'additional',mergeStructuredKnowledge:'merge'};
function visit(node){
 if(!node||typeof node!=='object')return;
 if(node.type==='VariableDeclarator'&&node.id?.name==='readSelected'){assert.equal(readSelectedSource,null,'unique emitted historical readSelected helper');readSelectedSource=instrumented.slice(node.init.start,node.init.end);}
 if(node.type==='VariableDeclarator'&&node.id?.name==='synthesizeChunkSummariesHierarchically')namedSynthesisSource=instrumented.slice(node.init.start,node.init.end);
 if(node.type==='ObjectExpression'&&['reanalyzeHistoricalConversation','snapshotHistoricalSource','integrateImportedKnowledge','buildAnalyzableMessages'].every(name=>node.properties.some(property=>property.key?.name===name)))managerReturn=node;
 if(node.type==='CallExpression'){
  const named=node.callee?.type==='Identifier'?hooks[node.callee.name]:null;
  const inlineSynthesis=node.callee?.type==='ArrowFunctionExpression'&&node.arguments?.[0]?.name==='chunkSummaries'&&node.arguments?.[1]?.name==='taskLabel';
  if(inlineSynthesis)inlineSynthesisSource=instrumented.slice(node.callee.start,node.callee.end);
  const hook=named||(inlineSynthesis?'synthesis':null);
  if(hook){edits.push({start:node.callee.start,end:node.callee.end,text:'globalThis.__WM_HISTORICAL_TRACE__.'+hook});matched.add(hook);}
 }
 for(const value of Object.values(node)){if(Array.isArray(value))for(const child of value)visit(child);else if(value&&typeof value==='object')visit(value);}
}
visit(acorn.parse(instrumented,{ecmaVersion:'latest'}));
assert(managerReturn&&(namedSynthesisSource||inlineSynthesisSource),'actual historical helper lexical scope');
assert(readSelectedSource,'actual emitted historical selection reader');
const exposeAt=managerReturn.properties[0].start;
edits.push({start:exposeAt,end:exposeAt,text:'__testHistoricalHelpers:{preflight:callColdStartLLMWithPreflight,synthesis:('+(namedSynthesisSource||inlineSynthesisSource)+')},'});
for(const hook of Object.values(hooks))assert(matched.has(hook),'emitted fake dependency boundary exists: '+hook);
for(const edit of edits.filter(x=>!edits.some(y=>y!==x&&y.start<=x.start&&y.end>=x.end)).sort((a,b)=>b.start-a.start))instrumented=instrumented.slice(0,edit.start)+edit.text+instrumented.slice(edit.end);
const fixturePath=path.join(__dirname,'libra_management_gui_integration_test.cjs');
let fixtureSource=fs.readFileSync(fixturePath,'utf8');
const start=fixtureSource.indexOf(' let code=fs.readFileSync('),end=fixtureSource.indexOf(' await w.eval(code);',start);
assert(start>=0&&end>start,'existing GUI fixture boundaries');
fixtureSource=fixtureSource.slice(0,start)+`
 let code=module.__artifactSource;
 const fullBoundary=code.lastIndexOf('\\n})();');
 const boundary=fullBoundary>=0?fullBoundary:Math.max(code.lastIndexOf('}();'),code.lastIndexOf('})();'));
 assert(boundary>=0,'actual production IIFE boundary');
 code=code.slice(0,boundary)+';globalThis.__WM_GUI_TEST__={...runtimeApi,ColdStartManager};'+code.slice(boundary);
`+fixtureSource.slice(end);
const fixtureModule=new Module(fixturePath,module);fixtureModule.filename=fixturePath;fixtureModule.paths=Module._nodeModulePaths(__dirname);fixtureModule.__artifactSource=instrumented;fixtureModule._compile(fixtureSource,fixturePath);
const {loadGui}=fixtureModule.exports;
async function fixture(){
 const messages=[{role:'user',data:'Open the old notebook.',chatId:'u0',metadata:{exact:'user metadata'}},{role:'char',data:'Mira found an old notebook.',chatId:'a0',metadata:{exact:'assistant metadata'}},{role:'user',data:'Read the final page.',chatId:'u1'},{role:'char',data:'The archive stays open tonight.',chatId:'a1'}];
 const f=await loadGui({character:{id:'fixture-char',name:'Fixture',chatPage:0,chats:[{id:'fixture-chat',bindedPersona:'persona-a',localLore:[],message:messages,msgs:messages,isStreaming:false}],globalLore:[],lorebook:[]}});
 f.trace=f.w.__WM_HISTORICAL_TRACE__;f.api.MemoryEngine.CONFIG.useLLM=true;
 f.api.MemoryEngine.CONFIG.llm={...f.api.MemoryEngine.CONFIG.llm,provider:'openai',url:'https://mock-only.invalid',key:'mock-only',model:'mock',stream:false};
 f.dispatcher=()=>{assert.equal(f.trace.instances.length,1,'one private shared dispatcher');return f.trace.instances[0].dispatcher;};
 f.flush=async()=>{while(f.pending.length)await Promise.allSettled(f.pending.splice(0));await delay(0);};
 f.dialog=()=>f.w.document.querySelector('[data-libra-dialog="true"]');
 f.resolveDialog=async approve=>{await waitFor(()=>f.dialog(),'real historical confirmation appears');const dialog=f.dialog();f.trace.dialogs.push(dialog.textContent);const button=[...dialog.querySelectorAll('button')].find(node=>node.textContent===(approve?'확인':'취소'));assert(button,'actual confirmation/cancel control');button.click();};
 f.start=()=>{const node=f.overlay.querySelector('#btn-cold-reanalyze');assert(node,'real existing historical button');const result=node.onclick();f.pending.push(result);return result;};
 f.applyResult=()=>f.trace.calls.findLast(call=>call.method==='apply'&&call.kind==='explicit_reanalysis')?.result;
 f.ticket=()=>f.trace.calls.findLast(call=>call.method==='preview'&&call.kind==='explicit_reanalysis')?.result;
 f.selection=()=>f.trace.calls.findLast(call=>call.method==='preview'&&call.kind==='explicit_reanalysis')?.args[1];
 f.preview=async()=>{
  await f.click('#btn-health-repair-preview');
  const selection=f.trace.calls.findLast(call=>call.method==='preview'&&call.kind==='refresh_derived_cache').args[1];
  return f.dispatcher().preview('explicit_reanalysis',{...selection,mode:'whole_conversation_merge',trigger:'manual_gui',reason:'Explicit historical fixture'});
 };
 f.mutate=kind=>{
  if(kind==='source-first')f.control.chat.msgs[0].data='Changed first source.';
  else if(kind==='source-last')f.control.chat.msgs.at(-1).data+=' Changed last source.';
  else if(kind==='source-metadata')f.control.chat.msgs[0].metadata.exact='Changed non-text byte';
  else if(kind==='source-null')f.control.chat.msgs.push(null);
  else if(kind==='source-selector')delete f.control.chat.msgs;
  else if(kind==='config')f.api.MemoryEngine.CONFIG.llm.model='changed-model';
  else if(kind==='canonical')f.store.set(f.key,f.store.get(f.key)+' ');
  else if(kind==='canonical-unreadable')f.control.failReads=true;
  else if(kind==='persona')f.control.chat.bindedPersona='persona-b';
  else if(kind==='scope'){f.control.chat.id='different-chat';f.control.char.id='different-char';}
  else if(kind==='reset')f.api.MemoryState.reset();
  else if(kind==='close')f.overlay.querySelector('#xbtn').click();
  else throw new Error('unknown fixture mutation '+kind);
 };
 f.assertNoEffects=()=>{assert.equal(f.trace.modelCalls,0);assert.equal(f.trace.mergeCalls,0);assert.equal(f.trace.persistenceCalls,0);assert.equal(f.trace.mutationStarted,0);assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);};
 return f;
}
const checks=[];
async function test(name,fn){
 if(process.env.LIBRA_HISTORICAL_DISPATCH_FILTER&&!new RegExp(process.env.LIBRA_HISTORICAL_DISPATCH_FILTER).test(name))return;
 let f;process.stderr.write('[historical-dispatch] START '+name+'\n');
 try{f=await fixture();await fn(f);checks.push({name,ok:true,evidence:{instances:f.trace.instances.length,dispatcherCalls:f.trace.calls.map(x=>({method:x.method,kind:x.kind,mode:x.args[1]?.mode,status:x.result?.state||x.result?.status,allowed:x.result?.allowed})),stages:f.trace.stages.map(x=>x.kind),modelCalls:f.trace.modelCalls,mergeCalls:f.trace.mergeCalls,persistenceCalls:f.trace.persistenceCalls,mutationStarted:f.trace.mutationStarted,dialogs:f.trace.dialogs.length,storageWrites:f.calls.writes.length,hostWrites:f.calls.hostWrites.length}});process.stderr.write('[historical-dispatch] PASS '+name+'\n');}
 catch(error){process.exitCode=1;checks.push({name,ok:false,error:error.stack,diagnostics:f?{calls:f.trace.calls.map(x=>({method:x.method,kind:x.kind,mode:x.args[1]?.mode,result:x.result})),stages:f.trace.stages.map(x=>x.kind),dialogs:f.trace.dialogs.length,body:f.w.document.body.textContent.slice(-1500)}:undefined});process.stderr.write('[historical-dispatch] FAIL '+name+': '+error.message+'\n');}
 finally{f?.close();}
}
async function main(){
 await test('real historical button routes through the shared explicit dispatcher in whole_conversation_merge mode',async f=>{
  f.dispatcher();const raw=f.store.get(f.key);const operation=f.start();await f.resolveDialog(false);await operation;await f.flush();
  const preview=f.trace.calls.find(call=>call.method==='preview'&&call.kind==='explicit_reanalysis');
  assert(preview,'historical control must not bypass the shared dispatcher');assert.equal(preview.args[1]?.mode,'whole_conversation_merge');
  assert(f.trace.calls.some(call=>call.method==='apply'&&call.kind==='explicit_reanalysis'));
  assert.equal(f.trace.dialogs.length,1);assert.match(f.trace.dialogs[0],/예상 LLM 호출: 약 \d+회 이상/,'retains the model-cost estimate');
  assert.equal(f.trace.modelCalls,0);assert.equal(f.trace.mergeCalls,0);assert.equal(f.trace.persistenceCalls,0);assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);assert.equal(f.store.get(f.key),raw);
 });

 await test('historical button visibly distinguishes whole conversation merge and shares the cache dispatcher',async f=>{
  const button=f.overlay.querySelector('#btn-cold-reanalyze');assert.equal(button.dataset.reanalysisMode,'whole_conversation_merge');assert.match(button.textContent,/전체 대화/);assert.match(button.textContent,/병합/);
  assert(f.overlay.querySelector('#historical-reanalysis-status[role="status"]'),'persistent accessible historical status');
  await f.click('#btn-health-scan');await f.click('#btn-health-repair-preview');
  const operation=f.start();await f.resolveDialog(false);await operation;
  for(const kind of ['refresh_derived_cache','explicit_reanalysis'])assert(f.trace.calls.some(call=>call.method==='preview'&&call.kind===kind));
  assert.equal(new Set(f.trace.calls.map(call=>call.instance)).size,1);f.assertNoEffects();
 });
 await test('private whole conversation preview is model free read only and keeps execution data off public tickets',async f=>{
  const raw=f.store.get(f.key),ticket=await f.preview();assert.equal(ticket.allowed,true);assert.equal(ticket.actionKind,'explicit_reanalysis');
  assert.equal(f.dialog(),null);f.assertNoEffects();assert.equal(f.store.get(f.key),raw);
  const publicJson=JSON.stringify(ticket);assert(!publicJson.includes('Mira found'));assert(!publicJson.includes('mock-only'));assert(!publicJson.includes('sourceBytes'));
  for(const forbidden of ['binding','expectedRaw','sourceBytes','sourceLabel','mode','signal','isViewCurrent','config'])assert.equal(Object.prototype.hasOwnProperty.call(ticket,forbidden),false,'private '+forbidden+' stays private');
 });
 await test('confirmed historical route preserves chunk synthesis verification then merge ordering',async f=>{
  let beforeApply;f.trace.onCall=call=>{if(call.method==='apply'&&call.kind==='explicit_reanalysis')beforeApply={models:f.trace.modelCalls,writes:f.calls.writes.length,dialogs:!!f.dialog()};};
  const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();
  assert.deepEqual(beforeApply,{models:0,writes:0,dialogs:false});assert.equal(f.trace.dialogs.length,1);
  assert.deepEqual(clone(f.trace.stages.map(stage=>stage.kind)),['chunk','synthesis','verify','additional','merge','persistence']);
  const chunk=f.trace.stages.find(stage=>stage.kind==='chunk');assert.match(chunk.user,/Mira found an old notebook/);assert.match(chunk.user,/archive stays open tonight/);assert.match(chunk.label,/cold-reanalysis.*chunk/);
  assert.equal(f.trace.stages.find(stage=>stage.kind==='verify').label,'cold-reanalysis-verify');
  const options=f.trace.stages.find(stage=>stage.kind==='merge').options;assert.equal(options.sourceId,'reanalysis');assert.equal(options.updateNarrative,true);assert.equal(options.targetChat.id,'fixture-chat');assert.equal(options.targetChar.id,'fixture-char');
  assert.equal(f.trace.mergeCalls,1);assert.equal(f.trace.persistenceCalls,1);assert.equal(f.trace.mutationStarted,1);assert.equal(f.applyResult()?.state,'committed');assert.equal(f.applyResult()?.committed,true);
  assert.equal(f.overlay.querySelector('#historical-reanalysis-status').dataset.state,'committed');assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0,'fake pipeline never exercises host mirroring');
 });
 await test('duplicate button clicks and duplicate ticket apply execute one confirmation and merge',async f=>{
  let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  f.trace.onStage=async stage=>{if(stage==='chunk'){started();await gate;}};
  const operation=f.start();const duplicate=f.start();await f.resolveDialog(true);await entered;
  const ticket=f.ticket(),replay=f.dispatcher().apply(ticket);
  try{assert.equal(f.dialog(),null);assert.equal(f.trace.dialogs.length,1);assert.equal(f.trace.modelCalls,1);}
  finally{release();await Promise.all([operation,duplicate,replay]);await f.flush();}
  assert.equal(f.trace.adapters.filter(call=>call.method==='apply'&&call.kind==='explicit_reanalysis').length,1);assert.equal(f.trace.mergeCalls,1);assert.equal(f.trace.persistenceCalls,1);
  const consumed=await f.dispatcher().apply(ticket);assert.equal(consumed.status,'blocked');assert.equal(f.trace.mergeCalls,1);
 });
 await test('cancel consumes historical ticket without confirmation or model effects on replay',async f=>{
  const operation=f.start();await f.resolveDialog(false);await operation;const ticket=f.ticket();f.assertNoEffects();
  const result=await f.dispatcher().apply(ticket);assert.equal(result.status,'blocked');assert.equal(f.dialog(),null);assert.equal(f.trace.dialogs.length,1);f.assertNoEffects();
 });
 for(const mutation of ['source-first','source-last','source-metadata','source-null','source-selector','config','canonical','canonical-unreadable','persona','scope','reset','close'])await test('preview ticket invalidates before dispatch on '+mutation,async f=>{
  const ticket=await f.preview();assert.equal(ticket.allowed,true);f.mutate(mutation);const result=await f.dispatcher().apply(ticket);
  assert.equal(result.status,'blocked');assert.notEqual(result.committed,true);assert.equal(f.dialog(),null);f.assertNoEffects();
 });
 for(const mutation of ['source-first','config','canonical','persona','scope','reset','close'])await test('captured selection is rechecked after confirmation on '+mutation,async f=>{
  const operation=f.start();await waitFor(()=>f.dialog(),'confirmation ready');f.mutate(mutation);
  // Closing may remove the dialog with the overlay; the real dialog remains a body sibling.
  if(f.dialog())await f.resolveDialog(true);
  await operation;await f.flush();const result=f.applyResult();assert.equal(result?.writeIssued,false);assert.notEqual(result?.state,'committed');f.assertNoEffects();
 });
 for(const [stage,mutation]of [['synthesis','source-first'],['synthesis','config'],['synthesis','canonical'],['synthesis','persona'],['synthesis','scope'],['synthesis','close'],['additional','source-last'],['additional','canonical'],['additional','reset']])await test('historical guard rejects '+mutation+' after '+stage+' before live merge',async f=>{
  f.trace.onStage=async current=>{if(current===stage)f.mutate(mutation);};
  const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();const result=f.applyResult();
  assert.equal(result?.writeIssued,false);assert.notEqual(result?.state,'committed');assert.equal(f.trace.mergeCalls,0);assert.equal(f.trace.persistenceCalls,0);assert.equal(f.trace.mutationStarted,0);assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);
 });
 await test('ok true without canonicalVerified is uncertain rather than committed',async f=>{
  f.trace.receipt={ok:true,canonicalVerified:false};const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();
  assert.equal(f.applyResult()?.state,'uncertain');assert.equal(f.applyResult()?.status,'uncertain');assert.notEqual(f.applyResult()?.writeIssued,false);assert.equal(f.overlay.querySelector('#historical-reanalysis-status').dataset.state,'uncertain');assert.equal(f.trace.persistenceCalls,1);
 });
 await test('late merge failure after mutation is uncertain with no clean abort or automatic retry',async f=>{
  f.trace.mergeError='synthetic persistence failure after live mutation';const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();
  assert.equal(f.applyResult()?.state,'uncertain');assert.equal(f.applyResult()?.status,'uncertain');assert.notEqual(f.applyResult()?.writeIssued,false);assert.equal(f.trace.mutationStarted,1);assert.equal(f.trace.mergeCalls,1);assert.equal(f.trace.persistenceCalls,1);
  assert.equal((await f.dispatcher().apply(f.ticket())).status,'blocked');assert.equal(f.trace.mergeCalls,1);
 });
 for(const terminal of ['committed','uncertain'])await test(terminal+' persistence outcome survives late view invalidation',async f=>{
  f.trace.receipt={ok:true,canonicalVerified:terminal==='committed'};f.trace.onStage=async stage=>{if(stage==='persistence')f.mutate('close');};
  const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();assert.equal(f.applyResult()?.state,terminal);assert.equal(f.trace.persistenceCalls,1);assert.equal(f.trace.mergeCalls,1);
  assert.equal((await f.dispatcher().apply(f.ticket())).status,'blocked');assert.equal(f.trace.persistenceCalls,1);
 });



 await test('moving a null slot invalidates exact source bytes despite identical filtered analysis',async f=>{
  f.control.chat.msgs.splice(1,0,null);const ticket=await f.preview();assert.equal(ticket.allowed,true);
  f.control.chat.msgs.splice(1,1);f.control.chat.msgs.push(null);const result=await f.dispatcher().apply(ticket);assert.equal(result.status,'blocked');assert.equal(f.dialog(),null);f.assertNoEffects();
 });
 await test('entire selected source bytes include content beyond model truncation limits',async f=>{
  f.control.chat.msgs[1].data='Mira '+ 'A'.repeat(100000)+'Z';const ticket=await f.preview();assert.equal(ticket.allowed,true);
  f.control.chat.msgs[1].data=f.control.chat.msgs[1].data.slice(0,-1)+'Q';const result=await f.dispatcher().apply(ticket);assert.equal(result.status,'blocked');assert.equal(f.dialog(),null);f.assertNoEffects();
 });
 await test('a newly preferred alternate source invalidates the captured source selector',async f=>{
  const ticket=await f.preview();assert.equal(ticket.allowed,true);f.control.chat.history={messages:[...clone(f.control.chat.msgs),{role:'char',data:'A new historical source row.',chatId:'new-row'}]};f.control.chat.history.messages[0].data='Different older historical source request.';
  const result=await f.dispatcher().apply(ticket);assert.equal(result.status,'blocked');assert.equal(f.dialog(),null);f.assertNoEffects();
 });
 await test('verified persistence receipt survives a late merge exception',async f=>{
  f.trace.mergeError='synthetic post-persistence refresh exception';f.trace.errorPersistence={ok:true,canonicalVerified:true};
  const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();assert.equal(f.applyResult()?.state,'committed');assert.equal(f.applyResult()?.committed,true);assert.equal(f.trace.persistenceCalls,1);assert.equal(f.trace.mergeCalls,1);
 });
 await test('whole conversation mode stays separate from default latest owned turn mode',async f=>{
  await f.click('#btn-health-repair-preview');const selection=f.trace.calls.findLast(call=>call.method==='preview'&&call.kind==='refresh_derived_cache').args[1];
  for(const mode of [undefined,'latest_owned_turn']){
   const ticket=await f.dispatcher().preview('explicit_reanalysis',{...selection,...(mode?{mode}:{}),canonicalMemoryId:'unowned-fixture-memory'});
   assert.equal(ticket.allowed,false);assert.equal(f.dialog(),null);f.assertNoEffects();
  }
 });
 await test('forged whole conversation public tickets cannot reach the historical owner',async f=>{
  const ticket=await f.preview();assert.equal(ticket.allowed,true);const before=f.trace.adapters.filter(call=>call.method==='apply').length;
  for(const candidate of [null,{}, {...ticket},Object.create(ticket),{allowed:true,actionKind:'explicit_reanalysis',mode:'whole_conversation_merge'}])assert.equal((await f.dispatcher().apply(candidate)).status,'blocked');
  assert.equal(f.trace.adapters.filter(call=>call.method==='apply').length,before);assert.equal(f.dialog(),null);f.assertNoEffects();
 });
 await test('selection change in merge preflight rejects before the mutation callback',async f=>{
  f.trace.onStage=async stage=>{if(stage==='merge-entry')f.mutate('source-last');};const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();
  assert.equal(f.applyResult()?.writeIssued,false);assert.notEqual(f.applyResult()?.state,'committed');assert.equal(f.trace.mergeCalls,1);assert.equal(f.trace.mutationStarted,0);assert.equal(f.trace.persistenceCalls,0);
 });
 await test('post-mutation source change with unavailable persistence remains uncertain',async f=>{
  f.trace.onStage=async stage=>{if(stage==='mutation')f.mutate('source-last');};f.trace.receipt={ok:false,canonicalVerified:false};
  const operation=f.start();await f.resolveDialog(true);await operation;await f.flush();assert.equal(f.applyResult()?.state,'uncertain');assert.notEqual(f.applyResult()?.writeIssued,false);assert.equal(f.trace.mutationStarted,1);assert.equal(f.trace.persistenceCalls,1);
 });
 await test('shared busy latch blocks derived-cache apply while historical analysis is pending',async f=>{
  await f.click('#btn-health-repair-preview');const cacheTicket=f.trace.calls.findLast(call=>call.method==='preview'&&call.kind==='refresh_derived_cache').result;
  let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);f.trace.onStage=async stage=>{if(stage==='chunk'){started();await gate;}};
  const operation=f.start();await f.resolveDialog(true);await entered;
  try{assert.equal((await f.dispatcher().apply(cacheTicket)).status,'blocked');const denied=await f.dispatcher().preview('refresh_derived_cache',{});assert.equal(denied.allowed,false);assert.equal(denied.reason,'operation_in_progress');assert.equal(f.trace.adapters.filter(call=>call.method==='apply'&&call.kind==='refresh_derived_cache').length,0);}
  finally{release();await operation;await f.flush();}
  assert.equal(f.applyResult()?.state,'committed');assert.equal(f.trace.persistenceCalls,1);
 });


 for(const mutation of ['source-last','close'])await test('between-model guard stops synthesis after pending chunk on '+mutation,async f=>{
  let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  f.trace.onStage=async stage=>{if(stage==='chunk'){started();await gate;}};
  const operation=f.start();await f.resolveDialog(true);await entered;assert.equal(f.trace.modelCalls,1);f.mutate(mutation);release();await operation;await f.flush();
  assert.equal(f.trace.stages.filter(stage=>stage.kind==='synthesis').length,0,'invalidated analysis must not dispatch the next synthesis model');
  assert.equal(f.trace.modelCalls,1,'only the already-dispatched chunk is allowed');assert.equal(f.applyResult()?.writeIssued,false);assert.equal(f.trace.mergeCalls,0);assert.equal(f.trace.persistenceCalls,0);assert.equal(f.trace.mutationStarted,0);assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);
 });
 await test('between-model guard stops queued chunks after in-flight source invalidation',async f=>{
  const messages=Array.from({length:520},(_,index)=>({role:index%2?'char':'user',data:index%2?'Mira recorded historical event '+index+'.':'Continue historical event '+index+'.',chatId:'historical-'+index}));
  f.control.chat.msgs=messages;f.control.chat.message=clone(messages);
  let release,started;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  f.trace.onStage=async stage=>{if(stage==='chunk'){started();await gate;}};
  const operation=f.start();await f.resolveDialog(true);await entered;await delay(20);const admitted=f.trace.modelCalls;assert(admitted>0&&admitted<13,'real bounded pool leaves historical chunks queued');
  f.mutate('source-last');release();await operation;await f.flush();
  assert.equal(f.trace.stages.filter(stage=>stage.kind==='chunk').length,admitted,'queued chunks must not start new model work after selection invalidation');
  assert.equal(f.trace.stages.filter(stage=>stage.kind==='synthesis').length,0);assert.equal(f.trace.modelCalls,admitted);assert.equal(f.applyResult()?.writeIssued,false);assert.equal(f.trace.mergeCalls,0);assert.equal(f.trace.persistenceCalls,0);assert.equal(f.trace.mutationStarted,0);assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);
 });

 await test('isolated real preflight helper rejects guardfalse before raw model dispatch',async f=>{
  let rawModels=0;f.api.LLMProvider.call=async()=>{rawModels++;return {content:'{}'};};
  const [outcome]=await Promise.allSettled([f.api.ColdStartManager.__testHistoricalHelpers.preflight({config:f.api.MemoryEngine.CONFIG,system:'Synthetic helper test',user:'Mira records an event.',isCurrent:async()=>false})]);
  assert.equal(rawModels,0);assert.equal(outcome.status,'rejected');assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);
 });
 for(const shape of ['direct','layered'])await test('isolated real '+shape+' synthesis stops guardfalse before model or retry',async f=>{
  let rawModels=0;const record=async()=>{rawModels++;return {content:'{}'};};f.api.LLMProvider.call=record;f.trace.onStage=async stage=>{if(stage==='chunk')await record();};
  const summaries=Array.from({length:shape==='direct'?1:14},(_,index)=>({events:['Mira records grounded event '+index+'.'],characters:[],relationships:[],world_rules:[]}));
  const [outcome]=await Promise.allSettled([f.api.ColdStartManager.__testHistoricalHelpers.synthesis(summaries,'cold-reanalysis',{isCurrent:async()=>false})]);
  assert.equal(rawModels,0);assert.equal(outcome.status,'rejected');assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);
 });
 for(const shape of ['direct','layered'])await test('isolated real '+shape+' synthesis suppresses fallback model after invalidation',async f=>{
  let rawModels=0,current=true;const fail=async()=>{rawModels++;current=false;throw new Error('synthetic first-model failure');};f.api.LLMProvider.call=fail;f.trace.onStage=async stage=>{if(stage==='chunk')await fail();};
  const summaries=Array.from({length:shape==='direct'?1:14},(_,index)=>({events:['Mira records grounded event '+index+'.'],characters:[],relationships:[],world_rules:[]}));
  const [outcome]=await Promise.allSettled([f.api.ColdStartManager.__testHistoricalHelpers.synthesis(summaries,'cold-reanalysis',{isCurrent:async()=>current})]);
  assert.equal(rawModels,1,'only the first already-dispatched model may run');assert.equal(outcome.status,'rejected');assert.equal(f.calls.writes.length,0);assert.equal(f.calls.hostWrites.length,0);
 });

 await test('monotonic selection latch rejects an older expected read after concurrent invalidation',async f=>{
  const expectedRaw=f.store.get(f.key),context={chat:clone(f.control.chat),char:clone(f.control.char)};
  const proof={binding:{scopeKey:'synthetic-existing-binding'},expectedRaw,configBytes:JSON.stringify(f.api.MemoryEngine.CONFIG),source:f.api.ColdStartManager.snapshotHistoricalSource(context.chat)};
  let release,started,reads=0;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const owner={read:async()=>{reads++;if(reads===1){started();await gate;return {raw:expectedRaw,context};}return {raw:expectedRaw+' ',context};}};
  // Extract the exact emitted adapter helper; fake only its owner-read dependency.
  const factory=new Function('proof','current','MemoryEngine','ManagementReviewCore','ColdStartManager','let selectionInvalidated=false; return ('+readSelectedSource+');');
  const readSelected=factory(proof,()=>true,f.api.MemoryEngine,owner,f.api.ColdStartManager);
  const older=readSelected();await entered;const changed=await readSelected();assert.equal(changed,null,'newer mismatched canonical root invalidates selection');release();
  assert.equal(await older,null,'older expected snapshot cannot revive an invalidated selection after its await');
  assert.equal(await readSelected(),null,'the invalidation latch remains monotonic');assert.equal(reads,2,'later calls stop before another owner read');f.assertNoEffects();
 });
 const report={testSourceSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),artifact,sha256:crypto.createHash('sha256').update(source).digest('hex'),passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,mockOnly:true,realEmittedDom:true,scope:'Historical GUI/dispatcher and existing historical method with fake analysis/merge/persistence. Ordinary host mirror and historical engine correctness remain unverified.',checks};
 if(process.env.LIBRA_HISTORICAL_DISPATCH_REPORT){fs.mkdirSync(path.dirname(process.env.LIBRA_HISTORICAL_DISPATCH_REPORT),{recursive:true});fs.writeFileSync(process.env.LIBRA_HISTORICAL_DISPATCH_REPORT,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
