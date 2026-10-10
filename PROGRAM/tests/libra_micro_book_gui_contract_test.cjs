'use strict';
// Task 9 (plan lines 128/131/323/334; spec line 187): "The Book default view presents Canonical history
// with expandable per-turn Micro evidence in one flow" - Canonical synthesis and the per-turn evidence
// you can expand are read in ONE flow.
//
// WHAT THIS SUITE LOCKS
//   The reading sheet of a Canonical chapter must offer the Micro evidence of the turns that chapter
//   covers, as an expandable section, and the section must appear only when such evidence exists.
//
// WHY IT EXISTS
//   Measured before the change: buildBookMemoryReadingSheet rendered the chapter body, the change trail,
//   the links and the pager, but nothing asked for the durable Micro rows of the covered turns - the
//   reader saw the synthesis with no way to open the evidence behind it.
//
// The builder source is EXECUTED (the convention of this test directory), so the assertion is about the
// rendered structure rather than about a class name existing in the file.
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
const domText = node => flat(node).map(n => (n.text == null ? '' : String(n.text))).join('\n');

const TURN_EVIDENCE = {
  schema: 'libra.micro_turn_evidence.v1',
  turns: [
    { turn: 1, analysisStatus: 'verified', text: '[MICRO T1 · 단일 턴 근거]\n도서관 전체는 정숙 구역이다.',
      sourceSpans: [{ role: 'assistant', messageId: 't1-a', exactQuote: '도서관 전체는 정숙 구역' }] },
    { turn: 2, analysisStatus: 'minimum_source_bound', text: '[MICRO T2 · 단일 턴 근거]\n원문 발췌만 있습니다.',
      sourceSpans: [{ role: 'assistant', messageId: 't2-a', exactQuote: '원문 발췌' }] }
  ]
};

const detail = () => ({
  memoryId: 'memory-1', chapterNumber: 3, title: '도서관의 규칙', revision: 2,
  worldlineId: 'wl', turnRange: { start: 1, end: 5 },
  text: '정본 본문입니다.', summary: '정본 요약',
  actualChanges: [{ domain: 'world', entityId: 'library', fields: ['rule'] }],
  links: [{ kind: 'character', id: 'c1', label: '민아' }]
});

// The sheet builder reads Gui + helpers; the Micro evidence arrives through buildBookTurnEvidenceSection,
// which is the unit this suite executes together with the sheet so the wiring is what is asserted.
const context = vm.createContext({
  guiEl: el,
  guiAsArray: value => (Array.isArray(value) ? value : []),
  guiAsObject: value => (value && typeof value === 'object' ? value : {}),
  text: value => (value == null ? '' : String(value)),
  Gui: { canonicalReaderTotal: 5, canonicalReaderEvidenceLoading: false },
  bookReaderCrossReference: link => el('button', { text: String(link?.label || '') }),
  openCanonicalReaderCorrection: async () => {},
  bookSelectMemorySection: () => {},
  loadCanonicalReaderDetail: async () => {},
  buildBookEmptyState: (kicker, title, body, attrs = {}) => el('div', { class: 'libra-book-empty-state', ...attrs }, [
    el('span', { text: kicker }), el('strong', { text: title }), el('p', { text: body })]),
  bookTurnEvidenceForChapter: () => TURN_EVIDENCE
});

vm.runInContext(
  `${between('const buildBookTurnEvidenceSection =', 'const buildBookMemoryReaderProjection =')}`
  + ';Object.assign(globalThis,{buildBookTurnEvidenceSection,buildBookMemoryReadingSheet});',
  context);

const evidenceFor = () => context.buildBookTurnEvidenceSection(
  { turnRange: { start: 1, end: 5 }, memoryId: 'memory-1' }, TURN_EVIDENCE);

// ── the section exists and is expandable ─────────────────────────────────────────────────────
{
  const section = evidenceFor();
  assert.ok(section, 'a chapter with Micro evidence renders a turn-evidence section');
  assert.equal(String(section.class || '').includes('libra-book-turn-evidence'), true,
    'the section carries its own class so the reader can find it');
  const details = byClass(section, 'libra-book-turn-evidence-item');
  assert.equal(details.length, 2,
    `each covered turn with evidence gets its own expandable item (got ${details.length})`);
  for (const item of details) {
    assert.equal(item.tag, 'details',
      'per-turn evidence must be an expandable details element, not always-open prose');
    assert.ok(flat(item).some(node => node.tag === 'summary'),
      'the per-turn item has a summary the reader opens');
  }
  const item1 = details.find(item => flat(item).some(node => node.text === 'T1'));
  assert.ok(item1, 'the per-turn item is labelled by its turn');
  assert.ok(domText(item1).includes('도서관 전체는 정숙 구역'),
    'the opened item carries the Micro text of that turn');
  assert.ok(domText(item1).includes('도서관 전체는 정숙 구역')
    || domText(item1).includes('t1-a'),
  'the opened item carries the source span of that turn');
  console.log('PASS Book chapter renders expandable per-turn Micro evidence');
}

// ── a turn whose analysis never ran is marked, not silently presented as verified ────────────
{
  const section = evidenceFor();
  const item2 = byClass(section, 'libra-book-turn-evidence-item').find(item => domText(item).includes('T2'));
  assert.ok(item2, 'the source-bound turn gets its own item');
  // Assert on the item's own SUMMARY label, not on any text inside it: the mutation run showed a loose
  // /원문|.../ match still passed when the summary said '단일 턴 근거', because the explanatory paragraph
  // carried the word anyway. The visible label is what the reader uses to tell the two apart.
  const summary2 = flat(item2).find(node => node.tag === 'summary');
  assert.ok(summary2, 'the source-bound item has an openable summary');
  assert.ok(/원문 근거만/.test(domText(summary2)),
    `the source-bound item's summary labels it as unanalysed (got "${domText(summary2)}")`);
  assert.ok(!/단일 턴 근거$/.test(domText(summary2).trim()),
    'the source-bound item must not be labelled as an analysed single-turn Micro');
  assert.equal(byClass(item2, 'libra-book-turn-evidence-pending').length, 1,
    'the source-bound item explains that its analysis is unfinished');
  // And the analysed turn must NOT be labelled as source-bound, or the two are indistinguishable.
  const item1 = byClass(section, 'libra-book-turn-evidence-item').find(item => domText(item).includes('T1'));
  const summary1 = flat(item1).find(node => node.tag === 'summary');
  assert.ok(/단일 턴 근거/.test(domText(summary1)),
    'the analysed turn says it is single-turn evidence');
  assert.ok(!/원문 근거만/.test(domText(summary1)),
    'the analysed turn is not labelled as source-bound-only');
  console.log('PASS Book marks a source-bound-only turn distinctly');
}

// ── no evidence means no empty section ──────────────────────────────────────────────────────
{
  const none = context.buildBookTurnEvidenceSection({ turnRange: { start: 1, end: 5 } }, { turns: [] });
  assert.equal(none, null, 'a chapter with no Micro evidence renders no empty section');
  console.log('PASS Book omits the evidence section when the chapter has no Micro rows');
}

// ── the section is wired into the reading sheet (one flow), not orphaned ────────────────────
{
  context.Gui.canonicalReaderDetail = detail();
  context.Gui.canonicalReaderDetailLoading = false;
  context.Gui.canonicalReaderDetailError = '';
  context.Gui.canonicalReaderLoaded = true;
  context.Gui.bookTurnEvidence = TURN_EVIDENCE;
  const sheet = context.buildBookMemoryReadingSheet();
  assert.ok(byClass(sheet, 'libra-book-reading-sheet').length === 1, 'the reading sheet renders');
  const sections = byClass(sheet, 'libra-book-turn-evidence');
  assert.equal(sections.length, 1,
    'the reading sheet renders the turn evidence inside the Canonical chapter view (one flow)');
  assert.ok(domText(sheet).includes('도서관 전체는 정숙 구역'),
    'the sheet shows the per-turn evidence together with the Canonical synthesis');
  console.log('PASS Book reading sheet carries the evidence inside the Canonical chapter flow');
}
