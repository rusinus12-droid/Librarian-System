'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

const registryBlock = between('const SHARED_SIDEBAR_PAGE_REGISTRY =', 'const normalizeHubChoice =');
const context = { Object, Array };
Object.assign(context,require('./fixtures/librarian_production_bindings.cjs')(source,['LIBRARIAN_STAGE_ID','RETIRED_MEMORY_STAGE_IDS']));
vm.createContext(context);
vm.runInContext(`${registryBlock}\nthis.registry = SHARED_SIDEBAR_PAGE_REGISTRY;`, context);
assert.deepEqual(Array.from(context.registry, page => page.id), [
  'memory', 'characters', 'relationships', 'world',
  'narrative', 'pipeline', 'ai', 'embedding', 'logs', 'settings'
]);
assert.deepEqual(Array.from(context.registry, page => page.label), [
  '기억', '인물', '관계', '세계', '내러티브', '에이전트 작업대', 'AI 연결', '임베딩 연결', '실행 기록', '설정'
]);

const navigation = between('const resolveSharedNavigationTarget =', 'const normalizeBookPage =');
assert.match(source, /const sharedNavigate = sectionValue =>/);
assert.match(navigation, /Gui\.sharedSidebarSection = pageId;[\s\S]*Gui\.sidebarSection = pageId;/);
const routeContext = {
  Object,
  Array,
  String,
  LIBRA_MEMORY_PIPELINE_STAGES: ['librarian'],
  LIBRA_REFERENCE_HUB_SECTIONS: ['modules', 'character_lore_exclusions', 'response_materials'],
  LIBRA_CONNECTION_HUB_SECTIONS: ['providers', 'embedding'],
  GRADIA_STAGE_ALIAS_MAP: { sga_shadow: 'sga_shadow' }
};
Object.assign(routeContext,require('./fixtures/librarian_production_bindings.cjs')(source,['LIBRARIAN_STAGE_ID','RETIRED_MEMORY_STAGE_IDS']));
vm.createContext(routeContext);
vm.runInContext(`${registryBlock}\n${navigation}\nthis.resolveShared = resolveSharedNavigationTarget;`, routeContext);
for (const [input, expected] of [
  ['home', { pageId: 'memory', memoryHubSection: 'read' }],
  ['memories', { pageId: 'memory', memoryHubSection: 'manage' }],
  ['continuity_state', { pageId: 'world' }],
  ['agent_plot_ito', { pageId: 'agents', agentHubSection: 'memory', memoryPipelineStage: 'librarian' }],
  ['gradia_results', { pageId: 'memory', memoryHubSection: 'read' }],
  ['input_writer', { pageId: 'memory', memoryHubSection: 'read' }],
  ['story_arc_direction', { pageId: 'narrative', narrativeHubSection: 'direction' }],
  ['providers', { pageId: 'ai' }],
  ['debug', { pageId: 'settings', settingsHubSection: 'general', generalSettingsSection: 'debug' }]
]) assert.deepEqual(JSON.parse(JSON.stringify(routeContext.resolveShared(input))), expected, `route mismatch: ${input}`);
assert.deepEqual(JSON.parse(JSON.stringify(routeContext.resolveShared('unknown-page'))),
  { pageId: 'memory', memoryHubSection: 'read' }, 'unknown routes must enter the Canonical Reader');

// The response-family state cache retired. Common navigation must retain draft state.
const navigationGui={dirty:true,state:{retained:'unsaved'}};
routeContext.Gui=navigationGui;
vm.runInContext(between('const normalizeHubChoice =','const resolveSharedNavigationTarget ='),routeContext);
routeContext.normalizePromptInjectionSection=v=>v;
routeContext.LIBRA_SETTINGS_HUB_SECTIONS=['memory_settings','debug'];
vm.runInContext('this.apply=applySharedNavigationTarget;',routeContext);
const draft=navigationGui.state;
for(const id of ['memory','world','server','recall']){routeContext.apply(routeContext.resolveShared(id));assert.equal(navigationGui.state,draft);assert.equal(navigationGui.dirty,true);}

const mobile = between('const BOOK_MOBILE_ITEMS =', 'const GUI_SCROLL_SELECTORS =');
assert.match(mobile, /BOOK_SIDEBAR_PAGE_REGISTRY\.filter/);
assert.match(mobile, /Gui\.bookPage/);
assert.doesNotMatch(mobile, /buildGradiaMobileNavigation/);

require('./helpers/libra_active_book_routes.cjs')(source);
// Removed embedded GRADIA result routing/header switcher has no current executor.
assert.match(source,/const normalizeResponseFamily = \(\) => 'libra'/);
const general = between('const buildGeneralSettingsPanel =', 'const buildSharedSettingsShellPanel =');
// The diagnostic section was consolidated behind a dispatcher (§34.2), so buildDebugTab() is no longer
// called directly here. What must still hold is that the general panel OFFERS the diagnostics and that
// the dispatcher can actually reach every panel — including buildDebugTab — so nothing was lost.
assert.match(general, /buildDiagnosticLogPanel\(\)/, 'the general settings panel must offer diagnostics');
assert.doesNotMatch(general, /Gui\.settingsHubSection === 'transfer'/);
const dispatcher = between('const buildDiagnosticLogSection = id =>', 'const buildDiagnosticLogPanel =');
for (const [id, builder] of [['health', 'buildOperationalHealthPanel'], ['swallowed', 'buildSwallowedDiagPanel'],
                             ['state_reflection', 'buildWorldManagerDiagnosticsPanel'], ['runtime', 'buildDebugTab']]) {
  assert.ok(dispatcher.includes(`id === '${id}'`) && dispatcher.includes(builder),
    `the diagnostics dispatcher must still reach ${builder} (${id})`);
}
assert.ok(dispatcher.includes("'log'") || dispatcher.includes('buildDiagnosticLogList'),
  'the dispatcher must still offer the unified log');

process.stdout.write('libra_shared_navigation_rc2_contract_test: PASS\n');
