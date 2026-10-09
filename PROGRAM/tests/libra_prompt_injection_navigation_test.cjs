'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

const sliceBetween = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.match(source, /promptInjectionSection:\s*'sga'/, 'SGA remains the default current-turn GRADIA result page');
assert.match(source, /PROMPT_INJECTION_SECTION_IDS\s*=\s*Object\.freeze\(\['sga', 'planner', 'recall'\]\)/,
  'legacy current-turn result IDs keep a stable alias set');

const resolver = sliceBetween('const resolveSharedNavigationTarget =', 'const applySharedNavigationTarget =');
assert.match(resolver, /requested === 'recall'.*pageId: 'logs', executionLogSection: 'recall'/s,
  'legacy recall routes land on the execution-owned Recall log');
assert.match(resolver, /\['prompt_injection', 'planner', 'sga'\]\.includes\(requested\).*pageId: 'memory', memoryHubSection: 'context'/s,
  'remaining legacy result routes retain their shared Memory evidence context compatibility');
assert.match(resolver, /requested === 'prompt'.*requested === 'prompt_studio'.*pageId: 'custom', customHubSection: 'active_draft'/s,
  'legacy prompt settings routes land in the active draft custom workspace');
assert.match(resolver, /requested === 'prompt_studio_ooc'.*pageId: 'custom', customHubSection: 'ooc'/s,
  'legacy OOC routes land in Custom > OOC Builder');
assert.match(resolver, /requested === 'gradia_prompt_results'.*pageId: 'logs', executionLogSection: 'draft'/s,
  'GRADIA prompt-result routes land in the authoritative draft execution log');

const navigation = sliceBetween('const applySharedNavigationTarget =', 'const GUI_FAMILY_HUB_STATE_KEYS =');
assert.match(navigation, /Gui\.sharedSidebarSection = pageId/,
  'shared navigation updates the selected top-level sidebar page');
assert.match(navigation, /Gui\.customHubSection = normalizeHubChoice/,
  'shared navigation applies the Custom subpage');
assert.match(navigation, /Gui\.promptInjectionSection = normalizePromptInjectionSection/,
  'shared navigation applies the current-turn result subpage');
assert.match(source, /const libraGuiNavigate = \(section, _tab = 'flow'\) => \{\s*sharedNavigate\(section\);\s*\}/,
  'the LIBRA compatibility navigator delegates to the shared router');

const custom = sliceBetween('const buildSharedAgentShellPanel =', 'const setSharedCustomPromptDomain =');
assert.match(custom, /고급 프롬프트 설정/);
assert.match(custom, /buildLibraPromptStudioPanel\(\{family,allowedDomains:\[promptDomain\]\}\)/);
assert.doesNotMatch(custom, /이번 턴 적용 결과|id: 'injection'/,
  'Custom must not duplicate results owned by Execution Log');
assert.match(custom, /Gui\.agentHubSection==='draft'.*renderPromptStudioOocBuilder/s,
  'the draft workbench owns the OOC builder');
assert.match(custom, /buildLibraHubTabs\(definitions, Gui\.agentHubSection/,
  'the workbench uses the shared accessible tabs');

const promptPanel = sliceBetween('const buildLibraHubTabs =', 'const buildLibraSectionLayout =');
assert.match(promptPanel, /role: 'tablist'/, 'current-turn result selectors remain accessible tabs');
assert.match(promptPanel, /'aria-selected': String\(active\)/, 'the selected result tab is exposed to assistive technology');

require('./helpers/libra_active_book_routes.cjs')(source);
const sidebar = sliceBetween('const buildBookSidebar =', 'const BOOK_MOBILE_ITEMS =');
assert.match(sidebar, /BOOK_SIDEBAR_PAGE_REGISTRY\.map/,
  'desktop navigation uses the one shared page registry');
assert.doesNotMatch(sidebar, /item\('(?:sga|planner|recall|prompt_injection)'/,
  'legacy result pages are not duplicated in the desktop sidebar');

process.stdout.write('libra_prompt_injection_navigation_test: PASS\n');
