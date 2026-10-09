'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

assert.match(source, /sga-prompt-injection-tabs\.libra-hub-tabs\.cols-4\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/,
  'the four Memory Pipeline tabs must stay in one desktop row');
assert.match(source, /class: `sga-prompt-injection-tabs libra-hub-tabs cols-\$\{Math\.max\(1, definitions\.length\)\}`/,
  'hub tabs must advertise their exact column count');

for (const variant of ['composer', 'choices', 'delivery']) {
  assert.ok(source.includes(`sga-input-confirm-app libra-input-writer-modal ${variant}`),
    `Input Writer ${variant} surface must use the compact modal contract`);
}
assert.match(source, /\.sga-input-confirm-app\.libra-input-writer-modal\{height:auto;max-height:/,
  'Input Writer dialogs must size to content instead of filling a fixed-height shell');

assert.match(source, /const SGA_NOVEL_AUTHORSHIP_CONTRACT = \[/,
  'SGA must have a dedicated Novel-mode full-cast contract');
assert.match(source, /const SGA_NOVEL_AIDE_CONTRACT = \[/,
  'SGA AIDEs must inherit Novel-mode authorship instead of applying RP agency rules');
assert.match(source, /writingMode: libraWritingMode\(settings\)/,
  'SGA cache identity must separate RP and Novel results');
assert.match(source, /const buildInputAssistSettingsPanel =/,
  'the Settings page must expose Input Writer configuration');
assert.match(source, /Input Writer의 RP\/작가 모드는 GRADIA 응답 모드와 독립적으로 저장/,
  'the GUI must explain the independent Input Writer and GRADIA writing-mode authorities');
assert.match(source, /const RESPONSE_FAMILIES = Object\.freeze\(\['libra', 'gradia'\]\)/,
  'the response engine must expose LIBRA and GRADIA as top-level families');
assert.match(source, /const LIBRA_RESPONSE_MODES = Object\.freeze\(\['classic', 'planner'\]\)/,
  'the LIBRA family must expose only Planner and Classic');
assert.match(source, /const GRADIA_WRITING_MODE_ORDER = Object\.freeze\(\['author', 'rp'\]\)/,
  'the GRADIA family must expose Novel before RP');
assert.match(source, /class: 'response-family-switch'.*aria-label': '메인 모드 선택'/s,
  'the GUI header must own the top-level family selector');
assert.match(source, /text: 'LIBRA'.*selectResponseFamilyFromHeader\('libra'\).*text: 'GRADIA'.*selectResponseFamilyFromHeader\('gradia'\)/s,
  'the public header selector must switch between LIBRA and GRADIA');
assert.doesNotMatch(source.slice(source.indexOf('const buildBookQuickLibraResponsePanel ='), source.indexOf('const buildBookQuickGradiaPanel =')), /libra-response-family-grid|selectFamily/,
  'Home must not duplicate the main family selector');
assert.match(source, /novelMode \? SGA_NOVEL_AUTHORSHIP_CONTRACT/,
  'SHADOW must select the Novel contract at runtime');
assert.match(source, /novelMode \? SGA_NOVEL_AIDE_CONTRACT/,
  'AIDEs must select the Novel contract at runtime');

const inputWriter = source.slice(
  source.indexOf('const generateLibraInputWriterChoices ='),
  source.indexOf('const notifyLibraInputWriterError =')
);
assert.match(inputWriter, /updatePipelineWorkPanel\(/,
  'Input Writer generation must open the live work panel');
assert.match(inputWriter, /finishPipelineWorkStatus\(/,
  'Input Writer generation must finish the live work panel');

const planner = source.slice(
  source.indexOf('const runTurnPlanner ='),
  source.indexOf('const compactPlannerInjectionView =')
);
assert.match(planner, /updatePipelineWorkPanel\('Planner가/,
  'Planner generation must open the live work panel');
assert.match(planner, /finishPipelineWorkStatus\(/,
  'Planner generation must finish the live work panel');

const sga = source.slice(
  source.indexOf('const runSgaPipeline ='),
  source.indexOf('const renderSgaBlock =')
);
assert.match(sga, /reportPipelineStageProgress\(SGA_SHADOW_STAGE_ID,\s*multiPipelineMode === 'heavyweight' \? 'analysis' : 'integrated'\)/,
  'SGA SHADOW must publish draft progress');
assert.match(sga, /reportPipelineStageProgress\(stageId, 'patch'\)/,
  'each enabled SGA AIDE must publish patch progress');

process.stdout.write('libra_writing_mode_live_work_ui_contract_test: PASS\n');
