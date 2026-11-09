'use strict';
// GUI 정리 4건: 인풋 관리자 적용 범위/확인 방식, 사용 안 함 선택지, 세계관 AIDE '실행 전' 카드,
// 한 가지뿐인 전달/마무리 선택지 카드가 모두 화면에서 사라졌는지 확인한다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,sleep}=require('../fixtures/companion_gui_fixture.cjs');

test('input manager scope/confirmation fields and the on/off choices are gone',async()=>{
  const f=await gradia();
  try{
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('home','overview');
    await sleep(30);
    const doc=f.doc;
    assert.equal(doc.querySelector('#q-input'),null,'quick setup no longer offers an input on/off choice');
    const steps=[...doc.querySelectorAll('[data-page="home"] .q-step .q-step__no')].map(n=>n.textContent.trim());
    assert.deepEqual(steps,['1','2','3','4'],`quick setup steps are renumbered: ${steps}`);
    await f.plugin.debugNavigateGui('pipeline','flow');
    await sleep(30);
    assert.equal(doc.querySelector('#inp-mode'),null,'the stage panel no longer offers the same choice');
    assert.equal(doc.querySelectorAll('[data-input-assist-field="scope"]').length,0,'적용 범위 field removed');
    assert.equal(doc.querySelectorAll('[data-input-assist-field="confirmation"]').length,0,'확인 방식 field removed');
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('the single-option transfer cards and the empty AIDE banner are gone',async()=>{
  const f=await gradia();
  try{
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('home','overview');
    await sleep(30);
    const text=f.doc.body.textContent;
    assert.ok(!text.includes('정보 전달'),'single-option 정보 전달 card removed');
    assert.ok(!text.includes('응답 마무리'),'single-option 응답 마무리 card removed');
    assert.ok(text.includes('전달 방식'),'one line explains the fixed transfer behaviour');
    await f.plugin.debugNavigateGui('pipeline','world');
    await sleep(30);
    const banner=f.doc.querySelector('.stage-detail[data-detail="world"] .banner');
    assert.ok(banner,'the world stage still has its banner element');
    assert.equal(banner.hidden,true,'an unexecuted stage hides its 실행 전 banner');
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
