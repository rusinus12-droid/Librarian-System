'use strict';
// Run results page: the SHADOW ACT draft is shown as prose (not escaped JSON), materials
// are grouped, memory is broken down per owner, and each AIDE shows analysis and edits.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,sleep}=require('./fixtures/companion_gui_fixture.cjs');

const expose=source=>source.replace('    async debugNavigateGui(section = \'overview\', tab = \'flow\') {',
  '    __testRuntime: Runtime, __testSetLibSelection: value => { libReadSelection = value; },\n    async debugNavigateGui(section = \'overview\', tab = \'flow\') {');

test('results page renders readable draft, grouped materials, memory owners and AIDE edits',async()=>{
 const f=await gradia({transformSource:expose});
 try{
  const draft='6월 13일, 토요일.\n\n5층 복도는 난방이 아직 돌지 않아 발밑이 차가웠다.';
  const usage={schema:'gradia_stage_material_usage_v1',stage:'shadow_act',referenceMaterials:[
    {kind:'persona',label:'푸딩',chars:1963},{kind:'character_definition',label:'description',chars:5801},
    {kind:'lore',label:'사이토 모에',chars:3990,evidenceMode:'relevant_passages',passageCount:4}],
   contextMaterials:[{kind:'recent_chat',label:'최근 완료 U+A 8턴',chars:78173,turns:8}],
   skillMaterials:[{label:'dialogue-scene-execution'}],qualityRules:[{label:'scene-performance'}],
   referenceBudget:{usedChars:74811,effectiveBudgetChars:96000,omittedChars:0}};
  const R=f.plugin.__testRuntime;
  R.stageTrace=[
   {stage:'shadow_act',ok:true,elapsedMs:19724,model:'m',parsed:{draft:{rp_text:draft}},materialsUsed:usage},
   {stage:'aide_character',ok:true,elapsedMs:14000,model:'m',parsed:{analysis:{summary:'모에의 내적 반응이 부족하다.',constraints:['모에는 끈을 숨긴다.'],risks:['인물 구분이 흐려진다.'],rewrite_directives:['p069 뒤에 내적 반응 추가']},
    edits:[{operation:'insert_after',target:'p069',content:'모에는 대답하지 않았다.',reason:'내적 논리 보강'}],
    patchMeta:{requestedEdits:1,appliedEdits:1,blockCountBefore:71,blockCountAfter:72},draft:{rp_text:draft+'\n\n모에는 대답하지 않았다.'}}}
  ];
  R.finalDraftMeta={externalEvidence:true,libReadStatus:'ready'};
  f.plugin.__testSetLibSelection({selectedItems:2,items:[
   {owner:'libra',source:'canonical',key:'mem_26',chars:120,preview:'T26–30 라운지 소동 정본'},
   {owner:'hayaku',source:'packet',key:'t31',chars:80,preview:'모에 손목 소매'}]});
  await f.plugin.openSettingsGui();await f.plugin.debugNavigateGui('results','s');await sleep(30);
  const page=f.doc.querySelector('[data-page="results"]');
  const shadow=page.querySelector('[data-subpanel="s"]');
  const draftNode=shadow.querySelector('.gx-draft');
  assert.equal(draftNode.textContent,draft,'draft is plain prose with real line breaks');
  assert.doesNotMatch(shadow.textContent,/"rp_text"|\\n/);
  const owners=[...shadow.querySelectorAll('.gx-owner')].map(node=>node.querySelector('strong').textContent);
  assert.deepEqual(owners,['LIBRA','HAYAKU','Flashback']);
  assert.match(shadow.querySelectorAll('.gx-owner')[0].textContent,/라운지 소동 정본/);
  assert.match(shadow.querySelectorAll('.gx-owner')[2].textContent,/사용 안 함/);
  const titles=[...shadow.querySelectorAll('.gx-sec > summary strong')].map(node=>node.textContent);
  for(const title of ['작성한 초안','페르소나 · 캐릭터 정의','로어','대화 · 문맥','Skill · 품질 규칙'])assert.ok(titles.includes(title),title);
  const aide=page.querySelector('[data-subpanel="c"]');
  assert.match(aide.textContent,/모에의 내적 반응이 부족하다/);
  assert.match(aide.textContent,/1\. 뒤에 추가 · p069/);
  assert.match(aide.textContent,/1\/1 적용 · 문단 71→72/);
  assert.doesNotMatch(aide.textContent,/"schema"|"analysis"/);
  assert.match(page.querySelector('[data-subpanel="p"]').textContent,/실행 기록 없음|실행 전|대기/);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
