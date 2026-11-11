'use strict';
// 비앙카 투입 설정은 화면에 실제로 있어야 하고, 켜면 저장 경로까지 이어져야 한다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,sleep}=require('../fixtures/companion_gui_fixture.cjs');
test('비앙카 투입 toggle renders, marks the GUI dirty, and persists on save',async()=>{
 const f=await gradia();
 try{
  await f.plugin.openSettingsGui();await sleep(80);
  const box=f.doc.querySelector('[data-existing-response-field="biancaInject"]');
  assert.ok(box,'the 비앙카 투입 toggle must be rendered in the settings shell');
  assert.match(box.closest('.setting, .row')?.textContent||'',/비앙카 투입/,'the label must read 비앙카 투입');
  assert.equal(box.checked,false,'the switch starts off');
  box.checked=true;box.dispatchEvent(new f.w.Event('change',{bubbles:true}));
  await sleep(60);
  assert.equal(f.plugin.debugGuiStateInfo().dirty,true,'toggling must mark the GUI dirty');
  f.doc.querySelector('#savebar [data-save]').click();
  await sleep(200);
  assert.equal((await f.plugin.getRuntimeSettings()).bianca_inject,'true','saving must persist the switch');
  assert.equal(f.plugin.debugGuiStateInfo().dirty,false,'the save bar must settle after saving');
 }finally{await f.close();}
});
