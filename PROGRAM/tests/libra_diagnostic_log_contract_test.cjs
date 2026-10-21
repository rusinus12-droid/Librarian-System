'use strict';
// ONE SEARCHABLE LOG, NOT FOUR FOLDED CARDS (§34.2).
//
// WHY THIS EXISTS
//   The first consolidation attempt only folded the four existing panels behind a section rail: opening
//   운영 상태 still built the old card bundle, and there was no list, no search and no selected detail.
//   The requirement is a single log screen — a list of entries, a filter/search, and a detail pane for
//   the selected entry — built from the collectors the plugin already has.
//
// WHAT THIS SUITE LOCKS
//   1. the default diagnostic section renders the unified log (list + search + kind filter + detail);
//   2. rows are normalised from the EXISTING collectors, and an entry's kind records whether it is an
//      actual event or a current-state snapshot — a snapshot must never be dressed as history;
//   3. search AND kind filter both narrow the list;
//   4. selecting an entry shows its detail, and the detail offers no auto-executing recovery;
//   5. the list is paged, so a large log does not build every row at once;
//   6. the other three diagnostic sections still render their own panels.
//
// The suite EXECUTES the shipped builders with DOM-free nodes and stub collectors, so a change that
// silently stops reading a collector, or that renders the wrong panel for a section, fails here.
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

const el = (tag, attrs = {}, children = []) => ({ tag, ...attrs, children: (children || []).filter(Boolean) });
const flat = n => [n, ...(n.children || []).flatMap(flat)];
const byClass = (node, cls) => flat(node).filter(n => String(n.class || n.attrs?.class || '').split(/\s+/).includes(cls));
// The approved GUI (789626a) replaced the libra-diag-* classes with generic layout classes; the log's
// parts are now identified by their accessible roles/labels, which are the stable product contract.
const PARTS = {
  'libra-diag-list': n => n.role === 'listbox' && n['aria-label'] === '디버그 로그 목록',
  'libra-diag-controls': n => (n.children || []).some(c => c.tag === 'input' && c.type === 'search'),
  'libra-diag-right': n => n.role === 'region' && n['aria-label'] === '선택한 로그 상세',
  'libra-diag-row': n => n.tag === 'button' && n.role === 'option' && n.dataset && 'logRowId' in n.dataset
};
const part = (node, name) => flat(node).filter(PARTS[name]);

const results = [];
const test = (name, fn) => { fn(); results.push(name); };

// ── the harness: stub every collector the log reads, and count what the screen builds ────────
const harness = () => {
  const state = {
    Gui: {
      diagnosticLogQuery: '', diagnosticLogKind: 'all', diagnosticLogLimit: 60,
      diagnosticLogSelectedId: ''
    },
    renders: 0,
    Runtime: {
      // TWO warnings share at=3000 on purpose: the review reproduced a defect where a
      // timestamp-derived id made them collapse into one selection. Distinct timestamps would hide
      // that regression, so the collision is part of the fixture.
      warnings: [{ at: 3000, msg: 'migration failed: synthetic' }, { at: 3000, msg: 'legacy vector fallback' },
                 { at: 4000, msg: 'quota warning' }],
      stageTrace: [
        { stage: 'beforeRequest', at: 5000, parsed: { label: '요청 적용 확인' }, ok: true, elapsed: 12 },
        { stage: 'afterRequest', at: 6000, parsed: { label: '응답 반영' }, ok: false, elapsed: 9 }
      ]
    },
    snapshot: { scope: { scopeKey: 'A' }, manifest: { memories: { 1: {}, 2: {} } } }
  };
  const context = vm.createContext({
    Object, Array, String, Number, Set, JSON, Date,
    Gui: state.Gui,
    Runtime: state.Runtime,
    STAGE_DEF_MAP: { afterRequest: { label: '응답 반영' } },
    guiEl: (tag, attrs = {}, children = []) => el(tag, attrs, children),
    guiLazyDetails: (attrs, summary, build) => el('details', attrs, [summary, ...build()]),
    guiAsArray: value => (Array.isArray(value) ? value : []),
    text: value => String(value ?? '').trim(),
    libraStatusBadge: (label, tone) => el('span', { class: `sga-badge ${tone}`, text: label }),
    libraFormatTime: at => `t${at}`,
    libraStatusBadgeTone: null,
    queueGuiRender: () => { state.renders += 1; },
    queueGuiNavigationRender: () => { state.renders += 1; },
    guiSetStatus: () => {},
    bookNavigate: () => {},
    selectBookSettingsRoomSection: () => {},
    LibraMemoryCore: { peekSnapshot: () => state.snapshot, state: { canonicalJob: { state: 'completed', completed: 2, total: 2 } } }
  });
  state.swallowed = [
    { plugin: 'LIBRA', tag: 'storage.read', count: 3, lastAt: 1000, lastMessage: 'quota exceeded' },
    { plugin: 'HAYAKU', tag: 'ledger.write', count: 1, lastAt: 2000, lastMessage: 'retry' }
  ];
  context.__librarianDiag = {
    // The shipped aggregator does NOT copy: it stores row objects in a Map and mutates them in place
    // (`row.count += 1`), returning the live objects. Copying here would hand the log a fresh object
    // every render, which hides any identity-based id bug — that is precisely how the two refresh
    // cases the review reproduced slipped past the previous version of this suite.
    snapshot: () => state.swallowed.slice()
  };
  context.buildSwallowedDiagPanel = () => el('section', { class: 'panel-swallowed' });
  context.buildWorldManagerDiagnosticsPanel = () => el('section', { class: 'panel-state' });
  context.buildDebugTab = () => el('section', { class: 'panel-runtime' });
  context.buildOperationalHealthPanel = () => el('section', { class: 'panel-health' });
  vm.runInContext(
    between('const compact =', 'const compactMiddle =') + '\n' +
    between('const formatElapsedBrief =', 'const traceStateInfo =') + '\n' +
    between('const traceStateInfo =', 'const traceBadgeNode =') + '\n' +
    // Starts ABOVE diagnosticLogRows: the row-identity helper and its WeakMap live just before it.
    between('  const diagnosticRowIds = new WeakMap();', 'const buildDiagnosticLogSection = id =>') + '\n' +
    between('const buildDiagnosticLogSection = id =>', 'const buildGeneralSettingsPanel =') +
    ';Object.assign(globalThis,{diagnosticLogRows,buildDiagnosticLogList,buildDiagnosticLogSection});',
    context);
  return { context, state };
};

// ── 1. the log is a list + search + kind filter + detail ────────────────────────────────────
test('the default diagnostic section renders the unified log', () => {
  const { context } = harness();
  // §34.2 + review fix: 'log' is the unified list; 'health' keeps its operational panel (which the
  // review found had become unreachable). An unknown id falls through to the log, which is also the
  // default section.
  const node = context.buildDiagnosticLogSection('log');
  assert.ok(part(node, 'libra-diag-list').length === 1, 'the log must render a list');
  const controls = part(node, 'libra-diag-controls')[0];
  assert.ok(controls, 'the log must render controls');
  const search = flat(controls).find(n => n.type === 'search');
  const select = flat(controls).find(n => n.tag === 'select');
  assert.ok(search, 'a search box is required');
  assert.ok(select, 'a kind filter is required');
  assert.ok(part(node, 'libra-diag-right').length === 1, 'a detail pane is required');
});

test('rows are normalised from the existing collectors', () => {
  const { context } = harness();
  const rows = context.diagnosticLogRows();
  const sources = new Set(rows.map(r => r.source));
  for (const needed of ['무시된 오류', '런타임 경고', '단계 추적', '현재 상태']) {
    assert.ok(sources.has(needed), `the log must read ${needed} (got ${JSON.stringify([...sources])})`);
  }
  assert.ok(rows.length >= 4, `expected every collector to contribute (got ${rows.length})`);
});

test('a snapshot is labelled as a snapshot, never as history', () => {
  const { context } = harness();
  const rows = context.diagnosticLogRows();
  const snapshots = rows.filter(r => r.kind === 'snapshot');
  assert.equal(snapshots.length, 1, 'exactly the current-state row is a snapshot');
  assert.match(snapshots[0].title, /작업|기억 작업/, `the snapshot row must describe current state (got ${snapshots[0].title})`);
  assert.match(snapshots[0].detail, /scope A/, 'the snapshot row must name the scope it was read for');
  assert.ok(rows.filter(r => r.kind === 'event').length >= 4, 'the collectors contribute events');
});

// ── 2. search and filter both narrow the list ───────────────────────────────────────────────
test('search narrows the list to matching entries', () => {
  const { context, state } = harness();
  const all = part(context.buildDiagnosticLogList(), 'libra-diag-row').length;
  state.Gui.diagnosticLogQuery = 'quota';
  const narrowed = part(context.buildDiagnosticLogList(), 'libra-diag-row').length;
  assert.ok(narrowed >= 1 && narrowed < all, `search must narrow (all=${all}, narrowed=${narrowed})`);
});

test('the kind filter separates events from the snapshot', () => {
  const { context, state } = harness();
  state.Gui.diagnosticLogKind = 'snapshot';
  const snapOnly = part(context.buildDiagnosticLogList(), 'libra-diag-row').length;
  assert.equal(snapOnly, 1, 'filtering to snapshots must leave only the current-state row');
  state.Gui.diagnosticLogKind = 'event';
  const events = context.buildDiagnosticLogList();
  const badges = flat(events).filter(n => String(n.text || '') === '스냅샷');
  assert.equal(badges.length, 0, 'no snapshot may appear in the event filter');
});

// ── 3. the detail pane ──────────────────────────────────────────────────────────────────────
test('the detail pane shows the selected entry and offers no auto-executing action', () => {
  const { context, state } = harness();
  const rows = context.diagnosticLogRows();
  const target = rows.find(r => /quota/.test(r.detail)) || rows[0];
  // Selection is by the row's unique id, not by its timestamp (same-millisecond rows must stay
  // distinguishable — that was a measured defect).
  state.Gui.diagnosticLogSelectedId = target.id;
  const node = context.buildDiagnosticLogList();
  const detail = part(node, 'libra-diag-right')[0];
  const text = flat(detail).map(n => n.text).filter(Boolean).join(' | ');
  assert.ok(text.includes(target.title.slice(0, 12)), `the detail must show the selection (got ${text.slice(0, 120)})`);
  const buttons = flat(detail).filter(n => n.tag === 'button').map(n => String(n.text || ''));
  for (const label of buttons) {
    assert.ok(!/복구|재분석|다시 실행|복원/.test(label),
      `the detail must not offer an auto-executing recovery action (got "${label}")`);
  }
});

test('two rows sharing a timestamp are separately selectable', () => {
  const { context, state } = harness();
  const rows = context.diagnosticLogRows();
  const ids = rows.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'every row must have a unique id');
  const sameAt = rows.filter(r => r.at === 3000);
  assert.equal(sameAt.length, 2, `the fixture must contain two rows at the same millisecond (got ${sameAt.length})`);
  // Their ids must differ because their CONTENT differs — a timestamp-derived id would give both the
  // same value here and the selection would collapse, which is the defect that was measured.
  assert.notEqual(sameAt[0].id, sameAt[1].id, 'rows at the same millisecond must still have distinct ids');
  state.Gui.diagnosticLogSelectedId = sameAt[1].id;
  const node = context.buildDiagnosticLogList();
  const actives = part(node, 'libra-diag-row').filter(n => String(n.class || n.attrs?.class || '').includes('active'));
  assert.equal(actives.length, 1, `exactly one row may be active (got ${actives.length})`);
  const activeId = String(actives[0].dataset?.logRowId || actives[0].attrs?.dataset?.logRowId);
  assert.equal(activeId, sameAt[1].id,
    'the active row must be the one selected, not merely one with the same time');
  // And the detail must describe THAT row, not the other one at the same millisecond.
  const detail = flat(part(node, 'libra-diag-right')[0]).map(n => n.text).filter(Boolean).join(' | ');
  assert.ok(detail.includes(sameAt[1].title.slice(0, 12)),
    `the detail must show the selected row (got ${detail.slice(0, 120)})`);
  assert.ok(!detail.includes(sameAt[0].title.slice(0, 12)) || sameAt[1].title.slice(0, 12) === sameAt[0].title.slice(0, 12),
    'the detail must not show the OTHER row at the same millisecond');
});

test('two IDENTICAL rows (same kind, source and title) are still distinct', () => {
  const { context, state } = harness();
  // Only an identical-content duplicate forces the disambiguating suffix; this is the case a
  // content-derived id would otherwise collapse.
  state.Runtime.warnings.push({ at: 8000, msg: 'migration failed: synthetic' });
  const rows = context.diagnosticLogRows();
  const twins = rows.filter(r => r.title === 'migration failed: synthetic');
  assert.equal(twins.length, 2, `the fixture must contain the duplicate (got ${twins.length})`);
  assert.notEqual(twins[0].id, twins[1].id, 'identical rows must still be separately addressable');
  state.Gui.diagnosticLogSelectedId = twins[1].id;
  const node = context.buildDiagnosticLogList();
  const actives = part(node, 'libra-diag-row').filter(n => String(n.class || n.attrs?.class || '').includes('active'));
  assert.equal(actives.length, 1, 'exactly one duplicate may be active');
  state.Runtime.warnings.pop();
});

test('selection survives a refresh that adds a row to an earlier collector', () => {
  const { context, state } = harness();
  const before = context.diagnosticLogRows();
  const target = before.find(r => r.source === '런타임 경고' && /legacy/.test(r.title));
  assert.ok(target, 'the fixture must contain the row under test');
  state.Gui.diagnosticLogSelectedId = target.id;
  // A NEW swallowed-error entry arrives — it is collected BEFORE the runtime warnings, so any
  // order-based id would shift every later row.
  state.swallowed.push({ plugin: 'RETRACE', tag: 'dialogue.parse', count: 1, lastAt: 7000, lastMessage: 'new' });
  const node = context.buildDiagnosticLogList();
  const actives = part(node, 'libra-diag-row').filter(n => String(n.class || n.attrs?.class || '').includes('active'));
  assert.equal(actives.length, 1, `exactly one row must stay active (got ${actives.length})`);
  const activeId = String(actives[0].dataset?.logRowId || actives[0].attrs?.dataset?.logRowId);
  assert.equal(activeId, target.id,
    `the SAME row must remain selected after a refresh (was ${target.id}, got ${activeId})`);
  const detail = flat(part(node, 'libra-diag-right')[0]).map(n => n.text).filter(Boolean).join(' | ');
  assert.ok(detail.includes(target.title.slice(0, 10)),
    `the detail must still describe the selected row (got ${detail.slice(0, 120)})`);
  state.swallowed.pop();
});

test('a row keeps its identity when the collector refreshes the object in place', () => {
  const { context, state } = harness();
  const row = state.Runtime.warnings.find(r => /quota/.test(String(r.msg || '')));
  assert.ok(row, 'the fixture must contain the warning under test');
  const before = context.diagnosticLogRows().find(r => /quota/.test(r.title));
  state.Gui.diagnosticLogSelectedId = before.id;
  // The collector owns this object; anything it does to it in place (a refreshed timestamp) must not
  // move the row's identity. A NEW occurrence is a different matter — `warn()` pushes a new object,
  // and that new object is correctly a new row (asserted separately below).
  row.at = Number(row.at) + 6000;
  const after = context.diagnosticLogRows().find(r => /quota/.test(r.title));
  assert.equal(after.id, before.id,
    `an in-place refresh must keep the id (was ${before.id}, got ${after.id})`);
  const node = context.buildDiagnosticLogList();
  const actives = part(node, 'libra-diag-row').filter(n => String(n.class || n.attrs?.class || '').includes('active'));
  assert.equal(actives.length, 1, 'the selection must survive the in-place refresh');
});

test('a new occurrence of the same message is a new row with its own id', () => {
  const { context, state } = harness();
  const first = context.diagnosticLogRows().filter(r => /quota/.test(r.title));
  assert.equal(first.length, 1, 'the fixture must start with one occurrence');
  // warn() pushes a NEW object for each occurrence — that is a new event, not the same row re-rendered.
  state.Runtime.warnings.push({ at: 12000, msg: 'quota warning' });
  const rows = context.diagnosticLogRows().filter(r => /quota/.test(r.title));
  assert.equal(rows.length, 2, 'the second occurrence must appear as its own row');
  assert.notEqual(rows[0].id, rows[1].id, 'two occurrences must be separately addressable');
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length, 'ids must be unique');
  const node = context.buildDiagnosticLogList();
  const actives = part(node, 'libra-diag-row').filter(n => String(n.class || n.attrs?.class || '').includes('active'));
  assert.equal(actives.length, 1, 'exactly one row may be active');
  state.Runtime.warnings.pop();
});

test('selection survives an aggregate count growing (1회 -> 2회)', () => {
  const { context, state } = harness();
  const before = context.diagnosticLogRows().find(r => r.source === '무시된 오류' && /ledger/.test(r.title));
  assert.ok(before, 'the fixture must contain the aggregate row under test');
  assert.ok(/1회/.test(before.title), `expected the 1회 aggregate first (got ${before.title})`);
  state.Gui.diagnosticLogSelectedId = before.id;
  // The same aggregate fires again: the collector mutates ITS row in place. The displayed title
  // changes (`1회` -> `2회`), so a title-derived id would lose the selection.
  const row = state.swallowed.find(r => r.tag === 'ledger.write');
  row.count += 1;
  row.lastAt = 5000;
  const after = context.diagnosticLogRows().find(r => r.source === '무시된 오류' && /ledger/.test(r.title));
  assert.ok(/2회/.test(after.title), `the title must have changed (got ${after.title})`);
  assert.equal(after.id, before.id,
    `an aggregate must keep its id when its count changes (was ${before.id}, got ${after.id})`);
  const node = context.buildDiagnosticLogList();
  const actives = part(node, 'libra-diag-row').filter(n => String(n.class || n.attrs?.class || '').includes('active'));
  assert.equal(actives.length, 1, 'the selection must survive the count change');
  row.count -= 1;
});

test('selection survives an older duplicate being evicted', () => {
  const { context, state } = harness();
  // Three warnings with IDENTICAL text; the collector drops the oldest past a cap (60 in the
  // shipped code), so eviction is a real path. Pick the SECOND of the three.
  const original = state.Runtime.warnings.slice();
  state.Runtime.warnings = [];
  for (let i = 0; i < 3; i += 1) state.Runtime.warnings.push({ at: 1000 + i, msg: 'identical warning text' });
  const before = context.diagnosticLogRows().filter(r => r.title === 'identical warning text');
  assert.equal(before.length, 3, `the fixture must hold three identical rows (got ${before.length})`);
  // The log is sorted newest-first, so identify the rows by their timestamp rather than by index.
  const idAt = (list, at) => list.find(r => r.at === at)?.id;
  const middle = idAt(before, 1001);
  assert.ok(middle, 'the fixture must contain the middle occurrence');
  state.Gui.diagnosticLogSelectedId = middle;
  // Evict the OLDEST (at=1000) — what the shipped collector does past its cap. A positional suffix
  // (#2) would be re-assigned to whichever row is now second, moving the selection.
  state.Runtime.warnings.shift();
  const after = context.diagnosticLogRows().filter(r => r.title === 'identical warning text');
  assert.equal(after.length, 2, 'one row must have been evicted');
  assert.equal(idAt(after, 1001), middle, `the selected row must keep its id after eviction (was ${middle}, got ${idAt(after, 1001)})`);
  assert.equal(idAt(after, 1002), idAt(before, 1002), 'the newest row must keep its own id too');
  assert.notEqual(idAt(after, 1002), middle, 'the two survivors must stay distinguishable');
  const node = context.buildDiagnosticLogList();
  const actives = part(node, 'libra-diag-row').filter(n => String(n.class || n.attrs?.class || '').includes('active'));
  assert.equal(actives.length, 1, 'exactly one row must remain active');
  assert.equal(String(actives[0].dataset?.logRowId || actives[0].attrs?.dataset?.logRowId), middle,
    'the selection must not move to another occurrence of the same text');
  state.Runtime.warnings = original;
});

// ── 4. paging, so a long log does not build everything ──────────────────────────────────────
test('the list is paged', () => {
  const { context, state } = harness();
  state.Gui.diagnosticLogLimit = 2;
  const node = context.buildDiagnosticLogList();
  const rows = part(node, 'libra-diag-row').length;
  assert.ok(rows <= 2, `the list must honour the page size (got ${rows})`);
});

// ── 5. the other sections still render their own panels ─────────────────────────────────────
test('the other diagnostic sections keep their panels', () => {
  const { context } = harness();
  const expectations = [['health', 'panel-health'], ['swallowed', 'panel-swallowed'],
                        ['state_reflection', 'panel-state'], ['runtime', 'panel-runtime']];
  for (const [id, cls] of expectations) {
    const node = context.buildDiagnosticLogSection(id);
    assert.ok(byClass(node, cls).length === 1, `section ${id} must render ${cls}, not another panel`);
  }
});

console.log(JSON.stringify({ test: 'libra_diagnostic_log_contract', passed: results.length, scenarios: results }));
console.log('libra_diagnostic_log_contract_test: PASS');
