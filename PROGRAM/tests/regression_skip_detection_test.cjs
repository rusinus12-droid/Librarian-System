'use strict';
// Verifies skip classification and selection through the actual copied runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PROGRAM = path.resolve(__dirname, '..');
const RUNNER = path.join(PROGRAM, 'run_regression_batch.py');

require('./fixtures/regression_skip_runner_probe.cjs')(RUNNER);

// Selection checks share this runner suite; no second overlapping entry point.
{
  const python = process.env.PYTHON || ['python', 'python3', 'py'].find(command =>
    spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0);
  assert.ok(python, 'the regression runner requires Python; set PYTHON when invoking this suite directly');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-selection-'));
  const runner = path.join(temp, 'run_regression_batch.py');
  const tests = path.join(temp, 'tests');
  const log = path.join(temp, 'execution.log');
  const outputDir = path.join(temp, 'output');
  fs.mkdirSync(tests);
  fs.copyFileSync(path.join(__dirname, '..', 'run_regression_batch.py'), runner);
  fs.writeFileSync(path.join(tests, 'alpha_test.cjs'), 'console.log("alpha");');
  fs.writeFileSync(path.join(tests, 'beta.test.cjs'), 'console.log("SKIP: optional fixture");');
  fs.writeFileSync(path.join(tests, 'helper.cjs'), 'throw Error("helper must never run");');
  fs.writeFileSync(path.join(tests, 'alpha_test 2.cjs'), 'throw Error("copy must never run");');
  const run = args => spawnSync(python, [runner, ...args], { cwd: temp, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, MEMORY_SUITE_REGRESSION_LOG: log, MEMORY_SUITE_REGRESSION_OUTPUT_DIR: outputDir } });
  try {
    // --list must work before metadata exists and leave no logs/artifacts.
    let result = run(['--list']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['alpha_test.cjs', 'beta.test.cjs']);
    assert.equal(fs.existsSync(log), false);
    assert.equal(fs.existsSync(outputDir), false);
    result = run(['--match', '*test.cjs', '--match', '*.test.cjs', '--exclude', 'alpha*', '--list']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'beta.test.cjs');
    result = run(['1', '2', '--list']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'beta.test.cjs');
    for (const args of [['--match', 'typo*'], ['--exclude', '*'], ['0', '0'], ['-1'], ['2']]) {
      result = run([...args, '--list']);
      assert.equal(result.status, 2, `empty/invalid selection must fail: ${args}: ${result.stderr}`);
      assert.equal(fs.existsSync(log), false);
    }
    fs.writeFileSync(path.join(temp, 'VERSION.txt'), '0.0.1');
    fs.writeFileSync(path.join(temp, 'program-manifest.json'), JSON.stringify({ plugins: {} }));
    result = run([]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /alpha_test\.cjs: PASS /);
    assert.match(result.stdout, /beta\.test\.cjs: PASS_SKIP /);
    assert.match(fs.readFileSync(log, 'utf8'), /full CJS regression/);
    assert.equal(fs.readdirSync(outputDir).length, 2);
    result = run(['--match', 'alpha*']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /beta\.test/);
    assert.match(fs.readFileSync(log, 'utf8'), /selected CJS regression/);
    const beforeInvalid = fs.readFileSync(log);
    result = run(['--match', 'missing*']);
    assert.equal(result.status, 2);
    assert.deepEqual(fs.readFileSync(log), beforeInvalid, 'an invalid selection cannot overwrite prior evidence');
    fs.writeFileSync(path.join(tests, 'alpha_test.cjs'), 'process.exitCode = 1;');
    result = run(['--match', 'alpha*']);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /alpha_test\.cjs: FAIL /);
    console.log('PASS regression selection: full default, glob filters, stable range, read-only listing, fail/skip accounting, empty selection rejection');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

}
