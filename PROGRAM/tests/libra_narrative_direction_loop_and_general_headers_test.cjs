'use strict';
// LOCKS A REPORTED FIX.
//
// 설정 > 일반 · 진단 (general & diagnostics):
//    The panel rendered its own '일반 · 진단' header card while the settings shell already renders that
//    section header — the same title twice, and the card ate vertical room. The panel must not repeat
//    the header, and the diagnostic windows must keep the expanded reading room.
const fs = require('node:fs');
const path = require('node:path');
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

(async () => {
  // ── 일반 · 진단: one header, and the reading room stays expanded ────────────────────────────
  // The settings shell renders the section header from its section definition; the panel itself is
  // now a self-contained "복구 · 진단" picker card plus the selected diagnostic section.
  const generalPanel = between('const buildGeneralSettingsPanel =', 'const bookStateProgress =');
  assert.ok(!/INTERFACE · DIAGNOSTICS|GENERAL & DIAGNOSTICS/.test(generalPanel), 'the general panel must not repeat the section eyebrow');
  assert.ok(!/guiEl\('h2'[^)]*일반 · 진단/.test(generalPanel), 'the general panel must not repeat the section title');
  assert.ok(!/일반 · 진단/.test(generalPanel), 'the section title belongs to the settings shell, not the panel body');
  assert.ok(/buildDiagnosticLogSection\(active\)/.test(generalPanel), 'the diagnostic panel itself must remain');

  const sectionDefinition = source.match(/\{ id: 'general', group: 'settings', no: '08', label: '일반 · 진단'[^}]*\}/);
  assert.ok(sectionDefinition, 'the settings shell keeps one section definition, and it carries the header');
  assert.equal(source.match(/\{ id: 'general', group: 'settings'/g).length, 1, 'exactly one general section definition');

  // The diagnostic log is a list/detail reading room: the list rail on the side, a wider detail card.
  const logList = between('const buildDiagnosticLogList = () =>', 'const buildDiagnosticLogSection =');
  assert.ok(/guiEl\('div', \{ class: "grid g-side" \}/.test(logList), 'the diagnostic log must keep the side-by-side list/detail layout');
  assert.ok(/guiEl\('div', \{ class: "rail" \}/.test(logList), 'the log list must sit in the side rail');
  assert.ok(/guiEl\('div', \{ class: "card", role: 'region', 'aria-label': '선택한 로그 상세' \}/.test(logList), 'the detail must keep its own region');
  assert.ok(/visible\.map\(row => guiEl\('button', \{\s*class: `row/.test(logList), 'log rows must stay clickable buttons');

  const layoutRule = cssRule('.g-side');
  const listRule = cssRule('.list');
  const rowRule = cssRule('.row');
  const sideMatch = layoutRule.match(/grid-template-columns:minmax\((\d+)px,([\d.]+)fr\) minmax\(0,([\d.]+)fr\)/);
  assert.ok(sideMatch, `the side layout must define a list column and a detail column, saw ${layoutRule}`);
  const listMinWidth = Number(sideMatch[1]);
  const listFr = Number(sideMatch[2]);
  const detailFr = Number(sideMatch[3]);
  assert.ok(listMinWidth >= 260, `the list column must keep its readable minimum width, saw ${listMinWidth}px`);
  assert.ok(detailFr >= 1.5 && detailFr > listFr, `the detail column must keep the wider share, saw ${listFr}fr / ${detailFr}fr`);
  assert.ok(!/max-height/.test(listRule), `the diagnostic list must not be capped back to a cramped height, saw ${listRule}`);
  assert.ok(/width:100%/.test(rowRule) && /button\.row:hover\{/.test(source), 'the row rule and its hover affordance must survive — deleting them removes the click affordance');
  const listHeight = 'uncapped';
  const detailHeight = `${detailFr}fr`;

  console.log(JSON.stringify({ test: 'libra_narrative_direction_loop_and_general_headers', ok: true, listHeight, detailHeight }));
  console.log('PASS 일반 · 진단 renders one header and keeps the expanded reading room');
})().catch(error => { console.error(String(error?.stack || error)); process.exit(1); });
