'use strict';
// Run results page: the SHADOW ACT draft is shown as prose (not escaped JSON), materials
// are grouped, memory is broken down per owner, and each AIDE shows analysis and edits.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gradia,sleep}=require('./fixtures/companion_gui_fixture.cjs');

const expose=source=>source.replace('    async debugNavigateGui(section = \'overview\', tab = \'flow\') {',
  '    __testRuntime: Runtime,\n    async debugNavigateGui(section = \'overview\', tab = \'flow\') {');

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
  R.lastMemoryRecall={owners:[
   {owner:'libra',status:'ok',chars:120,content:'T26–30 라운지 소동 정본'},
   {owner:'hayaku',status:'ok',chars:80,content:'모에 손목 소매'}]};
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

test('기타 참조 extracts character auxiliary prompts, preserves GRADIA active cards/locks across repack, and renders non-empty section in results view',async()=>{
 const f=await gradia({transformSource:expose});
 try{
  const scopeKey='aux-ref-scope';
  f.plugin.debugSetActiveScope(scopeKey,'푸딩');
  const settings={
   enableBodyStateAide:true,
   enableForcedBondAide:true,
   bodyStateCards:{[scopeKey]:[{id:'bs-1',name:'천하연',gender:'female',constitution:'생리 5일째'}]},
   forcedBondCards:{[scopeKey]:[{id:'fb-1',from:'푸딩',to:'천하연',stage:'expressed'}]},
   npcDisposition:{[scopeKey]:{default:'',npcs:[{id:'n-1',name:'천하연',level:'like'}]}}
  };
  const built=f.plugin.debugBuildCanonicalReferencePacket({
   settings,
   references:{authorNote:true,persona:true,characterDescription:true,characterLorebook:true,moduleLorebook:true},
   source:{
    character:{
     description:'기본 캐릭터 설명',
     postHistoryInstructions:'PHI_SENTINEL 항상 인물의 호흡을 묘사하라.',
     replaceGlobalNote:'GLOBAL_NOTE_SENTINEL',
     additionalText:'ADDITIONAL_TEXT_SENTINEL',
     depth_prompt:{prompt:'DEPTH_PROMPT_SENTINEL'}
    }
   },
   recent:{latestUser:'문을 연다.'}
  });
  const aux=built.packet.references.auxiliary||[];
  assert.equal(aux.length,4,'character auxiliary fields extracted into packet.references.auxiliary');
  assert.ok(aux.some(item=>item.label==='Post-History 지침'));
  assert.ok(aux.some(item=>item.label==='캐릭터 글로벌 노트'));
  assert.ok(aux.some(item=>item.label==='캐릭터 추가 설명'));
  assert.ok(aux.some(item=>item.label==='심층 지침 (Depth Prompt)'));

  const recent={
   latestUser:'천하연의 손을 잡는다.',
   completeTurnsText:'푸딩과 천하연이 대화했다.',
   recentTurnCount:1,
   othersInfo:'OTHERS_INFO_BODY',
   systemContext:'SYSTEM_CTX_BODY',
   continuityLedgerBlock:'LEDGER_BODY',
   continuityLedger:{currentCast:['푸딩','천하연']},
   relationshipCanonLockBlock:'CANON_LOCK_BODY',
   relationshipCanonLock:{facts:['동기 관계']},
   referencePacket:built.packet
  };
  const usage=f.plugin.debugBuildStageMaterialUsage({stageName:'shadow_act',recent,settings});
  const reconciled=f.plugin.debugReconcileStageMaterialUsage(usage,built.packet);
  const kinds=reconciled.referenceMaterials.map(item=>item.kind);
  assert.ok(kinds.includes('auxiliary'),'packet auxiliary survives reconcile');
  assert.ok(kinds.includes('continuity_ledger'),'continuity ledger recorded');
  assert.ok(kinds.includes('canon_lock'),'canon lock recorded');
  assert.ok(kinds.includes('gradia_card'),'active 이 채팅 cards recorded');
  assert.equal(JSON.stringify(reconciled).includes('LEDGER_BODY'),false,'nonPacketAuxiliary never leaks raw prompt text');
  assert.equal(JSON.stringify(reconciled).includes('CANON_LOCK_BODY'),false,'canon lock never leaks raw prompt text');

  const R=f.plugin.__testRuntime;
  R.stageTrace=[{stage:'shadow_act',ok:true,elapsedMs:100,model:'m',parsed:{draft:{rp_text:'초안 본문'}},materialsUsed:reconciled}];
  await f.plugin.openSettingsGui();
  await f.plugin.debugNavigateGui('results','s');
  await sleep(30);
  const shadow=f.doc.querySelector('[data-page="results"] [data-subpanel="s"]');
  const secs=[...shadow.querySelectorAll('.gx-sec')];
  const findSec=title=>secs.find(s=>s.querySelector('summary strong')?.textContent===title);
  const otherSec=findSec('기타 참조');
  const ctxSec=findSec('대화 · 문맥');
  assert.ok(otherSec,'기타 참조 section exists');
  assert.equal(otherSec.open,true,'기타 참조 auto-opens when non-empty');
  assert.match(otherSec.querySelector('summary .gx-meta').textContent,/^(?:11|12|13)개$/);
  assert.match(otherSec.textContent,/Post-History 지침/);
  assert.match(otherSec.textContent,/장면 연속성 원장/);
  assert.match(otherSec.textContent,/관계 정본 잠금/);
  assert.match(otherSec.textContent,/이 채팅 · NPC 반응 경향성/);
  assert.match(otherSec.textContent,/Others Info \/ 보조 패킷/);
  assert.match(otherSec.textContent,/RisuAI 시스템\/요청 문맥/);
  assert.doesNotMatch(ctxSec.textContent,/Others Info \/ 보조 패킷|RisuAI 시스템\/요청 문맥/,'aux contexts moved out of 대화 · 문맥 without duplication');
  assert.match(ctxSec.textContent,/최근 완료 U\+A 1턴/);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
