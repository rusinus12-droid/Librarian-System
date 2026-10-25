'use strict';
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const {ownerFixture}=require('./shared_reanalysis_owner_fixture.cjs');
const {createValidPacket,hiddenPacketMessage}=require('./hayaku_runtime_harness.cjs');
const waitFor=async fn=>{for(let i=0;i<250;i++){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('Reanalysis UI condition timed out');};
async function setup(owner,{turns=1,legacy=false}={}){
  const options={};
  if(owner==='hayaku'){
    options.transformSource=s=>s.replace('    globalThis.HAYAKU = exposedApi;',`    globalThis.__reviewUi={mount:async root=>{Memory.ledgerViewer.root=root;Memory.ledgerViewer.visible=true;Memory.ledgerViewer.activeTab='recovery';Memory.ledgerViewer.scope=await RisuCompat.currentChatScope();root.innerHTML='<section id="hayakuSourceEditConsent"></section><section id="hayakuSourceTrackingSettings"></section>';viewerRenderSourceEditConsent();},close:()=>{Memory.ledgerViewer.activeTab='overview';clearSourceEditPreview();}};\n    globalThis.HAYAKU = exposedApi;`);
    options.beforeSeed=async r=>{
      if(turns===2)r.chat.message.push({role:'user',id:'u2',chatId:'u2',data:'Second question'},
        {role:'assistant',id:'a2',chatId:'a2',data:hiddenPacketMessage('Alice waited outside.',createValidPacket({turn:2,subject:'Alice',scene:'office',summary:'Alice waited outside.'}))});
      if(legacy)for(const message of r.chat.message){delete message.id;delete message.chatId;}
    };
  }else{
    options.source=fs.readFileSync(path.join(__dirname,'../../plugins/Flashback_Memory.js'),'utf8').replace('  publicApi._test.renderFlashbackSourceEditStatus =',`  globalThis.__reviewUi={mount:async root=>{guiRoot=root;guiVisible=true;guiMounted=true;Runtime.guiTab='source-edits';root.innerHTML=buildFlashbackSourceEditCard();await refreshFlashbackSourceEditPanel();},close:()=>{guiVisible=false;flashbackSourceEditUiToken++;flashbackReanalysisLifetime++;cancelFlashbackSourceReanalysis();}};\n  publicApi._test.renderFlashbackSourceEditStatus =`);
  }
  const f=await ownerFixture(owner,options),dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),root=dom.window.document.querySelector('main');
  if(owner==='flashback'){
    f.r.context.document=dom.window.document;
    if(turns===2){f.chat.message.push({role:'user',id:'u2',chatId:'u2',data:'Second question'},{role:'assistant',id:'a2',chatId:'a2',data:'Alice waited outside.'});await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});}
  }
  const ui=f.r.context.__reviewUi;
  await ui.mount(root);
  const selectors=owner==='hayaku'?{ranges:'[data-reanalysis-ranges]',run:'[data-reanalysis-run]',review:'[data-reanalysis-review]',status:'[data-reanalysis-status]',confirm:'[data-reanalysis-confirm="apply"]'}:
    {ranges:'#fbReanalysisRanges',run:'#fbReanalysisRun',review:'#fbReanalysisReview',status:'#fbSourceEditStatus',confirm:'.overlay.is-open .dialog__actions .btn--primary'};
  const find=key=>(key==='confirm'?dom.window.document:root).querySelector(selectors[key]);
  await waitFor(()=>find('ranges').querySelectorAll('input').length===turns);
  const select=(index,checked=true)=>{const input=find('ranges').querySelectorAll('input')[index];input.checked=checked;input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
  const open=async()=>{select(0);await find('review').onclick();await waitFor(()=>root.querySelector('[data-review-apply]')?.disabled===false);return root.querySelector('[data-source-reanalysis-review]');};
  const extract=(review,role,text)=>{const area=review.querySelector('[data-review-source="'+role+'"]'),start=area.value.indexOf(text);if(start<0)throw Error('Selection text missing');area.setSelectionRange(start,start+text.length);area.onselect();review.querySelector('[data-review-extract]').click();};
  return {f,dom,root,ui,find,select,open,extract,waitFor,close:async()=>{await f.dispose();dom.window.close();}};
}
module.exports={setup,waitFor};
