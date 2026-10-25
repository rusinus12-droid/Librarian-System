'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom'),{ownerFixture,envelope,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI condition timed out');};
async function setup(owner){
 const options={};
 if(owner==='hayaku')options.transformSource=s=>s.replace('    globalThis.HAYAKU = exposedApi;',`    globalThis.__reanalysisDrawer={mount:async root=>{Memory.ledgerViewer.root=root;Memory.ledgerViewer.visible=true;Memory.ledgerViewer.activeTab='recovery';Memory.ledgerViewer.scope=await RisuCompat.currentChatScope();root.innerHTML='<section id="hayakuSourceEditConsent"></section><section id="hayakuSourceTrackingSettings"></section>';viewerRenderSourceEditConsent();},close:()=>{Memory.ledgerViewer.activeTab='overview';clearSourceEditPreview();}};\n    globalThis.HAYAKU = exposedApi;`);
 else options.source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8').replace('  publicApi._test.renderFlashbackSourceEditStatus =',`  globalThis.__reanalysisDrawer={mount:async root=>{guiRoot=root;guiVisible=true;guiMounted=true;Runtime.guiTab='source-edits';root.innerHTML=buildFlashbackSourceEditCard();await refreshFlashbackSourceEditPanel();},close:()=>{guiVisible=false;flashbackSourceEditUiToken+=1;flashbackReanalysisLifetime+=1;}};\n  publicApi._test.renderFlashbackSourceEditStatus =`);
 const f=await ownerFixture(owner,options),dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main');
 // Flashback's explicit-reanalysis confirmation is a guiDialog on the plugin document; HAYAKU's lives inside the viewer root.
 if(owner==='flashback')f.r.context.document=dom.window.document;
 return {f,dom,root,ui:f.r.context.__reanalysisDrawer};
}
for(const owner of ['hayaku','flashback'])test(owner+' actual range drawer runs once using text edited after opening',async()=>{
 const {f,dom,root,ui}=await setup(owner);try{
  await ui.mount(root);await waitFor(()=>root.querySelector(owner==='hayaku'?'[data-reanalysis-ranges] input':'#fbReanalysisRanges input'));
  const input=root.querySelector(owner==='hayaku'?'[data-reanalysis-ranges] input':'#fbReanalysisRanges input'),button=root.querySelector(owner==='hayaku'?'[data-reanalysis-run]':'#fbReanalysisRun');
  input.checked=true;input.onchange();assert.equal(button.disabled,false);f.edit(NEW);f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const first=button.onclick(),second=button.onclick();assert.equal(button.disabled,true);
  // The product now asks for explicit confirmation of target turns, call count and memory replacement before running.
  const confirmSelector=owner==='hayaku'?'#hayakuSourceReanalysisConfirmOverlay [data-reanalysis-confirm="apply"]':'.overlay.is-open .dialog__actions .btn--primary';
  await waitFor(()=>dom.window.document.querySelector(confirmSelector));
  const dialog=dom.window.document.querySelector(confirmSelector).closest('[role="dialog"]');assert.ok(dialog,'confirmation is an accessible dialog');
  assert.match(dialog.textContent,owner==='hayaku'?/1턴[\s\S]*Other Ax 1회/:/\(1턴\)[\s\S]*원문 저장 단계의 임베딩 호출은 0회/);
  assert.equal(f.calls(),0,'nothing runs before the confirmation is accepted');
  dom.window.document.querySelector(confirmSelector).click();await Promise.all([first,second]);
  assert.equal(f.calls(),owner==='hayaku'?1:0);assert.ok((await f.records()).some(r=>JSON.stringify(r).includes(NEW)));
  assert.match(root.querySelector(owner==='hayaku'?'[data-reanalysis-status]':'#fbSourceEditStatus').textContent,owner==='hayaku'?/갱신했습니다/:/선택한 구간의 원문을 저장했습니다/);
 }finally{await f.dispose();dom.window.close();}
});
for(const owner of ['hayaku','flashback'])test(owner+' closing the actual drawer while inventory loads cannot publish a stale selection',async()=>{
 const {f,dom,root,ui}=await setup(owner);try{
  const get=f.store.getItem.bind(f.store);let release,enter,held=false;const gate=new Promise(r=>enter=r),pause=new Promise(r=>release=r);
  f.store.getItem=async key=>{if(!held&&(owner==='hayaku'?String(key).startsWith('hayaku.v2.ledger.'):String(key).endsWith(':manifest:v2'))){held=true;enter();await pause;}return get(key)};
  const mounting=ui.mount(root);await gate;ui.close();release();await mounting;await new Promise(r=>setTimeout(r,10));
  assert.equal(root.querySelectorAll(owner==='hayaku'?'[data-reanalysis-ranges] input':'#fbReanalysisRanges input').length,0);assert.equal(f.calls(),0);
 }finally{await f.dispose();dom.window.close();}
});
