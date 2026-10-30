'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,sleep}=require('../fixtures/companion_gui_fixture.cjs');
const expose=source=>source.replace("    async debugNavigateGui(section = 'overview', tab = 'flow') {",
  "    __testRuntime: Runtime,\n    async debugNavigateGui(section = 'overview', tab = 'flow') {");
test('production results page identifies a whole recovery separately from paragraph edits',async()=>{
 const f=await gradia({transformSource:expose});
 try{
  const body='The archivist found the blue ledger and stopped at the doorway.';
  f.plugin.__testRuntime.stageTrace=[{stage:'aide_plot',ok:true,parsed:{analysis:{summary:'The candidate contained only editing status.'},
    draft_kind:'full_draft_recovery',patchMeta:{mode:'full_draft_recovery',requestedEdits:1,appliedEdits:1,blockCountBefore:4,blockCountAfter:1},
    edits:[{operation:'replace_draft',target:'draft',reason:'A scene was missing from the whole candidate.',content:body}],draft:{rp_text:body}}}];
  await f.plugin.openSettingsGui();await f.plugin.debugNavigateGui('results','p');await sleep(30);
  const panel=f.doc.querySelector('[data-page="results"] [data-subpanel="p"]');
  assert.match(panel.textContent,/전면 교체 · 1\/1 적용 · 문단 4→1/);
  assert.match(panel.textContent,/1\. 전면 교체 · draft/);assert.ok(panel.textContent.includes(body));assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
