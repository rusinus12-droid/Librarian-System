'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const sourcePath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const betweenIfPresent = (start, end) => {
  const from = source.indexOf(start);
  if (from < 0) return '';
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
};

// Compatibility links retain factual/current and explicit user-direction readers.
const route=require('./helpers/libra_navigation_contract.cjs').navigation(source);
for(const [name,section] of [['story_arc','current'],['story_arc_current','current'],['story_arc_advanced','evidence'],['story_arc_direction','direction']])assert.deepEqual(route(name),{pageId:'narrative',narrativeHubSection:section},name+' follows the approved retained Narrative route');
assert.doesNotMatch(source,/const buildLibraDraftWorkspacePanel\s*=/,'retired response drafting must not be revived to satisfy old links');

// A compatibility builder is acceptable only as a redirect/shared-builder
// adapter. It must not construct or call the legacy Story Arc panel.
const compatibilityBuilder = betweenIfPresent(
  'const buildLibraStoryArcPanel =',
  'const buildLibraRecallViewerPanel ='
);
if (compatibilityBuilder) {
  assert.doesNotMatch(compatibilityBuilder, /buildLibraStoryArcPanelLegacy0316\s*\(/,
    'Story Arc compatibility builder still executes the legacy GUI');
  assert.doesNotMatch(compatibilityBuilder, /__libraCompletionRetireStoryArcDom\s*\(/,
    'Story Arc compatibility builder must not render-then-hide legacy DOM');
  assert.match(compatibilityBuilder, /buildWorldManagerNarrativePanel\s*\(|sharedNavigate\s*\(\s*['"]narrative['"]\s*\)/,
    'Story Arc compatibility builder must redirect to or render shared Narrative');
}

const legacyBuilderReferences = source.match(/buildLibraStoryArcPanelLegacy0316/g) || [];
assert.ok(legacyBuilderReferences.length <= 1,
  'legacy Story Arc builder has an executable call site; declaration-only debug code is the maximum allowed');

// No old family router may make Story Arc an active page again.
const oldGradiaRouter = betweenIfPresent(
  'const resolveGradiaNavigationTarget =',
  'const applyGradiaNavigationTarget ='
);
if (oldGradiaRouter) {
  assert.doesNotMatch(oldGradiaRouter, /pageId:\s*['"]story_arc['"]/,
    'old GRADIA router still selects the legacy Story Arc page');
}
const oldGradiaRenderer = betweenIfPresent(
  'const buildGradiaExecutionFlowTab =',
  'const buildGradiaSidebar ='
);
if (oldGradiaRenderer) {
  assert.doesNotMatch(oldGradiaRenderer, /buildLibraStoryArcPanel\s*\(/,
    'old GRADIA renderer still has an active Story Arc builder branch');
}

// The render-then-hide MutationObserver workaround is fully retired.
assert.doesNotMatch(source, /new\s+MutationObserver\s*\(/,
  'Story Arc MutationObserver DOM scan must be removed');
const retireHelperReferences = source.match(/__libraCompletionRetireStoryArcDom/g) || [];
assert.ok(retireHelperReferences.length <= 1,
  'Story Arc DOM retirement helper still has an active invocation');

const compatibilityApi = betweenIfPresent(
  'function __libraCompletionInstallPublicApi() {',
  '\n\n\n})();'
);
assert.match(compatibilityApi, /api\.getStoryArc\s*=\s*async/,
  'legacy read clients still need a Narrative projection adapter');
assert.match(compatibilityApi, /api\.rebuildStoryArc\s*=\s*async[\s\S]*rebuildWorldManagerNarrative/,
  'legacy rebuild clients must delegate to the World Manager Narrative owner');
assert.match(compatibilityApi, /api\.setStoryArcDestination\s*=\s*async[\s\S]*setNarrativeDirection/,
  'legacy direction writes must delegate to Planner Narrative Direction');
assert.doesNotMatch(compatibilityApi, /story-arc:|saveStoryArc|LibraMemoryCore\.setStoryArcDestination/,
  'compatibility adapters must not revive legacy Story Arc persistence');

// GUI code must not write legacy Story Arc settings/state. The migration/API
// compatibility layer outside this region is intentionally not covered here.
const guiRegion = betweenIfPresent(
  'const buildLibraStoryArcPanelLegacy0316 =',
  'const buildLibraRecallViewerPanel ='
);
if (guiRegion) {
  assert.doesNotMatch(guiRegion, /LibraMemoryCore\.(?:rebuildStoryArc|setStoryArcDestination|clearStoryArc|saveStoryArc)\s*\(/,
    'legacy Story Arc write remains reachable from GUI code');
}

process.stdout.write(`libra_story_arc_gui_retirement_rc2_test: PASS (${path.basename(sourcePath)})\n`);
