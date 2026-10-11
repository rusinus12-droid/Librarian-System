'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const part = (a, b) => { const i = source.indexOf(a), j = source.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a); return source.slice(i, j); };
const el = (tag, attrs = {}, children = []) => ({ tag, ...attrs, children: children.filter(Boolean) });
const flat = node => [node, ...(node.children || []).flatMap(flat)];
const marker = text => el('section', { text });
const state = { runtime: { libraResponseMode: 'classic' }, agents: {}, prompts: {} };
let dirtyCalls = 0, opened = '', navigated = '';
const c = vm.createContext({
  Gui: { state, dirty: true, pipelineHubSection: 'response_generation' }, Runtime: { settings: {} },
  guiEl: el, guiLazyDetails: (attrs, summary, build) => el('details', { ...attrs, build }, [summary]),
  guiSlotFromSettings: (settings, stageId, enabled) => ({ enabled: enabled !== false, presetName: '', preset: '' }),
  activeGuiResponseFamily: () => 'libra', resolvedPresetNameForStage: () => 'My saved AI', LIBRARIAN_STAGE_ID: 'librarian',
  normalizeHubChoice: (v, allowed, fallback) => allowed.includes(v) ? v : fallback,
  SHARED_PIPELINE_HUB_SECTIONS: ['response_generation', 'memory_pipeline'],
  SHARED_AGENT_HUB_SECTIONS: ['memory', 'draft'], LIBRA_DRAFT_SECTIONS: ['mode', 'direction', 'results'],
  resolveResponseModeState: v => ({ libraResponseMode: v.libraResponseMode || 'classic' }), normalizeLibraResponseMode: v => v,
  normalizePlannerOutputLanguage: v => v || 'host', normalizePlannerDetailLevel: v => v || 'normal', normalizePlannerOutputBudget: v => v || 1000,
  presetChoicesFromState: () => [], PLANNER_OUTPUT_LANGUAGES: [], PLANNER_DETAIL_LEVELS: [], PLANNER_OUTPUT_BUDGET_MIN: 1, PLANNER_OUTPUT_BUDGET_MAX: 9999,
  markGuiDirty: () => { dirtyCalls++; }, queueBookDrawerRender: () => {}, closeBookQuickSettings: () => {},
  bookOpenQuickSettings: section => { opened = section; }, selectBookSettingsRoomSection: section => { navigated = section; },
  selectNode: () => marker('select'), libraRuntimeNumberInput: () => marker('number'),
  bookQuickSection: (title, note, children) => el('section', { text: title }, children), bookQuickChoiceCard: o => el('button', { text: o.title, onClick: o.onClick }),
  bookQuickToggle: (value, label, note, onChange) => el('button', { text: label, onClick: () => onChange(!value) }),
  openBookMemoryAdvancedSettings: () => { c.Gui.pipelineHubSection = 'memory_pipeline'; navigated = 'pipeline'; },
  bookQuickField: (label, control) => el('label', { text: label }, [control]), bookQuickActionRow: children => el('footer', {}, children),
  saveGuiState: () => { throw Error('navigation must not save'); }, revertGuiStateFromStorage: () => { throw Error('navigation must not revert'); },
  buildResponseConsumerPolicyPanel: () => marker('planner-policy'), buildGenerationPolicyPanel: () => marker('memory-budget'),
  buildLibrarianAnalyzerPanel: (compact, advanced) => marker(compact ? 'memory-basic' : advanced ? 'memory-advanced' : 'duplicate-basic'),
  buildLibraHubTabs: (defs, value, change) => el('nav', {}, defs.map(d => el('button', { text: d.label, onClick: () => change(d.id) }))),
  buildLibraResponseResultPanel: () => marker('results'), buildNarrativeDirectionPanel: () => marker('direction'),
  buildStateTrackingAvailabilityPanel: () => marker('local-state'), buildLibraPromptStudioPanel: () => marker('prompts'),
  setSharedCustomPromptDomain: () => {}, renderPromptStudioOocBuilder: () => marker('ooc'),
});
// Embedded response drafting was retired; the shared workbench now owns only
// memory analysis and lazy memory prompt editing. Exercise the shipped builders.
c.buildLibraClassicPanel = options => el('section', {text:'classic',options});
c.buildLibraLiveContextSettingsPanel = () => marker('recent-dialogue');
c.buildMemoryPromptStudioDisclosure = () => marker('lazy-memory-prompts');
// Embedded response drafting was retired; the shared workbench now owns only
// memory analysis and lazy memory prompt editing. Exercise the shipped builders.
c.buildLibraClassicPanel = options => el('section', {text:'classic',options});
c.buildLibraLiveContextSettingsPanel = () => marker('recent-dialogue');
c.buildMemoryPromptStudioDisclosure = () => marker('lazy-memory-prompts');
vm.runInContext(
  part('const buildAgentQuickSettingsSummary =', 'const buildSharedPipelineShellPanel =') +
  part('const buildSharedPipelineShellPanel =', 'const buildMemoryPromptStudioDisclosure =') +
  part('const buildSharedAgentShellPanel =', 'const setSharedCustomPromptDomain =') +
  part('const buildBookQuickLibraResponsePanel =', 'const buildBookQuickMemoryAgentsPanel =') +
  part('const buildBookQuickMemoryAgentsPanel =', 'const saveBookQuickSettings =') +
  ';Object.assign(globalThis,{buildSharedPipelineShellPanel,buildBookQuickLibraResponsePanel,buildBookQuickMemoryAgentsPanel,buildAgentQuickSettingsSummary});', c);
let nodes = flat(c.buildBookQuickLibraResponsePanel());
assert.deepEqual(nodes.slice(1).map(n=>n.text), ['classic','recent-dialogue']);
assert.equal(nodes[1].options.compact,true);
assert.equal(state.runtime.libraResponseMode,'classic');
assert.equal(dirtyCalls,0,'rendering response evidence must not change settings');
nodes = flat(c.buildBookQuickMemoryAgentsPanel());
assert.ok(nodes.some(n => n.text === '기억 분석 사용'));
assert.ok(nodes.some(n => n.text === '기억 분석 AI'));
assert.equal(nodes.filter(n => n.text === 'memory-budget').length,0);
nodes.find(n => n.text === '기억 분석 사용').onClick();
assert.equal(state.agents.librarian.enabled,false);
assert.equal(dirtyCalls,1);
nodes.find(n => n.text === '기억 분석 고급 설정 →').onClick();
assert.equal(c.Gui.pipelineHubSection,'memory_pipeline');
assert.equal(navigated,'pipeline');
nodes = flat(c.buildSharedPipelineShellPanel());
assert.equal(c.Gui.agentHubSection,'memory');
assert.equal(c.Gui.pipelineHubSection,'memory_pipeline');
assert.ok(nodes.some(n=>n.text==='memory-advanced'));
assert.ok(nodes.some(n=>n.text==='lazy-memory-prompts'));
assert.ok(!nodes.some(n=>n.text==='duplicate-basic'||n.text==='local-state'||n.text==='results'));
flat(c.buildAgentQuickSettingsSummary()).find(n=>n.tag==='button').onClick();
assert.equal(opened,'memory_agents');
assert.equal(c.Gui.state,state);
assert.equal(dirtyCalls,1,'workbench navigation must retain the unsaved draft');
assert.doesNotMatch(part('const BOOK_EXTERNAL_SETTINGS_ITEMS =', 'const bookExternalSettingsActive ='), /에이전트 상세/);
console.log('libra_agent_workbench_consolidation_runtime: PASS (production UI functions with DOM boundaries; no live RisuAI)');
