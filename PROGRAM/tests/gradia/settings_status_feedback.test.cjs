'use strict';
// guiSetStatus()가 쓰는 [data-gui-status] 노드가 실제 설정 화면에 있어야 연결 테스트·저장 결과가 보인다.
// 이 노드가 없던 동안 버튼은 조용히 아무 것도 표시하지 않았다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,sleep}=require('../fixtures/companion_gui_fixture.cjs');
test('settings GUI renders the status line the connection test writes to',async()=>{
 const f=await gradia();
 try{
  await f.plugin.openSettingsGui();await sleep(60);
  const status=f.doc.querySelector('[data-gui-status]');
  assert.ok(status,'settings shell must render a [data-gui-status] node');
  const button=f.doc.querySelector('[data-provider-test]');
  assert.ok(button,'a provider connection test button is rendered');
  button.dispatchEvent(new f.w.Event('click',{bubbles:true}));
  await sleep(120);
  assert.match(status.textContent,/연결 테스트/);
  assert.equal(status.classList.contains('err'),true,'a failed test must be reported as an error');
 }finally{await f.close();}
});
