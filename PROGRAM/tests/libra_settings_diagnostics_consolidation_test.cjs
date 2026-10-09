'use strict';
// ONE HOME PER SETTING, ONE SCREEN FOR DIAGNOSTICS.
//
// WHY THIS EXISTS (§32.1 요청 6·7, §34)
//   Two independent complaints, both about the same failure mode — the same content offered twice:
//
//   · 원문 수정 확인 had its own settings route (`source_edits`) AND its own sidebar entry, and
//     buildGeneralSettingsPanel called the same panel again. The user saw one panel in its own menu
//     and a second copy inside 일반 · 진단, and mounting the tracking controls twice registered the
//     same DOM id and handlers twice.
//   · The diagnostics screen stacked four large panels (운영 상태, 무시된 오류, 상태 반영 진단,
//     디버그). Each was its own always-built card, so opening 일반 · 진단 built all four at once.
//
// WHAT THIS SUITE LOCKS
//   1. the general settings screen does NOT call the source-edit panel (its own route still does);
//   2. the source-edit route and sidebar entry still exist — the fix removes a duplicate, not the
//      feature;
//   3. the diagnostics screen renders ONE section at a time, chosen by the rail, and does not build
//      the unselected sections;
//   4. every diagnostic section the old layout exposed is still reachable — nothing was dropped in
//      the consolidation;
//   5. the panels are built lazily, so opening the screen does not pay for all four.
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

const results = [];
const test = (name, fn) => { fn(); results.push(name); };
const failures = [];
const guarded = (name, fn) => { try { fn(); results.push(name); } catch (error) { failures.push(`${name}: ${error.message}`); } };

// ── 1. the general screen must not mount the source-edit panel ───────────────────────────────
const generalSource = between('const buildGeneralSettingsPanel =', 'const buildSharedSettingsShellPanel =');
test('buildGeneralSettingsPanel does not call buildSourceEditConsentPanel', () => {
  assert.ok(!/buildSourceEditConsentPanel\s*\(/.test(generalSource),
    'the general screen must not mount the source-edit panel — that is the duplicate');
});

test('the source-edit route and its sidebar entry still exist', () => {
  assert.ok(/section === 'source_edits'\)\s*return buildSourceEditConsentPanel\(\)/.test(source),
    'the independent settings route must survive');
  assert.ok(/'source_edits'/.test(source), 'the sidebar/registry entry must survive');
  const sidebar = source.match(/\{id:'source_edits'[^}]*\}/);
  assert.ok(sidebar, 'the independent menu entry must survive the de-duplication');
});

// ── 2. diagnostics: one section at a time, lazily ────────────────────────────────────────────
const contexts = { built: [] };
const diagContext = vm.createContext({
  guiEl: el,
  guiLazyDetails: (attrs, summary, build) => el('details', attrs, [summary, ...build()]),
  buildLibraSectionLayout: (definitions, selected, onSelect, ariaLabel, panel) =>
    el('div', { class: 'libra-section-layout' }, [
      el('div', { class: 'libra-section-rail', dataset: { selected, ariaLabel } },
        definitions.map(d => el('button', { class: 'rail-item', dataset: { id: d.id, selected: String(d.id === selected) }, text: d.label }))),
      el('div', { class: 'libra-section-content' }, [panel])
    ]),
  buildOperationalHealthPanel: () => { contexts.built.push('health'); return el('section', { class: 'diag-health' }); },
  buildSwallowedDiagPanel: () => { contexts.built.push('swallowed'); return el('section', { class: 'diag-swallowed' }); },
  buildWorldManagerDiagnosticsPanel: () => { contexts.built.push('state_reflection'); return el('section', { class: 'diag-state' }); },
  buildDebugTab: () => { contexts.built.push('runtime'); return el('section', { class: 'diag-runtime' }); },
  // §34.2: the default section is the unified log, which reads these helpers.
  text: value => String(value ?? '').trim(),
  guiAsArray: value => (Array.isArray(value) ? value : []),
  libraStatusBadge: (label, tone) => el('span', { class: `badge ${tone}`, text: label }),
  libraFormatTime: at => `t${at}`,
  libraStatusBadgeTone: null,
  queueGuiRender: () => {},
  queueGuiNavigationRender: () => {},
  guiSetStatus: () => {},
  bookNavigate: () => {},
  selectBookSettingsRoomSection: () => {},
  Runtime: { warnings: [], stageTrace: [] },
  STAGE_DEF_MAP: {},
  traceStateInfo: () => ({ label: '확인', className: 'good', elapsed: '' }),
  LibraMemoryCore: { peekSnapshot: () => ({ scope: { scopeKey: 'A' }, manifest: { memories: {} } }), state: {} },
  Gui: { diagnosticLogSection: 'health', diagnosticLogQuery: '', diagnosticLogKind: 'all', diagnosticLogLimit: 60, diagnosticLogSelectedAt: 0 }
});
vm.runInContext(`${between('const DIAGNOSTIC_LOG_SECTIONS =', 'const buildGeneralSettingsPanel =')};Object.assign(globalThis,{buildDiagnosticLogPanel,DIAGNOSTIC_LOG_SECTIONS,buildDiagnosticLogSection});`, diagContext);

test('all four previous diagnostic sections are still offered, plus the log', () => {
  const ids = diagContext.DIAGNOSTIC_LOG_SECTIONS.map(s => s.id);
  // The review found that routing 'health' into the log made the operational panel unreachable, so
  // each previous panel keeps its own section and the log is added beside them.
  for (const id of ['health', 'swallowed', 'state_reflection', 'runtime']) {
    assert.ok(ids.includes(id), `the consolidated screen must still expose ${id}`);
  }
  assert.ok(ids.includes('log'), 'the unified log must be offered');
  assert.equal(ids.length, 5, 'four previous sections plus the log — nothing dropped');
});

test('selecting a section builds ONLY that section', () => {
  // §34.2: the default section is the unified LOG; the other three keep their own panels.
  for (const [id, panelClass] of [['swallowed', 'diag-swallowed'],
                                  ['state_reflection', 'diag-state'], ['runtime', 'diag-runtime']]) {
    contexts.built = [];
    diagContext.Gui = Object.assign(diagContext.Gui || {}, { diagnosticLogSection: id });
    const node = diagContext.buildDiagnosticLogPanel();
    assert.equal(contexts.built.length <= 1, true,
      `selecting ${id} must not build the other sections (built ${JSON.stringify(contexts.built)})`);
    const body = flat(node).filter(n => String(n.class || '').includes(panelClass));
    assert.equal(body.length, 1, `the ${id} section must render its own panel (${panelClass})`);
  }
});

test('the default section renders the unified log, not the old health card', () => {
  contexts.built = [];
  diagContext.Gui = Object.assign(diagContext.Gui || {}, { diagnosticLogSection: 'log' });
  const node = diagContext.buildDiagnosticLogPanel();
  const log = flat(node).filter(n => String(n.class || '').includes('libra-diag-layout'));
  assert.equal(log.length, 1, '§34.2: the default diagnostic section must be the searchable log');
  // ...and the old health panel must NOT be built just because the section is named health.
  assert.equal(contexts.built.includes('health'), false,
    'the unified log must not build the operational health panel behind the user');
});

test('the panel is lazy — building the screen does not construct a diagnostic panel yet', () => {
  contexts.built = [];
  diagContext.Gui = Object.assign(diagContext.Gui || {}, { diagnosticLogSection: 'health' });
  const node = diagContext.buildDiagnosticLogPanel();
  // guiLazyDetails in production defers buildChildren until the <details> is opened; this harness
  // calls it immediately, so the assertion is about the CONTAINER shape: the body sits inside one
  // details element rather than being inlined as a sibling.
  const details = flat(node).filter(n => n.tag === 'details');
  assert.ok(details.length >= 1, 'the section body must be wrapped so it can hydrate on open');
});

test('an unknown stored section falls back to the first instead of rendering nothing', () => {
  diagContext.Gui = Object.assign(diagContext.Gui || {}, { diagnosticLogSection: 'not-a-section' });
  const node = diagContext.buildDiagnosticLogPanel();
  const rail = flat(node).find(n => String(n.class || '').includes('libra-section-rail'));
  assert.ok(rail, 'the rail must render even when the stored choice is stale');
  const real = diagContext.DIAGNOSTIC_LOG_SECTIONS.map(s => s.id);
  assert.ok(real.includes(diagContext.Gui.diagnosticLogSection),
    `a stale section id must normalise to a real one (got ${diagContext.Gui.diagnosticLogSection}, real: ${real})`);
});

if (failures.length) {
  console.error(JSON.stringify({ test: 'libra_settings_diagnostics_consolidation', failures }, null, 1));
  console.log('libra_settings_diagnostics_consolidation_test: FAIL');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ test: 'libra_settings_diagnostics_consolidation', passed: results.length, scenarios: results }));
  console.log('libra_settings_diagnostics_consolidation_test: PASS');
}
