'use strict';
// Gate: 사이드바 항목을 눌렀을 때 실제로 화면이 바뀌는가.
//
// 배경 (실측): 실제 RisuAI 화면에서 월드 에디셔널·유저 DLC 를 누르면 화면이
// 비어 있었다. 원인은 항목 이름과 패널 id 가 1:1 이 아니었고, switchTab 이
// 그대로 #tab-<이름> 을 찾다가 `if (panel)` 로 조용히 넘어간 것이었다.
// 직전 패널이 그대로 남아 "눌러도 안 바뀐다"가 되었다.
//
// 마크업만 검사하던 종전 검사는 이걸 못 잡았다 — 문자열이 아니라
// "이 항목이 어느 패널로 해석되는가" 를 봐야 한다.
//
// 이 게이트가 단언하는 계약:
//   1) 사이드바의 모든 항목이 존재하는 패널로 해석된다 (빈 화면 0)
//   2) 상세 화면(프로필/내러티브/세계관)도 유효한 패널을 갖는다
//   3) 고아 패널이 없다 — 어디서도 열리지 않는 패널은 죽은 화면이다
//   4) 패널을 못 찾을 때 조용히 넘어가지 않는다 (런타임 오류로 드러낸다)
//   5) 각 항목이 켤 루트 그룹이 실제로 존재한다 (사이드바 강조가 동작)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const source = fs.readFileSync(path.join(ROOT, 'src', 'parts', '15-gui-and-exports.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'src', 'parts', '15b-gui-content-world-dlc.js'), 'utf8');
const dist = fs.readFileSync(DIST, 'utf8');

function assert(name, ok, details = {}) { return { name, ok: !!ok, details }; }
const assertions = [];

// ── 마크업에서 패널·항목 추출 ────────────────────────────────────────────
const bodyStart = source.indexOf('const GUI_BODY = `');
const body = source.slice(bodyStart, source.indexOf('`;', bodyStart));
const panels = [...body.matchAll(/<div id="(tab-[a-z\-]+)" class="panel/g)].map(m => m[1]);
const sideItems = [...body.matchAll(/class="side-link"[^>]*data-tab="([^"]+)"/g)].map(m => m[1]);

assertions.push(assert('panels_and_sidebar_items_extracted',
  panels.length >= 10 && sideItems.length >= 8,
  { panels: panels.length, sideItems: sideItems.length }));

// ── dist 에서 실제 해석 규칙을 읽는다 (문자열이 아니라 실행 결과) ────────
const grab = (name) => {
  const i = dist.indexOf('const ' + name + ' = {');
  if (i < 0) return null;
  const end = dist.indexOf('};', i);
  try { return new Function(dist.slice(i, end + 2) + '; return ' + name + ';')(); }
  catch (_) { return null; }
};
const alias = grab('GUI_PANEL_ALIAS');
const groups = grab('GUI_TAB_GROUPS');

assertions.push(assert('panel_alias_map_exists_in_dist', alias !== null, { keys: alias ? Object.keys(alias).length : 0 }));
assertions.push(assert('tab_group_map_exists_in_dist', groups !== null, { keys: groups ? Object.keys(groups).length : 0 }));

// ── 1·2. 항목 → 패널 해석 ────────────────────────────────────────────────
const resolve = (name) => 'tab-' + ((alias || {})[name] || name);
const panelSet = new Set(panels);
const blank = sideItems.filter(name => !panelSet.has(resolve(name)));
assertions.push(assert('no_sidebar_item_lands_on_missing_panel', blank.length === 0,
  { blank, hint: '이 항목을 누르면 화면이 비거나 직전 패널이 남는다' }));

const detailPanels = ['tab-entity-profile', 'tab-narrative-detail', 'tab-world-detail'];
const missingDetail = detailPanels.filter(p => !panelSet.has(p));
assertions.push(assert('detail_panels_exist', missingDetail.length === 0, { missing: missingDetail }));

// ── 3. 고아 패널 없음 ────────────────────────────────────────────────────
const reachable = new Set([
  ...sideItems.map(resolve),
  ...Object.values(groups || {}).map(r => 'tab-' + r),
  ...detailPanels
]);
const orphans = panels.filter(p => !reachable.has(p));
assertions.push(assert('no_orphan_panels', orphans.length === 0,
  { orphans, hint: '어디서도 열리지 않는 패널은 죽은 화면이다' }));

// ── 4. 조용한 실패 제거 ──────────────────────────────────────────────────
assertions.push(assert('missing_panel_is_surfaced_not_swallowed',
  content.includes('gui.switch_tab_panel_missing'),
  { note: '패널을 못 찾으면 recordSuppressedRuntimeError 로 드러낸다' }));

// ── 5. 루트 그룹 존재 ────────────────────────────────────────────────────
const badRoots = sideItems.filter(name => {
  const root = (groups || {})[name];
  return root && !panelSet.has('tab-' + root);
});
assertions.push(assert('every_item_has_existing_root_group', badRoots.length === 0,
  { badRoots, hint: '루트가 없으면 사이드바 강조가 동작하지 않는다' }));

// ── 6. 항목 이름이 패널과 1:1 이 아니면 별칭이 있어야 한다 ───────────────
const needsAlias = sideItems.filter(name => !panelSet.has('tab-' + name));
const unaliased = needsAlias.filter(name => !(alias || {})[name]);
assertions.push(assert('non_1to1_items_have_alias', unaliased.length === 0,
  { needsAlias, unaliased }));

const ok = assertions.every(a => a.ok);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
