'use strict';
// 초안을 응답 모델에 넘긴 뒤 런타임을 정리(purge)해도 결과 화면은 작성된 초안을 계속 보여줘야 한다.
// 실측 2026-11-09: 4단계 모두 성공했는데 화면은 "실행 전 / (초안 없음)" 이었다.
// 계약(evidence-bridge)은 "플러그인이 밖으로 내보내는 런타임 스냅샷/저장소에 파생 초안 본문이 남지
// 않는다"는 것이므로, 패널용 사본은 남기고 getRuntime() 에서만 걷어낸다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradia, sleep } = require('../fixtures/companion_gui_fixture.cjs');

const expose = source => source.replace(
  "    async debugNavigateGui(section = 'overview', tab = 'flow') {",
  "    __testRuntime: Runtime,\n    __testPurge: () => purgeLibEvidenceRuntime(),\n    __testTraceFor: stage => latestTraceForStage(stage),\n    async debugNavigateGui(section = 'overview', tab = 'flow') {");

const DRAFT = '푸딩은 젖은 외투를 벗어 의자에 걸고 창가로 걸어갔다.';

test('purge keeps the draft for the panel but not in the exported runtime', async () => {
  const f = await gradia({ transformSource: expose });
  try {
    const runtime = f.plugin.__testRuntime;
    runtime.finalDraft = DRAFT;
    runtime.stageTrace = [
      { stage: 'shadow_act', ok: true, elapsedMs: 6224, model: 'deepseek-v4.1-flash' },
      { stage: 'aide_character', ok: true, elapsedMs: 5522 },
      { stage: 'aide_world', ok: true, elapsedMs: 8194 },
      { stage: 'aide_plot', ok: true, elapsedMs: 13319 }
    ];

    f.plugin.__testPurge();

    assert.equal(runtime.finalDraft, '', '정리 후 요청 로컬 초안은 비운다');
    assert.equal(runtime.stageTrace.length, 0, '정리 후 실행 추적은 비운다');
    assert.ok(runtime.lastDraftArchive, '정리 전에 요약을 남긴다');
    assert.equal(runtime.lastDraftArchive.draft, DRAFT, '패널용 본문 사본은 남는다');
    assert.equal(runtime.lastDraftArchive.chars, DRAFT.length);
    assert.equal(runtime.lastDraftArchive.stages.length, 4);
    assert.equal(runtime.lastDraftArchive.stages[0].stage, 'shadow_act');

    // 계약: 밖으로 나가는 스냅샷에는 본문이 없다.
    assert.equal(JSON.stringify(f.plugin.getRuntime()).includes('젖은 외투'), false, 'getRuntime() 스냅샷에 본문이 없다');

    const shadow = f.plugin.__testTraceFor('shadow_act');
    assert.ok(shadow?.archived, '정리 뒤에도 단계 상태를 복원한다');
    assert.equal(shadow.ok, true);
    assert.equal(shadow.elapsedMs, 6224);

    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('results', 's');
    await sleep(30);
    const panel = f.doc.querySelector('[data-page="results"] [data-subpanel="s"]');
    assert.ok(panel, 'the shadow results panel renders');
    const body = panel.textContent;
    assert.match(body, /작성한 초안/);
    assert.match(body, /젖은 외투를 벗어/, '정리 뒤에도 패널은 본문을 보여준다');
    assert.match(body, /지난 요청/);
    assert.match(body, /6\.2s/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a purge with nothing written leaves the archive untouched', async () => {
  const f = await gradia({ transformSource: expose });
  try {
    const runtime = f.plugin.__testRuntime;
    runtime.finalDraft = '';
    runtime.stageTrace = [];
    runtime.lastDraftArchive = null;
    f.plugin.__testPurge();
    assert.equal(runtime.lastDraftArchive, null, '아무것도 없으면 빈 아카이브를 만들지 않는다');
    assert.equal(f.plugin.__testTraceFor('shadow_act'), null);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
