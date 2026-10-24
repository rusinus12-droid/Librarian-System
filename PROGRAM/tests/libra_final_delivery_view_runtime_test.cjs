'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {JSDOM}=require('jsdom');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
test('final delivery GUI uses only the current receipt and never promotes selection to delivery',async()=>{
 const dom=new JSDOM('<div class="app"></div>'),document=dom.window.document;
 const seam='  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
 const f=await createLibraVmHarness({}, {},{contextGlobals:{document,MutationObserver:dom.window.MutationObserver},transformSource:rawSource=>{
  const source=rawSource.replace(/\r\n/g, '\n');
  assert.equal(source.split(seam).length,2);return source.replace(seam,'  globalThis.__deliveryUi={Gui,Runtime,LibraMemoryCore,bookFinalDeliveryView,openBookFinalEvidenceDialog};\n'+seam);
 }});
 try{
  const u=f.context.__deliveryUi,scopeKey='synthetic-scope';
  u.LibraMemoryCore.state.snapshot={scope:{scopeKey},manifest:{activeWorldlineId:'branch-a'}};
  u.Gui.app=document.querySelector('.app');u.Gui.visible=true;u.Gui.openSerial=1;
  const receipt={scopeKey,worldlineId:'branch-a',at:1,route:'classic',blockChars:5,
   finalVerification:{status:'verified',modelDispatchEligible:true},rows:[
    {family:'canonical',worldlineId:'parent-worldline',turnRange:{start:1,end:5},revision:2,text:'<literal>canonical</literal>',injected:true},
    {family:'micro',turnRange:{start:6,end:6},text:'Micro receipt text',injected:true},
    {family:'canonical',text:'selected but never delivered',classicUsed:true,injected:false}]};
  const reads=f.storageReads.length,writes=f.storageWrites.length;
  u.Runtime.lastMemoryRecallViewer=structuredClone(receipt);
  let view=u.bookFinalDeliveryView();assert.equal(view.status,'verified');assert.equal(view.rows.length,2,'candidate-only row is excluded');
  assert.equal(view.rows[0].worldlineId,'parent-worldline','verified inherited evidence is retained');
  u.openBookFinalEvidenceDialog();const overlay=document.querySelector('[data-final-evidence]');assert.ok(overlay);
  assert.equal(overlay.querySelectorAll('[data-evidence-family]').length,2);
  const detail=overlay.querySelector('[data-evidence-family] details');detail.open=true;detail.dispatchEvent(new dom.window.Event('toggle'));
  await Promise.resolve();assert.equal(detail.querySelector('.evidence-text').textContent,receipt.rows[0].text);assert.equal(detail.querySelector('literal'),null,'excerpt is inert text');
  u.LibraMemoryCore.state.snapshot.scope.scopeKey='other-scope';overlay.libraRefreshState();assert.equal(overlay.isConnected,false);
  assert.equal(u.bookFinalDeliveryView().status,'unavailable');
  u.LibraMemoryCore.state.snapshot.scope.scopeKey=scopeKey;u.Runtime.lastMemoryRecallViewer.worldlineId='other-worldline';
  assert.equal(u.bookFinalDeliveryView().status,'unavailable');
  // A failed newer request wins over an older successful recall in core state.
  u.LibraMemoryCore.state.lastRecall={delivery:structuredClone(receipt)};
  for(const extra of [{error:'fixture failure',failOpen:true},{skipped:true,skipReason:'fixture skip'},{finalVerification:{status:'rejected'}}]){
   u.Runtime.lastMemoryRecallViewer={...structuredClone(receipt),...extra};view=u.bookFinalDeliveryView();assert.notEqual(view.status,'verified');assert.equal(view.rows.length,0);
  }
  assert.equal(f.storageReads.length,reads,'receipt display performs no storage reads');assert.equal(f.storageWrites.length,writes,'receipt display performs no writes');
 }finally{await f.cleanup();dom.window.close();}
});
