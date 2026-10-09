'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const clone=x=>JSON.parse(JSON.stringify(x));
const runtimeKey='fixture-char::0::fixture-chat::::';
const canonical='char:fixture-char|chat:fixture-chat|persona:persona-a';
const review={key:'q-state',comment:'lmai_analysis_quarantine',content:JSON.stringify({schema:'libra.analysis_quarantine.v1',entries:[{id:'q1',status:'blocked',domain:'entity',reason:'review_required',payload:{success:true,entities:[{name:'Mira',background:{occupation:'Archivist'}}],conversationText:'Mira is an archivist.'}}]})};
async function loadGui(options={}){
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://wm-fixture.invalid/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});
 const w=dom.window,store=options.store||new Map(),pending=[],calls={writes:[],hostWrites:[]},callbacks={};
 const replayAdmissions=[];
 try {
 const defaultChat={id:'fixture-chat',bindedPersona:options.unbound?undefined:'persona-a',localLore:[],message:[],msgs:[],isStreaming:false};
 const char=options.character?clone(options.character):{id:'fixture-char',name:'Fixture',chatPage:0,chats:[defaultChat],globalLore:[],lorebook:[]};
 const chat=char.chats[Number(char.chatPage||0)];
 const control={chat,char,failReads:false,rejectWrites:false,selectedPersona:0,afterSet:null};
 const add=w.EventTarget.prototype.addEventListener;
 w.EventTarget.prototype.addEventListener=function(type,listener,opts){return add.call(this,type,typeof listener==='function'?function(...args){const result=listener.apply(this,args);if(result&&typeof result.then==='function')pending.push(result);return result}:listener,opts)};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.fetch=options.fetch||(async()=>{throw new Error('fixture forbids external fetch')});w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.AbortController=AbortController;if(options.observeManualStorage)Object.defineProperty(w,'crypto',{value:require('node:crypto').webcrypto});
 const R={
  async getArgument(key){return Object.prototype.hasOwnProperty.call(options.args||{},key)?options.args[key]:({use_llm:'false',embedding_enabled:'false',activity_dashboard:'off',cbs_enabled:'false'})[key]},
  async nativeFetch(url,init){if(options.nativeFetch)return options.nativeFetch(url,init);throw new Error('fixture forbids provider transport')},
  async getLocalPluginStorage(){return options.localStore?{getItem:async k=>options.localStore.get(k)??null,setItem:async(k,v)=>{options.localStore.set(k,String(v));return true;},removeItem:async k=>options.localStore.delete(k),keys:async()=>[...options.localStore.keys()]}:R.pluginStorage},
  async requestPluginPermission(){return true},async getCharacter(){return clone(control.char)},async getCurrentCharacterIndex(){return 0},async getCurrentChatIndex(){return 0},
  async getCharacterFromIndex(){return clone(control.char)},async getChatFromIndex(){const snapshot=clone(control.chat);if(control.afterChatRead)await control.afterChatRead();return snapshot},
  async getDatabase(){return {selectedPersona:control.selectedPersona,personas:[{id:'persona-a',name:'A'},{id:'persona-b',name:'B'}],characters:[clone(control.char)]}},
  async setChatToIndex(ci,ti,value){calls.hostWrites.push(clone(value));if(control.rejectHostWrites)return false;control.chat=clone(value);control.char.chats[0]=control.chat;return true},
  async setCharacter(value){control.char=clone(value);control.chat=control.char.chats[0];return true},async setCharacterToIndex(_,value){return this.setCharacter(value)},
  async registerSetting(name,fn){callbacks.setting=fn},async registerButton(){},async showContainer(){},async hideContainer(){},
  async addRisuReplacer(type,fn){callbacks[type]=fn},async removeRisuReplacer(){},async addRisuScriptHandler(){},async removeRisuScriptHandler(){},async onUnload(fn){(callbacks.unload ||= []).push(fn)},async confirm(){return options.confirm===true},
  pluginStorage:{async keys(){return [...store.keys()]},async getItem(key){if(control.failReads&&key.startsWith('LIBRA_DATA::'))throw new Error('synthetic canonical read failure');const value=store.get(key)??null;if(control.afterRead&&key.startsWith('LIBRA_DATA::'))await control.afterRead(key,value);return value},
   async setItem(key,value){calls.writes.push({key,value});if(control.rejectWrites&&key.startsWith('LIBRA_DATA::'))return false;store.set(key,String(value));if(control.afterSet&&key.startsWith('LIBRA_DATA::'))await control.afterSet(key,value);return true},async removeItem(key){store.delete(key);return true}}
 };
 w.risuai=R;w.Risuai=R;
 let code=fs.readFileSync(process.env.LIBRA_GUI_TEST_DIST || path.join(__dirname,'../dist/LIBRA World Manager Full.js'),'utf8');const end=code.lastIndexOf('})();');assert(end>=0,'artifact closing IIFE found');
 code=code.slice(0,end)+';\nglobalThis.__WM_GUI_TEST__={MemoryEngine,MemoryState,LibraDataStorage,ManagementReviewCore,EntityManager,TimeEngine,EntityCandidateCore,HierarchicalWorldManager,ActivityDashboardCore,LibraTurnWorldline,IntegrityMetaManager,EntityAwareProcessor,TransitionManager,ScopedRuntimeTransaction,NarrativeTracker,StoryAuthor,Director,WorldAdditionalCore,UserDlcCore,CharacterStateTracker,WorldStateTracker,SecretKnowledgeCore,EntityKnowledgeVaultCore,SectionWorldInferenceManager,reloadChatScopedRuntime,rememberScopedRuntimeState,getChatRuntimeScopeKey,TypedRecallRollout,stripSettingsSecrets,TypedRecallCorpus,SemanticRecallJobs,SemanticRecallIndex,persistLoreToActiveChat,PersonaRuntimeCoordinator};\n'+(options.observeCommonAnalysis?';globalThis.__WM_GUI_ANALYSIS__={resolveCommonAnalysisPreset,LLMProvider};\n':'')+code.slice(end);
 if(options.observeManualStorage)code=code.slice(0,code.lastIndexOf('})();'))+';globalThis.__WM_MANUAL_TEST__={manual:WmManualRuntime,connection:WmConnectionRuntime,compat:RisuCompat,ledger:DurableTurnLedger,cold:ColdArchiveManager,journal:IntegratedAnalysisJournal,history:WmExtensionHistory};\n'+code.slice(code.lastIndexOf('})();'));
 if(options.observeReplayAdmission){const anchor='const admission = classifyWmAnalysisAdmission(record, null, replayAdmissionContext());';assert.equal(code.split(anchor).length,2,'unique actual durable replay admission call');w.__WM_REPLAY_OBSERVER__=value=>replayAdmissions.push(clone(value));code=code.replace(anchor,anchor+'globalThis.__WM_REPLAY_OBSERVER__({recordKey:record.recordKey,resetGeneration:record.resetGeneration,expectedResetGeneration:targetContext.resetGeneration,kind:admission.kind,reason:admission.reason});');}
 await w.eval(code);await new Promise(resolve=>setTimeout(resolve,30));
 const api=w.__WM_GUI_TEST__;assert(api&&callbacks.setting,'full plugin registered its actual setting callback');
 const scope=options.unbound&&!options.nativeInitialization?'char:fixture-char|chat:fixture-chat|persona:default':canonical;
 const key=api.LibraDataStorage.storageKeyFor(scope);
 if(!options.nativeInitialization){
 if(!options.store)store.set(key,JSON.stringify({version:'1.0',scopeKey:scope,entries:[review]}));
 api.MemoryState._activeScopeKey=api.getChatRuntimeScopeKey(control.chat,control.char);api.MemoryState._activeChatId='fixture-chat';
 if(options.beforeHydrate)await options.beforeHydrate({api,store,control,key});
 await api.LibraDataStorage.hydrate(control.char,control.chat,{runtimeScopeKey:api.getChatRuntimeScopeKey(control.chat,control.char),runtimeChatId:'fixture-chat'});
 }else{const deadline=Date.now()+5000;while(!api.MemoryState.isInitialized&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert(api.MemoryState.isInitialized,'native plugin initialization completed')}
 if(options.hostLore){control.chat.localLore=clone(options.hostLore);control.char.chats[0]=control.chat;}
 if(options.failInitialRead)control.failReads=true;
 calls.writes.length=0;calls.hostWrites.length=0;
 await callbacks.setting();
 await Promise.allSettled(pending.splice(0));
 const overlay=w.document.querySelector('#lmai-overlay');assert(overlay,'registered setting callback opened GUI');
 calls.openWrites=clone(calls.writes);calls.openHostWrites=clone(calls.hostWrites);
 calls.writes.length=0;calls.hostWrites.length=0;
 const click=async(selector)=>{const node=typeof selector==='string'?overlay.querySelector(selector):selector;assert(node,'registered GUI control exists');node.click();await Promise.allSettled(pending.splice(0));};
 return {dom,w,api,replayAdmissions,manual:w.__WM_MANUAL_TEST__,common:w.__WM_GUI_ANALYSIS__,store,key,control,calls,callbacks,overlay,pending,click,close:()=>w.close(),canonicalPayload:()=>JSON.parse(store.get(key))};
 } catch(error) { w.close(); throw error; }
}
module.exports={loadGui,canonical,runtimeKey,review};
const checks=[];async function test(name,fn,options={}){if(process.env.LIBRA_GUI_TEST_FILTER&&!new RegExp(process.env.LIBRA_GUI_TEST_FILTER).test(name))return;console.log("CASE_START",name);let f;try{f=await loadGui(options);await fn(f);checks.push({name,ok:true})}catch(e){checks.push({name,ok:false,error:e.stack||e.message});process.exitCode=1}finally{f?.close()}}
if(require.main===module)(async()=>{
 await test('registered health refresh shows stale canonical read failure rather than healthy empty',async f=>{
  assert.equal(f.overlay.querySelector('#health-summary').dataset.readState,'current');f.control.failReads=true;await f.click('#btn-health-refresh');
  assert.equal(f.overlay.querySelector('#health-summary').dataset.readState,'stale');assert.match(f.overlay.querySelector('#health-summary').textContent,/확인|이전/);
 });
 await test('registered quarantine accept confirms canonical persistence and entity result',async f=>{
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  const entries=f.canonicalPayload().entries;assert(entries.some(e=>e.comment==='lmai_entity'));
  assert.equal(JSON.parse(entries.find(e=>e.comment==='lmai_analysis_quarantine').content).entries[0].status,'accepted');
 });
 await test('write failure does not mark canonical review accepted or show merge success',async f=>{
  f.control.rejectWrites=true;await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  assert.equal(JSON.parse(f.canonicalPayload().entries.find(e=>e.comment==='lmai_analysis_quarantine').content).entries[0].status,'blocked');
  assert(!f.w.document.body.textContent.includes('검역 항목 승인 병합 완료'));
 });
 await test('persona switch after GUI open blocks old handler before any write',async f=>{
  f.control.chat.bindedPersona='persona-b';f.control.char.chats[0]=f.control.chat;
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');assert.equal(f.calls.writes.filter(x=>x.key.startsWith('LIBRA_DATA::')).length,0);
 });
 await test('initial canonical read failure is visible and cannot look like healthy empty',async f=>{
  const summary=f.overlay.querySelector('#health-summary');assert.equal(summary.dataset.readState,'unavailable');assert.match(summary.textContent,/확인할 수 없|확인 불가/);assert(!summary.textContent.includes('정상'));
 },{failInitialRead:true});
 await test('unbound persona mismatch preserves legacy bytes and explains migration',async f=>{
  const before=f.store.get(f.key);assert.match(f.overlay.querySelector('#health-summary').textContent,/기존 데이터는 보존.*페르소나/);
  await f.click('#btn-health-scan');assert.equal(f.store.get(f.key),before);assert.equal(f.calls.writes.filter(x=>x.key.startsWith('LIBRA_DATA::')).length,0);
  assert.equal(f.store.has(f.api.LibraDataStorage.storageKeyFor(canonical)),false);
 },{unbound:true});
 await test('confirmed acceptance survives a fresh full plugin runtime and registered GUI reopen',async f=>{
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');const fresh=await loadGui({store:f.store});
  try{assert.equal(fresh.overlay.querySelector('#health-summary').dataset.readState,'current');assert(fresh.canonicalPayload().entries.some(x=>x.comment==='lmai_entity'));assert(fresh.overlay.querySelector('#health-quarantine-list').textContent.includes('accepted'))}finally{fresh.close()}
 });
 await test('failed acceptance remains blocked in a fresh runtime on the same backing store',async f=>{
  f.control.rejectWrites=true;await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');const fresh=await loadGui({store:f.store});
  try{assert.equal(JSON.parse(fresh.canonicalPayload().entries.find(x=>x.comment==='lmai_analysis_quarantine').content).entries[0].status,'blocked');assert(!fresh.canonicalPayload().entries.some(x=>x.comment==='lmai_entity'))}finally{fresh.close()}
 });
 await test('two immediate clicks produce one canonical commit',async f=>{
  const button=f.overlay.querySelector('[data-health-action="quarantine-accept"][data-health-id="q1"]');button.click();button.click();await Promise.allSettled(f.pending.splice(0));
  assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,1);
 });
 await test('dismissal during durable write suppresses later UI/cache publication without compensation',async f=>{
  let release,start;const gate=new Promise(r=>release=r),started=new Promise(r=>start=r);f.control.afterSet=async()=>{start();await gate};
  const before=JSON.stringify([...f.api.EntityManager.getEntityCache()]);f.overlay.querySelector('[data-health-action="quarantine-accept"][data-health-id="q1"]').click();await started;
  f.overlay.querySelector('#xbtn').click();release();await Promise.allSettled(f.pending.splice(0));
  assert.equal(f.overlay.isConnected,false);assert.equal(JSON.stringify([...f.api.EntityManager.getEntityCache()]),before);assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,1);
  assert(!f.w.document.body.textContent.includes('검역 항목 승인 병합 완료'));assert.equal(f.calls.hostWrites.length,0);
 });
 for(const when of ['write','readback'])await test(`persona transition during ${when} preserves new runtime state and blocks old publication`,async f=>{
  const transition=()=>{f.control.chat.bindedPersona='persona-b';f.control.char.chats[0]=f.control.chat;f.api.EntityManager.rebuildCache([{key:'new-persona',comment:'lmai_entity',content:JSON.stringify({name:'Nova Reed',id:'nova',meta:{created:1,updated:1}})}]);f.api.TimeEngine.resetState({notes:'new persona'})};
  if(when==='write')f.control.afterSet=async()=>transition();
  else{f.control.afterSet=async()=>{f.control.armRead=true};f.control.afterRead=async()=>{if(f.control.armRead){f.control.armRead=false;transition()}}}
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  assert(f.api.EntityManager.getEntityCache().has('Nova Reed'));assert(!f.api.EntityManager.getEntityCache().has('Mira'));assert.equal(f.api.TimeEngine.getState().notes,'new persona');assert.equal(f.calls.hostWrites.length,0);
  assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,1);assert(!f.w.document.body.textContent.includes('검역 항목 승인 병합 완료'));
 });
 await test('deleted review id does not produce success or a replacement write',async f=>{
  f.store.set(f.key,JSON.stringify({version:'1.0',scopeKey:canonical,entries:[]}));await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,0);assert(!f.w.document.body.textContent.includes('검역 항목 승인 병합 완료'));
 });
 for(const action of ['ignore','resolve'])await test(`registered ${action} persists canonical review state`,async f=>{
  await f.click(`[data-health-action="quarantine-${action}"][data-health-id="q1"]`);assert.equal(JSON.parse(f.canonicalPayload().entries.find(x=>x.comment==='lmai_analysis_quarantine').content).entries[0].status,action==='ignore'?'ignored':'resolved');
 });
 await test('late failed refresh cannot overwrite a newer successful canonical read',async f=>{
  let reject,start;const gate=new Promise((_,r)=>reject=r),started=new Promise(r=>start=r);let held=false;
  f.control.afterRead=async()=>{if(!held){held=true;start();await gate}};
  f.overlay.querySelector('#btn-health-refresh').click();const first=f.pending.splice(0);await started;
  f.control.afterRead=null;await f.click('#btn-health-refresh');assert.equal(f.overlay.querySelector('#health-summary').dataset.readState,'current');
  reject(new Error('late old read failure'));await Promise.allSettled(first);assert.equal(f.overlay.querySelector('#health-summary').dataset.readState,'current');
 });
 await test('canonical acceptance preserves all host lore including unrelated managed rows and messages',async f=>{
  const native={key:'native',comment:'user-entry',content:'Preserved native text'};
  f.control.chat.localLore=[native,review];f.control.chat.message=[{role:'user',data:'Newest message'}];f.control.char.chats[0]=f.control.chat;
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  assert.deepEqual(f.control.chat.localLore,[native,review]);assert.deepEqual(f.control.chat.message,[{role:'user',data:'Newest message'}]);assert.equal(f.calls.hostWrites.length,0);
 });
 await test('canonical management does not call unavailable host writers or perform unrelated cleanup',async f=>{
  f.control.chat.localLore=[review];f.control.char.chats[0]=f.control.chat;f.control.rejectHostWrites=true;
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  assert.equal(JSON.parse(f.canonicalPayload().entries.find(x=>x.comment==='lmai_analysis_quarantine').content).entries[0].status,'accepted');
  assert.equal(f.calls.hostWrites.length,0);assert.deepEqual(f.control.chat.localLore,[review]);
 });
 for(const invalid of ['zero_applied','schema_invalid'])await test(`registered accept refuses ${invalid} without canonical writes`,async f=>{
  const payload=f.canonicalPayload();const state=JSON.parse(payload.entries[0].content);
  state.entries[0].payload=invalid==='zero_applied'?{success:true,world:{irrelevant:'value'}}:{success:true,schemaInvalid:true,entities:[{name:'Mira'}]};
  payload.entries[0].content=JSON.stringify(state);const before=JSON.stringify(payload);f.store.set(f.key,before);
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,0);assert.equal(f.store.get(f.key),before);assert(!f.w.document.body.textContent.includes('검역 항목 승인 병합 완료'));
 });
 await test('canonical read failure disables destructive review controls while keeping refresh available',async f=>{
  f.control.failReads=true;await f.click('#btn-health-refresh');assert([...f.overlay.querySelectorAll('[data-health-id]')].every(node=>node.disabled));assert(!f.overlay.querySelector('#btn-health-refresh').disabled);
 });
 await test('old persona view cannot replace the newly active dashboard health state',async f=>{
  f.control.chat.bindedPersona='persona-b';f.control.char.chats[0]=f.control.chat;
  f.api.ActivityDashboardCore.updateHealthSummary({}, {total:77,message:'new persona health',severity:'warn'});
  await f.click('#btn-health-refresh');assert.equal(f.api.ActivityDashboardCore.getState().healthSummary.total,77);
 });
 for(const options of [{unbound:true},{failInitialRead:true}])await test(`opening a readonly health view performs no writes ${JSON.stringify(options)}`,async f=>{
  assert.equal(f.calls.openWrites.filter(x=>x.key.startsWith('LIBRA_DATA::')).length,0);assert.equal(f.calls.openHostWrites.length,0);
  assert(f.control.chat.localLore.some(x=>x.key==='host-only'));
 },{...options,hostLore:[{key:'host-only',comment:'lmai_memory',content:'[META:{"t":1}] preserved host-only memory'}]});
 await test('concurrent host message survives canonical management without stale whole-chat overwrite',async f=>{
  f.control.chat.localLore=[review];f.control.chat.message=[{role:'user',data:'Before'}];f.control.char.chats[0]=f.control.chat;
  let wrote=false,armed=false,count=0;f.control.afterSet=async()=>{wrote=true};
  f.control.afterRead=async()=>{if(wrote&&!armed){armed=true;count=0}};
  f.control.afterChatRead=async()=>{if(armed&&++count===2)f.control.chat.message.push({role:'assistant',data:'Concurrent newest message'})};
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  assert(f.control.chat.message.some(x=>x.data==='Concurrent newest message'));assert.equal(f.calls.hostWrites.length,0);
 });
 for(const change of ['reroll','rollback'])await test(`same-chat ${change} during write prevents stale publication`,async f=>{
  const wl=f.api.LibraTurnWorldline;const pair=(n,a,id='a'+n)=>({pairIndex:n,userText:'u'+n,assistantText:a,userMessageId:'u'+n,assistantMessageId:id});
  const proof={explicitReanalysis:true,sourceVerified:true};
  await wl.observe(canonical,[pair(1,'a1'),pair(2,'a2')],proof);const before=wl.get(canonical).revision;
  // An independent writer can change durable lineage while this runtime's canonical write is in flight.
  // Re-entering this same runtime's serial writer from its awaited backend callback deadlocks the fixture.
  const other=await loadGui({store:f.store});
  try {
    f.control.afterSet=async()=>{
      await other.api.LibraTurnWorldline.observe(canonical,change==='reroll'?[pair(1,'a1 changed','accepted-reroll-a1'),pair(2,'a2')]:[pair(1,'a1')],proof);
      await wl.load(canonical); // owner observes the independent durable revision before publication
      f.api.TimeEngine.resetState({notes:'new worldline state'});
    };
    await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
    assert(wl.get(canonical).revision>before);assert.equal(f.api.TimeEngine.getState().notes,'new worldline state');assert(!f.w.document.body.textContent.includes('검역 항목 승인 병합 완료'));
  } finally { f.control.afterSet=null;other.close(); }
 });
 await test('accepted canonical entity is consumed by the live entity cache',async f=>{
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  const raw=JSON.parse(f.canonicalPayload().entries.find(x=>x.comment==='lmai_entity').content);
  assert.equal(f.api.IntegrityMetaManager.validateIntegrityMeta(raw,{domain:'entity',recordId:raw.name,scopeKey:f.api.MemoryState._activeScopeKey}).ok,true);
  assert(f.api.EntityManager.getEntityCache().has('Mira'));
  assert(f.api.EntityAwareProcessor.formatStoredInfoForExtraction(8,{conversationText:'Mira',focusNames:['Mira']}).includes('Mira'));
  assert(f.api.EntityManager.formatEntityForPrompt(f.api.EntityManager.getEntityCache().get('Mira')).includes('Archivist'));
 });
 await test('accepted entity remains consumable after full runtime restart',async f=>{
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');const fresh=await loadGui({store:f.store});
  try{assert(fresh.api.EntityManager.getEntityCache().has('Mira'));assert(fresh.api.EntityAwareProcessor.formatStoredInfoForExtraction(8,{conversationText:'Mira',focusNames:['Mira']}).includes('Mira'))}finally{fresh.close()}
 });
 for(const invalid of ['tampered','wrong_scope'])await test(`consumer continues rejecting ${invalid} canonical entity without rewriting bytes`,async f=>{
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');const payload=f.canonicalPayload(),row=payload.entries.find(x=>x.comment==='lmai_entity'),entity=JSON.parse(row.content);
  if(invalid==='tampered')entity.background.occupation='Tampered value';
  else f.api.IntegrityMetaManager.applyIntegrityMeta(entity,{domain:'entity',recordSchema:'libra.entity.record.v1',recordId:entity.name,scopeKey:'another-runtime',turn:0,source:'fixture'});
  row.content=JSON.stringify(entity);const before=JSON.stringify(payload);f.store.set(f.key,before);const fresh=await loadGui({store:f.store});
  try{assert(!fresh.api.EntityManager.getEntityCache().has('Mira'));assert(!fresh.api.EntityAwareProcessor.formatStoredInfoForExtraction(8,{conversationText:'Mira',focusNames:['Mira']}).includes('Mira'));assert.equal(f.store.get(f.key),before);
   const summary=fresh.overlay.querySelector('#health-summary');assert.equal(summary.dataset.readState,'unavailable');assert.match(summary.textContent,/기존 데이터는 보존.*소유 범위 또는 무결성.*읽기 전용/);
   await fresh.click('#btn-health-scan');assert.equal(f.store.get(f.key),before);assert.equal(fresh.calls.writes.filter(x=>x.key===f.key).length,0);
  }finally{fresh.close()}
 });
 await test('unrelated review acceptance refuses mixed foreign canonical data without pruning it',async f=>{
  const payload=f.canonicalPayload();const entity={id:'foreign',name:'Foreign Vale',background:{occupation:'Keeper'},meta:{created:1,updated:1}};
  f.api.IntegrityMetaManager.applyIntegrityMeta(entity,{domain:'entity',recordId:entity.name,scopeKey:'another-runtime',turn:1});
  const foreign={key:'foreign',comment:'lmai_entity',content:JSON.stringify(entity)};payload.entries.push(foreign);const before=JSON.stringify(payload);f.store.set(f.key,before);
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  assert.equal(f.store.get(f.key),before);assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,0);
  assert.match(f.overlay.querySelector('#health-summary').textContent,/기존 데이터는 보존.*읽기 전용/);
  assert(!f.w.document.body.textContent.includes('검역 항목 승인 병합 완료'));
  const fresh=await loadGui({store:f.store});try{assert.equal(f.store.get(f.key),before);assert(!fresh.api.EntityManager.getEntityCache().has('Foreign Vale'));assert.equal(JSON.parse(fresh.canonicalPayload().entries.find(x=>x.comment==='lmai_analysis_quarantine').content).entries[0].status,'blocked')}finally{fresh.close()}
 });
 for(const partial of [false,true])await test(`registered read-only scan preserves canonical bytes and reports ${partial?'partial':'complete'} truthfully`,async f=>{
  if(partial){const payload=f.canonicalPayload();payload.entries.push(...Array.from({length:321},(_,i)=>({key:'scan-'+i,comment:'lmai_entity',content:JSON.stringify({id:'scan-'+i,name:'Person '+i,meta:{created:1,updated:1}})})));f.store.set(f.key,JSON.stringify(payload))}
  const before=f.store.get(f.key);await f.click('#btn-health-scan');assert.equal(f.store.get(f.key),before);
  assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,0);
  const text=f.overlay.querySelector('#health-recovery-status').textContent;
  assert(text.includes(partial?'읽기 전용 검사 일부 완료':'읽기 전용 검사 완료'));
  if(partial)assert(text.includes('정상으로 확정하지 않습니다'));
 });
 for(const category of ['integrity','conflict'])for(const action of ['ignore','resolve'])await test(`registered ${category} ${action} persists the selected finding`,async f=>{
  const payload=f.canonicalPayload();payload.entries.push({key:'integrity',comment:'lmai_integrity_scan',content:JSON.stringify({schema:'libra.integrity_scan.v1',findings:[{id:'f1',type:'duplicate_entity',status:'open',severity:'warn',reason:'fixture'}]})});f.store.set(f.key,JSON.stringify(payload));
  await f.click('#btn-health-refresh');await f.click(`[data-health-action="${category}-${action}"][data-health-id="${category==='conflict'?'integrity:':''}f1"]`);
  assert.equal(JSON.parse(f.canonicalPayload().entries.find(x=>x.comment==='lmai_integrity_scan').content).findings[0].status,action==='ignore'?'ignored':'resolved');
 });
 await test('character and chat navigation during write preserves destination caches and host data',async f=>{
  f.control.afterSet=async()=>{f.control.chat={id:'destination',bindedPersona:'persona-a',localLore:[],message:[{role:'user',data:'New destination'}]};f.control.char={id:'other-character',chatPage:0,chats:[f.control.chat]};f.api.MemoryState._activeScopeKey=f.api.getChatRuntimeScopeKey(f.control.chat,f.control.char);f.api.MemoryState._activeChatId='destination';f.api.TimeEngine.resetState({notes:'destination state'})};
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
  assert.equal(f.api.TimeEngine.getState().notes,'destination state');assert.equal(f.control.chat.message[0].data,'New destination');assert.equal(f.calls.hostWrites.length,0);assert(!f.w.document.body.textContent.includes('검역 항목 승인 병합 완료'));
 });
 await test('unverified branch source remains visibly readonly when child canonical storage is absent',async f=>{
  const before=f.store.get(f.control.branchParentKey);assert.equal(f.store.has(f.key),false);assert.equal(f.overlay.querySelector('#health-summary').dataset.readState,'unavailable');
  assert.match(f.overlay.querySelector('#health-summary').textContent,/기존 데이터는 보존.*읽기 전용/);
  await f.click('#btn-health-scan');assert.equal(f.store.has(f.key),false);assert.equal(f.store.get(f.control.branchParentKey),before);assert.equal(f.calls.writes.filter(x=>x.key===f.key).length,0);
 },{beforeHydrate:({api,store,control,key})=>{
  store.delete(key);const msgs=Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',data:'p'+i,chatId:'pm'+i,isComment:false,disabled:false}));
  const parent={id:'parent',bindedPersona:'persona-a',message:msgs,localLore:[]};control.chat.message=[...clone(msgs),{role:'assistant',data:'{{specialcomment::branchedfrom::parent::Parent::pm5::}}',chatId:'marker',isComment:true,disabled:true}];control.char.chats=[control.chat,parent];
  const ps=api.LibraDataStorage.scopeKeyFor(control.char,parent),entity={id:'foreign',name:'Foreign Vale',meta:{created:1,updated:1}};api.IntegrityMetaManager.applyIntegrityMeta(entity,{domain:'entity',scopeKey:'foreign-runtime',recordId:entity.name});
  control.branchParentKey=api.LibraDataStorage.storageKeyFor(ps);store.set(control.branchParentKey,JSON.stringify({scopeKey:ps,entries:[{key:'foreign',comment:'lmai_entity',content:JSON.stringify(entity)}]}));
 }});
 await test('registered review acceptance preserves inherited canonical envelope metadata after restart',async f=>{
  const metadata={inheritedFrom:'fixture-parent',hostWorldlineMeta:{parentWorldlineId:'parent-worldline',forkTurn:3,forkFingerprint:'known-prefix'},extension:{labels:['preserve']}};const payload={...f.canonicalPayload(),...metadata};f.store.set(f.key,JSON.stringify(payload));
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');for(const [key,value]of Object.entries(metadata))assert.deepEqual(f.canonicalPayload()[key],value);
  const fresh=await loadGui({store:f.store});try{for(const [key,value]of Object.entries(metadata))assert.deepEqual(fresh.canonicalPayload()[key],value);assert.equal(JSON.parse(fresh.canonicalPayload().entries.find(x=>x.comment==='lmai_analysis_quarantine').content).entries[0].status,'accepted')}finally{fresh.close()}
 });
 await test('valid stored entity still obeys the active name exclusion setting',async f=>{
  await f.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');const before=f.store.get(f.key);
  f.api.MemoryEngine.CONFIG.entityBlocklist=['Mira'];f.api.EntityManager.rebuildCache(f.canonicalPayload().entries);
  assert(!f.api.EntityManager.getEntityCache().has('Mira'));assert.equal(f.store.get(f.key),before);
 });
 console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,checks},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
