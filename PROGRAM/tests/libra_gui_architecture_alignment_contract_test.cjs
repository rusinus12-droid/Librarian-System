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
  assert.notEqual(to, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
};

const extractConst = name => {
  const marker = `const ${name} =`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing const: ${name}`);
  let quote = '';
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
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
    else if (char === ';' && round === 0 && square === 0 && curly === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated const: ${name}`);
};

const evaluateConst = name => {
  const context = { Object, Array };
  vm.createContext(context);
  vm.runInContext(`${extractConst(name)}\nthis.value = ${name};`, context);
  return JSON.parse(JSON.stringify(context.value));
};

const pages = evaluateConst('SHARED_SIDEBAR_PAGE_REGISTRY');
assert.equal(pages.length, 10, 'the shared shell omits the retired custom workshop and duplicate agent page');
assert.deepEqual(pages.map(page => page.id), [
  'memory', 'characters', 'relationships', 'world', 'narrative', 'pipeline',
  'ai', 'embedding', 'logs', 'settings'
]);
assert.deepEqual(pages.map(page => page.label), [
  '기억', '인물', '관계', '세계', '내러티브', '에이전트 작업대',
  'AI 연결', '임베딩 연결', '실행 기록', '설정'
]);
assert.equal(pages.some(page => page.id === 'home' || page.id === 'convenience'), false,
  'retired Home/status and Convenience pages must not return');

assert.deepEqual(evaluateConst('SHARED_PIPELINE_HUB_SECTIONS'), [
  'memory_pipeline'
]);
assert.deepEqual(evaluateConst('SHARED_AGENT_HUB_SECTIONS'), ['memory']);
assert.deepEqual(evaluateConst('SHARED_CUSTOM_HUB_SECTIONS'), [
  'memory', 'state', 'active_draft', 'ooc'
]);
assert.deepEqual(evaluateConst('SHARED_SETTINGS_HUB_SECTIONS'), [
  'references', 'memory', 'state', 'server', 'ai', 'embedding', 'recovery', 'transfer', 'general', 'source_edits'
]);
assert.deepEqual(evaluateConst('SHARED_EXECUTION_LOG_SECTIONS'), [
  'memory', 'state', 'draft', 'recall', 'embedding', 'rebuild'
]);

const route=require('./helpers/libra_navigation_contract.cjs').navigation(source);
for(const name of ['convenience','input_writer'])assert.deepEqual(route(name),{pageId:'memory',memoryHubSection:'read'},'retired writer link safely falls back');
assert.deepEqual(route('providers'),{pageId:'ai'});assert.deepEqual(route('embedding'),{pageId:'embedding'});
for(const name of ['runs','execution_results'])assert.deepEqual(route(name),{pageId:'logs',executionLogSection:'memory'});

require('./helpers/libra_active_book_routes.cjs')(source);
const settings = extractConst('buildApprovedMockupSettingsPanel');
assert.doesNotMatch(source,/const buildInputAssistSettingsPanel\s*=|const showLibraInputWriterComposer\s*=/,'retired input-writer controls and composer remain absent');
assert.doesNotMatch(settings,/showLibraInputWriterComposer\s*\(|showLibraInputWriterChoicePicker\s*\(/,'Settings do not revive the retired composer');

// Explicitly approved UI ownership: the single Librarian editor now owns the
// pipeline route directly; the retired nested shell is an obsolete visual layer.
const pipelineShell=extractConst('buildApprovedMockupSettingsPanel');
assert.match(pipelineShell,/sectionId==='pipeline'\)return buildLibrarianAnalyzerPanel/);
assert.doesNotMatch(pipelineShell,/buildSharedPipelineShellPanel|buildSharedAgentShellPanel/);
const agentShell=extractConst('buildLibrarianAnalyzerPanel');
assert.match(agentShell,/memoryStage:LIBRARIAN_STAGE_ID/);
assert.match(agentShell,/slot\.turnWindow=5/);
assert.match(agentShell,/slot\.executionMode='draft_only'/);
assert.match(agentShell,/analyzerField\('presetName'/,'actual independent stage preset remains reachable');
const stateTrackingPanel = extractConst('buildStateTrackingAvailabilityPanel');
assert.match(stateTrackingPanel, /librarianLocalState:'true'/);
assert.doesNotMatch(stateTrackingPanel, /buildEntityAdmissionStageCard|buildStateStageSlotCard/,'no retired remote agent controls in active state panel');
assert.match(stateTrackingPanel, /buildApprovedRecoveryActions\(\)/);
assert.match(stateTrackingPanel, /three-status/);
assert.doesNotMatch(agentShell, /buildStateTrackingAvailabilityPanel|id: 'state'/,
  'Agent Workbench must not expose the non-actionable State Tracking tab');
assert.match(settings, /buildStateTrackingAvailabilityPanel\('settings'\)/,
  'Settings retains the state tracking owner surface');

const canonicalJobSurface = between('function renderCanonicalJobSurface', 'const refreshGuiRuntimeIndicators =');
assert.match(canonicalJobSurface, /\['maintained_by_user',\s*'상태 변화 없음'\]/);
assert.match(canonicalJobSurface, /\['sparse_correction',\s*'상태 보정 작성'\]/);
assert.match(canonicalJobSurface, /saveCanonicalManualStateDisposition\(\{\s*jobId:\s*job\.jobId,\s*mode:\s*dispositionSelect\.value,\s*patch:\s*parsed\s*\}\)/,
  'manual canonical comparison must durably save one of the two state dispositions');
assert.match(canonicalJobSurface, /text:\s*['"]후보 채택['"][\s\S]{0,180}disabled:\s*manualCandidate\s*&&\s*!savedDisposition/,
  'manual candidate adoption stays disabled until a disposition has been saved');

const manualDispositionWriter = extractConst('saveCanonicalManualStateDisposition');
assert.match(manualDispositionWriter, /maintained_by_user/);
assert.match(manualDispositionWriter, /sparse_correction/);
assert.match(manualDispositionWriter, /canonical_manual_state_disposition_candidate_readback_failed/i,
  'manual disposition must be read back from the candidate record');
assert.match(manualDispositionWriter, /canonical_manual_state_disposition_job_readback_failed/,
  'manual disposition must also be read back from the canonical job');
const adoptionGate = extractConst('resolveCanonicalCandidate');
assert.match(adoptionGate, /canonicalCandidateRequiresManualValidation\(candidate,\s*found\.variant\)[\s\S]*validateCanonicalManualAuthority[\s\S]*validateManualStateDispositionIntent/,
  'manual adoption must be classified from the sealed candidate record even when variant display metadata was normalized');
assert.match(adoptionGate, /canonical_manual_state_disposition_required/,
  'runtime adoption must fail closed even if the GUI gate is bypassed');

assert.doesNotMatch(source,/const buildDraftWorkspacePanel\s*=|const buildGradiaDraftWorkspacePanel\s*=/,'retired response-family workspaces remain absent');
// Shared owner routes are exercised above through the active Book renderer.

process.stdout.write(`libra_gui_architecture_alignment_contract_test: PASS (${path.basename(sourcePath)})\n`);
