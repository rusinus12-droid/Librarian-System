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

const vm = require('node:vm');
const resolver = sliceBetween('const resolveSharedNavigationTarget =', 'const applySharedNavigationTarget =');
const context = {SHARED_SIDEBAR_SECTIONS:['memory','characters','relationships','world','narrative','pipeline','ai','embedding','logs','settings','custom','agents'],
LIBRA_MEMORY_PIPELINE_STAGES:['librarian'],RETIRED_MEMORY_STAGE_IDS:['ariadne'],LIBRARIAN_STAGE_ID:'librarian',LIBRA_REFERENCE_HUB_SECTIONS:['modules','character_lore_exclusions','response_materials']};
vm.createContext(context);vm.runInContext(resolver+'\nthis.resolve=resolveSharedNavigationTarget;',context);
const resolve=v=>JSON.parse(JSON.stringify(context.resolve(v)));
assert.deepEqual(resolve('recall'),{pageId:'logs',executionLogSection:'recall'});
for(const alias of ['prompt','prompt_studio','prompt_studio_ooc','user_intent_ooc'])
 assert.deepEqual(resolve(alias),{pageId:'custom',customHubSection:'memory'},alias+' retains lazy memory editing');
for(const retired of ['prompt_injection','planner','sga','gradia_prompt_results'])
 assert.deepEqual(resolve(retired),{pageId:'memory',memoryHubSection:'read'},retired+' safely returns to the supported reader');

const navigation = sliceBetween('const applySharedNavigationTarget =', 'const normalizeBookPage =');
assert.match(navigation, /Gui\.sharedSidebarSection = pageId/,
  'shared navigation updates the selected top-level sidebar page');
assert.match(navigation, /Gui\.customHubSection = normalizeHubChoice/,
  'shared navigation applies the Custom subpage');
assert.match(navigation, /Gui\.promptInjectionSection = normalizePromptInjectionSection/,
  'shared navigation applies the current-turn result subpage');
assert.match(source, /const libraGuiNavigate = \(section, _tab = 'flow'\) => \{\s*sharedNavigate\(section\);\s*\}/,
  'the LIBRA compatibility navigator delegates to the shared router');

// Prompt Studio is now a literal approved dialog with a canonical expert fold;
// memory-only authority/lazy editing is retained, the old shared shell is retired.
const approved=require('./helpers/libra_approved_gui_contract.cjs');
const custom=approved.extract(source,'buildLibrarianAnalyzerPanel');
assert.match(custom,/openApprovedPromptDialog\(\)/);
assert.match(custom,/memoryStage:LIBRARIAN_STAGE_ID/);
assert.doesNotMatch(custom,/이번 턴 적용 결과|id: 'injection'|renderPromptStudioOocBuilder/);
const disclosure=approved.extract(source,'openApprovedPromptDialog');
assert.match(disclosure,/className='fold'/);
assert.match(disclosure,/buildLibraPromptStudioPanel\(\{ allowedDomains: \['memory'\] \}\)/);
const promptPanel=approved.extract(source,'buildLibraHubTabs');
assert.match(promptPanel, /role: 'tablist'/, 'current-turn result selectors remain accessible tabs');
assert.match(promptPanel, /'aria-selected': String\(active\)/, 'the selected result tab is exposed to assistive technology');

require('./helpers/libra_active_book_routes.cjs')(source);
const shell=approved.literal(source,'LIBRA_APPROVED_MOCKUP_APP_HTML');
for(const destination of ['desk','memory','people','world','story','settings'])assert.ok(shell.includes(`data-go="${destination}"`),destination+' exists in approved navigation');
assert.doesNotMatch(shell,/data-go="(?:sga|planner|recall|prompt_injection)"/,'legacy result pages are not duplicated');
process.stdout.write('libra_prompt_injection_navigation_test: PASS\n');
