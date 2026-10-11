'use strict';
// Real Flashback source + real Chromium DOM/event handlers. The RisuAI host
// storage/API boundary is supplied; no replacement UI or cleanup code is used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {resolveChromeExecutable}=require('./fixtures/browser_resolver.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const out=process.env.MEMORY_PATCH_BROWSER_OUTPUT||path.join(os.tmpdir(),'flashback-scope-panels-evidence');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-browser-'));
// Chromium's singleton Unix socket must fit sun_path even when evidence TMPDIR is long.
const socketTmp=fs.mkdtempSync(path.join(process.platform==='win32'?os.tmpdir():'/tmp','fb-chrome-'));
const stderrFile=path.join(out,'chromium.stderr.log'),stderrFd=fs.openSync(stderrFile,'a');
const child=spawn(resolveChromeExecutable(),['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-dev-shm-usage','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{env:{...process.env,TMPDIR:socketTmp,XDG_CONFIG_HOME:path.join(profile,'config'),XDG_CACHE_HOME:path.join(profile,'cache')},stdio:['ignore','ignore',stderrFd]});
fs.closeSync(stderrFd);
let childExit;child.on('error',error=>{childExit={error:error.message};});child.on('exit',(code,signal)=>{childExit={code,signal};});
let ws;const watchdog=setTimeout(()=>{child.kill('SIGKILL');console.error('Flashback browser timeout');process.exit(1);},90000);
(async()=>{
 let port;for(let n=0;n<100;n++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}if(childExit)break;await pause(100);}assert.ok(port,'Chromium starts: '+JSON.stringify(childExit||{})+'; stderr='+stderrFile);
 const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(pages.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let seq=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const wait=async(expression)=>{for(let i=0;i<160;i++){if(await ev(expression))return;await pause(50);}throw new Error('Condition not reached: '+expression);};
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await ev(`window.hostWrites=0;window.hostMessages=[];window.unloads=[];
 const makeStore=()=>{const m=new Map();return {m,getItem:async k=>m.get(String(k))??null,setItem:async(k,v)=>{hostWrites++;m.set(String(k),v);return true;},removeItem:async k=>{hostWrites++;m.delete(String(k));return true;},keys:async()=>[...m.keys()]};};
 window.pluginStore=makeStore();window.localStore=makeStore();window.chat={id:'active',chatId:'active',name:'현재 채팅',message:[],messages:[]};window.character={id:'actor',chaId:'actor',name:'류지현',chats:[chat]};
 const argumentsMap=new Map([['memory_suite_server_mode','plugin_only'],['enable_gui','false'],['embedding_provider','hash']]);
 window.risuai={pluginStorage:pluginStore,safeLocalStorage:localStore,getLocalPluginStorage:async()=>localStore,getArgument:async n=>argumentsMap.get(n)||'',getArg:async n=>argumentsMap.get(n)||'',setArgument:async(k,v)=>{argumentsMap.set(k,String(v));return true;},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacter:async()=>character,getCharacterFromIndex:async()=>character,getChat:async()=>chat,getCurrentChat:async()=>chat,getChatFromIndex:async()=>chat,getDatabase:async fields=>{const db={characters:[character],personas:[],selectedPersona:'',plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},setDatabase:async()=>true,nativeFetch:async()=>{throw new Error('Network not used in DOM test');},onUnload:async fn=>{unloads.push(fn);return true;},getRootContainer:async()=>null,getPluginRoot:async()=>null,showContainer:async()=>true,hideContainer:async()=>true};
 for(const name of ['addPluginChannelListener','removePluginChannelListener','removePluginChannelHandler','offPluginChannelMessage','postPluginChannelMessage','registerSetting','registerButton','unregisterSetting','unregisterButton','unregisterUIPart','addRisuReplacer','removeRisuReplacer','addRisuScriptHandler','removeRisuScriptHandler','addRisuChatListener','removeRisuChatListener']) risuai[name]=async()=>true;`);
 const source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8').replace('_test: { maintenanceResultText,','_test: { Runtime, buildUiHtml, mountGuiRoot, rememberScope, readRegistry, scopeKeys, maintenanceResultText,');
 await ev(source);await wait('!!window.__FlashbackMemory?._test');
 await ev(`(async()=>{window.fb=__FlashbackMemory;window.t=fb._test;t.Runtime.nativeCopyObserver.running=false;
 window.activeScope=(await t.resolveCurrentScopeIdentityBundle(false)).scope;
 for(const [scopeKey,title] of [['memory-1','Alpha memory'],['memory-2','Beta memory']]) await t.saveAllRecords([{id:scopeKey,hash:scopeKey,type:'response',sourceType:'response',text:'안전하게 보존할 기억 '+title,dim:4,vector:[1,0,0,0]}],null,{...activeScope,scopeKey,chatId:scopeKey,canonicalChatId:scopeKey,chatTitle:title});
 for(const scopeKey of ['unused-1','unused-2'])await t.rememberScope({scopeKey,chatTitle:scopeKey});
 await fb.showUi();})()`);
 await wait('!!document.getElementById("tab-restore")');
 for(const tab of ['source-edits','restore','import','storage']){
  await ev(`document.getElementById('tab-${tab}').click()`);await wait(`document.getElementById('panel-${tab}').classList.contains('active')`);
  assert.equal(await ev(`document.querySelectorAll('.panel[data-panel]:not([hidden]).active').length`),1,'one independent active panel');
 }
 await ev(`document.querySelector('[data-storage-tab="scopes"]').click()`);
 await wait('document.querySelectorAll("input[data-select-scope]").length>=2');
 // Pending checkboxes must work without asking the user to run a full list scan.
 await ev(`document.getElementById('selectAllScopes').click()`);await pause(100);
 assert.equal(await ev(`document.querySelectorAll('input[data-select-scope]:checked').length>=2`),true);
 assert.equal(await ev(`document.getElementById('deleteSelectedScopesBtn').disabled`),false);
 await ev(`document.getElementById('selectCleanupCandidatesBtn').click()`);
 await wait(`document.getElementById('storageManagementView').value==='cleanup' && !document.getElementById('cleanupSelectedScopesBtn').disabled`);
 assert.equal(await ev(`document.querySelectorAll('input[data-select-scope]:checked').length`),2,'both list-only items selected');
 await ev(`document.getElementById('selectAllScopes').click();document.getElementById('selectAllScopes').click()`);
 assert.equal(await ev(`document.getElementById('selectAllScopes').checked && !document.getElementById('selectAllScopes').indeterminate`),true,'select-all reflects the visible cleanup group, not hidden memory rows');
 assert.equal(await ev(`(async()=>new DOMParser().parseFromString(await t.buildUiHtml(),'text/html').getElementById('storageManagementView').value)()`),'cleanup','rebuilt GUI keeps the selected classification');
 await ev(`document.getElementById('selectAllScopes').click();var search=document.getElementById('storageScopeFilter');search.value='unused-1';search.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('selectAllScopes').click()`);
 assert.equal(await ev(`document.getElementById('selectAllScopes').checked && !document.getElementById('selectAllScopes').indeterminate`),true,'select-all reflects the active search too');
 assert.equal(await ev(`document.querySelectorAll('input[data-select-scope]:checked').length`),1);
 await ev(`var search=document.getElementById('storageScopeFilter');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('selectAllScopes').click()`);
 assert.equal(await ev(`document.querySelectorAll('input[data-select-scope]:checked').length`),2);
 const snap=async name=>{const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 await snap('cleanup-desktop');
 await ev(`document.getElementById('cleanupSelectedScopesBtn').click()`);
 await wait(`document.querySelector('.vrmDialogBackdrop')`);
 // Inspect dialog controls without guessing a selector for the confirmation.
 const buttons=await ev(`Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='확인'&&!b.disabled).map(b=>({text:b.textContent,cls:b.className}))`);assert.ok(buttons.length,'real confirmation dialog visible');
 await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='확인'&&!b.disabled).click()`);
 await wait(`!Array.from(pluginStore.m.values()).some(v=>typeof v==='string'&&v.includes('"scopeKey":"unused-1"'))`);
 assert.equal(await ev(`(async()=>(await t.loadScopeRecords('memory-1')).records.length)()`),1);
 assert.equal(await ev(`(async()=>(await t.loadScopeRecords('memory-2')).records.length)()`),1);
 await wait(`document.querySelector('.vrmDialogBackdrop .vrmDialogOk')?.textContent==='닫기'`);
 // Close informational result then exercise independent source-review and restore layouts.
 await ev(`Array.from(document.querySelectorAll('button')).filter(b=>['닫기','확인'].includes(b.textContent.trim())&&b.closest('[role="dialog"]')).forEach(b=>b.click())`);
 await wait(`t.Runtime.guiBusyDepth===0`);
 for(const tab of ['source-edits','restore']){await ev(`document.getElementById('tab-${tab}').click()`);await pause(200);await snap(tab+'-desktop');}
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await snap('restore-mobile');
 assert.equal(await ev(`document.querySelectorAll('#panel-source-edits').length`),1);
 assert.equal(await ev(`document.querySelectorAll('[data-portable-backup-host="flashback_memory"]').length`),1);
 console.log('PASS real Chromium: independent panels, selectable pending rows, batch empty cleanup with confirmation and preserved memories; screenshots '+out);
 await ev('Promise.all(unloads.map(fn=>fn()))');await call('Browser.close');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);ws?.close();child.kill();await pause(200);fs.rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});fs.rmSync(socketTmp,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
