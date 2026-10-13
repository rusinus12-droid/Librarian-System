'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const wait=async(fn)=>{const start=Date.now();while(Date.now()-start<10000){const found=fn();if(found)return found;await new Promise(r=>setTimeout(r,10));}throw Error('public editor did not appear');};
test('composed public settings opens real input editor, applies once, previews locally and preserves rules on reopen',async()=>{
 const f=await fixture(),dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true});
 Object.assign(f.r.context,{document:dom.window.document,window:dom.window,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)});
 const doc=dom.window.document; const diagnostics=[]; f.r.context.console={log:(...v)=>diagnostics.push(v),info(){},debug(){},warn:(...v)=>diagnostics.push(v),error:(...v)=>diagnostics.push(v)};
 try{
  console.log('COMPOSED_EDITOR_LOAD '+JSON.stringify({path:process.env.LIBRA_TEST_PLUGIN||'source',sha256:crypto.createHash('sha256').update(f.r.source).digest('hex')}));
  await f.r.api.setSourceEditRules({version:1,ignoredTags:[],unwrapTags:[],sourceTags:[],controls:[]});
  assert.equal(await f.r.api.openSettingsGui(),true);
  // Post-GUI navigation: 설정 nav -> 참고 자료 subtab -> 분석할 내용(section id source_edits).
  (await wait(()=>doc.querySelector('[data-go="settings"]'))).click();
  (await wait(()=>doc.querySelector('[data-subtab="ref"]'))).click();
  (await wait(()=>[...doc.querySelectorAll('nav.tabs button,.tabs button')].find(node=>node.textContent.trim()==='분석할 내용'))).click();
  const list=await wait(()=>doc.querySelector('[data-source-input-list]'));
  assert.equal(doc.querySelectorAll('[data-source-input-list]').length,1);
  const before=f.control.calls.length,last=list.querySelector('[data-source-input-row]:last-child'),input=last.querySelector('[data-rule-value]');
  input.value='decoration';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  const apply=doc.querySelector('[data-source-input-apply]');await apply.onclick();
  assert.deepEqual(Array.from(f.r.api.getSourceEditRules().ignoredTags),['decoration']);
  await doc.querySelector('[data-source-input-preview]').onclick();
  assert.equal(f.control.calls.length,before,'local preview must not call model');
  assert.equal(doc.querySelectorAll('[data-source-input-list]').length,1);
  assert.match(doc.querySelector('[data-source-input-status]').textContent,/미리보기|적용|현재|완료|내용/);
  await f.r.api.closeSettingsGui();await f.r.api.openSettingsGui();
  (await wait(()=>doc.querySelector('[data-go="settings"]'))).click();
  (await wait(()=>doc.querySelector('[data-subtab="ref"]'))).click();
  (await wait(()=>[...doc.querySelectorAll('nav.tabs button,.tabs button')].find(node=>node.textContent.trim()==='분석할 내용'))).click();await wait(()=>doc.querySelector('[data-source-input-list]'));
  assert.deepEqual(Array.from(f.r.api.getSourceEditRules().ignoredTags),['decoration']);
  assert.equal(typeof f.r.api.getSourceEditSyncStatus,'undefined');assert.equal(typeof f.r.api.setSourceEditTrackingMode,'undefined');
 }catch(error){console.log('DOM_DIAGNOSTICS',JSON.stringify({text:doc.body.textContent.slice(0,4000),html:doc.body.innerHTML.slice(0,4000),logs:diagnostics}));throw error;}finally{await f.r.api.closeSettingsGui();await f.r.cleanup();dom.window.close();}
});
