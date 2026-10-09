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
 const defaultChat={id:'fixture-chat',bindedPersona:options.unbound?undefined:'persona-a',localLore:[],message:[],msgs:[],isStreaming:false};
 const char=options.character?clone(options.character):{id:'fixture-char',name:'Fixture',chatPage:0,chats:[defaultChat],globalLore:[],lorebook:[]};
 const chat=char.chats[Number(char.chatPage||0)];
 const control={chat,char,failReads:false,rejectWrites:false,selectedPersona:0,afterSet:null};
 const add=w.EventTarget.prototype.addEventListener;
 w.EventTarget.prototype.addEventListener=function(type,listener,opts){return add.call(this,type,typeof listener==='function'?function(...args){const result=listener.apply(this,args);if(result&&typeof result.then==='function')pending.push(result);return result}:listener,opts)};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.fetch=async()=>{throw new Error('fixture forbids external fetch')};w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.AbortController=AbortController;
 const R={
  async getArgument(key){return Object.prototype.hasOwnProperty.call(options.args||{},key)?options.args[key]:({use_llm:'false',embedding_enabled:'false',activity_dashboard:'off',cbs_enabled:'false'})[key]},
  async nativeFetch(url,init){if(options.nativeFetch)return options.nativeFetch(url,init);throw new Error('fixture forbids provider transport')},
  async getLocalPluginStorage(){return R.pluginStorage},
  async requestPluginPermission(){return true},async getCharacter(){return clone(control.char)},async getCurrentCharacterIndex(){return 0},async getCurrentChatIndex(){return 0},
  async getCharacterFromIndex(){return clone(control.char)},async getChatFromIndex(){const snapshot=clone(control.chat);if(control.afterChatRead)await control.afterChatRead();return snapshot},
  async getDatabase(){return {selectedPersona:control.selectedPersona,personas:[{id:'persona-a',name:'A'},{id:'persona-b',name:'B'}],characters:[clone(control.char)]}},
  async setChatToIndex(ci,ti,value){calls.hostWrites.push(clone(value));if(control.rejectHostWrites)return false;control.chat=clone(value);control.char.chats[0]=control.chat;return true},
  async setCharacter(value){control.char=clone(value);control.chat=control.char.chats[0];return true},async setCharacterToIndex(_,value){return this.setCharacter(value)},
  async registerSetting(name,fn){callbacks.setting=fn},async registerButton(){},async showContainer(){},async hideContainer(){},
  async addRisuReplacer(type,fn){callbacks[type]=fn},async removeRisuReplacer(){},async addRisuScriptHandler(){},async removeRisuScriptHandler(){},async onUnload(fn){(callbacks.unload ||= []).push(fn)},async confirm(){return false},
  pluginStorage:{async getItem(key){if(control.failReads&&key.startsWith('LIBRA_DATA::'))throw new Error('synthetic canonical read failure');const value=store.get(key)??null;if(control.afterRead&&key.startsWith('LIBRA_DATA::'))await control.afterRead(key,value);return value},
   async setItem(key,value){calls.writes.push({key,value});if(control.rejectWrites&&key.startsWith('LIBRA_DATA::'))return false;store.set(key,String(value));if(control.afterSet&&key.startsWith('LIBRA_DATA::'))await control.afterSet(key,value);return true},async removeItem(key){store.delete(key);return true}}
 };
 w.risuai=R;w.Risuai=R;
 let code=fs.readFileSync(process.env.LIBRA_GUI_TEST_DIST || path.join(__dirname,'../dist/LIBRA World Manager Full.js'),'utf8');const end=code.lastIndexOf('})();');assert(end >= 0, 'artifact closing IIFE found');
 code=code.slice(0,end)+';\nglobalThis.__WM_GUI_TEST__={MemoryEngine,MemoryState,LibraDataStorage,ManagementReviewCore,EntityManager,TimeEngine,EntityCandidateCore,HierarchicalWorldManager,ActivityDashboardCore,LibraTurnWorldline,IntegrityMetaManager,EntityAwareProcessor,TransitionManager,ScopedRuntimeTransaction,NarrativeTracker,StoryAuthor,Director,WorldAdditionalCore,UserDlcCore,CharacterStateTracker,WorldStateTracker,SecretKnowledgeCore,EntityKnowledgeVaultCore,SectionWorldInferenceManager,reloadChatScopedRuntime,rememberScopedRuntimeState,getChatRuntimeScopeKey,TypedRecallRollout,stripSettingsSecrets,TypedRecallCorpus,SemanticRecallJobs,SemanticRecallIndex,persistLoreToActiveChat,PersonaRuntimeCoordinator,VersionedCanonicalBridge,WmReadonlyDerivedCache};\n'+code.slice(end);
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
 const preGuiConfig=clone(api.MemoryEngine.CONFIG);await callbacks.setting();
 await Promise.allSettled(pending.splice(0));
 const overlay=w.document.querySelector('#lmai-overlay');assert(overlay,'registered setting callback opened GUI');
 calls.openWrites=clone(calls.writes);calls.openHostWrites=clone(calls.hostWrites);
 calls.writes.length=0;calls.hostWrites.length=0;
 const click=async(selector)=>{const node=typeof selector==='string'?overlay.querySelector(selector):selector;assert(node,'registered GUI control exists');node.click();await Promise.allSettled(pending.splice(0));};
 return {preGuiConfig,dom,w,api,store,key,control,calls,callbacks,overlay,pending,click,close:()=>w.close(),canonicalPayload:()=>JSON.parse(store.get(key))};
}
module.exports={loadGui,canonical,runtimeKey,review};
