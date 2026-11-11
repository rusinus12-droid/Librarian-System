'use strict';
// 실행 결과 화면은 모델 컨텍스트를 맞추려고 버린 것을 그대로 보여줘야 한다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,sleep}=require('../fixtures/companion_gui_fixture.cjs');
const expose=source=>source.replace("    async debugNavigateGui(section = 'overview', tab = 'flow') {",
  "    __testRuntime: Runtime,\n    async debugNavigateGui(section = 'overview', tab = 'flow') {");

test('the results page lists what the context ladder dropped',async()=>{
  const f=await gradia({transformSource:expose});
  try{
    f.plugin.__testRuntime.lastContextDegradation={at:Date.now(),stage:'shadow_act',
      dropped:['output_tokens','shared_reference','memory_evidence'],contextLimit:16000,
      outputBefore:10644,outputAfter:3727,referenceRemovedChars:18000,evidenceChars:17477};
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('results','s');
    await sleep(30);
    const panel=f.doc.querySelector('[data-page="results"] [data-subpanel="s"]');
    assert.ok(panel,'the shadow results panel renders');
    const text=panel.textContent;
    assert.match(text,/컨텍스트 조정/);
    assert.match(text,/출력 토큰 축소/);
    assert.match(text,/공유 참조 축소/);
    assert.match(text,/기억 증거 생략/);
    assert.match(text,/10,644 → 3,727/);
    assert.match(text,/18,000자 제외/);
    assert.match(text,/17,477자 미주입/);
    assert.match(text,/한도 16,000 토큰/);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
