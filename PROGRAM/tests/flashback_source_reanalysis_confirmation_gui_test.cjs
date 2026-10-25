'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ownerFixture,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const {waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const {configure,syntheticFetch}=require('./helpers/unload_recall_contract_fixture.cjs');
async function start(settings=null){
 const f=await ownerFixture('flashback'),gui=createColdStartGuiDocument();
 try{
  if(settings){f.r.host.nativeFetch=syntheticFetch;await configure(f.r,'configured');await f.api.saveSettings({...await f.api.loadSettings(),...settings});}
  Object.assign(f.r.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});
  f.r.host.showContainer=async()=>true;f.r.host.hideContainer=async()=>true;
  await f.api.showUi();const root=gui.document.getElementById('vector-rag-memory-root');
  assert.ok(root);await root.querySelector('[data-go="care"]').fire('click');
  await waitFor(()=>root.querySelectorAll('#fbReanalysisRanges input').length===1,'stored turn inventory');
  const input=root.querySelector('#fbReanalysisRanges input'),run=root.querySelector('#fbReanalysisRun'),status=root.querySelector('#fbSourceEditStatus');
  input.checked=true;input.dispatchEvent(new gui.dom.window.Event('change',{bubbles:true}));assert.equal(run.disabled,false);
  const before=JSON.stringify(await f.records());
  return {f,gui,root,run,status,before,
   open:async()=>{run.click();return waitFor(()=>gui.document.querySelector('[role="dialog"][aria-describedby]'),'source replacement confirmation');},
   same:async()=>assert.equal(JSON.stringify(await f.records()),before),
   close:async()=>{await f.dispose();gui.dom.window.close();}};
 }catch(error){await f.dispose();gui.dom.window.close();throw error;}
}
for(const action of ['button','escape','close','navigate'])test('Flashback '+action+' cancellation retains saved original and makes no model calls',async()=>{
 const s=await start();try{
  const box=await s.open();assert.match(box.textContent,/T1/);assert.match(box.textContent,/LLM 호출은 없으며, 원문 저장 단계의 임베딩 호출은 0회/);assert.match(box.textContent,/검색용 임베딩/);
  assert.equal(s.gui.document.activeElement,box.querySelector('button'),'default focus is cancellation');await s.same();
  if(action==='button')box.querySelector('button').click();
  if(action==='escape')s.gui.document.dispatchEvent(new s.gui.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  if(action==='close')await s.f.api.closeUi();
  if(action==='navigate')await s.root.querySelector('[data-go="vault"]').fire('click');
  await waitFor(()=>!s.gui.document.querySelector('[role="dialog"][aria-describedby]'),'cancelled confirmation');await s.same();assert.equal(s.f.calls(),0);assert.deepEqual(s.gui.errors,[]);
 }finally{await s.close();}
});
test('Flashback approval replaces only the selected current source and reports raw-save separately',async()=>{
 const s=await start();try{
  s.f.edit(NEW);const box=await s.open();const approve=[...box.querySelectorAll('button')].at(-1);approve.click();approve.click();
  await waitFor(()=>/원문을 저장했습니다/.test(s.status.textContent),'verified source replacement');assert.match(s.status.textContent,/자동 임베딩은 예약되지 않았습니다/);assert.match(s.status.textContent,/별도로 준비/);
  assert.ok(JSON.stringify(await s.f.records()).includes(NEW));assert.equal(s.f.chat.message[1].data,NEW);assert.equal(s.f.calls(),0);assert.deepEqual(s.gui.errors,[]);
 }finally{await s.close();}
});
for(const [name,settings,notice,queued]of[
 ['automatic embedding enabled',{embeddingAutoProcess:true},/자동 예약됩니다.*모델 사용량이 발생할 수 있으며/,true],
 ['automatic embedding disabled',{embeddingAutoProcess:false},/자동 임베딩이 꺼져 있습니다/,false],
 ['embedding disabled',{embeddingAutoProcess:true,embeddingEnabled:false},/임베딩 사용이 꺼져 있습니다/,false]
])test('Flashback confirmation and result disclose '+name,async()=>{
 const s=await start(settings);try{
  s.f.edit(NEW);const box=await s.open();assert.match(box.textContent,notice);assert.match(box.textContent,/원문 저장 단계의 임베딩 호출은 0회/);
  assert.match(s.root.querySelector('[data-reanalysis-fold] .card__desc').textContent,/저장 후 자동 예약되며.*모델 사용량이 발생할 수 있습니다/);
  [...box.querySelectorAll('button')].at(-1).click();await waitFor(()=>/원문을 저장했습니다/.test(s.status.textContent),'saved raw result');
  assert.match(s.status.textContent,queued?/임베딩을 자동 예약했습니다.*진행 결과/:/자동 임베딩은 예약되지 않았습니다.*별도로 준비/);
  assert.doesNotMatch(s.status.textContent,/임베딩.*완료/);assert.ok(JSON.stringify(await s.f.records()).includes(NEW));assert.equal(s.f.calls(),0);assert.deepEqual(s.gui.errors,[]);
 }finally{await s.close();}
});
test('Flashback changed message identity before preview requires refreshing the displayed selection',async()=>{
 const s=await start();try{
  s.f.chat.message[1].id=s.f.chat.message[1].chatId='replacement-message';s.run.click();
  await waitFor(()=>/구간 목록을 새로고침/.test(s.status.textContent),'stale checkbox rejection');assert.equal(s.gui.document.querySelector('[role="dialog"][aria-describedby]'),null);await s.same();assert.equal(s.f.calls(),0);
 }finally{await s.close();}
});
test('Flashback changed identity after confirmation is opened cannot replace the previous saved source',async()=>{
 const s=await start();try{
  const box=await s.open();s.f.chat.message[1].id=s.f.chat.message[1].chatId='replacement-message';[...box.querySelectorAll('button')].at(-1).click();
  await waitFor(()=>/재분석 중단/.test(s.status.textContent),'execution freshness rejection');await s.same();assert.equal(s.f.calls(),0);
 }finally{await s.close();}
});
