'use strict';
// Execute exact old/new release files; never expose _test or rewrite plugin bytes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const prior = process.env.RELEASE_PARITY_CONTROL_DIR;
const candidate = process.env.ULTRALIGHT_ARTIFACT_DIR;
const rows = [
  ['hayaku','HAYAKU_Locator_Continuity.js','HAYAKU'],
  ['flashback','Flashback_Memory.js','__FlashbackMemory'],
  ['libra','LIBRA.js','__LIBRA__'],
  ['lia','LIA_Persona_Linker.js','__lia_persona_linker_runtime_v1__'],
  ['retrace','RETRACE.js','__RETRACE']
];
const plain = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const start=Date.now();
  while (Date.now()-start<15000) {const value=predicate();if(value)return value;await sleep(10);}
  throw Error(`timed out waiting for ${label}`);
}
const libraTerminalStatus='\ucd5c\uc2e0 LIBRA \ub370\uc774\ud130\ub97c \ud655\uc778\ud588\uc2b5\ub2c8\ub2e4.';
const libraReceiptRetryText='\uc800\uc7a5 \ub2e4\uc2dc \ud655\uc778';
async function exercise(dir, [owner,file,globalName], options={}) {
  const source=fs.readFileSync(path.join(dir,file),'utf8');
  const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{url:'https://artifact.invalid/'});
  const values=new Map(), accesses=[], registrations=[], hooks=new Map(), listeners=new Map(), unload=[], timers=new Set(), intervals=new Set();
  let portalObserver;
  const store={async getItem(k){accesses.push(['read',String(k)]);return values.get(String(k))??null;},async setItem(k,v){accesses.push(['write',String(k)]);values.set(String(k),v);return true;},async removeItem(k){accesses.push(['remove',String(k)]);values.delete(String(k));return true;},async keys(){return [...values.keys()];}};
  const messages=[{role:'user',is_user:true,chatId:'u1',data:'Alice holds the blue prism.'},{role:'assistant',is_user:false,chatId:'a1',data:'Alice keeps the blue prism in the hall.'}];
  const chat={id:'release-parity-chat',chatId:'release-parity-chat',name:'Parity',message:messages,messages,bindedPersona:''};
  const character={id:'release-parity-character',chaId:'release-parity-character',name:'Parity',chatPage:0,chats:[chat]};
  const db={personas:[],selectedPersona:'',characters:[character],plugins:[]};
  let containers=0, networkCalls=0, modelCalls=0, portalPhase=false;
  const register=(kind,args)=>{const callback=args.find(v=>typeof v==='function');registrations.push({kind,callback,label:typeof args[0]==='string'?args[0]:args[0]?.name||'',id:args[0]?.id||args[4]||''});return true;};
  const host={pluginStorage:store,safeLocalStorage:store,async getLocalPluginStorage(){return store;},async getArgument(name){const k=String(name);if(k.includes('memory_suite_server_mode'))return 'plugin_only';if(k.includes('enable_gui'))return 'true';if(k.includes('auto_repair')||k.includes('debug'))return 'false';if(k.includes('failed_recovery_automation'))return 'off';return '';},async getArg(k){return this.getArgument(k);},async setArgument(){return true;},async nativeFetch(){networkCalls++;throw Error('offline artifact parity');},async runLLMModel(){modelCalls++;return {type:'error',result:'offline artifact parity: no model'};},async getDatabase(fields){return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},async setDatabase(patch){Object.assign(db,patch||{});return true;},async getCurrentCharacterIndex(){return 0;},async getCurrentChatIndex(){return 0;},async getCharacter(){return character;},async getCharacterFromIndex(){return character;},async getChar(){return character;},async getChat(){return chat;},async getCurrentChat(){return chat;},async getChatFromIndex(){return chat;},async registerSetting(...args){return register('setting',args);},async registerButton(...args){return register('button',args);},async registerUIPart(...args){return register('part',args);},async unregisterSetting(){return true;},async unregisterButton(){return true;},async unregisterUIPart(){return true;},async addRisuReplacer(kind,callback){hooks.set(kind,callback);return true;},async removeRisuReplacer(kind,callback){if(hooks.get(kind)===callback)hooks.delete(kind);return true;},async addRisuChatListener(kind,callback){listeners.set(kind,callback);return true;},async removeRisuChatListener(){return true;},async addRisuScriptHandler(){return true;},async removeRisuScriptHandler(){return true;},async addPluginChannelListener(){return true;},async removePluginChannelListener(){return true;},async postPluginChannelMessage(){return true;},async requestPluginPermission(){return true;},async onUnload(callback){unload.push(callback);return true;},async addEventListener(kind,callback){if(kind==='unload')unload.push(callback);return true;},async showContainer(){containers++;return true;},async hideContainer(){return true;},async getRootDocument(){return dom.window.document;},async getRootContainer(){return dom.window.document.body;},async getPluginRoot(){return dom.window.document.body;},async log(){return true;}};
  class FixedDate extends Date {constructor(...args){super(...(args.length?args:['2026-10-03T12:00:00.000Z']));}static now(){return 1791028800000;}}
  // Identical hosts produce identical lineage nonces, retaining exact-value parity.
  let randomState=123456789;
  const fixedMath=Object.create(Math);fixedMath.random=()=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState/4294967296;};
  const fixedCrypto={subtle:globalThis.crypto.subtle,getRandomValues(array){for(let i=0;i<array.length;i++)array[i]=Math.floor(fixedMath.random()*256);return array;},randomUUID(){return '00000000-0000-4000-8000-'+Math.floor(fixedMath.random()*1e12).toString().padStart(12,'0');}};
  const context=vm.createContext({risuai:host,window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,MutationObserver:dom.window.MutationObserver,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),Date:FixedDate,Math:fixedMath,console:{log(){},info(){},warn(){},error(){},debug(){}},setTimeout(fn,delay,...args){let timer;const effectiveDelay=owner==='libra'&&portalPhase&&Number(delay)===0?Math.max(Number(delay),options.libraHydrationDelayMs||0):delay;timer=setTimeout(()=>{timers.delete(timer);fn(...args);},effectiveDelay);timers.add(timer);return timer;},clearTimeout(t){timers.delete(t);clearTimeout(t);},setInterval(fn,delay,...args){const t=setInterval(fn,delay,...args);intervals.add(t);return t;},clearInterval(t){intervals.delete(t);clearInterval(t);},queueMicrotask,AbortController,AbortSignal,DOMException,URL,URLSearchParams,TextEncoder,TextDecoder,crypto:fixedCrypto,structuredClone,performance,Headers,Request,Response,FormData,Blob,atob,btoa,confirm:()=>false,alert(){},prompt:()=>null,addEventListener(){},removeEventListener(){},dispatchEvent(){},fetch:async()=>{networkCalls++;throw Error('offline artifact parity');}});
  try {
    await vm.runInContext(source,context,{filename:path.join(dir,file)});
    const api=await until(()=>context[globalName],`${owner} public API`);
    await until(()=>registrations.find(r=>r.kind==='setting'&&r.callback),`${owner} setting callback`);
    await sleep(80);
    const hookResults={};
    if(owner==='lia') {
      assert.equal(hooks.has('beforeRequest'),false,'manual-only LiA does not register automatic before-request tracking');
      assert.equal(listeners.has('output'),false,'manual-only LiA does not register automatic output capture');
      assert.equal(typeof hooks.get('afterRequest'),'function','independent emotion asset after hook remains');
      hookResults.after=plain(await hooks.get('afterRequest')('Alice stays in the hall.','model'));
      assert.equal(hookResults.after,'Alice stays in the hall.');
      hookResults.manualIdle=plain(api.getLiveSyncCaptureState());
      assert.equal(hookResults.manualIdle.backend,'none');
      assert.equal(hookResults.manualIdle.registered,false);
      assert.equal(hookResults.manualIdle.trackedTurnRevisions,0);
      assert.equal(hookResults.manualIdle.scheduledScopes,0);
      assert.equal(modelCalls,0);
    } else if(owner!=='retrace') {
      const before=await until(()=>hooks.get('beforeRequest'),`${owner} beforeRequest`);
      hookResults.before=plain(await before([{role:'system',content:'Continue the scene.'},{role:'user',content:'Where is Alice and the blue prism?'}],'model'));
      assert.ok(Array.isArray(hookResults.before),`${owner}: actual beforeRequest returns the request messages`);
      if(owner==='hayaku')assert.ok(hookResults.before.some(message=>String(message.content||'').includes('[HAYAKU RUNTIME PACKET SHAPE]')),'HAYAKU registered hook injects its runtime packet contract');
      if(hooks.has('afterRequest'))hookResults.after=plain(await hooks.get('afterRequest')('Alice stays in the hall.','model'));
      if(listeners.has('output')) {await listeners.get('output')({role:'assistant',content:'Alice stays in the hall.',data:'Alice stays in the hall.',chatId:'a1',messageIndex:1});hookResults.outputExecuted=true;}
    } else {
      hookResults.lineage=plain(await api.getHostLineageStatus());
      assert.equal(hookResults.lineage.owner,'retrace');
    }
    const setting=registrations.find(r=>r.kind==='setting'&&r.callback);
    const decode=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch(_){return null;}};
    const expectedScope=owner==='libra'?decode(values.get('libra:v1:scope-registry:v1'))?.[`${character.id}::${chat.id}`]?.scopeKey:null;
    const expectedManifestKey=expectedScope?`libra:v1:scope:${expectedScope}:manifest`:null;
    if(owner==='libra')assert.ok(expectedScope,'registered hook establishes the exact current LIBRA context scope');
    const portalState=()=>{const manifest=decode(values.get(expectedManifestKey));const panel=[...dom.window.document.querySelectorAll('[data-receipt-recovery-scope]')].find(node=>node.dataset.receiptRecoveryScope===expectedScope);const receipt=panel?.querySelector('[data-receipt-turn="1"][data-receipt-status="missing"]');return {status:dom.window.document.querySelector('[data-gui-status="true"]')?.textContent,hasManifest:!!manifest&&manifest.schema==='libra.manifest.v1'&&manifest.scopeKey===expectedScope&&manifest.characterId===character.id&&manifest.chatId===chat.id,manifestSchema:manifest?.schema,receiptPanelReady:!!receipt&&[...receipt.querySelectorAll('button')].some(node=>node.textContent===libraReceiptRetryText),expectedScope,expectedManifestKey};};
    let terminalState;
    const observeTerminal=()=>{const state=portalState();if(!terminalState&&state.status===libraTerminalStatus)terminalState=state;};
    // The terminal hydration event precedes the native-copy probe's durable
    // manifest; a background render may clear its status in the same timer turn.
    // The receipt-status read queues another render. This fixture has one complete
    // turn and no receipt: require its loaded T1 missing card and exact retry label.
    // All stages belong to this fresh DOM/host and the hook's exact current scope.
    if(owner==='libra'){portalObserver=new dom.window.MutationObserver(observeTerminal);portalObserver.observe(dom.window.document.body,{subtree:true,childList:true,characterData:true});}
    portalPhase=true;
    await setting.callback();
    if(owner==='libra')await until(()=>{observeTerminal();const state=portalState();options.onPortalObservation?.({...state,terminalWitnessed:!!terminalState});if(terminalState&&state.hasManifest&&state.receiptPanelReady){const ready={...state,terminalStatus:terminalState.status};options.onPortalReady?.(ready);return ready;}return false;},'LIBRA terminal event, exact current-scope durable manifest and loaded T1 receipt panel');
    else await sleep(80);
    options.onPortalSnapshot?.(portalState());
    assert.ok(containers>0,`${owner}: registered setting opens the host container`);
    const body=dom.window.document.body;
    await options.onPortalDom?.({body,api,values,accesses});
    assert.ok(body.querySelectorAll('button,input,select,textarea').length>0,`${owner}: callback builds usable portal controls`);
    const portal={ids:[...body.querySelectorAll('[id]')].map(n=>n.id),buttons:[...body.querySelectorAll('button')].map(n=>n.textContent.trim()),headings:[...body.querySelectorAll('h1,h2,h3')].map(n=>n.textContent.trim()),containers};
    assert.ok(accesses.length>0,`${owner}: plugin executes the storage boundary`);
    return {owner,file,sha256:crypto.createHash('sha256').update(source).digest('hex'),apiKeys:Object.keys(api).sort(),hookResults,portal,registrations:registrations.map(({kind,label,id})=>({kind,label,id})),storageKeys:[...new Set(accesses.map(x=>x[1]))].sort(),storage:plain(Object.fromEntries(values)),modelCalls,networkCalls};
  } finally {
    portalObserver?.disconnect();
    for(const callback of unload.reverse())try{await callback();}catch(_){}
    try{await context[globalName]?.dispose?.();}catch(_){}
    for(const t of timers)clearTimeout(t);for(const t of intervals)clearInterval(t);dom.window.close();
  }
}
module.exports={exercise,libraTerminalStatus};
if(require.main===module)(async()=>{
  assert.ok(prior && candidate, 'explicit preserved control and candidate artifact directories are required');
  const results=[];
  for(const row of rows){const before=await exercise(prior,row),after=await exercise(candidate,row);const {sha256:oldSha,...expected}=before;const {sha256:newSha,...actual}=after;assert.deepEqual(actual,expected,`${row[0]} actual hook, portal, registration and storage behavior parity`);results.push({owner:row[0],controlSHA256:oldSha,artifactSHA256:newSha,hooks:Object.keys(after.hookResults),portalControls:after.portal.buttons.length,storageKeys:after.storageKeys.length,modelCalls:after.modelCalls,networkCalls:after.networkCalls});console.log(JSON.stringify({owner:row[0],result:'PASS',...results.at(-1)}));}
  console.log(JSON.stringify({test:'build_plugins_artifact_behavior_parity',passed:results.length,results}));
})().catch(error=>{console.error(error);process.exitCode=1;});
