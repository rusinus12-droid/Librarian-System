'use strict';
// Verifies the runner's skip detection WITHOUT running the full suite.
//
// Why this exists: run_regression_batch.py was changed to accept two skip conventions (`SKIP:` and
// `"skipped": true`). That change is only worth anything if the runner actually flips the status, so
// this harness feeds the runner's own predicate the two real output shapes plus a control that must
// stay PASS. A test that only asserted the source text would pass on a typo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PROGRAM = path.resolve(__dirname, '..');
const RUNNER = path.join(PROGRAM, 'run_regression_batch.py');
const runner = fs.readFileSync(RUNNER, 'utf8');

// ── the predicate the runner uses, extracted verbatim so this test measures the shipped rule ────
const predicateSource = runner.match(/if status=='PASS' and \(([^)]*)\):/);
assert.ok(predicateSource, 'the runner must expose its skip predicate for this check to read');
const condition = predicateSource[1];
assert.equal(/SKIP:/.test(condition), true, 'the runner must still accept the SKIP: marker');
assert.equal(/skipped/.test(condition), true, 'the runner must also accept the JSON skipped flag');

// ── drive the predicate on real suite output ────────────────────────────────────────────────────
// NOTE: this mirrors the PYTHON predicate (`'X' in output`) with JS `.includes()`. JS `in` is a key
// check, not a substring search — using it here threw instead of measuring.
const decide = output => {
  const status = 'PASS';
  const marked = output.includes('SKIP:') || output.includes('"skipped": true') || output.includes('"skipped":true');
  return status === 'PASS' && marked ? 'PASS_SKIP' : 'PASS';
};

const cases = [
  // The four model-recording suites, each in its real no-capture shape.
  ['artifact', '{"test":"gemma4_libra_artifact_acceptance","observed":{"answerAvailable":false}}\nSKIP: no captured Gemma-4 answer; run tools/_gemma_libra_check.py to produce one\nlibra_gemma4_artifact_acceptance_test: PASS (skipped, no recording)', 'PASS_SKIP'],
  ['planner', '{\n "suite": "libra_gemma4_planner_acceptance",\n "skipped": true,\n "reason": "no model recording present"\n}\nSKIP: no model recording present; run tools/_gemma_libra_modes_check.py', 'PASS_SKIP'],
  ['sga', '{\n "suite": "libra_gemma4_sga_acceptance",\n "skipped": true\n}\nSKIP: no model recording present', 'PASS_SKIP'],
  ['hayaku', '{"test":"gemma4_normal_turn_acceptance","observed":{"answerAvailable":false}}\nSKIP: no captured Gemma-4 normal-turn answer', 'PASS_SKIP'],
  ['minified-json', '{"skipped":true}', 'PASS_SKIP'],
  // Control: the long-standing Windows-host skip marker must still be caught.
  ['windows-launcher', 'SKIP: POSIX launcher execution (Windows host); static contracts checked', 'PASS_SKIP'],
  // Control: a genuine full pass must stay PASS — a detector that flags everything is useless.
  ['full-pass', '{"test":"something","passed":3,"results":["a","b","c"]}\nsomething_test: PASS', 'PASS']
];
for (const [label, output, expected] of cases) {
  assert.equal(decide(output), expected, `skip detection for "${label}" must be ${expected}`);
}

// ── each suite's own output must actually carry a marker the runner can see ─────────────────────
for (const [file, needle] of [
  ['libra_gemma4_artifact_acceptance_test.cjs', 'SKIP:'],
  ['hayaku_gemma4_normal_turn_acceptance_test.cjs', 'SKIP:']
]) {
  const source = fs.readFileSync(path.join(PROGRAM, 'tests', file), 'utf8');
  assert.ok(source.includes(needle), `${file} must emit a ${needle} marker for the runner`);
}
// And the no-capture path must not be a non-zero exit any more.
const artifact = fs.readFileSync(path.join(PROGRAM, 'tests', 'libra_gemma4_artifact_acceptance_test.cjs'), 'utf8');
const noCapture = artifact.slice(artifact.indexOf('if (!observed.answerAvailable)'), artifact.indexOf('// 1 + 2 + 3:'));
assert.ok(!/process\.exitCode\s*=\s*1/.test(noCapture),
  'a missing capture must not set a non-zero exit code — it is NOT_RUN, not FAIL');

// ── end-to-end: run one suite through the real runner path and read the status it would log ────
const runOne = spawnSync(process.execPath, [path.join(PROGRAM, 'tests', 'libra_gemma4_artifact_acceptance_test.cjs')],
  { cwd: PROGRAM, encoding: 'utf8', timeout: 120000 });
const combined = `${runOne.stdout || ''}${runOne.stderr || ''}`;
assert.equal(runOne.status, 0, 'the artifact suite must exit 0 when there is no capture');
assert.equal(decide(combined), 'PASS_SKIP', 'the artifact suite output must be classified PASS_SKIP by the runner rule');

console.log(JSON.stringify({ test: 'regression_skip_detection', ok: true, cases: cases.length }));
console.log('PASS 회귀 러너: SKIP 표기와 skipped JSON 둘 다 PASS_SKIP 으로 판정하고, 실제 통과는 PASS 로 남긴다');

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
