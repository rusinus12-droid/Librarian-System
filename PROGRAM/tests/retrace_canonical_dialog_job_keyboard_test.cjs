'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const source=fs.readFileSync(require('node:path').join(__dirname,'../plugins/RETRACE.js'),'utf8');
const document=new JSDOM(JSON.parse(source.match(/root.innerHTML = (".*");/)[1])).window.document;
const window=document.defaultView,root=document.body,opener=document.createElement('button');opener.textContent='실제 UI 진입 버튼';root.append(opener);
const Runtime={visible:true,root,dialogSequence:0,busy:false};const listeners={keydown:new Set(),focusin:new Set()};
const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
document.addEventListener=(type,handler,capture)=>{if(listeners[type])listeners[type].add(handler);add(type,handler,capture);};
document.removeEventListener=(type,handler,capture)=>{if(listeners[type])listeners[type].delete(handler);remove(type,handler,capture);};
const start=source.indexOf('  const clearRetraceDialogListeners ='),end=source.indexOf('  const retraceAlert =',start);
const ui=new Function('Runtime','document','text','escapeHtml','scopeManagerArray','MEMORY_SUITE_NAMESPACE_LABELS','warn',source.slice(start,end)+'return {showRetraceDialog,openRetraceJob,hideRetraceJob,finishRetraceJob};')(Runtime,document,v=>String(v??''),v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),v=>Array.isArray(v)?v:[],{hayaku:'HAYAKU'},()=>{});
const settle=()=>new Promise(resolve=>setTimeout(resolve,5));
const press=(key,shiftKey=false)=>document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true}));
(async()=>{
 const confirmations=[];
 for(const id of ['dlg-next','dlg-retry','dlg-del','dlg-restore','dlg-reset']){
  opener.focus();const typedWord=id==='dlg-del'?'정리':id==='dlg-restore'?'복원':id==='dlg-reset'?'초기화':'';
  const pending=ui.showRetraceDialog('현재 승인 대상',{dialogId:id,confirm:true,typedWord,summary:'hayaku',dialogFields:{target:'hayaku',targets:'hayaku',backup:'검사한 백업',kept:'libra'},safety:'기존 target admission 유지'});
  await settle();const layer=document.querySelector('#'+id);assert(layer.contains(document.activeElement));
  for(let i=0;i<5;i++){press('Tab');assert(layer.contains(document.activeElement),'Tab stays in canonical '+id);}
  press('Escape');assert.equal(await pending,false,'Escape denies '+id);await settle();assert.equal(document.activeElement,opener,'confirmation returns opener focus');
  assert.equal(listeners.keydown.size,0);assert.equal(listeners.focusin.size,0);
  const again=ui.showRetraceDialog('재검사 대상',{dialogId:id,confirm:true,typedWord,summary:'hayaku'});await settle();assert.equal(listeners.keydown.size,1);assert.equal(listeners.focusin.size,1);press('Escape');assert.equal(await again,false);await settle();confirmations.push(id);
 }
 const jobs=[];let aborted=0;Runtime.portableTransfer={controller:{abort(){aborted++;}},restoring:false};Runtime.serverScopeDeleteJob={rows:[],cancelRequested:false};
 const tray=document.querySelector('[data-job-tray]');tray.hidden=false;
 for(const kind of ['next','del','backup','restore','reset']){
  Runtime.busy=true;opener.focus();ui.openRetraceJob(kind,'실제 작업 대기',{facts:{namespaces:['hayaku'],withoutBackup:false}});await settle();const layer=document.querySelector('#job-'+kind);
  assert(layer.contains(document.activeElement));const first=document.activeElement;
  ui.openRetraceJob(kind,Runtime.activeJobMessage,{resume:true});await settle();assert.equal(listeners.keydown.size,1,'one job keyboard handler');assert.equal(listeners.focusin.size,1,'one job focus handler');
  press('Tab');assert(layer.contains(document.activeElement),'job Tab stays contained');
  const visibleButtons=[...layer.querySelectorAll('button')].filter(n=>!n.hidden&&!n.disabled);if(visibleButtons.length>1)assert.notEqual(document.activeElement,first,'one Tab advances once after repeated open');
  press('Escape');await settle();assert.equal(layer.hidden,true);assert.equal(Runtime.activeJobKind,kind);assert.equal(Runtime.busy,true,'Escape only hides actual job');assert.equal(aborted,0);assert.equal(Runtime.serverScopeDeleteJob.cancelRequested,false);assert.equal(document.activeElement,opener);
  tray.focus();ui.openRetraceJob(kind,Runtime.activeJobMessage,{resume:true});await settle();press('Escape');await settle();assert.equal(document.activeElement,tray,'task-tray reopening returns to actual opener');assert.equal(listeners.keydown.size,0);assert.equal(listeners.focusin.size,0);jobs.push(kind);
 }
 console.log(JSON.stringify({test:'retrace_canonical_dialog_job_keyboard',confirmations,jobs,tabContained:true,escapeDeniesConsent:true,escapeHidesWithoutCancel:true,openerFocusReturned:true,repeatedOpenSingleHandler:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
