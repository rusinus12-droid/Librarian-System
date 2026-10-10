'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeWmDevelopmentSource } = require('../tools/build_wm_source.cjs');
const { captureWmExecutionIdentity, requireWmExecutionIdentity } = require('../tools/wm_test_execution_identity.cjs');
const programDir = path.resolve(__dirname, '..');
const wmRoot = path.join(programDir, 'wm');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const testName = name => /(?:_test|\.test)\.cjs$/.test(name);

test('wm_suite_discovers_both_test_names_and_loads_the_same_seven_plugin_project_artifact', async () => {
  const receipt = await writeWmDevelopmentSource({ programDir, fullOutputDir: path.join(programDir, 'plugins') });
  const artifact = path.join(programDir, 'plugins', receipt.filename);
  assert.equal(hashFile(artifact), receipt.outputSha256);
  const plugins = fs.readdirSync(path.join(programDir, 'plugins')).filter(name => name.endsWith('.js')).sort();
  assert.equal(plugins.length, 7, 'six existing plugin identities plus independent WM');
  const inventory = fs.readdirSync(path.join(wmRoot, 'tools')).filter(testName).sort();
  assert(inventory.some(name => name.endsWith('_test.cjs')));
  assert(inventory.some(name => name.endsWith('.test.cjs')));
  const requiredRegression = ['libra_settings_verified_persistence_test.cjs', 'libra_settings_uncertain_outcome_test.cjs'];
  const discovered = inventory.filter(name => /^wm[-_]/.test(name) || requiredRegression.includes(name));
  assert(discovered.includes('wm-preset-dirty-navigation.test.cjs'));
  assert(discovered.includes('wm-preset-dirty-races.test.cjs'));
  const exclusions = inventory.filter(name => !discovered.includes(name)).map(filename => {
    const code = fs.readFileSync(path.join(wmRoot, 'tools', filename), 'utf8');
    const reason = filename === 'libra_gui_health_review_test.cjs'
      ? 'Previously blocked by OUTSIDE_SELECTED_WM_ARTIFACT; no retry or guard relaxation authorized'
      : ['libra_operational_log_artifact_test.cjs', 'libra_cbs_debug_export_schema_test.cjs'].includes(filename)
        ? 'Mandatory privacy subset is run separately against the explicit unified artifact'
        : /dist\/LIBRA World Manager/.test(code)
          ? 'Historical artifact or paired Full/Min path contract; deferred to explicit D1 compatibility qualification'
          : 'Non-WM-prefixed archival/custom regression; inventoried for explicit D1 compatibility qualification';
    return { filename, reason, status: 'NOT_QUALIFIED_BY_P0a_WRAPPER' };
  });
  const evidence = process.env.WM_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lib-wm-suite-'));
  fs.mkdirSync(evidence, { recursive: true });
  const audit = process.env.LIBRA_NETWORK_AUDIT || path.join(evidence, 'network-attempts.jsonl');
  if (!fs.existsSync(audit)) fs.writeFileSync(audit, '');
  const guard = path.join(wmRoot, 'tools/strict-offline-guard.cjs');
  const portable = path.join(wmRoot, 'tools/portable-test-paths.cjs');
  const environment = {
    PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin',
    HOME: evidence, LANG: 'C.UTF-8', NODE_PATH: process.env.NODE_PATH || '',
    NODE_OPTIONS: '--require=' + JSON.stringify(guard) + ' --require=' + JSON.stringify(portable),
    LIBRA_NETWORK_AUDIT: audit, WM_SETTINGS_ROOT: wmRoot, WM_SCORING_SETTINGS_ROOT: wmRoot,
    WM_TEST_PROFILE: receipt.profile,
    WM_EVIDENCE_DIR: evidence, WM_VECTOR_EVIDENCE: path.join(evidence, 'vector.json'),
    WM_CHUNK_REPORT: path.join(evidence, 'chunk-report.json'),
    WM_CHECKSUM_DIST: artifact, WM_VERSIONED_DIST: artifact, WM_CHUNK_DIST: artifact,
    LIBRA_RECALL_TEST_DIST: artifact, LIBRA_GUI_TEST_DIST: artifact
  };
  fs.writeFileSync(path.join(evidence, 'wm-suite-inventory.json'), JSON.stringify({ inventory, selected: discovered, exclusions }, null, 2) + '\n');
  const fileResults = [];
  for (const filename of discovered) {
    const file = path.join(wmRoot, 'tools', filename);
    const executionIdentity = captureWmExecutionIdentity({ programDir, artifact, profile: receipt.profile, environment });
    const reusePath = process.env.WM_SUITE_REUSE_DIR && path.join(process.env.WM_SUITE_REUSE_DIR, filename + '.json');
    if (reusePath && fs.existsSync(reusePath)) {
      const prior = JSON.parse(fs.readFileSync(reusePath, 'utf8'));
      requireWmExecutionIdentity(prior, executionIdentity);
      assert.equal(prior.testFileSha256, hashFile(file), 'reuse requires an unchanged test');
      assert.equal(prior.artifactSha256, receipt.outputSha256, 'reuse requires the identical runtime artifact');
      assert.equal(prior.complete, true, 'an interrupted suite is not a reusable file result');
      assert.equal(prior.status, 'PASS');
      assert.equal(prior.resultFileSha256, hashFile(prior.resultFile), 'terminal custom evidence must remain unchanged');
      for (const [dependency, sha256] of Object.entries(prior.dependencies || {})) assert.equal(hashFile(path.join(wmRoot, dependency)), sha256, dependency);
      fileResults.push({ filename, reused: true, ...prior });
      console.log('WM_FILE_REUSED ' + filename);
      continue;
    }
    const fileEvidence = path.join(evidence, 'files', filename);
    fs.mkdirSync(fileEvidence, { recursive: true });
    const fileEnvironment = { ...environment, WM_CHUNK_REPORT: path.join(fileEvidence, 'chunk-report.json') };
    const command = [process.execPath, '--expose-gc', '--test', '--test-force-exit', '--test-concurrency=1', file];
    const logPath = path.join(fileEvidence, 'stdout.log');
    const log = fs.openSync(logPath, 'wx');
    console.log('WM_FILE_START ' + filename);
    let result;
    try {
      result = spawnSync(command[0], command.slice(1), { cwd: wmRoot, env: fileEnvironment, stdio: ['ignore', log, log], timeout: 300000 });
    } finally { fs.closeSync(log); }
    const stdout = fs.readFileSync(logPath, 'utf8');
    const counts = Object.fromEntries([...stdout.matchAll(/^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(match => [match[1], Number(match[2])]));
    const customFail = [...stdout.matchAll(/^(?:# )?FAIL /gm)].length;
    const identityAfter = captureWmExecutionIdentity({ programDir, artifact, profile: receipt.profile, environment });
    const inputStable = executionIdentity.identitySha256 === identityAfter.identitySha256;
    const status = !inputStable ? 'BLOCKED_EXECUTION_INPUT_CHANGED' : result.error?.code === 'ETIMEDOUT' ? 'BLOCKED_FILE_OBSERVATION_TIMEOUT' : result.status === 0 && !customFail && counts.tests > 0 && ['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0) ? 'PASS' : 'FAIL';
    const row = { filename, command, cwd: wmRoot, environment: fileEnvironment, exit: result.status, signal: result.signal, error: result.error?.message || null,
      status, complete: !result.error && inputStable, executionIdentity, testFileSha256: hashFile(file), artifactSha256: hashFile(artifact), counts,
      customPass: [...stdout.matchAll(/^(?:# )?PASS /gm)].length, customFail, logSha256: hashFile(logPath) };
    fs.writeFileSync(path.join(fileEvidence, 'RESULT.json'), JSON.stringify(row, null, 2) + '\n');
    fileResults.push(row);
    console.log('WM_FILE_TERMINAL ' + filename + ' ' + status);
    if (status === 'BLOCKED_FILE_OBSERVATION_TIMEOUT' || status === 'BLOCKED_EXECUTION_INPUT_CHANGED') break;
  }
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, fileResults.reduce((sum, row) => sum + (row.counts?.[key] || 0), 0)]));
  const networkAttempts = fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).length;
  const summary = {
    artifact, artifactSha256: hashFile(artifact), receipt,
    pluginArtifacts: plugins.map(filename => ({ filename, sha256: hashFile(path.join(programDir, 'plugins', filename)) })),
    discoveryInventory: inventory, discoveredTests: discovered, exclusions, fileResults, cwd: wmRoot, environment,
    counts, networkAttempts,
    customPass: fileResults.reduce((sum, row) => sum + (row.customPass || 0), 0),
    customFail: fileResults.reduce((sum, row) => sum + (row.customFail || 0), 0)
  };
  fs.writeFileSync(path.join(evidence, 'wm-suite-result.json'), JSON.stringify(summary, null, 2) + '\n');
  assert.equal(fileResults.length, discovered.length, 'every selected file needs a terminal result');
  assert(fileResults.every(row => row.status === 'PASS'), 'selected file results must pass; inspect per-file RESULT.json');
  assert(counts.tests > 0, 'suite must produce test counts');
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(counts[name], 0, name);
  assert.equal(summary.customFail, 0, 'custom assertion suite must pass');
  assert.equal(networkAttempts, 0, 'external transport and listeners remain prohibited');
});
