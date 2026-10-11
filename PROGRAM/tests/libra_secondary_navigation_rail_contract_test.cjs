'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.match(source.slice(0, 512), releasePattern("\\/\\/@version {libra}", ""),
  'the release version must remain inside the first 512 bytes');

const rail = between('const buildLibraSectionRail =', 'const canonicalReaderIdentityKey =');
assert.match(rail, /class: 'libra-section-rail'/);
assert.match(rail, /role: 'tablist'/);
assert.match(rail, /title: definition\.label/,
  'truncated navigation labels retain their full accessible hover title');
assert.match(rail, /'aria-selected': String\(active\)/);
assert.match(rail, /syncGuiTabSelectionFeedback\(event\.currentTarget\)[\s\S]*queueGuiNavigationRender\(\)/,
  'secondary navigation paints selection feedback before rebuilding the outlet');
assert.match(rail, /class: 'libra-section-layout'[\s\S]*class: 'libra-section-content', role: 'tabpanel'/);

assert.match(source, /\.libra-section-layout\{display:grid;grid-template-columns:minmax\(176px,208px\) minmax\(0,1fr\)/,
  'desktop category pages use a bounded left rail and flexible content');
assert.match(source, /\.libra-section-rail\{position:sticky;top:0;display:flex;[\s\S]*flex-direction:column/);
assert.match(source, /\.libra-section-rail \.sga-btn\{[\s\S]*overflow:hidden[\s\S]*text-overflow:ellipsis;white-space:nowrap/,
  'long rail labels never protrude or wrap');
assert.match(source, /@media\(max-width:900px\)\{\.libra-section-layout\{display:block\}[\s\S]*\.libra-section-rail\{[\s\S]*flex-direction:row;overflow-x:auto;overflow-y:hidden/,
  'narrow layouts collapse to one horizontally scrollable row');
assert.match(source, /\.libra-hub-tabs\{display:flex!important;[\s\S]*flex-wrap:nowrap!important[\s\S]*overflow-x:auto/,
  'remaining contextual tabs stay on one row and scroll instead of wrapping');
assert.match(source, /\.libra-hub-tabs \.sga-btn\{[\s\S]*min-width:0[\s\S]*text-overflow:ellipsis;white-space:nowrap/,
  'remaining contextual labels cannot escape their tab');

const custom = between('const buildSharedCustomShellPanel =', 'const executionReceiptCacheKey =');
assert.match(custom, /migrateCustomWorkshopSelection\(\)/);
assert.match(custom, /buildSharedAgentShellPanel\(\)/);
const agents = between('const buildSharedAgentShellPanel =', 'const setSharedCustomPromptDomain =');
assert.match(agents,/buildMemoryPromptStudioDisclosure\(/);
assert.match(agents,/buildMemoryPipelinePanel\(\)/);
assert.doesNotMatch(custom, /이번 턴 적용 결과|id: 'injection'|buildLibraSgaPanel|buildPromptInjectionPanel/,
  'Custom is prompt authoring only and does not duplicate execution results');

const logs = between('const buildSharedExecutionLogsPanel =', 'const buildGeneralSettingsPanel =');
assert.match(logs, /buildLibraSectionLayout\(definitions, Gui\.executionLogSection/);
for (const id of ['memory', 'state', 'draft', 'recall', 'embedding', 'rebuild']) {
  assert.ok(logs.includes(`id: '${id}'`), `missing execution category: ${id}`);
}

const settings = between('const buildSharedSettingsShellPanel =', 'const renderActiveTab =');
assert.match(settings, /buildLibraSectionLayout\(definitions, Gui\.settingsHubSection/);
for (const id of ['references', 'memory', 'state', 'server', 'recovery', 'transfer', 'general']) {
  assert.ok(settings.includes(`id: '${id}'`), `missing settings category: ${id}`);
}

// Embedded GRADIA category rails retired; retained Memory prompt disclosure is lazy.
const memoryPrompts=between('const buildMemoryPromptStudioDisclosure =','const buildSharedAgentShellPanel =');
assert.match(memoryPrompts,/guiLazyDetails/);
assert.match(memoryPrompts,/allowedDomains: \['memory'\]/);

process.stdout.write('libra_secondary_navigation_rail_contract_test: PASS\n');
