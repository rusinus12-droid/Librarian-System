'use strict';

// Double-click launchers require only Node. Share the artifact input contract with
// run_regression_batch.py without adding a Python dependency to those launchers.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inputs = require('./regression_inputs.json');

function selectTests(programDir, names = []) {
  const all = fs.readdirSync(path.join(programDir, 'tests'))
    .filter(name => /(?:_test|\.test)\.cjs$/.test(name)).sort();
  if (!names.length) return all;
  for (const name of names) if (!all.includes(name)) throw Error(`regression_test_not_found:${name}`);
  return all.filter(name => names.includes(name));
}

function run({ programDir = path.resolve(__dirname, '..'), names = [], list = false,
  env = process.env, output = console.log } = {}) {
  const tests = selectTests(programDir, names);
  if (list) { tests.forEach(name => output(name)); return { code: 0, listed: tests.length }; }
  if (!tests.length) throw Error('regression_no_tests_selected');
  const { ensureBuildSupportDependencies } = require(path.join(programDir, 'tools', 'ensure_build_support.cjs'));
  const support = ensureBuildSupportDependencies({ programDir,
    installIfMissing: env.MEMORY_SUITE_REGRESSION_NO_INSTALL !== '1', onProgress: output });
  if (!support?.modulesDir) throw Error('regression_build_support_unavailable');
  const childEnv = { ...env, GRADIA_TOOLCHAIN_ROOT: support.modulesDir,
    NODE_PATH: [support.modulesDir, env.NODE_PATH].filter(Boolean).join(path.delimiter) };
  let passed = 0, failed = 0, inputRequired = 0;
  for (const name of tests) {
    const missing = (inputs[name] || []).filter(key => !childEnv[key]);
    if (missing.length) {
      inputRequired++;
      output(`INPUT_REQUIRED ${name}: ${missing.join(', ')} (not run)`);
      continue;
    }
    const result = spawnSync(process.execPath, ['--no-warnings', path.join(programDir, 'tests', name)],
      { cwd: programDir, env: childEnv, stdio: 'inherit' });
    if (result.status === 0 && !result.error) { passed++; output(`PASS ${name}`); }
    else { failed++; output(`FAIL ${name}: ${result.error?.message || result.signal || result.status}`); }
  }
  output(`SUMMARY files_pass=${passed} files_fail=${failed} input_required=${inputRequired} total=${tests.length}`);
  if (inputRequired) output('별도 빌드 입력이 필요한 시험은 실행하지 않았습니다. 전체 시험 통과로 판정하지 않습니다.');
  return { code: failed ? 1 : inputRequired ? 2 : 0, passed, failed, inputRequired };
}

if (require.main === module) {
  try {
    const names = []; let list = false;
    for (const arg of process.argv.slice(2)) {
      if (arg === '--list') list = true;
      else if (arg.startsWith('--')) throw Error(`unknown_regression_argument:${arg}`);
      else names.push(arg);
    }
    process.exitCode = run({ names, list }).code;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { run, selectTests };
