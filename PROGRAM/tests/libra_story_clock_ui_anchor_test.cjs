'use strict';
// Story Clock GUI anchor input binding: derives Day-1 date from transcript date reports
// without mutating stored manual anchorDate, allows overriding, and restores derived date on clear.
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const slice = (a, b) => {
  const start = source.indexOf(a);
  const end = source.indexOf(b, start);
  assert.ok(start >= 0 && end > start, `source anchors not found: ${a} .. ${b}`);
  return source.slice(start, end);
};

const clockCoreSource = slice("const STORY_CLOCK_SCHEMA = 'libra.story_clock.v1';", 'const LENS_DEFAULT_OUTPUT_HINT =');
const storyClockUiSource = slice('const storyClockPanelState = () => {', 'const buildApprovedMockupStory = () => {');

const flatNodes = root => root ? [root, ...(Array.isArray(root.children) ? root.children.flatMap(flatNodes) : [])] : [];
const makeEl = (tag, attrs = {}, children = []) => ({
  tag,
  ...attrs,
  children: (Array.isArray(children) ? children : [children]).filter(Boolean)
});

const createHarness = (initialClock, pairs) => {
  let clockRecord = structuredClone(initialClock);
  let apiCalls = [];
  const ctx = vm.createContext({
    LibraMemoryCore: { peekSnapshot: () => ({ scope: { scopeKey: clockRecord.scopeKey } }) },
    Gui: {},
    guiAsObject: v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
    guiAsArray: v => (Array.isArray(v) ? v : []),
    text: v => String(v ?? ''),
    queueGuiNavigationRender: () => {},
    guiEl: makeEl,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    Promise,
    JSON,
    Map,
    Set
  });
  vm.runInContext(
    clockCoreSource + '\n' + storyClockUiSource + ';globalThis.StoryClockCore={computeStoryClockTimeline,formatStoryClockDay,storyClockDelivery};globalThis.buildCard=buildStoryClockCard;globalThis.loadPanel=loadStoryClockPanel;',
    ctx
  );
  const makeView = () => {
    const timeline = ctx.StoryClockCore.computeStoryClockTimeline(clockRecord, pairs);
    return {
      schema: 'libra.story_clock_view.v1',
      scopeKey: clockRecord.scopeKey,
      anchorDate: timeline.anchorDate,
      derivedAnchorDate: timeline.derivedAnchorDate,
      effectiveAnchorDate: timeline.effectiveAnchorDate,
      anchorSource: timeline.anchorSource,
      corrections: clockRecord.corrections || {},
      basis: timeline.basis,
      current: timeline.current,
      currentLabel: timeline.current ? ctx.StoryClockCore.formatStoryClockDay(timeline.current) : ctx.StoryClockCore.formatStoryClockDay(null),
      entries: timeline.entries.map(entry => ({ ...entry, label: ctx.StoryClockCore.formatStoryClockDay(entry) })),
      timeline
    };
  };
  ctx.__LIBRA__ = {
    async getStoryClock() {
      apiCalls.push(['getStoryClock']);
      return makeView();
    },
    async setStoryClockAnchor(dateValue) {
      apiCalls.push(['setStoryClockAnchor', dateValue]);
      clockRecord = { ...clockRecord, anchorDate: String(dateValue || '').trim() };
      return makeView();
    },
    async correctStoryClockTurn() {
      return makeView();
    }
  };
  return {
    ctx,
    getClockRecord: () => clockRecord,
    getApiCalls: () => apiCalls
  };
};

test('Story Clock GUI populates derived Day-1 date, supports manual override, and reverts to derived on clear', async () => {
  const pairs = Array.from({ length: 33 }, (_, idx) => ({ turn: idx + 1, revisionId: `rev_${idx + 1}` }));
  const h = createHarness({
    schema: 'libra.story_clock.v1',
    scopeKey: 'ffeb99ef_19:0',
    anchorDate: '',
    corrections: {},
    pairs: {
      1: { advance: { kind: 'date', date: '2027-04-25', timeOfDay: 'late_night' }, sourceRevisionId: 'stale_1' },
      27: { advance: { kind: 'same_day', timeOfDay: 'night' }, sourceRevisionId: 'rev_27' },
      28: { advance: { kind: 'date', date: '2027-04-25', timeOfDay: 'night' }, sourceRevisionId: 'rev_28' },
      32: { advance: { kind: 'date', date: '2027-04-26', timeOfDay: 'morning' }, sourceRevisionId: 'rev_32' },
      33: { advance: { kind: 'same_day', timeOfDay: 'morning' }, sourceRevisionId: 'rev_33' }
    }
  }, pairs);

  await h.ctx.loadPanel();
  let nodes = flatNodes(h.ctx.buildCard());

  const dateInput1 = nodes.find(n => n.tag === 'input' && n['aria-label'] === '이야기 1일째의 날짜');
  assert.ok(dateInput1, 'anchor date input renders');
  assert.equal(dateInput1.value, '2027-04-25');
  assert.equal(h.getClockRecord().anchorDate, '', 'displaying derived date does not mutate stored anchorDate');

  const derivedBadge = nodes.find(n => n.dataset?.storyClockAnchorSource === 'derived');
  assert.equal(derivedBadge?.text, '기록에서 자동 인식');
  const anchorLabel1 = nodes.find(n => n.class === 'label' && String(n.text || '').startsWith('기준 날짜'));
  assert.equal(anchorLabel1?.text, '기준 날짜(기록 1일째, 선택)');
  assert.ok(nodes.some(n => n.class === 'hint' && String(n.text || '').includes('1일째 기준 날짜(2027-04-25)를 자동으로 읽었습니다')));

  // 2. Manual override saves 2027-04-20 and switches badge to '직접 저장됨'.
  const saveBtn1 = nodes.find(n => n.tag === 'button' && n.text === '저장');
  assert.ok(saveBtn1);
  dateInput1.value = '2027-04-20';
  saveBtn1.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(h.getApiCalls().slice(-1)[0], ['setStoryClockAnchor', '2027-04-20']);
  assert.equal(h.getClockRecord().anchorDate, '2027-04-20');
  nodes = flatNodes(h.ctx.buildCard());
  const dateInput2 = nodes.find(n => n.tag === 'input' && n['aria-label'] === '이야기 1일째의 날짜');
  assert.equal(dateInput2.value, '2027-04-20');
  assert.equal(nodes.find(n => n.dataset?.storyClockAnchorSource === 'manual')?.text, '직접 저장됨');
  assert.equal(nodes.find(n => n.role === 'status')?.text, '기준 날짜를 저장했습니다.');

  // 3. Clearing the input and clicking 저장 calls setStoryClockAnchor('') and restores derived 2027-04-25.
  const saveBtn2 = nodes.find(n => n.tag === 'button' && n.text === '저장');
  dateInput2.value = '';
  saveBtn2.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(h.getApiCalls().slice(-1)[0], ['setStoryClockAnchor', '']);
  assert.equal(h.getClockRecord().anchorDate, '');
  nodes = flatNodes(h.ctx.buildCard());
  const dateInput3 = nodes.find(n => n.tag === 'input' && n['aria-label'] === '이야기 1일째의 날짜');
  assert.equal(dateInput3.value, '2027-04-25');
  assert.equal(nodes.find(n => n.dataset?.storyClockAnchorSource === 'derived')?.text, '기록에서 자동 인식');
  assert.equal(nodes.find(n => n.role === 'status')?.text, '직접 지정한 기준 날짜를 지우고 기록 기준(2027-04-25)으로 돌렸습니다.');
});

test('Story Clock GUI leaves date input empty with no source badge when no dates exist, and clears cleanly', async () => {
  const pairs = [{ turn: 1, revisionId: 'rev_1' }, { turn: 2, revisionId: 'rev_2' }];
  const h = createHarness({
    schema: 'libra.story_clock.v1',
    scopeKey: 'no-date-scope',
    anchorDate: '',
    corrections: {},
    pairs: {
      1: { advance: { kind: 'none' }, sourceRevisionId: 'rev_1' },
      2: { advance: { kind: 'days', days: 1, timeOfDay: 'morning' }, sourceRevisionId: 'rev_2' }
    }
  }, pairs);

  await h.ctx.loadPanel();
  let nodes = flatNodes(h.ctx.buildCard());
  const dateInput = nodes.find(n => n.tag === 'input' && n['aria-label'] === '이야기 1일째의 날짜');
  assert.equal(dateInput.value, '');
  assert.equal(nodes.find(n => n.dataset?.storyClockAnchorSource), undefined);
  assert.equal(nodes.find(n => n.class === 'label' && String(n.text || '').startsWith('기준 날짜'))?.text, '기준 날짜(1일째, 선택)');

  const saveBtn = nodes.find(n => n.tag === 'button' && n.text === '저장');
  saveBtn.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));
  nodes = flatNodes(h.ctx.buildCard());
  assert.equal(nodes.find(n => n.role === 'status')?.text, '기준 날짜를 지웠습니다.');
});
