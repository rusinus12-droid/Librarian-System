'use strict';
// THE READING DESK MUST GIVE ITS SPACE TO THE TEXT.
//
// WHY THIS EXISTS (§32.1 요청 1·2, §32.2, §32.3)
//   A reading-desk page spent its first screen on a decorative header: an uppercase eyebrow on its
//   own line, a 30px serif title, a description paragraph, and below that an always-on status card.
//   Measured against the shipped layout, the reader had to scroll before reaching any content. The
//   fix folds the eyebrow into the title row, moves the description behind a summary, and turns the
//   status card into a compact button row.
//
// WHAT THIS SUITE LOCKS
//   1. the header renders as ONE title row (eyebrow inside it, not stacked above the title);
//   2. the description is opt-in (inside a <details>), so it costs nothing until opened;
//   3. the status area still reports the SAME verdict, keeps the retry action for recoverable
//      states, and still exposes the advanced management entry — the requirement was to shrink it,
//      never to hide a failure;
//   4. the reading surface tokens are untouched (paper/ink/border colours).
//
// The panel sources are EXECUTED, not string-matched: a header that merely contains the right class
// names can still render a stacked layout. Where the shipped code depends on runtime state, the
// smallest possible stand-ins are supplied (documented in each context below), and the assertion is
// about STRUCTURE, which is what the complaint was about.
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

const el = (tag, attrs = {}, children = []) => ({ tag, ...attrs, children: children.filter(Boolean) });
const flat = n => [n, ...(n.children || []).flatMap(flat)];
const byClass = (node, cls) => flat(node).filter(n => String(n.class || '').split(/\s+/).includes(cls));

const results = [];
const test = (name, fn) => { fn(); results.push(name); };

// ── the header builder, executed with the smallest possible scaffolding ───────────────────────
// buildBookPage calls buildBookStateProgress, which reads the memory snapshot. That status path is
// covered by its own assertions below, so here it is stubbed to a marker node and the header is
// what is under test.
const headerContext = vm.createContext({
  guiEl: el,
  guiAsArray: value => (Array.isArray(value) ? value : []),
  guiLazyDetails: (attrs, summary, build) => el('details', attrs, [summary, ...build()]),
  buildBookStateButton: () => el('details', { class: 'libra-book-state-popover' }),
  Gui: { bookPage: 'desk' },
  buildBookStateProgressMarker: true
});
vm.runInContext(`${between('const buildBookPage =', 'const bookProjectionStateValue =')};Object.assign(globalThis,{buildBookPage});`, headerContext);

test('the header is one title row, with the eyebrow inside it', () => {
  const page = headerContext.buildBookPage('BOOK · 기억', '기억 서고', '이 화면은 저장된 기억을 읽습니다.', [el('div', { class: 'content' })], { pageId: 'memory' });
  const head = byClass(page, 'libra-book-page-head');
  assert.equal(head.length, 1, 'the page must render exactly one header');
  const rows = byClass(page, 'libra-book-page-title-row');
  assert.equal(rows.length, 1, 'the title row must exist — a stacked eyebrow+title is the defect');
  const titles = flat(rows[0]).filter(n => n.tag === 'h1');
  const eyebrows = flat(rows[0]).filter(n => n.tag === 'span' && String(n.class || '').includes('libra-book-eyebrow'));
  assert.equal(titles.length, 1, 'the title must sit in the row');
  assert.equal(eyebrows.length, 1, 'the eyebrow must sit in the SAME row, not on its own line above it');
  // §32.3: the status control belongs to the header, on the right, not below it as a card.
  const stateControl = (rows[0].children || []).filter(n => String(n.class || '').includes('libra-book-state-popover'));
  assert.equal(stateControl.length, 1, 'the status button must live in the title row');
  // The old shape: eyebrow as a direct child of the header, i.e. a line of its own.
  const strayEyebrow = (head[0].children || []).filter(n => String(n?.class || '').includes('libra-book-eyebrow'));
  assert.equal(strayEyebrow.length, 0, 'the eyebrow must not remain a direct header child (stacked layout)');
});

test('the description is opt-in, so it costs no space until opened', () => {
  const page = headerContext.buildBookPage('BOOK', '제목', '긴 설명입니다.', [], { pageId: 'memory' });
  const head = byClass(page, 'libra-book-page-head')[0];
  const directParagraph = (head.children || []).filter(n => n.tag === 'p');
  assert.equal(directParagraph.length, 0, 'the description must not be an always-visible paragraph');
  const notes = byClass(page, 'libra-book-page-note');
  assert.equal(notes.length, 1, 'the description must live behind a summary');
  assert.equal(notes[0].tag, 'details', 'the description container must be a details element');
});

test('a page without a description still renders one clean row', () => {
  const page = headerContext.buildBookPage('BOOK', '제목', '', [], { pageId: 'memory' });
  assert.equal(byClass(page, 'libra-book-page-title-row').length, 1);
  assert.equal(byClass(page, 'libra-book-page-note').length, 0, 'no description means no empty details');
});

// ── the status control: in the header, still never hiding a failure ──────────────────────────
// The verdict mapper sits above the detail builder; both are needed for the button labels.
const statusSource = between('const bookStateVerdict =', 'const buildBookPage =');
const statusContext = vm.createContext({
  guiEl: el,
  guiLazyDetails: (attrs, summary, build) => el('details', attrs, [summary, ...build()]),
  guiSetStatus: () => {},
  queueGuiRender: () => {},
  Gui: {},
  LibraMemoryCore: {
    peekSnapshot: () => statusSnapshot,
    state: {},
    resolveContext: async () => ({ scope: { scopeKey: 'A' } }),
    recoverPendingStateTrackingJournal: async () => ({ recovered: 0, remaining: 0, ok: true }),
    refreshSnapshot: async () => {}
  },
  buildStateReplayMaintenancePanel: () => el('section', { class: 'advanced-stub' }),
  bookStateProgress: () => progressRow
});
let statusSnapshot = {};
let progressRow = null;
vm.runInContext(`${statusSource};Object.assign(globalThis,{buildBookStateButton});`, statusContext);

const stateButtonOf = node => flat(node).find(n => n.dataset && n.dataset.stateButton);
const buttonTextOf = node => (stateButtonOf(node) || {}).text || '';

test('the status is a header popover, not a card', () => {
  progressRow = { state: 'ready', label: '반영 완료', retry: false, detail: '', scopeKey: 'A' };
  const node = statusContext.buildBookStateButton('desk');
  assert.equal(node.tag, 'details', '§32.3: the header control must be a disclosure, not a section card');
  assert.equal(node.class.includes('libra-book-state-popover'), true);
  assert.equal(flat(node).filter(n => String(n.class || '').includes('libra-book-state-progress')).length, 0,
    'the full-width status card must be gone');
});

test('a healthy state reads 현재 상태 · 정상', () => {
  progressRow = { state: 'ready', label: '반영 완료', retry: false, detail: '', scopeKey: 'A' };
  const node = statusContext.buildBookStateButton('desk');
  assert.equal(buttonTextOf(node), '현재 상태 · 정상', `§32.3 vocabulary (got ${buttonTextOf(node)})`);
});

test('a FAILED state keeps its message and its retry — never hidden', () => {
  progressRow = { state: 'failed', label: '상태 적용 실패 · T5까지 반영', retry: true, detail: '상세 실패 사유', scopeKey: 'A' };
  const node = statusContext.buildBookStateButton('desk');
  assert.match(buttonTextOf(node), /현재 상태 · 확인 필요/, `§32.3: a problem reads 확인 필요 (got ${buttonTextOf(node)})`);
  const text = flat(node).map(n => n.text).filter(Boolean).join(' | ');
  assert.ok(/완료하지 못했습니다/.test(text), `a failed state must explain itself (got ${text})`);
  assert.ok(/상태 적용 실패/.test(text), 'the detailed label must survive');
  const buttons = flat(node).filter(n => n.tag === 'button' && /상태 다시 갱신/.test(String(n.text || '')));
  assert.equal(buttons.length, 1, 'a recoverable failure must keep its retry action');
});

test('an unavailable state is reported as 조회 실패, not silently treated as fine', () => {
  progressRow = { state: 'unavailable', label: '현재 상태 조회 실패', retry: false, detail: '', scopeKey: 'A' };
  const node = statusContext.buildBookStateButton('desk');
  assert.equal(buttonTextOf(node), '현재 상태 · 조회 실패', `§32.3 vocabulary (got ${buttonTextOf(node)})`);
  assert.ok(/읽지 못했습니다/.test(flat(node).map(n => n.text).filter(Boolean).join(' | ')));
});

test('전체 상태 확인 is offered and reads only', () => {
  progressRow = { state: 'ready', label: '반영 완료', retry: false, detail: '', scopeKey: 'A' };
  const node = statusContext.buildBookStateButton('desk');
  const all = flat(node).filter(n => n.tag === 'button' && n.text === '전체 상태 확인');
  assert.equal(all.length, 1, '§32.3: 전체 상태 확인 must be offered in the detail');
});

test('the advanced management entry survives the move', () => {
  progressRow = { state: 'ready', label: '반영 완료', retry: false, detail: '', scopeKey: 'A' };
  const node = statusContext.buildBookStateButton('desk');
  assert.equal(byClass(node, 'advanced-stub').length, 1, '고급 관리 must remain reachable');
});

// ── the reading surface is not part of this change ───────────────────────────────────────────
test('the paper/ink/border palette is unchanged', () => {
  assert.ok(/\.libra-book-page-head\{[^}]*border-bottom:1px solid #d3c1a8/.test(source),
    'the header hairline must keep its paper tone');
  assert.ok(/\.libra-book-page-head h1\{[^}]*color:#33261c/.test(source),
    'the title must keep its ink colour — space was reclaimed, not legibility');
});

console.log(JSON.stringify({ test: 'libra_book_reading_space_contract', passed: results.length, scenarios: results, method: 'shipped builders executed with DOM-free nodes; layout structure asserted, not pixels' }));
console.log('libra_book_reading_space_contract_test: PASS');
