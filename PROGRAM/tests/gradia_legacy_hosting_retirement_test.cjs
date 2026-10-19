'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom');
const {load}=require('./gradia/host.cjs');
const runtimeKey='serial_gradation_agents_for_rp:runtime_settings:v2';
const retired={backendHosting:{mode:'hosted',url:'http://127.0.0.1:18787',token:'retired-only'},backend_hosting_mode:'hosted',backend_hosting_url:'http://127.0.0.1:18787',backendHostingToken:'retired-only'};
const wait=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('GUI action did not settle');};

test('retired hosting settings cannot load, import, export or redirect a provider call',async t=>{
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'}),requests=[],unloads=[],local=new Map();let exported;
 const api={getArgument:async name=>retired[name],getLocalPluginStorage:async()=>({getItem:async k=>local.get(k),setItem:async(k,v)=>local.set(k,v)}),
  nativeFetch:async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({choices:[{message:{content:'OK'},finish_reason:'stop'}]}));},
  onUnload:async f=>unloads.push(f),showContainer:async()=>{},hideContainer:async()=>{}};
 const h=await load({storage:{[runtimeKey]:JSON.stringify({version:3,settings:{...retired,mode:'normal',internal_draft_language:'english'}})},api,
  testGlobals:{Response,Headers,crypto:crypto.webcrypto,navigator:{clipboard:{writeText:async value=>{exported=JSON.parse(value);}}},window:dom.window,Element:dom.window.Element,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});
 t.after(async()=>{await h.plugin.closeSettingsGui();for(const f of unloads)await f();dom.window.close();});
 const clean=await h.plugin.getRuntimeSettings();assert.equal(clean.internal_draft_language,'english');assert(!Object.keys(clean).some(k=>/^backend(?:_hosting|Hosting)/.test(k)));
 await h.plugin.saveRuntimeSettings({...retired,mode:'normal',internalDraftLanguage:'japanese'});
 const persisted=JSON.parse(h.store.get(runtimeKey)).settings;
 assert.equal(persisted.internal_draft_language,'japanese');assert(!Object.keys(persisted).some(k=>/^backend(?:_hosting|Hosting)/.test(k)));
 await h.plugin.saveProviderPreset('default',{provider:'openai',url:'https://provider.invalid/v1/chat/completions',model:'synthetic-model',key:'synthetic-provider-only',stream:false});
 await h.plugin.openSettingsGui();await h.plugin.debugNavigateGui('providers','providers');
 const doc=dom.window.document;
 assert.equal(doc.querySelector('[data-backend-hosting-panel]'),null);
 doc.querySelector('[data-provider-test="default"]').click();await wait(()=>requests.length>0);
 await wait(()=>h.plugin.getProviderDebug().response||h.plugin.getProviderDebug().error);
 assert.equal(h.plugin.getProviderDebug().error,null);
 assert.equal(requests.length,1);assert.equal(requests[0].url,'https://provider.invalid/v1/chat/completions');
 assert(!JSON.stringify(requests).includes('retired-only'));assert(!JSON.stringify(requests).includes('/__libra_host__/'));
 // A settings backup from a legacy installation must not reactivate the proxy.
 await h.plugin.debugNavigateGui('transfer','flow');
 const box=doc.querySelector('#mockup-import-text');box.value=JSON.stringify({runtime:{backendHosting:{mode:'hosted',url:retired.backend_hosting_url},backend_hosting_mode:'hosted',backend_hosting_url:retired.backend_hosting_url,mode:'lite',internalDraftLanguage:'english'}});box.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 doc.querySelector('[data-manage-action="import-replace"]').click();await wait(()=>doc.querySelector('.overlay.is-open .dialog .btn--primary'));
 doc.querySelector('.overlay.is-open .dialog .btn--primary').click();await wait(()=>h.plugin.debugGuiStateInfo().dirty);
 doc.querySelector('#savebar [data-save]').click();await wait(()=>!h.plugin.debugGuiStateInfo().dirty);
 const imported=await h.plugin.getRuntimeSettings();assert.equal(imported.mode,'lite');assert.equal(imported.internal_draft_language,'english');assert(!Object.keys(imported).some(k=>/^backend(?:_hosting|Hosting)/.test(k)));
 doc.querySelector('[data-export-scope="all"]').click();doc.querySelector('[data-manage-action="export-copy"]').click();await wait(()=>exported);
 assert(!JSON.stringify(exported).includes('backendHosting'));assert(!JSON.stringify(exported).includes('backend_hosting'));
 assert.equal(requests.length,1,'importing and saving must not call the obsolete bridge');
});
