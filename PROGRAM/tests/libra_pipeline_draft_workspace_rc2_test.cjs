'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const extractConst = (text, name) => {
  const marker = `const ${name} =`;
  const start = text.indexOf(marker);
  if (start < 0) return '';
  let quote = '';
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ';' && round === 0 && square === 0 && curly === 0) return text.slice(start, index + 1);
  }
  return '';
};

const between = (text, startMarker, endMarker) => {
  const start = text.indexOf(startMarker);
  const end = start < 0 ? -1 : text.indexOf(endMarker, start + startMarker.length);
  return start < 0 || end < 0 ? '' : text.slice(start, end);
};

const failures = [];
const check = (label, fn) => {
  try { fn(); }
  catch (error) { failures.push(`${label}: ${error.message}`); }
};
const mustExtract = name => {
  const block = extractConst(source, name);
  check(`helper ${name}`, () => assert.ok(block, `missing helper: ${name}`));
  return block;
};

const shell = mustExtract('buildSharedPipelineShellPanel');
const agentShell = mustExtract('buildSharedAgentShellPanel');
const memoryWorkspace = mustExtract('buildMemoryPipelineWorkspacePanel');
const draftWorkspace = mustExtract('buildDraftWorkspacePanel');
const libraWorkspace = mustExtract('buildLibraDraftWorkspacePanel');
const gradiaWorkspace = mustExtract('buildGradiaDraftWorkspacePanel');
const quick = mustExtract('buildGradiaDraftSettingsPanel');
const setWritingMode = mustExtract('setGradiaWritingModeFromHome');
const revertGuiState = mustExtract('revertGuiStateFromStorage');
const loadSettings = mustExtract('loadSettings');
const saveGuiState = mustExtract('saveGuiState');
const numberInput = mustExtract('libraRuntimeNumberInput');
const applyLength = mustExtract('applySimpleLengthToGui');
const applyLanguage = mustExtract('applyInternalDraftLanguageToGui');
const renderOnce = between(source, 'async function renderSettingsGuiOnce()', 'const hideSettingsGui =');

check('pipeline shell split', () => {
  assert.match(shell, /memory_pipeline[\s\S]*buildSharedAgentShellPanel\(\)/);
  assert.doesNotMatch(shell, /state_tracking|buildStateTrackingAvailabilityPanel/);
  assert.match(agentShell, /id:\s*'memory',\s*label:\s*'기억 작성'[\s\S]*?id:\s*'draft'/);
  assert.match(agentShell, /buildMemoryPipelinePanel\(\)/, 'memory route must use the family-neutral memory workspace');
  assert.match(agentShell, /buildDraftWorkspacePanel\(family\)/, 'only response generation may branch by family');
  assert.doesNotMatch(agentShell, /id:\s*'state'|buildStateTrackingAvailabilityPanel/);
  assert.doesNotMatch(shell, /buildGradiaDraftSettingsPanel|buildGradiaPipelinePanel|buildLibraResponseModeSettingsPanel/, 'family builders belong in draft wrappers, not the common shell');
});

check('family-neutral memory workspace', () => {
  assert.match(memoryWorkspace, /buildLibrarianAnalyzerPanel\(false, true\)/);
  assert.doesNotMatch(memoryWorkspace, /responseFamily|activeGuiResponseFamily|buildGradia|buildLibraDraft/i);
});

check('draft family boundary', () => {
  assert.match(draftWorkspace, /family\s*===\s*'gradia'[\s\S]*?buildGradiaDraftWorkspacePanel\(\)[\s\S]*?buildLibraDraftWorkspacePanel\(\)/);
});

check('LIBRA Classic Planner workspace', () => {
  assert.match(libraWorkspace, /Gui\.libraDraftSection/);
  assert.match(libraWorkspace, /buildAgentQuickSettingsSummary\('draft'\)/, 'the workbench links to the single live quick-settings editor');
  assert.match(libraWorkspace, /buildLibraResponseResultPanel\(/, 'the active Classic/Planner delivery result must be present');
  assert.doesNotMatch(libraWorkspace, /buildGradia|SHADOW|AIDE/, 'LIBRA draft workspace must not expose GRADIA controls');
});

check('GRADIA workspace order and builder reuse', () => {
  assert.match(source, /const GRADIA_DRAFT_SECTIONS\s*=\s*Object\.freeze\(\[\s*'quick',\s*'stages',\s*'skills',\s*'output',\s*'results'\s*\]\)/);
  const orderedLabels = ['빠른 설정', '단계', '스킬', '출력', '결과'];
  let cursor = -1;
  for (const label of orderedLabels) {
    const next = gradiaWorkspace.indexOf(`label: '${label}'`, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order GRADIA tab: ${label}`);
    cursor = next;
  }
  for (const builder of [
    'buildGradiaDraftSettingsPanel', 'buildGradiaPipelinePanel',
    'buildGradiaSkillSettings', 'buildGradiaOutputPanel', 'buildGradiaResultsPanel'
  ]) assert.match(gradiaWorkspace, new RegExp(`${builder}\\(`), `wrapper must reuse ${builder}`);
});

check('GRADIA Quick required labels', () => {
  const missing = ['작성 모드', '초안 입력 처리', '초안 분량', '작성 언어', '파이프라인 호출 방식']
    .filter(label => !quick.includes(label));
  assert.deepEqual(missing, [], `missing Quick controls: ${missing.join(', ')}`);
});

check('GRADIA Quick writing mode runtime binding', () => {
  assert.match(quick, /GRADIA_WRITING_MODE_ORDER|\[['"]author['"][\s\S]*?['"]rp['"]\]/, 'Quick must expose Novel/RP choices');
  assert.match(quick, /setGradiaWritingModeFromHome\(/, 'Quick must use the established Novel/RP runtime update path');
  assert.match(setWritingMode, /runtime\.gradiaWritingMode\s*=/, 'writing mode must update the existing runtime field');
  assert.doesNotMatch(setWritingMode, /runtime\.inputWriterMode\s*=/, 'GRADIA writing mode must not overwrite the independent Input Writer mode');
  assert.match(setWritingMode, /Object\.assign\(runtime, resolveResponseModeState\(runtime\)\)/, 'writing mode must re-resolve the family route while retaining mode-local selections');
  assert.match(setWritingMode, /markGuiDirty\(\)/, 'writing mode changes must mark the existing GUI draft dirty');
});

check('GRADIA Quick remaining runtime controls', () => {
  assert.match(quick, /GRADIA_INPUT_PLACEMENT_CHOICES\.map\(/, 'draft input placement keeps the shared choice registry');
  assert.match(quick, /normalizeGradiaNovelDraftMode\(runtime\.gradiaNovelDraftMode\)/, 'draft input placement stays bound to the shared runtime setting');
  assert.match(quick, /SIMPLE_LENGTH_CHOICES/);
  assert.match(quick, /INTERNAL_DRAFT_LANGUAGES/);
  assert.match(quick, /multiPipelineMode[\s\S]*?lightweight[\s\S]*?heavyweight/);
  assert.doesNotMatch(quick, /buildHeavyweightTransferQuickChoices|informationTransferMode|draft_and_analysis/,
    'Quick Settings must not offer the retired analysis handoff');
});

check('common shell revert action', () => {
  assert.match(renderOnce, /(?:text:\s*['"][^'"]*되돌리기[^'"]*['"][\s\S]{0,320}?onClick:|onClick:[\s\S]{0,320}?text:\s*['"][^'"]*되돌리기[^'"]*['"])/,
    'the common shell must expose the save/revert contract used by Quick');
  assert.match(renderOnce, /revertGuiStateFromStorage\(\)/,
    'the common shell revert action must use the persisted-state readback helper');
  assert.match(revertGuiState, /Runtime\.settings\s*=\s*null[\s\S]*?loadSettings\(\)[\s\S]*?applyGuiSettingsState\([\s\S]*?renderSettingsGui\(\)/,
    'revert must reload persisted runtime settings and render their readback');
});

check('Quick dirty paths', () => {
  assert.match(numberInput, /markGuiDirty\(\)/);
  assert.match(applyLength, /targetDraftMinChars[\s\S]*?targetDraftMaxChars[\s\S]*?markGuiDirty\(\)/);
  assert.match(applyLanguage, /internalDraftLanguage[\s\S]*?markGuiDirty\(\)/);
  assert.doesNotMatch(source, /applyInformationTransferModeToGui|buildHeavyweightTransferQuickChoices/,
    'the old transfer-selection handlers must be removed');
});

check('runtime key read and save compatibility', () => {
  for (const key of [
    'gradia_writing_mode', 'gradia_novel_draft_mode', 'internal_draft_language',
    'target_draft_min_chars', 'target_draft_max_chars', 'multi_pipeline_mode',
    'information_transfer_mode'
  ]) {
    assert.ok(loadSettings.includes(key), `loadSettings lost runtime key: ${key}`);
    assert.ok(saveGuiState.includes(key), `saveGuiState lost runtime key: ${key}`);
  }
});

check('status-dashboard home retired', () => {
  require('./helpers/libra_active_book_routes.cjs')(source);
  assert.doesNotMatch(renderOnce, /buildSharedHeaderStatusPanel\(\)|buildInsightRail\(\)/,
    'persistent status strip and summary rail must not be rendered');
  assert.match(renderOnce, /\[buildSidebarRegion\(\), buildMainRegion\(\)\]/,
    'the desktop shell must contain only navigation and the active workspace');
});

check('status-only chrome hidden', () => {
  assert.match(source, /\.libra-header-status,\.sga-insight-rail\{display:none!important\}/,
    'retired status surfaces must remain hidden even during stale-DOM replacement');
});

const baselinePath = process.env.LIBRA_RC2_EXECUTION_BASELINE;
if (baselinePath) {
  const baseline = fs.readFileSync(path.resolve(baselinePath), 'utf8');
  check('GRADIA draft execution declarations unchanged', () => {
    for (const name of ['runSgaPrivateAnalysis', 'runSgaResponseEngine', 'runSgaFinalLengthCorrection', 'runSgaPipeline']) {
      const exactExecutionBlock = text => name === 'runSgaPipeline'
        ? between(text, 'const runSgaPipeline =', 'const renderSgaBlock =')
        : extractConst(text, name);
      const before = exactExecutionBlock(baseline);
      const after = exactExecutionBlock(source);
      assert.ok(before && after, `missing execution helper: ${name}`);
      const hash = value => crypto.createHash('sha256').update(value).digest('hex');
      assert.equal(hash(after), hash(before), `${name} changed during GUI-only work`);
    }
  });
}

if (failures.length) {
  throw new Error(`Commit 6 contract failures (${failures.length}):\n- ${failures.join('\n- ')}`);
}

process.stdout.write('libra_pipeline_draft_workspace_rc2_test: PASS\n');
