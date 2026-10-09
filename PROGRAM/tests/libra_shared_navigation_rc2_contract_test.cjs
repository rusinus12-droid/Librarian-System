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

const navigation = between('const resolveSharedNavigationTarget =', 'const GUI_FAMILY_HUB_STATE_KEYS =');
assert.match(navigation, /const sharedNavigate = sectionValue =>/);
assert.match(navigation, /Gui\.sharedSidebarSection = pageId;[\s\S]*Gui\.sidebarSection = pageId;/);
for (const [legacy, target] of [
  ['memories', "pageId: 'memory'"],
  ['continuity_state', "pageId: 'world'"],
  ['memory_pipeline', "pageId: 'pipeline'"],
  ['gradia_pipeline', "gradiaDraftSection: 'stages'"],
  ['gradia_input', "settingsHubSection: 'input_writer'"],
  ['prompt_studio', "pageId: 'custom'"],
  ['story_arc_direction', "libraDraftSection: 'direction'"],
  ['providers', "pageId: 'ai'"],
  ['embedding', "pageId: 'embedding'"],
  ['runs', "pageId: 'logs'"],
  ['server', "settingsHubSection: 'server'"],
  ['memory_restore', "settingsHubSection: 'recovery'"]
]) {
  assert.ok(navigation.includes(legacy) && navigation.includes(target), `missing legacy route: ${legacy}`);
}

const routeContext = {
  Object,
  Array,
  String,
  LIBRA_MEMORY_PIPELINE_STAGES: ['ariadne', 'character_ito', 'world_ito', 'plot_ito'],
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
  ['gradia_results', { pageId: 'pipeline', pipelineHubSection: 'response_generation', gradiaDraftSection: 'results' }],
  ['input_writer', { pageId: 'settings', settingsHubSection: 'input_writer' }],
  ['story_arc_direction', { pageId: 'pipeline', pipelineHubSection: 'response_generation', libraDraftSection: 'direction' }],
  ['providers', { pageId: 'ai' }],
  ['debug', { pageId: 'settings', settingsHubSection: 'general', generalSettingsSection: 'debug' }]
]) assert.deepEqual(JSON.parse(JSON.stringify(routeContext.resolveShared(input))), expected, `route mismatch: ${input}`);
assert.deepEqual(JSON.parse(JSON.stringify(routeContext.resolveShared('unknown-page'))),
  { pageId: 'memory', memoryHubSection: 'read' }, 'unknown routes must enter the Canonical Reader');

const familyKeys = between('const GUI_FAMILY_HUB_STATE_KEYS =', 'const guiFamilyHubDefaults =');
for (const commonKey of [
  'memoryHubSection', 'memoryPipelineStage', 'storyArcHubSection',
  'referenceHubSection', 'connectionHubSection', 'settingsHubSection', 'sharedSidebarSection'
]) assert.doesNotMatch(familyKeys, new RegExp(`['"]${commonKey}['"]`), `${commonKey} must remain common across families`);

const mobile = between('const BOOK_MOBILE_ITEMS =', 'const GUI_SCROLL_SELECTORS =');
assert.match(mobile, /BOOK_SIDEBAR_PAGE_REGISTRY\.filter/);
assert.match(mobile, /Gui\.bookPage/);
assert.doesNotMatch(mobile, /buildGradiaMobileNavigation/);

require('./helpers/libra_active_book_routes.cjs')(source);
const unread = between('const routeUnreadGradiaResult =', 'const acknowledgeRenderedGradiaResult =');
assert.match(unread, /sharedSidebarSection = 'pipeline'/);
assert.match(unread, /pipelineHubSection = 'response_generation'/);
assert.match(unread, /gradiaDraftSection = 'results'/);
assert.doesNotMatch(unread, /gradiaPageId = 'gradia_results'/);

const switcher = between('const activateResponseFamilyFromHeader =', 'const GRADIA_STAGE_ALIAS_MAP =');
assert.match(switcher, /migrateLegacyGuiNavigationState\(\)/);
assert.match(switcher, /Gui\.sharedSidebarSection = SHARED_SIDEBAR_SECTIONS\.includes/);
assert.doesNotMatch(switcher, /Gui\.gradiaSidebarSection\s*=/);
assert.doesNotMatch(switcher, /Gui\.libraSidebarSection\s*=/);

const render = between('async function renderSettingsGuiOnce()', 'const hideSettingsGui =');
const headerSelection = render.match(/const selectResponseFamilyFromHeader = (async nextFamily => \{[\s\S]*?\n    \});/);
assert.ok(headerSelection, 'header family selection remains available');
const headerState = { bookFamilyMenuOpen: true, invalidations: new Set() };
let activation;
const selectHeaderFamily = vm.runInNewContext(`(${headerSelection[1]})`, {
  Gui: headerState,
  activateResponseFamilyFromHeader: family => {
    activation = { family, menuOpen: headerState.bookFamilyMenuOpen, headerInvalidated: headerState.invalidations.has('header') };
  }
});
void selectHeaderFamily('gradia');
assert.deepEqual(activation, { family: 'gradia', menuOpen: false, headerInvalidated: true },
  'header selection closes and invalidates the menu before activating the requested family');

assert.match(source, /settingsHubSection: 'input_writer',[\s\S]*generalSettingsSection: 'memory_settings'/,
  'fresh GUI state opens Settings on Input Writer configuration without changing the legacy general-settings fallback');
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
