 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const program=path.resolve(__dirname,'..'),metadata=require('../tools/release_metadata.cjs');
const artifactDir=process.env.WM_COEXIST_ARTIFACT_DIR||path.join(program,'plugins');
const globals={libra:'__LIBRA__',hayaku:'HAYAKU',flashback:'__FlashbackMemory',lia:'__lia_persona_linker_runtime_v1__',retrace:'__RETRACE',gradia:'__SerialGradationAgentsForRP'};
function sandbox(owner){
 const dom=new JSDOM('<!doctype html><body></body>',{url:'https://offline.invalid',virtualConsole:new VirtualConsole()}),values=new Map(),regs=new Map(),unloads=[],timers=new Set(),wire=[],removed=[];
 const storage={async getItem(k){return values.has(k)?values.get(k):null},async setItem(k,v){values.set(k,v);return true},async removeItem(k){values.delete(k);return true},async keys(){return [...values.keys()]}};
 const chat={id:'fixture-chat',chatId:'fixture-chat',message:[],localLore:[]},char={id:'fixture-character',name:'Fixture',chats:[chat],chatPage:0,globalLore:[]};
 const register=(kind,id,callback)=>{const realId=owner+':host:'+id;assert.equal(regs.has(realId),false);regs.set(realId,{kind,requestedId:id,callback});return {id:realId};};
 const blocked=(...a)=>{wire.push(a);throw Error('P0b offline host transport forbidden')};
 const host={pluginStorage:storage,safeLocalStorage:storage,getLocalPluginStorage:async()=>storage,getArgument:async key=>String(key).includes('memory_suite_server_mode')?'plugin_only':String(key).includes('enable_gui')?'true':String(key).includes('debug')?'false':'',getArg:async()=>'',setArgument:async()=>true,
 registerSetting:async(name,cb,icon,type,id)=>register('setting',id||name,cb),registerButton:async(options,cb)=>register('button',options.id||options.name,cb),unregisterUIPart:async id=>{removed.push(id);return regs.delete(id)},onUnload:async cb=>{unloads.push(cb);return true},
 registerUIPart:async()=>true,addRisuReplacer:async()=>true,removeRisuReplacer:async()=>true,addRisuChatListener:async()=>true,removeRisuChatListener:async()=>true,addRisuScriptHandler:async()=>true,removeRisuScriptHandler:async()=>true,addPluginChannelListener:async()=>true,removePluginChannelListener:async()=>true,postPluginChannelMessage:async()=>true,
 getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[char],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db},setDatabase:async()=>true,
 getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>char,getCharacterFromIndex:async()=>char,getChar:async()=>char,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,
 showContainer:async()=>true,hideContainer:async()=>true,getRootContainer:async()=>null,getPluginRoot:async()=>null,getColorScheme:async()=> 'dark',nativeFetch:blocked,fetch:blocked,runLLMModel:blocked};
 const timer=(fn,ms,...a)=>{const id=setTimeout(()=>{timers.delete(id);fn(...a)},ms);id.unref();timers.add(id);return id};
 const interval=(fn,ms,...a)=>{const id=setInterval(fn,ms,...a);id.unref();timers.add(id);return id};
 const context=vm.createContext({risuai:host,Risuai:host,document:dom.window.document,window:dom.window,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,MutationObserver:dom.window.MutationObserver,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,HTMLInputElement:dom.window.HTMLInputElement,HTMLSelectElement:dom.window.HTMLSelectElement,getComputedStyle:dom.window.getComputedStyle,
 console:{log(){},warn(){},error(){},info(){},debug(){}},setTimeout:timer,clearTimeout,setInterval:interval,clearInterval,queueMicrotask,TextEncoder,TextDecoder,URL,URLSearchParams,AbortController,AbortSignal,DOMException,crypto:globalThis.crypto,structuredClone,performance,fetch:blocked,Headers,Request,Response,FormData,Blob,atob,btoa,confirm:()=>false,alert(){},prompt:()=>null,addEventListener(){},removeEventListener(){},dispatchEvent(){}});
 return {owner,dom,context,host,values,regs,unloads,removed,wire,async close(){for(const cb of unloads)await cb();for(const id of timers){clearTimeout(id);clearInterval(id)}dom.window.close()}};
}
async function settle(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}assert.ok(predicate(),'plugin registration/public API must settle');}
test('wm_seven_sandboxes_keep_registration_and_storage_isolated',async()=>{
 assert.equal(Object.keys(metadata.PLUGINS).length,7,'seven identities share build management');const sandboxes=[];
 try{
 for(const [owner,[file,,id]]of Object.entries(metadata.PLUGINS)){
 const s=sandbox(owner);sandboxes.push(s);const source=fs.readFileSync(path.join(artifactDir,file),'utf8');assert.match(source,new RegExp('^//@name '+id+'\\r?$','m'));vm.runInContext(source,s.context,{filename:file,timeout:5000});
 await settle(()=>owner==='wm'?[...s.regs.values()].some(r=>r.requestedId==='lmai-button'):!!s.context[globals[owner]]);
 await s.host.pluginStorage.setItem('same-key',owner);
 for(const [other,g]of Object.entries(globals))if(other!==owner)assert.equal(s.context[g],undefined,owner+' must not export '+other+' API');
 }
 assert.equal(new Set(sandboxes.map(s=>s.context)).size,7);assert.equal(new Set(sandboxes.map(s=>s.values)).size,7);
 for(const s of sandboxes)assert.equal(await s.host.pluginStorage.getItem('same-key'),s.owner);
 const wm=sandboxes.find(s=>s.owner==='wm'),libra=sandboxes.find(s=>s.owner==='libra');
 await settle(()=>[...libra.regs.values()].some(r=>r.kind==='setting'));
 const wmSetting=[...wm.regs.values()].find(r=>r.requestedId==='lmai-settings'),wmButton=[...wm.regs.values()].find(r=>r.requestedId==='lmai-button');assert.ok(wmSetting);assert.ok(wmButton);assert.equal(wmSetting.callback,wmButton.callback);
 await wmSetting.callback();assert.ok(wm.dom.window.document.getElementById('lmai-overlay'),'WM menu must open its own DOM');assert.equal(libra.dom.window.document.getElementById('lmai-overlay'),null);
 const libraSetting=[...libra.regs.values()].find(r=>r.kind==='setting');assert.notEqual(libraSetting.requestedId,'lmai-settings');await libraSetting.callback();assert.ok(libra.dom.window.document.getElementById('sga-rp-gui-root'),'LIBRA menu must open its own DOM');assert.equal(wm.dom.window.document.getElementById('sga-rp-gui-root'),null);
 const wmIds=[...wm.regs.keys()].filter(id=>/lmai-(settings|button)$/.test(id));for(const cb of wm.unloads)await cb();for(const id of wmIds){assert.equal(wm.regs.has(id),false,'WM must remove returned host registration ID');assert.ok(wm.removed.includes(id));}
 for(const cb of libra.unloads)await cb();assert.equal(libra.regs.has(libra.owner+':host:'+libraSetting.requestedId),false,'LIBRA menu disposal must remain independent');
 for(const s of sandboxes)assert.deepEqual(s.wire,[],s.owner+' no provider/network attempt');
 }finally{for(const s of sandboxes)await s.close()}
});
