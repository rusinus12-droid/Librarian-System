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

// The approved six-product GUI retired the custom left section rail, the shared
// custom/agent/settings shells and the hub-tab CSS. The same navigation contracts
// now live in the shared hub tabs, the approved settings layout (.setnav groups +
// per-group .tabs) and the original suite CSS.
const approvedCss = (() => {
  const marker = 'const LIBRA_APPROVED_MOCKUP_STYLE = ';
  const at = source.indexOf(marker);
  assert.ok(at >= 0, 'approved suite CSS is embedded');
  return JSON.parse(source.slice(at + marker.length, source.indexOf('\n', at)).replace(/;\s*$/, ''));
})();

const tabs = between('const buildLibraHubTabs =', 'const canonicalReaderIdentityKey =');
assert.match(tabs, /role: 'tablist'/);
assert.match(tabs, /'aria-label': ariaLabel/);
assert.match(tabs, /role: 'tab'/);
assert.match(tabs, /text: definition\.label/, 'navigation tabs show their full label');
assert.match(tabs, /'aria-selected': String\(active\)/);
assert.match(tabs, /syncGuiTabSelectionFeedback\(event\.currentTarget\);\s*queueGuiNavigationRender\(\)/,
  'secondary navigation paints selection feedback before rebuilding the outlet');
const feedback = between('const syncGuiTabSelectionFeedback = button =>', 'const buildLibraHubTabs =');
assert.match(feedback, /closest\?\.\('\[role="tablist"\]'\)/);
assert.match(feedback, /setAttribute\('aria-selected', String\(active\)\)/);

assert.match(approvedCss, /\.settings-layout\{display:grid;grid-template-columns:230px minmax\(0,1fr\)/,
  'desktop settings use a bounded left category rail and flexible content');
assert.match(approvedCss, /\.setnav\{display:grid;gap:3px;position:sticky;top:0\}/);
assert.match(approvedCss, /\.setnav button\[aria-selected=true\]\{/);
assert.match(approvedCss, /@container app \(max-width:900px\)\{[^@]*\.settings-layout\{grid-template-columns:1fr\}\.setnav\{grid-auto-flow:column;grid-auto-columns:max-content;overflow:auto;position:static\}/,
  'narrow layouts collapse the category rail to one horizontally scrollable row');
assert.match(approvedCss, /\.tabs\{display:flex;[^}]*overflow-x:auto/,
  'contextual tabs stay on one row and scroll instead of wrapping');
assert.match(approvedCss, /\.tab\{[^}]*white-space:nowrap\}/,
  'contextual tab labels never wrap out of their tab');

const settingsLayout = between('const buildApprovedMockupSettings = () =>', 'const buildApprovedMockupPeople =');
assert.match(settingsLayout, /button\.setAttribute\('aria-selected',String\(activeGroup\.id===group\.id\)\);button\.setAttribute\('role','tab'\)/);
assert.match(settingsLayout, /guiEl\('nav',\{class:'tabs',role:'tablist','aria-label':`\$\{activeGroup\.label\} 상세 설정`\}/);
assert.match(settingsLayout, /'aria-selected':String\(active===id\)/);
const settingsSections = new Set(Array.from(settingsLayout.matchAll(/sections:\[([^\]]*)\]/g))
  .flatMap(match => Array.from(match[1].matchAll(/'([a-z_]+)'/g), item => item[1])));
for (const id of ['references', 'memory', 'state', 'scopes', 'recovery', 'transfer', 'general']) {
  assert.ok(settingsSections.has(id), `missing settings category: ${id}`);
}
assert.equal(settingsSections.has('server'), false,
  'Settings storage category removes duplicate server entry button; dedicated sidebar server navigation remains authoritative');
assert.match(settingsLayout, /sections:\['scopes','recovery','transfer'\]/,
  'Settings store category opens scope management by default and keeps user inside settings');

const navFeedback = between('const syncGuiNavigationFeedback = () =>', 'const cancelQueuedGuiFrame =');
assert.match(navFeedback, /scopes:'store'/, 'navigation feedback maps scopes to store settings tab');

const sidebarPages = between('const BOOK_SIDEBAR_PAGE_REGISTRY =', 'const BOOK_PAGE_IDS =');
assert.match(sidebarPages, /id:\s*'server'/, 'dedicated sidebar server connection page remains registered');

// Retired custom-workshop deep links migrate to the memory analyzer route, which
// authors analysis settings only and never duplicates execution results.
const migration = between('const migrateCustomWorkshopSelection = () =>', 'const executionReceiptCacheKey =');
assert.match(migration, /Gui\.bookSettingsWorkbenchSection='pipeline'/);
const selectRoom = between('const selectBookSettingsRoomSection = id =>', 'if (id === \'agents\')');
assert.match(selectRoom, /if \(id === 'custom'\) \{ migrateCustomWorkshopSelection\(\); id = 'pipeline'; \}/);
const settingsPanel = between('const buildApprovedMockupSettingsPanel = (groupId, sectionId) =>', "if(groupId==='mem')");
assert.match(settingsPanel, /if\(sectionId==='pipeline'\)return buildLibrarianAnalyzerPanel\(false,false\)/);
assert.match(settingsPanel, /if\(sectionId==='logs'\)return buildSharedExecutionLogsPanel\(\)/);
const analyzer = between('const buildLibrarianAnalyzerPanel =', 'const exportConfiguration =');
assert.match(analyzer, /openApprovedPromptDialog\(\)/, 'prompt authoring opens the Lens Studio');
assert.match(analyzer, /guiEl\('details',\{class:'fold'\}/, 'expert analyzer controls stay folded');
assert.doesNotMatch(analyzer, /이번 턴 적용 결과|id: 'injection'|buildLibraSgaPanel|buildPromptInjectionPanel/,
  'the analyzer route is authoring only and does not duplicate execution results');

const logs = between('const buildSharedExecutionLogsPanel =', 'const buildAnalysisInputPanel =');
assert.match(logs, /normalizeHubChoice\(Gui\.executionLogSection,SHARED_EXECUTION_LOG_SECTIONS,'memory'\)/);
assert.match(logs, /class:'tabs',role:'tablist'/);
assert.match(logs, /'aria-selected':String\(Gui\.executionLogSection===id\)/);
for (const id of ['memory', 'state', 'draft', 'recall', 'embedding', 'rebuild']) {
  assert.ok(logs.includes(`['${id}',`), `missing execution category: ${id}`);
}

process.stdout.write('libra_secondary_navigation_rail_contract_test: PASS\n');
