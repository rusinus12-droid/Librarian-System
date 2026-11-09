'use strict';
// 초안을 응답 모델에 넘긴 뒤 런타임을 정리(purge)해도, 결과 화면은 무엇이 작성됐는지 계속 보여줘야 한다.
// 실측 2026-11-09: 4단계 모두 성공했는데 화면은 "실행 전 / (초안 없음)" 이었다.
// 단, 런타임이 초안 본문을 보관하면 안 된다(evidence-bridge 계약). 자수·해시·단계 요약만 남긴다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradia, sleep } = require('../fixtures/companion_gui_fixture.cjs');

const expose = source => source.replace(
  "    async debugNavigateGui(section = 'overview', tab = 'flow') {",
  "    __testRuntime: Runtime,\n    __testPurge: () => purgeLibEvidenceRuntime(),\n    __testTraceFor: stage => latestTraceForStage(stage),\n    async debugNavigateGui(section = 'overview', tab = 'flow') {");

const DRAFT = '푸딩은 젖은 외투를 벗어 의자에 걸고 창가로 걸어갔다.';

test('purge keeps a content-free summary and the panel renders it', async () => {
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
    assert.equal(runtime.lastDraftArchive.chars, DRAFT.length);
    assert.equal('draft' in runtime.lastDraftArchive, false, '초안 본문은 보관하지 않는다');
    assert.ok(runtime.lastDraftArchive.hash.length > 0, '본문 대신 해시를 남긴다');
    assert.equal(runtime.lastDraftArchive.stages.length, 4);
    assert.equal(runtime.lastDraftArchive.stages[0].stage, 'shadow_act');
    assert.equal(JSON.stringify(f.plugin.getRuntime()).includes('젖은 외투'), false, '런타임 스냅샷에도 본문이 없다');

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
    assert.match(body, /전달 후 본문 정리됨/);
    assert.match(body, /단계 완료/);
    assert.match(body, /6\.2s/);
    assert.equal(body.includes('젖은 외투'), false, '패널에도 본문을 되살리지 않는다');
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
