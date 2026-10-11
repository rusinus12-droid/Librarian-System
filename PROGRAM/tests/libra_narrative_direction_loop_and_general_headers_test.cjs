'use strict';
// LOCKS TWO REPORTED FIXES.
//
// 1. 작성실 > 서사 방향 (narrative direction):
//    With no chat scope, loadNarrativeDirectionDraft returned early AND re-scheduled a render, while
//    buildNarrativeDirectionPanel re-scheduled the load on EVERY render. Together they formed a
//    render -> load -> render loop that kept cancelling and re-arming the navigation timer, so clicking
//    another 작성실 tab never painted. The empty-scope path must record the refusal and stop.
//    A control proves the fix does not disable the feature: with a scope present the draft still loads
//    and exactly one completion render is requested.
//
// 2. 설정 > 일반 · 진단 (general & diagnostics):
//    The panel rendered its own '일반 · 진단' header card while the settings shell already renders that
//    section header — the same title twice, and the card ate vertical room. The panel must not repeat
//    the header, and the diagnostic windows must keep the expanded reading room.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const between = (a, b) => {
  const i = source.indexOf(a); const j = source.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `source anchors not found: ${a} .. ${b}`);
  return source.slice(i, j);
};
const cssRule = selector => {
  const match = source.match(new RegExp(`\\${selector}\\{[^}]*\\}`));
  assert.ok(match, `css rule must exist: ${selector}`);
  return match[0];
};

// ── 1. 서사 방향: the empty-scope path must not re-schedule a render ───────────────────────────
const narrativeSlices = between('const narrativeDirectionScopeKey = () =>', 'const saveNarrativeDirectionDraft');

const narrativeHarness = scopeKey => {
  const state = {
    renders: 0,
    Gui: {
      narrativeDirectionDraft: null, narrativeDirectionDraftKey: '', narrativeDirectionLoading: false,
      narrativeDirectionError: '', narrativeDirectionLoadSerial: 0
    }
  };
  const context = vm.createContext({
    Gui: state.Gui, text: value => String(value ?? ''),
    // narrativeDirectionDraftFromRecord가 쓰는 GUI 스코프 헬퍼 (프로덕션 L63629-63630).
    guiAsObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    guiAsArray: value => Array.isArray(value) ? value : [],
    LibraMemoryCore: { peekSnapshot: () => ({ scope: { scopeKey } }) },
    queueGuiNavigationRender: () => { state.renders += 1; },
    Promise, JSON, Number, String, Error, console,
    // vm 컨텍스트에서 globalThis는 샌드박스 전역이므로, 플러그인의 `globalThis.__LIBRA__`는
    // 컨텍스트 객체의 __LIBRA__ 프로퍼티로 해석된다.
    __LIBRA__: {
      getNarrativeDirection: async ({ scopeKey: requested }) => ({
        schema: 'libra.narrative_direction.v1', scopeKey: requested, revision: 1, goal: '테스트 목표',
        completionConditions: [], doNotForce: [], softPreferences: [], locked: false, source: 'test', updatedAt: 1
      })
    }
  });
  const { loadNarrativeDirectionDraft } = vm.runInContext(`${narrativeSlices}\n({loadNarrativeDirectionDraft});`, context,
    { filename: 'narrative-direction-slices.js' });
  return { state, load: loadNarrativeDirectionDraft };
};

(async () => {
  // 1a. empty scope: eight render passes must converge, never loop.
  {
    const { state, load } = narrativeHarness('');
    for (let pass = 0; pass < 8; pass += 1) await load();
    assert.equal(state.renders, 0, 'the empty-scope path must never schedule a render — that re-schedule was the loop');
    assert.equal(state.Gui.narrativeDirectionError, '현재 채팅 scope를 확인하지 못했습니다.', 'the empty-scope refusal must still be reported');
    assert.equal(state.Gui.narrativeDirectionLoading, false, 'the loading flag must not get stuck');
    assert.equal(state.Gui.narrativeDirectionDraft, null, 'no draft may be invented without a scope');
  }

  // 1b. control: a real scope still loads, and the completion render is requested exactly once.
  {
    const { state, load } = narrativeHarness('chat-1');
    await load();
    assert.equal(state.Gui.narrativeDirectionDraft?.scopeKey, 'chat-1', 'a real scope must still load the draft');
    assert.equal(state.Gui.narrativeDirectionError, '', 'no error for a loadable scope');
    assert.equal(state.renders, 1, 'the completed load requests exactly one re-render');
    await load();
    assert.equal(state.renders, 1, 'an already-loaded draft is not re-fetched, so no further render is requested');
  }

  // ── 2. 일반 · 진단: one header, and the reading room stays expanded ────────────────────────────
  const generalPanel = between('const buildGeneralSettingsPanel =', 'const buildSharedSettingsShellPanel =');
  assert.ok(!/INTERFACE · DIAGNOSTICS/.test(generalPanel), 'the general panel must not repeat the section eyebrow');
  assert.ok(!/guiEl\('h2'[^)]*일반 · 진단/.test(generalPanel), 'the general panel must not repeat the section title');
  assert.ok(/buildDiagnosticLogPanel\(\)/.test(generalPanel), 'the diagnostic panel itself must remain');

  const sectionDefinition = source.match(/\{ id: 'general', group: 'settings', no: '08', label: '일반 · 진단'[^}]*\}/);
  assert.ok(sectionDefinition, 'the settings shell keeps one section definition, and it carries the header');

  const listRule = cssRule('.libra-diag-list');
  const detailRule = cssRule('.libra-diag-detail-body');
  const layoutRule = cssRule('.libra-diag-layout');
  const rowRule = cssRule('.libra-diag-row');
  const listHeight = Number((listRule.match(/max-height:(\d+)vh/) || [])[1] || 0);
  const detailHeight = Number((detailRule.match(/max-height:(\d+)vh/) || [])[1] || 0);
  assert.ok(listHeight >= 60, `the diagnostic list must keep its expanded height, saw ${listHeight}vh`);
  assert.ok(detailHeight >= 56, `the diagnostic detail must keep its expanded height, saw ${detailHeight}vh`);
  assert.ok(/minmax\(320px,520px\)/.test(layoutRule), 'the detail column must keep its widened range');
  assert.ok(/cursor:pointer/.test(rowRule), 'the row rule must survive — deleting it removes the click affordance');

  console.log(JSON.stringify({ test: 'libra_narrative_direction_loop_and_general_headers', ok: true, listHeight, detailHeight }));
  console.log('PASS narrative direction converged on an empty scope; 일반 · 진단 renders one header and keeps the expanded reading room');
})().catch(error => { console.error(String(error?.stack || error)); process.exit(1); });
