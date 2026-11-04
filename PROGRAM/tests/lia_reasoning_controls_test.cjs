'use strict';
// The provider form shows only the controls the chosen provider and reasoning family actually use.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const {until}=require('./fixtures/libra_gui_memory_dom_host.cjs');
async function setup(t){
 let open;
 const f=await createFixture('official',{configureApi(api){api.registerSetting=async(_name,fn)=>{open=fn;return true;};},transformSource:s=>s
  .replace('  async function getContext(contextOptionsOverride = null) {',`  globalThis.__saveAudit={read:readStoredLLMConfig};\n  async function getContext(contextOptionsOverride = null) {`)});
 const gui=createColdStartGuiDocument();Object.assign(f.context,{document:gui.document,window:gui.dom.window,HTMLInputElement:gui.dom.window.HTMLInputElement,HTMLTextAreaElement:gui.dom.window.HTMLTextAreaElement,HTMLSelectElement:gui.dom.window.HTMLSelectElement});
 t.after(async()=>{await f.dispose();gui.dom.window.close();});
 await open();gui.document.querySelector('.sidebar [data-go="settings"]').click();
 const doc=gui.document,$=id=>doc.querySelector('#'+id);
 const set=(id,value)=>{const el=$(id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new gui.dom.window.Event('change',{bubbles:true}));};
 const shown=id=>$(id).style.display!=='none';
 const save=async()=>{const b=$('lia-save-provider');b.click();await until(()=>!b.disabled,'provider save settles');return f.context.__saveAudit.read();};
 return {doc,$,set,shown,save};
}
test('reasoning preset fills its defaults, limits effort choices and shows what will be sent',async t=>{
 const x=await setup(t);
 x.set('lia-reasoning-preset','gemini');
 assert.deepEqual([...x.$('lia-reasoning-effort').options].map(o=>o.value),['none','minimal','low','medium','high']);
 assert.equal(x.$('lia-reasoning-effort').value,'medium');
 assert.equal(x.shown('lia-reasoning-effort-field'),true);assert.equal(x.shown('lia-reasoning-budget-field'),false);
 assert.match(x.$('lia-reasoning-hint').textContent,/thinkingLevel/);
 assert.match(x.$('lia-reasoning-effective').textContent,/^실제 적용: GEMINI/);
 x.set('lia-reasoning-preset','claude_budget');
 assert.equal(x.$('lia-reasoning-budget').value,'4096');assert.equal(x.shown('lia-reasoning-effort-field'),false);assert.equal(x.shown('lia-reasoning-budget-field'),true);
 assert.match(x.$('lia-reasoning-effective').textContent,/budget_tokens=4096/);
 const stored=await x.save();assert.equal(stored.reasoningPreset,'claude_budget');assert.equal(stored.reasoningBudgetTokens,4096);
});
test('an effort value the family does not offer falls back instead of being sent',async t=>{
 const x=await setup(t);
 x.set('lia-reasoning-preset','gpt');x.set('lia-reasoning-effort','xhigh');assert.equal(x.$('lia-reasoning-effort').value,'xhigh');
 x.$('lia-reasoning-preset').value='gemini';x.set('lia-reasoning-effort','xhigh');
 assert.equal(x.$('lia-reasoning-effort').value,'none');
});
test('custom provider sends service tier only when allowed, and the choice survives saving',async t=>{
 const x=await setup(t);
 x.set('lia-provider','custom');
 assert.equal(x.shown('lia-custom-service-tier-field'),true);assert.equal(x.$('lia-service-tier').disabled,true);
 x.set('lia-custom-service-tier',true);assert.equal(x.$('lia-service-tier').disabled,false);
 assert.equal((await x.save()).customServiceTierPassthrough,true);
 assert.equal((await x.save()).customServiceTierPassthrough,true);
 x.set('lia-provider','openai');assert.equal(x.shown('lia-custom-service-tier-field'),false);assert.equal(x.shown('lia-service-tier-field'),true);
});
test('vertex shows flex and credential guidance, and flex mode no longer resets on save',async t=>{
 const x=await setup(t);
 x.set('lia-provider','vertex');
 assert.equal(x.shown('lia-vertex-flex-field'),true);assert.equal(x.shown('lia-service-tier-field'),false);
 assert.equal(x.$('lia-vertex-credential-meta').hidden,false);assert.match(x.$('lia-vertex-credential-meta').textContent,/Project:/);
 x.set('lia-vertex-flex','flex_only');
 assert.equal((await x.save()).vertexFlexMode,'flex_only');assert.equal((await x.save()).vertexFlexMode,'flex_only');
 x.set('lia-provider','openai');assert.equal(x.shown('lia-vertex-flex-field'),false);assert.equal(x.$('lia-vertex-credential-meta').hidden,true);
});
