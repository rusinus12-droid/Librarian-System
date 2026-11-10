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
  "    __testRuntime: Runtime,\n    __testPurge: () => purgeLibEvidenceRuntime(),\n    __testTraceFor: stage => latestTraceForStage(stage),\n    __testDisplayRuntime: () => runtimeForDisplay(),\n    __testResetResults: () => resetGuiExecutionResults(),\n    __testRecordEvidenceTrace: entry => { const prior = activeLibEvidenceRun; activeLibEvidenceRun = {}; try { recordStageTrace(entry); } finally { activeLibEvidenceRun = prior; } },\n    async debugNavigateGui(section = 'overview', tab = 'flow') {");

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

test('evidence stages keep their own drafts, analysis, edits and materials only for the results UI', async () => {
  const f = await gradia({ transformSource: expose });
  try {
    const runtime = f.plugin.__testRuntime;
    const stages = [['s', 'shadow_act'], ['c', 'aide_character'], ['w', 'aide_world'], ['p', 'aide_plot']];
    for (const [, stage] of stages) {
      const draft = `${DRAFT}\n\n${stage} 전용 본문`;
      f.plugin.__testRecordEvidenceTrace({
        stage, ok: true, elapsedMs: 1200, model: 'results-test',
        systemPrompt: 'PRIVATE_PROMPT_SENTINEL', rawResponse: 'PRIVATE_RESPONSE_SENTINEL',
        parsed: { stage, ok: true, draft: { rp_text: draft },
          twoCallAnalysis: { analysis: { summary: `${stage} 분석`, constraints: ['시점 유지'], risks: [] }, rewriteDirectives: ['대사 보강'] },
          edits: [{ operation: 'insert_after', target: 'p001', content: `${stage} 수정문`, reason: '대사 보강' }],
          patchMeta: { requestedEdits: 1, appliedEdits: 1, blockCountBefore: 1, blockCountAfter: 2 } },
        materialsUsed: { referenceMaterials: [{ kind: 'lore', label: '기록 보존용 로어', chars: 123 }],
          contextMaterials: [], skillMaterials: [], qualityRules: [] }
      });
      const liveTrace = f.plugin.__testTraceFor(stage);
      assert.ok(liveTrace, `${stage} has live evidence results`);
      assert.equal(liveTrace.parsed.draft.rp_text, draft, 'live results are visible during evidence execution');
    }
    assert.equal(runtime.stageTrace.length, 0, 'evidence traces stay out of the replayable runtime');
    runtime.finalDraft = `${DRAFT}\n\n최종 합성본`;
    f.plugin.__testPurge();
    assert.equal(runtime.lastDraftArchive.stages.length, 4);
    for (const [, stage] of stages) {
      const trace = f.plugin.__testTraceFor(stage);
      assert.equal(trace.archived, true);
      assert.equal(trace.parsed.draft.rp_text, `${DRAFT}\n\n${stage} 전용 본문`);
      assert.equal(trace.materialsUsed.referenceMaterials[0].label, '기록 보존용 로어');
      assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_PROMPT_SENTINEL|PRIVATE_RESPONSE_SENTINEL/);
    }
    for (const snapshot of [f.plugin.getRuntime(), f.plugin.__testDisplayRuntime()]) {
      assert.doesNotMatch(JSON.stringify(snapshot), /전용 본문|수정문|기록 보존용 로어|최종 합성본/);
    }
    await f.plugin.openSettingsGui();
    const recent = f.doc.querySelector('[data-page="home"] .list');
    assert.equal(recent.querySelectorAll('.row').length, 4, 'recent execution rows use the same retained results');
    for (const [tab, stage] of stages) {
      await f.plugin.debugNavigateGui('results', tab);
      const panel = f.doc.querySelector(`[data-page="results"] [data-subpanel="${tab}"]`);
      const draftNode = panel.querySelector('.gx-draft');
      if (tab === 's') {
        assert.equal(draftNode.textContent, `${DRAFT}\n\nshadow_act 전용 본문`, 'SHADOW ACT never substitutes the final AIDE draft');
        assert.match(panel.textContent, /기록 보존용 로어/);
      } else {
        assert.match(panel.textContent, new RegExp(`${stage} 분석`));
        assert.match(panel.textContent, /1\/1 적용 · 문단 1→2/);
        assert.match(panel.textContent, /대사 보강/);
        assert.equal(panel.querySelectorAll('.gx-draft')[1].textContent, `${DRAFT}\n\n${stage} 전용 본문`);
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('results prefer the latest recovery, render fallback details and reset for the next request', async () => {
  const f = await gradia({ transformSource: expose });
  try {
    const record = f.plugin.__testRecordEvidenceTrace;
    record({ stage: 'aide_plot', ok: true, parsed: { draft: { rp_text: '처음 수정' } } });
    record({ stage: 'aide_plot', ok: true, parsed: { draft: { rp_text: '복구한 수정' }, analysis: { summary: '복구 분석' } } });
    record({ stage: 'aide_world', ok: false, reason: '모델 응답 실패', fallbackStage: {
      fallback: true, reason: '모델 응답 실패', draft: { rp_text: '유지한 직전 초안' }, analysis: { summary: '세계관 폴백 분석' }
    } });
    f.plugin.__testRuntime.finalDraft = '이전 요청 최종 초안';
    f.plugin.__testPurge();
    assert.equal(f.plugin.__testTraceFor('aide_plot').parsed.draft.rp_text, '복구한 수정');
    await f.plugin.openSettingsGui();
    await f.plugin.debugNavigateGui('results', 'w');
    const panel = f.doc.querySelector('[data-page="results"] [data-subpanel="w"]');
    assert.match(panel.textContent, /폴백/);
    assert.match(panel.textContent, /세계관 폴백 분석/);
    assert.match(panel.textContent, /유지한 직전 초안/);
    f.plugin.__testResetResults();
    f.plugin.__testRuntime.inFlight = true;
    assert.equal(f.plugin.__testTraceFor('aide_plot'), null);
    assert.equal(f.plugin.__testRuntime.lastDraftArchive, null);
    await f.plugin.debugNavigateGui('results', 'p');
    assert.doesNotMatch(f.doc.querySelector('[data-page="results"] [data-subpanel="p"]').textContent, /복구한 수정|복구 분석/);
    await f.plugin.debugNavigateGui('results', 's');
    assert.doesNotMatch(f.doc.querySelector('[data-page="results"] [data-subpanel="s"]').textContent, /이전 요청 최종 초안/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
