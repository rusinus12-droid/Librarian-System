'use strict';
// LOCKS the 기억 분석 엔진 header layout fixes.
//
// Reported from a screenshot: the four action buttons wrapped onto two rows at their natural widths,
// leaving a large empty area on the right, and '통합 저장 지원 확인' printed its result BELOW the
// button as a bare '미확인' with nothing tying it to the control that produces it.
//
// The approved six-product GUI (5e1db38) replaced that card and its plugin-local .sga-* CSS with the
// suite design: the engine actions now live together in the memory-maintenance fold's .cluster row,
// and the analyzer card keeps a single title with a subordinate description. This test locks that
// current shape. (The storage-support check button itself was not carried over to the new GUI.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = process.env.LIBRA_TEST_PLUGIN
  ? path.resolve(process.env.LIBRA_TEST_PLUGIN)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const between = (a, b) => {
  const i = source.indexOf(a); const j = source.indexOf(b, i + a.length);
  assert.ok(i >= 0 && j > i, `source anchors not found: ${a} .. ${b}`);
  return source.slice(i, j);
};
// The approved six-product GUI replaced the plugin-local .sga-* styles with the
// original suite CSS (embedded verbatim). The same layout contracts are now
// expressed with the suite's .cluster action row and .card__head hierarchy.
const approvedCss = (() => {
  const marker = 'const LIBRA_APPROVED_MOCKUP_STYLE = ';
  const at = source.indexOf(marker);
  assert.ok(at >= 0, 'approved suite CSS is embedded');
  return JSON.parse(source.slice(at + marker.length, source.indexOf('\n', at)).replace(/;\s*$/, ''));
})();
const cssRule = selector => {
  const match = approvedCss.match(new RegExp(`(?:^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^}]*\\}`));
  assert.ok(match, `css rule must exist: ${selector}`);
  return match[0];
};

// ── the shared action row stays one centred, wrapping flex row ─────────────────────────────────
const clusterRule = cssRule('.cluster');
assert.match(clusterRule, /display:flex/, 'the shared .cluster action row must stay a flex row');
assert.match(clusterRule, /flex-wrap:wrap/, 'narrow screens wrap the action row instead of squeezing it');
assert.match(clusterRule, /align-items:center/, 'controls and their inline status sit vertically centred on the row');

// ── the engine maintenance actions share ONE action row, not stacked blocks ─────────────────────
const maintenance = between("guiLazyDetails({class:'fold',dataset:{memoryMaintenance:'true'}}", 'buildUnifiedLegacySelectionPanel(),');
const actionRow = maintenance.slice(maintenance.indexOf("guiEl('div',{class:'cluster'},["));
assert.ok(maintenance.includes("guiEl('div',{class:'cluster'},["), 'engine maintenance actions are grouped in a .cluster row');
for (const label of ['기존 기억 보존 전환', '통합 상태 적용 재시도', '통합 임베딩 후처리 재시도']) {
  assert.ok(actionRow.includes(`text:'${label}'`), `engine action must live in the shared row: ${label}`);
}
assert.equal((actionRow.match(/guiEl\('button',\{class:'btn btn--sm'/g) || []).length, 3,
  'the three engine actions are sibling buttons of the same row');

// ── the analyzer card gives its two lines a hierarchy instead of two identical headings ────────
const cardHead = between("guiEl('div',{class:'card__head'},[\n          guiEl('div',{},[guiEl('h2',{class:'card__title',text:'기억 분석기'})", "guiEl('div',{class:'setting'}");
assert.match(cardHead, /guiEl\('h2',\{class:'card__title',text:'기억 분석기'\}\)/,
  'the section title must remain the only heading in this card');
assert.match(cardHead, /guiEl\('p',\{class:'card__desc',text:'완료된 5턴/,
  'the explanatory line uses the description role so it is not a second identical heading');
assert.equal((cardHead.match(/guiEl\('h[1-6]'/g) || []).length, 1,
  'the card must expose exactly one heading, not two competing ones');
assert.ok(cardHead.indexOf("'card__title'") < cardHead.indexOf("'card__desc'"),
  'the title sits above its description, so the card reads subject-first');
const titleRule = cssRule('.card__title');
const descRule = cssRule('.card__desc');
assert.match(titleRule, /font:700 /, 'the title is visually weighted');
assert.match(descRule, /color:var\(--text2\)/, 'the description is visually subordinate to the title');

console.log(JSON.stringify({ test: 'libra_unified_engine_header_layout', ok: true }));
console.log('PASS 기억 분석기: engine actions share one action row and the card has a single heading');
