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
vm.runInContext(
  part('const buildAgentQuickSettingsSummary =', 'const buildGradiaDraftWorkspacePanel =') +
  'const buildDraftWorkspacePanel = () => buildLibraDraftWorkspacePanel(); const buildMemoryPipelinePanel = () => buildMemoryPipelineWorkspacePanel();\n' +
  part('const buildSharedPipelineShellPanel =', 'const setSharedCustomPromptDomain =') +
  part('const buildBookQuickLibraResponsePanel =', 'const buildBookQuickGradiaPanel =') +
  part('const buildBookQuickMemoryAgentsPanel =', 'const saveBookQuickSettings =') +
  ';Object.assign(globalThis,{buildSharedPipelineShellPanel,buildBookQuickLibraResponsePanel,buildBookQuickMemoryAgentsPanel});', c);

// The first choice is the mode, and switching it exposes only its own policy.
let nodes = flat(c.buildBookQuickLibraResponsePanel());
assert.equal(nodes[1].text, '전처리 모드');
assert.ok(!nodes.some(n => n.text === 'planner-policy' || n.text === 'memory-budget'));
nodes.find(n => n.text === '플래너 모드').onClick();
assert.equal(state.runtime.libraResponseMode, 'planner');
nodes = flat(c.buildBookQuickLibraResponsePanel());
assert.ok(nodes.some(n => n.text === 'Planner 연결' || n.text === 'Planner AI 프리셋'), 'Planner mode exposes its current connection controls');
assert.ok(!nodes.some(n => n.text === 'memory-budget'));
nodes = flat(c.buildBookQuickMemoryAgentsPanel());
assert.ok(nodes.some(n => n.text === '기억 분석 사용'), 'quick memory settings keep the enable toggle');
assert.ok(nodes.some(n => n.text === '기억 분석 AI'), 'quick memory settings keep the preset selector');
assert.equal(nodes.filter(n => n.text === 'memory-budget').length, 0, 'the detailed budget remains behind advanced settings');
nodes.find(n => n.text === '기억 분석 고급 설정 →').onClick();
assert.equal(c.Gui.pipelineHubSection, 'memory_pipeline'); assert.equal(navigated, 'pipeline');

// Both former workspaces now use one tab state and keep the same draft object.
nodes = flat(c.buildSharedPipelineShellPanel());
assert.ok(nodes.some(n => n.text === 'memory-advanced'));
assert.ok(!nodes.some(n => n.text === 'duplicate-basic'));
assert.ok(!nodes.some(n => n.text === '상태 추적'));
nodes.find(n => n.text === 'LIBRA 응답').onClick();
assert.equal(c.Gui.pipelineHubSection, 'response_generation');
nodes = flat(c.buildSharedPipelineShellPanel());
nodes.find(n => n.text === 'LIBRA 빠른 설정 열기').onClick();
assert.equal(opened, 'response');
assert.ok(nodes.some(n => n.text === '고급 프롬프트 설정'));
assert.ok(nodes.some(n => n.text === '추가 작성 지시 · OOC'));
assert.equal(c.Gui.state, state); assert.equal(dirtyCalls, 1);

// Memory prompt editing belongs to the single advanced studio; consumer policies
// must never mount the memory budget in any response family.
assert.doesNotMatch(part('const buildResponseConsumerPolicyPanel =', 'const libraRecallScoreTone ='), /buildGenerationPolicyPanel\(/);
assert.match(part('const buildLibrarianAnalyzerPanel =', 'const buildCharacterLoreExclusionPanel ='), /!compactView&&!advancedOnly\?fieldNode\('Librarian 추가 지침'/);
assert.doesNotMatch(part('const BOOK_EXTERNAL_SETTINGS_ITEMS =', 'const bookExternalSettingsActive ='), /에이전트 상세/);
console.log('libra_agent_workbench_consolidation_runtime: PASS (production UI functions with DOM boundaries; no live RisuAI)');
