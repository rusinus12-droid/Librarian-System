'use strict';

// One maintained entry for the manual-analysis regression contract:
// backend/data-safety cases run in the VM suite; real GUI/provider workflows
// run in the mounted Chromium suite because JSDOM's cross-realm VM bridge
// stalls nested async context reads after a UI callback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const program = path.resolve(__dirname, '..');
const repo = path.dirname(program);
const evidence = process.env.LIA_MANUAL_EVIDENCE || path.join(program, 'docs/gui-redesign/verification/lia-20261013');
const commands = [
  ['backend', path.join(__dirname, 'lia_manual_analysis_runtime_test.cjs')],
  ['static_ui_contract', path.join(__dirname, 'lia_manual_analysis_ui_test.cjs')],
  ['mounted_ui', path.join(__dirname, 'browser/lia_mockup_mounted_product_browser_test.cjs')],
  ['asset_restart', path.join(__dirname, 'lia_public_asset_server_restore_flow_test.cjs')],
];
const exactUiCases = [
  'actual mockup update route refresh keeps duplicate clicks to one manual action',
  'actual mockup update cancel discards an outstanding provider result',
  'actual mockup update discards a changed earlier processed pair while provider is pending',
];

fs.mkdirSync(evidence, { recursive: true });
const results = [];
for (const [name, script] of commands) {
  const command = `node ${path.relative(repo, script)}`;
  const env = name === 'mounted_ui' ? { ...process.env, LIA_CAPTURE_DIR: evidence }
    : name === 'asset_restart' ? {
      ...process.env,
      NODE_PATH: process.env.NODE_PATH || '',
      LIA_FLOW_EVIDENCE: path.join(evidence, 'lia-public-asset-local-restart-result.json'),
    }
      : process.env;
  const run = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8', env });
  for (const [suffix, contents] of [['command.txt', `${command}\n`], ['stdout.log', run.stdout || ''], ['stderr.log', run.stderr || ''], ['exit.txt', `${run.status ?? 'spawn-error'}\n`]]) {
    fs.writeFileSync(path.join(evidence, `lia-manual-regression-${name}.${suffix}`), contents);
  }
  results.push({ name, command, exit: run.status, stdout: path.basename(path.join(evidence, `lia-manual-regression-${name}.stdout.log`)), stderr: path.basename(path.join(evidence, `lia-manual-regression-${name}.stderr.log`)) });
  assert.equal(run.error, undefined, `${name} process launched: ${run.error || ''}`);
  assert.equal(run.status, 0, `${name} command passes; inspect preserved stdout/stderr`);
}

const browserResultPath = path.join(evidence, 'lia-mounted-browser-results.json');
const browserResult = JSON.parse(fs.readFileSync(browserResultPath, 'utf8'));
const actualUiCases = new Map((browserResult.manualAnalysisUiCases || []).map(item => [item.name, item]));
for (const name of exactUiCases) assert.equal(actualUiCases.get(name)?.passed, true, `mounted Chromium replacement passed: ${name}`);
const legacyGuiCases = new Map((browserResult.legacyGuiCases || []).map(item => [item.name, item]));
const migratedLegacyCases = [
  'LIA repeated UI entry preserves unsaved model and shell without silently saving',
  'LIA full-chat evolution displays review in editor and never applies it automatically',
];
for (const name of migratedLegacyCases) assert.equal(legacyGuiCases.get(name)?.passed, true, `mounted Chromium migration passed: ${name}`);
const summary = {
  testedSourceSha256: browserResult.testedSource,
  backendCommand: results[0],
  staticUiCommand: results[1],
  mountedUiCommand: results[2],
  assetRestartCommand: results[3],
  migratedUiCases: exactUiCases.map(name => actualUiCases.get(name)),
  migratedLegacyGuiCases: migratedLegacyCases.map(name => legacyGuiCases.get(name)),
  networkBoundary: 'synthetic local host/provider only; no external API, user data, or paid model calls',
};
fs.writeFileSync(path.join(evidence, 'lia-manual-regression-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`lia_manual_analysis_regression_test: PASS (backend suite + static UI contract + ${exactUiCases.length} mounted Chromium safety scenarios + ${migratedLegacyCases.length} migrated GUI scenarios + physical asset/recovery restart flow)`);
