'use strict';
// Gate: CSS 규칙이 **실제로 계산되는지** — 무력(inert) 선언과 죽은 마크업을 잡는다.
//
// 배경 (실측): 이 리포에는 jsdom/playwright 같은 렌더러가 없다. 그래서 레이아웃 결함을
//   "마크업에 그 클래스가 있다"로만 판정해 왔고, 그 결과 **계산되지 않는 규칙**이 통과했다.
//   대표 사례(수리 전, 커밋 이전):
//
//     780px 블록 A:  .tabs{display:grid; grid-template-columns:repeat(4,1fr)}
//     780px 블록 B:  .tabs{flex-direction:row; flex-wrap:wrap}      ← 부모가 grid 라 **무력**
//     780px 블록 B:  .side-sec{display:flex; align-items:center; gap:6px}  ← **flex-wrap 없음**
//
//   즉 그룹 항목이 감기지 않는데, 어느 게이트도 이걸 보지 않았다
//   (`libra_gui_ux_integration_test` 는 `display:flex;flex-direction:column` 문자열만 본다).
//
// 계약:
//   C1 부모가 grid 인데 자식이 flex-wrap 없이 flex 면 **무력**이다 → 0건이어야 한다
//   C2 같은 브레이크포인트에서 같은 선택자+속성을 두 번 선언하면 앞은 죽은 코드다 → 보고만
//   C3 `hidden` 인데 부활 코드가 없는 마크업을 **사실로** 남긴다 (판단은 사람이)
//   C4 도구가 cascade 를 실제로 계산한다 (파서가 규칙을 찾았는지 — 빈 결과로 통과 금지)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'tools/libra_css_cascade_probe.cjs');

const assertions = [];
const assert = (name, ok, details = {}) => assertions.push({ name, ok: !!ok, details });

// ── C4: 파서가 실제로 규칙을 찾았는지 (빈 결과로 통과 금지) ──
let probe = null;
try {
  const out = execFileSync(process.execPath, [PROBE], { timeout: 60000, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  probe = JSON.parse(out);
} catch (e) {
  assert('probe_ran', false, { error: String((e && e.message) || e).slice(0, 200) });
}
if (probe) {
  assert('probe_ran', probe.ok === true, { ok: probe.ok });
  assert('probe_parsed_css_rules',
    Number(probe.cssRuleCount) > 300,
    { cssRuleCount: probe.cssRuleCount,
      note: '규칙을 못 찾으면 아래 단언들이 **공허하게** 통과한다 (빈 결과로 통과 금지)' });
  assert('probe_found_breakpoints',
    Array.isArray(probe.mediaBreakpoints) && probe.mediaBreakpoints.includes('780'),
    { mediaBreakpoints: probe.mediaBreakpoints });

  // ── C1: 무력 flex 는 0건 (이번에 수리한 결함) ──
  assert('no_inert_flex_in_navigation',
    (probe.inertFlex || []).length === 0,
    { inertFlex: probe.inertFlex,
      note: '★ 부모가 grid 인데 자식 .side-sec 가 flex-wrap 없이 flex 면 항목이 감기지 않는다' });

  // ── C1b: 780px 사이드바 그룹이 실제로 감기는지 (수리 지점 직접 확인) ──
  const gui = fs.readFileSync(path.join(ROOT, 'src/parts/15-gui-and-exports.js'), 'utf8');
  const sideSec = (() => {
    //   780px 블록의 .side-sec 선언을 찾는다 (여러 블록 중 flex-wrap 이 있는 것)
    const blocks = [...gui.matchAll(/\.side-sec\{([^}]*)\}/g)].map(m => m[1]);
    return blocks.find(d => /display\s*:\s*flex/.test(d)) || '';
  })();
  assert('mobile_sidebar_groups_wrap',
    /flex-wrap\s*:\s*wrap/.test(sideSec),
    { sideSec, note: '★ 780px 에서 그룹 4개가 세로로 쌓이므로 각 그룹 항목은 감겨야 한다' });

  // ── C1c: **무력 flex 선언**은 0건 (D3) ──
  //   실측 사례: 780px 에서 `.tabs{display:grid}`(345블록) 가 이기는데
  //   701블록이 `.tabs{flex-direction:row;flex-wrap:wrap}` 를 선언해 **완전 무력**했다.
  //   컨테이너가 grid 인데 `flex-direction`/`flex-wrap` 을 쓰면 효과가 없고,
  //   읽는 사람에게 "여기는 flex row" 라는 **거짓 인상**을 준다.
  //   ※ `align-items`/`justify-content` 는 **Box Alignment 라 grid 에서도 유효**하다 —
  //     그걸 결함으로 세면 오탐이 쏟아진다(실측: 6건 중 5건 오탐). 그래서 대상이 아니다.
  const inertFlexDecls = probe.inertFlexDeclarations || [];
  assert('no_inert_flex_direction_or_wrap_declarations',
    inertFlexDecls.length === 0,
    { inertFlexDeclarations: inertFlexDecls,
      note: '★ display 가 flex 가 아닌데 flex-direction/flex-wrap 을 선언하면 무력한 죽은 코드다' });

  // ── C2: **레이아웃 모드(display) 충돌**만 결함이다 ──
  //   같은 값 중복은 무해하고, base 안의 후속 보정(예: `.kv-grid` 100px→96px)은
  //   **의도적**이다 — 형제 선언이 그 값을 전제하지 않으므로 아무것도 무력화하지 않는다.
  //   반면 **display 가 바뀌면** 다른 블록의 flex/grid 전제가 통째로 무력해진다(D1 이 그 사례).
  const displayConflicts = (probe.overriddenDeclarations || [])
    .filter(x => /\|display$/.test(x.key))
    .filter(x => new Set(x.overridden.concat([x.winner])).size > 1);
  assert('no_layout_mode_conflicts',
    displayConflicts.length === 0,
    { displayConflicts,
      informational: (probe.overriddenDeclarations || []).filter(x => !/\|display$/.test(x.key)),
      note: '★ display 가 다른 값으로 덮이면 다른 블록의 flex/grid 전제가 무력해진다' });
  assertions.push({
    name: 'same_value_overrides_are_informational',
    ok: true,
    details: {
      count: (probe.overriddenDeclarations || []).length,
      note: '값 중복·base 후속 보정은 죽은 코드일 뿐 결함이 아니다 (사실로만 남긴다)'
    }
  });

  // ── C3: hidden 마크업을 사실로 남긴다 (판단은 사람이) ──
  assertions.push({
    name: 'hidden_markup_inventory',
    ok: true,
    details: {
      count: (probe.deadHiddenMarkup || []).length,
      items: (probe.deadHiddenMarkup || []).map(x => x.keys.join(',')),
      note: '부활 코드가 없는 hidden 은 **사실**이다. 의도적일 수 있으므로 실패시키지 않는다.'
    }
  });
}

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, passed: assertions.filter(a => a.ok).length, total: assertions.length, assertions }, null, 2));
process.exit(ok ? 0 : 1);
