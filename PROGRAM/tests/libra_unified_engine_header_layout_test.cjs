'use strict';
// LOCKS the 기억 분석 엔진 header layout fixes.
//
// Reported from a screenshot: the four action buttons wrapped onto two rows at their natural widths,
// leaving a large empty area on the right, and '통합 저장 지원 확인' printed its result BELOW the
// button as a bare '미확인' with nothing tying it to the control that produces it.
//
// The buttons are now an even auto-fit grid, and the status is a sibling of its button inside the
// action row, taking the remaining width. Both are scoped to new local class names so the shared
// `.sga-actions` rule (used in 75 places) is untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.env.LIBRA_TEST_PLUGIN
  ? path.resolve(process.env.LIBRA_TEST_PLUGIN)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

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

// ── the shared rule must not have been repurposed ───────────────────────────────────────────────
assert.ok(/\.sga-actions\{display:flex;gap:8px;flex-wrap:wrap\}/.test(source) ||
  /\.sga-actions\{[^}]*display:flex/.test(source),
  'the shared .sga-actions rule must stay a flex row for its other 74 call sites');

// ── the engine action row is an even grid, and its buttons fill their cell ──────────────────────
const rowRule = cssRule('.libra-unified-engine-actions');
assert.match(rowRule, /display:grid/, 'the engine action row must be a grid so the buttons fill the width');
assert.match(rowRule, /repeat\(auto-fit,minmax\(168px,1fr\)\)/,
  'the grid must distribute the buttons evenly instead of leaving the right side empty');
const buttonRule = cssRule('.libra-unified-engine-actions>.sga-btn');
assert.match(buttonRule, /width:100%/, 'each engine button must fill its grid cell');

// ── the status is a sibling of its button inside the action row ────────────────────────────────
const statusRule = cssRule('.libra-unified-storage-status');
assert.match(statusRule, /align-items:center/, 'the status must sit on the button row, vertically centred');
const statusNoteRule = cssRule('.libra-unified-storage-status>.sga-note');
assert.match(statusNoteRule, /margin-left:auto/, 'the status must take the remaining width rather than fall to the next line');

// Narrow screens stack instead of squeezing.
const narrow = source.match(/@media\(max-width:620px\)\{[^}]*libra-unified-engine-actions[^}]*\}/);
assert.ok(narrow, 'a narrow-screen rule must exist for the engine action row');

// ── built structure: the status lives inside the same container as the button ──────────────────
const el = (tag, attrs = {}, children = []) => ({
  tag, class: attrs.class, text: attrs.text, dataset: attrs.dataset || {},
  children: (Array.isArray(children) ? children : [children]).filter(Boolean)
});
const flat = node => [node, ...(node.children || []).flatMap(flat)];

const context = vm.createContext({
  guiEl: el, Promise, JSON, String, Error, console,
  LibraMemoryCore: { getUnifiedStorageStatus: async () => ({ summary: 'ok', mode: 'mirror', eligible: true, blocked: [] }) },
  Gui: { openSerial: 0 },
  Gui_openSerialStub: 0
});
const code = `${between('const buildUnifiedStorageStatusPanel = () => {', 'const buildLibraMemorySettingsPanel =')}\n({buildUnifiedStorageStatusPanel});`;
const { buildUnifiedStorageStatusPanel } = vm.runInContext(code, context, { filename: 'panel.js' });
const panel = buildUnifiedStorageStatusPanel();
const nodes = flat(panel);
const button = nodes.find(node => node.text === '통합 저장 지원 확인');
const status = nodes.find(node => node.dataset?.unifiedStorageResult === 'true');
assert.ok(button, 'the check button must render');
assert.ok(status, 'the status node must render');
assert.ok(panel.children.includes(button) && panel.children.includes(status),
  'the status must be a direct sibling of its button in the action row, not a separate block below it');
assert.ok(/libra-unified-storage-status/.test(String(panel.class)),
  'the status row must carry the local class the CSS targets');
// The row must also keep the flex behaviour, or the status drops to its own line inside the same box.
assert.ok(/\bsga-actions\b/.test(String(panel.class)),
  'the status row must keep .sga-actions so the status shares the button row instead of stacking under it');
// A block-level status (div) breaks the row even with flex, because it cannot sit beside the button.
assert.equal(status.tag, 'span',
  'the status must be inline-level so it can share the button row; a block element stacks beneath it');

// ── the card gives its two lines a hierarchy instead of two identical headings ─────────────────
// Measured before the fix: both lines were h3 with the same resolved font-size (13px), the same
// colour (#f4ebdc) and the same margin. Nothing distinguished the section title from the
// implementation label, so they read as one heading. The label keeps its text (it is the
// "consolidated into one Librarian analyzer" contract statement) but drops to the eyebrow role —
// the pattern the sibling cards in this same panel already use (h3 + sga-note).
const cardHead = between("guiEl('div', { class: 'sga-card wide' }, [\n        // 제목은 하나만 h3", "buildLibrarianConfigurationReviewPanel()");
assert.match(cardHead, /class: 'libra-article-eyebrow', text: 'Librarian · 단일 통합 분석기'/,
  'the implementation label must use the eyebrow role so it is not a second identical heading');
assert.match(cardHead, /guiEl\('h3', \{ text: '기억 분석 엔진' \}\)/,
  'the section title must remain the only h3 in this card');
assert.equal((cardHead.match(/guiEl\('h3'/g) || []).length, 1,
  'the card must expose exactly one heading, not two competing ones');
assert.ok(cardHead.indexOf('libra-article-eyebrow') < cardHead.indexOf("guiEl('h3'"),
  'the label must sit above the title, so the card reads subject-first');

console.log(JSON.stringify({ test: 'libra_unified_engine_header_layout', ok: true }));
console.log('PASS 기억 분석 엔진: action buttons fill an even grid and the storage status sits on its button row');
