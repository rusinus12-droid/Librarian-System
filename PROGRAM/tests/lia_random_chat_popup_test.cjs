'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{for(let n=0;n<150;n++){if(fn())return;await pause(20);}throw Error('UI did not settle');};
test('chat popup offers three candidates, saves all idempotently, binds adoption and supports countdown cancellation/expiry',async t=>{
 let open;const f=await createFixture('official',{configureApi(api){api.registerButton=async(d,fn)=>{if(d.location==='chat'){assert.equal(d.name,'리아로 랜덤 페르소나 생성하기');open=fn;}return true;};},transformSource:s=>s
  .replace('  async function generateRandomCandidates(contextOptions = null) {',`  async function generateRandomCandidates(contextOptions = null) { preservedRandomCandidates=[1,2,3].map(n=>({id:'c'+n,name:'Candidate '+n})); return {candidates:preservedRandomCandidates};`)
  .replace('  async function runLLMRewrite(contextOptions = null) {',`  async function runLLMRewrite(contextOptions = null) { const c=preservedRandomCandidates.find(c=>c.id===preservedSelectedRandomCandidateId);setGeneratedOutputText(JSON.stringify({generationMode:GENERATION_MODE_RANDOM,generationId:c.id,personaName:c.name,personaPrompt:'Full persona for '+c.name,personaSpec:{name:c.name}}));return {};`)});
 const gui=createColdStartGuiDocument();Object.assign(f.context,{document:gui.document,window:gui.dom.window});t.after(async()=>{await f.dispose();gui.dom.window.close();});assert(open);
 const original=f.liveChat.bindedPersona;await open();let popup=gui.document.querySelector('#lia-random-chat-popup');assert.equal(popup.querySelectorAll('[data-save]').length,3,popup.textContent);
 if(process.env.LIA_RANDOM_POPUP_HTML)require('node:fs').writeFileSync(process.env.LIA_RANDOM_POPUP_HTML,gui.dom.serialize());
 popup.querySelector('[data-all]').click();await until(()=>!popup.querySelector('[data-adopt]').disabled);assert.equal(f.db.personas.filter(p=>p.id.startsWith('lia-persona-generated::')).length,3,popup.textContent+JSON.stringify(f.db.personas));assert.equal(f.liveChat.bindedPersona,original);
 assert.equal(popup.querySelector('[data-all]').disabled,true);popup.querySelector('[data-adopt="0"]').click();await until(()=>!popup.querySelector('[data-countdown]').hidden);
 assert.notEqual(f.liveChat.bindedPersona,original);assert.match(popup.querySelector('[data-countdown] span').textContent,/10초/);
 popup.querySelector('[data-cancel-close]').click();await pause(250);assert.equal(popup.isConnected,true);assert.equal(popup.querySelector('[data-countdown]').hidden,true);
 popup.querySelector('[data-adopt="1"]').click();await until(()=>!popup.querySelector('[data-countdown]').hidden);
 const vm=require('node:vm');vm.runInContext('Date.now=()=>9999999999999',f.context);await until(()=>!popup.isConnected);
 assert.equal(f.db.personas.filter(p=>p.id.startsWith('lia-persona-generated::')).length,3);assert.deepEqual(gui.errors,[]);
});
test('closing during candidate generation never reopens or saves late candidates',async t=>{
 let open,resolve,shown=0;const gate=new Promise(r=>resolve=r);
 const f=await createFixture('official',{configureApi(api){api.registerButton=async(d,fn)=>{if(d.location==='chat')open=fn;return true;};api.showContainer=async()=>{shown++;};},transformSource:s=>s.replace('  async function generateRandomCandidates(contextOptions = null) {',`  async function generateRandomCandidates(contextOptions = null) { await globalThis.__candidateGate;return {candidates:[1,2,3].map(n=>({id:'c'+n,name:'C'+n}))};`)});
 const gui=createColdStartGuiDocument();Object.assign(f.context,{document:gui.document,window:gui.dom.window,__candidateGate:gate});t.after(async()=>{await f.dispose();gui.dom.window.close();});
 const before=JSON.stringify(f.db.personas),pending=open();await until(()=>gui.document.querySelector('[data-close]'));gui.document.querySelector('[data-close]').click();await open();assert.equal(shown,1);resolve();await pending;assert.equal(gui.document.querySelector('#lia-random-chat-popup'),null);assert.equal(JSON.stringify(f.db.personas),before);
});
