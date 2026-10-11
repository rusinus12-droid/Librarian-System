"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = function probe(runner) {
  const python = process.env.PYTHON || ['python', 'python3', 'py'].find(command =>
    spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0);
  assert.ok(python, 'Python is required to exercise the shipped runner');
  const cases = [
    ['explicit-marker', 'SKIP: no captured Gemma-4 answer', 'PASS_SKIP'],
    ['compact-json', '{"skipped":true}', 'PASS_SKIP'],
    ['legacy-json', '{\n "suite": "recording",\n "skipped": true\n}', 'PASS_SKIP'],
    ['mixed-log-json', 'starting probe\n{\n "skipped": true,\n "reason": "no recording"\n}\nprobe: PASS', 'PASS_SKIP'],
    ['multiple-documents', '{"skipped":false}\n{"skipped":true}', 'PASS_SKIP'],
    ['nested-refusal', '{"observed":{"diagnostics":{"skipped":true,"reason":"refused unsafe write"}}}', 'PASS'],
    ['nested-idempotence', '{\n "result": {\n  "skipped": true,\n  "reason": "already applied"\n }\n}', 'PASS'],
    ['nested-guard', 'guard verified\n{"results":[{"skipped":true,"reason":"guard refused"}]}\nPASS', 'PASS'],
    ['array-is-not-suite', '[{"skipped":true}]', 'PASS'],
    ['string-is-not-flag', '{"message":"\\"skipped\\": true"}', 'PASS'],
    ['nonboolean-flag', '{"skipped":"true"}', 'PASS'],
    ['false-flag', '{"skipped":false}', 'PASS'],
    ['plain-pass', 'full suite: PASS', 'PASS'],
    ['failed-skip', '{"skipped":true}\nSKIP: optional step failed', 'FAIL', 1],
  ];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-skip-runner-'));
  try {
    const tests = path.join(temp, 'tests');
    fs.mkdirSync(tests);
    fs.copyFileSync(runner, path.join(temp, 'run_regression_batch.py'));
    fs.writeFileSync(path.join(temp, 'VERSION.txt'), '0.0.1');
    fs.writeFileSync(path.join(temp, 'program-manifest.json'), JSON.stringify({ plugins: {} }));
    for (const [name, output, , code = 0] of cases) {
      fs.writeFileSync(path.join(tests, `${name}_test.cjs`),
        `process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${code};`);
    }
    const log = path.join(temp, 'execution.log');
    const result = spawnSync(python, [path.join(temp, 'run_regression_batch.py')], {
      cwd: temp, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, MEMORY_SUITE_REGRESSION_LOG: log },
    });
    assert.equal(result.status, 1, 'a nonzero suite exit must keep the batch failing');
    const execution = fs.readFileSync(log, 'utf8');
    for (const [name, , expected] of cases) {
      assert.match(execution, new RegExp(`${name}_test\\.cjs: ${expected} `),
        `${name} must classify as ${expected}`);
    }
    assert.match(execution, /Suites reporting a partial skip \(PASS_SKIP\): 5\./,
      'only successful suites reporting skipped work contribute to the summary');
    console.log(JSON.stringify({ test: 'regression_skip_detection', ok: true, cases: cases.length }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};
