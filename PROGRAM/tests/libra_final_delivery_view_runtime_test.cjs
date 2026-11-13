'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {JSDOM}=require('jsdom');
const {createLibraVmHarness,waitFor}=require('./fixtures/libra_vm_harness.cjs');
test('delivery list keeps its scroll and filter during background refreshes of the same receipt',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true}),{window}=dom,{document}=window;
 window.scrollTo=()=>{};
 const seam='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
 const f=await createLibraVmHarness({}, {},{
  contextGlobals:{document,window,MutationObserver:window.MutationObserver,requestAnimationFrame:window.requestAnimationFrame.bind(window)},
  transformSource:source=>source.replace(/\r\n/g,'\n').replace(seam,
   '  globalThis.__deliveryUi={Gui,Runtime,LibraMemoryCore,renderSettingsGuiOnce,scheduleGuiTraceRefresh};\n'+seam)
 });
 try{
  const {Gui,Runtime,LibraMemoryCore,renderSettingsGuiOnce,scheduleGuiTraceRefresh}=f.context.__deliveryUi;
  Gui.root=document.querySelector('#root');Gui.visible=true;Gui.state={};
  LibraMemoryCore.state.snapshot={scope:{scopeKey:'scope-a'},manifest:{activeWorldlineId:'branch-a'}};
  const receipt={scopeKey:'scope-a',worldlineId:'branch-a',at:1,responseContextRequestId:'request-a',
   finalVerification:{status:'verified',modelDispatchEligible:true},
   rows:[{family:'state',text:'State evidence',injected:true},
    ...Array.from({length:39},(_,i)=>({family:'micro',text:`Micro evidence ${i}`,injected:true}))]};
  Runtime.lastMemoryRecallViewer=receipt;
  assert.equal(await renderSettingsGuiOnce(),true);
  const list=()=>Gui.root.querySelector('[data-recall-list]');
  const original=list();
  Gui.root.querySelector('.recall-filter button[data-val="micro"]').click();
  original.scrollTop=350;
  const initialRenders=Gui.renderMetrics.regionRenders.main;
  scheduleGuiTraceRefresh();
  await waitFor(()=>Gui.renderMetrics.regionRenders.main>initialRenders);
  assert.equal(list(),original);
  assert.equal(list().scrollTop,350);
  assert.equal(list().children.length,39);
  assert.equal(Gui.root.querySelector('.recall-filter button[data-val="micro"]').getAttribute('aria-pressed'),'true');

  Runtime.lastMemoryRecallViewer={...receipt,at:2,responseContextRequestId:'request-b'};
  Gui.invalidations.add('body');
  assert.equal(await renderSettingsGuiOnce(),true);
  assert.notEqual(list(),original);
  assert.equal(list().scrollTop,0);
  assert.equal(list().children.length,40);
 }finally{await f.cleanup();window.close();}
});

test('final delivery GUI uses only the current receipt and never promotes selection to delivery',async()=>{
 const dom=new JSDOM('<div class="app"></div>'),document=dom.window.document;
 const seam='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
 const f=await createLibraVmHarness({}, {},{contextGlobals:{document,MutationObserver:dom.window.MutationObserver},transformSource:rawSource=>{
  const source=rawSource.replace(/\r\n/g, '\n');
  assert.equal(source.split(seam).length,2);return source.replace(seam,'  globalThis.__deliveryUi={Gui,Runtime,LibraMemoryCore,bookFinalDeliveryView,buildBookDeliveryNotes,openBookFinalEvidenceDialog};\n'+seam);
 }});
 try{
  const u=f.context.__deliveryUi,scopeKey='synthetic-scope';
  u.LibraMemoryCore.state.snapshot={scope:{scopeKey},manifest:{activeWorldlineId:'branch-a'}};
  u.Gui.app=document.querySelector('.app');u.Gui.visible=true;u.Gui.openSerial=1;
  const block='<literal>전체 주입 본문</literal>';
  const receipt={scopeKey,worldlineId:'branch-a',at:1,route:'classic',blockChars:block.length,responseContextRequestId:'request-a',
   finalVerification:{status:'verified',modelDispatchEligible:true},rows:[
    {family:'canonical',worldlineId:'parent-worldline',turnRange:{start:1,end:5},revision:2,text:'<literal>canonical</literal>',injected:true},
    {family:'micro',turnRange:{start:6,end:6},text:'Micro receipt text',injected:true},
    {family:'canonical',text:'selected but never delivered',classicUsed:true,injected:false}]};
  const reads=f.storageReads.length,writes=f.storageWrites.length;
  u.Runtime.lastMemoryRecallViewer=structuredClone(receipt);
  u.Runtime.lastInjection=block;
  u.Runtime.lastMemoryInjectionMeta={scopeKey,responseContextRequestId:receipt.responseContextRequestId};
  let view=u.bookFinalDeliveryView();assert.equal(view.status,'verified');assert.equal(view.rows.length,2,'candidate-only row is excluded');
  assert.equal(view.rows[0].worldlineId,'parent-worldline','verified inherited evidence is retained');
  let notes=u.buildBookDeliveryNotes(view);
  assert.match(notes.textContent,/마지막 요청의 사서 주석/);assert.doesNotMatch(notes.textContent,/이번 턴|이번 리콜|추가 LLM/);
  assert.match(notes.textContent,/현재 턴과 다를 수 있습니다/);assert.ok(notes.querySelector('.anno--final'));
  // The note lists the delivered lines themselves, grouped by a filter, without opening a dialog.
  assert.equal(notes.querySelectorAll('.recall-line').length,2,'only injected rows are listed');
  assert.deepEqual([...notes.querySelectorAll('.recall-line')].map(row=>row.dataset.recallFamily),['canonical','micro']);
  assert.equal(notes.querySelector('.recall-line__text').textContent,receipt.rows[0].text);assert.equal(notes.querySelector('literal'),null,'a delivered line is inert text');
  assert.deepEqual([...notes.querySelectorAll('.recall-filter button')].map(button=>button.textContent),['전체 2','정본 1','Micro 1']);
  notes.querySelector('.recall-filter button[data-val="micro"]').click();
  assert.deepEqual([...notes.querySelectorAll('.recall-line')].map(row=>row.querySelector('.recall-line__text').textContent),['Micro receipt text']);
  assert.equal(notes.querySelector('.recall-filter button[data-val="micro"]').getAttribute('aria-pressed'),'true');
  assert.equal(notes.querySelectorAll('.recall-mix__part').length,2);assert.doesNotMatch(notes.textContent,/selected but never delivered/);
  u.openBookFinalEvidenceDialog();const overlay=document.querySelector('[data-final-evidence]');assert.ok(overlay);
  assert.equal(overlay.querySelectorAll('[data-evidence-family]').length,2);
  const full=overlay.querySelector('[data-final-injection-body]');assert.ok(full);
  full.open=true;full.dispatchEvent(new dom.window.Event('toggle'));
  await Promise.resolve();
  assert.equal(full.querySelector('.evidence-text').textContent,block);
  assert.equal(full.querySelector('literal'),null);
  u.Runtime.lastMemoryInjectionMeta.responseContextRequestId='another-request';
  overlay.libraRefreshState();
  assert.equal(overlay.querySelector('[data-final-injection-body]'),null,'same-scope text from another request is excluded');
  const detail=overlay.querySelector('[data-evidence-family] details');detail.open=true;detail.dispatchEvent(new dom.window.Event('toggle'));
  await Promise.resolve();assert.equal(detail.querySelector('.evidence-text').textContent,receipt.rows[0].text);assert.equal(detail.querySelector('literal'),null,'excerpt is inert text');
  u.LibraMemoryCore.state.snapshot.scope.scopeKey='other-scope';overlay.libraRefreshState();assert.equal(overlay.isConnected,false);
  assert.equal(u.bookFinalDeliveryView().status,'unavailable');
  u.LibraMemoryCore.state.snapshot.scope.scopeKey=scopeKey;u.Runtime.lastMemoryRecallViewer.worldlineId='other-worldline';
  assert.equal(u.bookFinalDeliveryView().status,'unavailable');
  // A failed newer request wins over an older successful recall in core state.
  u.LibraMemoryCore.state.lastRecall={delivery:structuredClone(receipt)};
  for(const extra of [{error:'fixture failure',failOpen:true},{skipped:true,skipReason:'fixture skip'},{finalVerification:{status:'rejected'}}]){
   u.Runtime.lastMemoryRecallViewer={...structuredClone(receipt),lensRecall:{injected:true,injectedItems:[{text:'unverified lens'}]},...extra};view=u.bookFinalDeliveryView();assert.notEqual(view.status,'verified');assert.equal(view.rows.length,0);assert.equal(view.lensRows.length,0);
   notes=u.buildBookDeliveryNotes(view);assert.equal(notes.querySelector('.anno--final'),null);assert.doesNotMatch(notes.textContent,/unverified lens|리콜 기록이 없습니다/);
   assert.match(notes.textContent,extra.error?/전달 실패/:extra.skipped?/리콜 건너뜀/:/검증 미확인/);
  }
  u.Runtime.lastMemoryRecallViewer={...structuredClone(receipt),rows:[],lensRecall:{injected:true,injectedItems:[{text:'lens-only evidence',lensName:'렌즈'}]}};
  view=u.bookFinalDeliveryView();notes=u.buildBookDeliveryNotes(view);
  assert.match(notes.textContent,/기억 근거 1개/);assert.match(notes.textContent,/일반 근거 0개 · 렌즈 기억\(비정본\) 1개/);assert.match(notes.textContent,/lens-only evidence/);
  u.openBookFinalEvidenceDialog();assert.ok(document.querySelector('[data-evidence-family="렌즈 기억"]'));
  u.Runtime.lastMemoryRecallViewer.scopeKey='other';view=u.bookFinalDeliveryView();notes=u.buildBookDeliveryNotes(view);
  assert.equal(notes.dataset.deliveryNotes,'unavailable');assert.match(notes.textContent,/전달 기록 없음/);assert.doesNotMatch(notes.textContent,/lens-only evidence/);
  assert.equal(f.storageReads.length,reads,'receipt display performs no storage reads');assert.equal(f.storageWrites.length,writes,'receipt display performs no writes');
 }finally{await f.cleanup();dom.window.close();}
});
