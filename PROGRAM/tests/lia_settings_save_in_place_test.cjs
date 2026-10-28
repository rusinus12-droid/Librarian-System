'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const {until}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(t){
 let open,host;
 const f=await createFixture('official',{configureApi(api){host=api;const args=new Map(),get=api.getArgument.bind(api);api.getArgument=async name=>args.has(name)?args.get(name):get(name);api.setArgument=async(name,value)=>{args.set(name,value);return true;};api.registerSetting=async(_name,fn)=>{open=fn;return true;};},transformSource:s=>s
  .replace('  async function getContext(contextOptionsOverride = null) {',`  globalThis.__saveAudit={read:readStoredLLMConfig};\n  async function getContext(contextOptionsOverride = null) {globalThis.__contextReads=(globalThis.__contextReads||0)+1;`)
  .replace('  async function writeStoredLLMConfig(config) {',`  async function writeStoredLLMConfig(config) {if(globalThis.__saveGate)await globalThis.__saveGate;`)});
 const gui=createColdStartGuiDocument();Object.assign(f.context,{document:gui.document,window:gui.dom.window,HTMLInputElement:gui.dom.window.HTMLInputElement,HTMLTextAreaElement:gui.dom.window.HTMLTextAreaElement,HTMLSelectElement:gui.dom.window.HTMLSelectElement});
 t.after(async()=>{await f.dispose();gui.dom.window.close();});await open();gui.document.querySelector('.sidebar [data-go="settings"]').click();
 assert(gui.document.querySelector('#lia-save-provider'));return {f,gui,host};
}
async function save(x){const b=x.gui.document.querySelector('#lia-save-provider');b.click();await until(()=>!b.disabled,'provider save settles');return b;}
test('provider save verifies storage without replacing DOM, context reads, scroll, focus or open details',async t=>{
 const x=await setup(t),doc=x.gui.document,root=doc.querySelector('#dpg-preview-root'),header=root.firstElementChild;
 const main=root.querySelector('.main'),fold=doc.querySelector('#lia-timeout').closest('details'),model=doc.querySelector('#lia-model');
 model.value='persisted-model';doc.querySelector('#lia-api-key').value='synthetic-key';fold.open=true;main.scrollTop=230;model.focus();model.setSelectionRange(2,5);
 const reads=x.f.context.__contextReads;await save(x);
 assert.equal(root.firstElementChild,header);assert.equal(doc.querySelector('#lia-model'),model);assert.equal(doc.activeElement,model);assert.equal(model.selectionStart,2);assert.equal(model.selectionEnd,5);
 assert.equal(main.scrollTop,230);assert.equal(fold.open,true);assert.equal(x.f.context.__contextReads,reads);assert.equal(doc.querySelector('[data-lia-preview-state]'),null);
 assert.equal(doc.querySelector('#lia-api-key').value,'');assert.match(doc.querySelector('#lia-provider-state').textContent,/저장 완료/);
 let stored=await x.f.context.__saveAudit.read();assert.equal(stored.model,'persisted-model');assert.equal(stored.apiKey,'synthetic-key');
 await save(x);stored=await x.f.context.__saveAudit.read();assert.equal(stored.apiKey,'synthetic-key','blank key reuses the refreshed saved baseline');
 doc.querySelector('#lia-clear-api-key').checked=true;await save(x);assert.equal((await x.f.context.__saveAudit.read()).apiKey,'');assert.equal(doc.querySelector('#lia-clear-api-key').checked,false);
 await save(x);assert.equal((await x.f.context.__saveAudit.read()).apiKey,'','cleared secret never returns from an outdated UI baseline');
 assert.deepEqual(x.gui.errors,[]);
});
test('input typed during a pending save remains as an unsaved draft',async t=>{
 const x=await setup(t),doc=x.gui.document,gate=deferred();x.f.context.__saveGate=gate.promise;
 const model=doc.querySelector('#lia-model'),key=doc.querySelector('#lia-api-key');model.value='submitted';key.value='submitted-key';
 const button=doc.querySelector('#lia-save-provider');button.click();assert.equal(button.disabled,true);
 model.value='later-draft';key.value='later-key';gate.resolve();await until(()=>!button.disabled,'held save settles');
 assert.equal(model.value,'later-draft');assert.equal(key.value,'later-key');assert.equal((await x.f.context.__saveAudit.read()).model,'submitted');
 assert.match(doc.querySelector('#lia-provider-state').textContent,/이후 입력 변경은 미저장/);
});
test('storage failure retains the current form and allows another save',async t=>{
 const x=await setup(t),doc=x.gui.document,model=doc.querySelector('#lia-model');model.value='retry-model';
 const original=x.host.pluginStorage.setItem.bind(x.host.pluginStorage);let fail=true;
 x.host.pluginStorage.setItem=async(key,value)=>{if(fail&&key==='dynamicPersonaLorebookGeneratorLLMConfig')throw Error('synthetic save failure');return original(key,value);};
 await save(x);assert.equal(doc.querySelector('#lia-model'),model);assert.equal(model.value,'retry-model');assert.match(doc.querySelector('#dpg-status').textContent,/실패 또는 결과 확인 필요/);
 fail=false;await save(x);assert.equal((await x.f.context.__saveAudit.read()).model,'retry-model');
});
test('lore length setting also saves and verifies the ARG without rebuilding the workspace',async t=>{
 const x=await setup(t),doc=x.gui.document,root=doc.querySelector('#dpg-preview-root'),header=root.firstElementChild;
 doc.querySelector('.sidebar [data-go="make"]').click();const input=doc.querySelector('#lia-max-chars');
 input.value='2300';input.dispatchEvent(new x.gui.dom.window.Event('input',{bubbles:true}));
 const reads=x.f.context.__contextReads,button=doc.querySelector('[data-save-lore-limit]');assert(button);button.click();
 await until(()=>!button.disabled,'lore limit save');assert.equal(String(await x.host.getArgument('max_lore_chars')),'2300');
 assert.equal(root.firstElementChild,header);assert.equal(doc.querySelector('#lia-max-chars'),input);assert.equal(x.f.context.__contextReads,reads);assert.equal(doc.querySelector('#savebar').hidden,true);
});
