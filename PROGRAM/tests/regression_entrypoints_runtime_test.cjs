'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const program = path.resolve(__dirname, '..');

test('Node and POSIX launchers prepare dependencies and distinguish required artifact inputs without Python', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-entrypoints-'));
  try {
    for (const dir of ['tools', 'tests', 'modules/probe-dependency', '관리도구']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ['tools/run_regression_tests.cjs', 'tools/regression_inputs.json', 'tools/check_node.cjs',
      '관리도구/전체_자동시험.sh']) fs.copyFileSync(path.join(program, file), path.join(root, file));
    fs.writeFileSync(path.join(root, 'VERSION.txt'), '0.4.1');
    fs.writeFileSync(path.join(root, 'program-manifest.json'), '{"plugins":{}}');
    const modules = path.join(root, 'modules');
    fs.writeFileSync(path.join(modules, 'probe-dependency/index.js'), 'module.exports=42;');
    fs.writeFileSync(path.join(root, 'tools/ensure_build_support.cjs'),
      `exports.ensureBuildSupportDependencies=()=>({modulesDir:${JSON.stringify(modules)}});`);
    fs.writeFileSync(path.join(root, 'tests/probe_test.cjs'), `
      require('node:assert/strict').equal(require('probe-dependency'),42);
      require('node:assert/strict').equal(process.env.GRADIA_TOOLCHAIN_ROOT,${JSON.stringify(modules)});
    `);
    const artifact = 'build_plugins_artifact_behavior_parity_test.cjs';
    const marker = path.join(root, 'artifact-ran');
    fs.writeFileSync(path.join(root, 'tests', artifact), `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
    const env = { ...process.env, NODE_PATH: '', GRADIA_TOOLCHAIN_ROOT: '',
      ULTRALIGHT_ARTIFACT_DIR: '', RELEASE_PARITY_CONTROL_DIR: '',
      MEMORY_SUITE_REGRESSION_LOG: path.join(root, 'execution.log') };
    const run = (command, args, extra = {}) => spawnSync(command, args, { cwd: root,
      env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
    const entries = [[process.execPath, [path.join(root, 'tools/run_regression_tests.cjs')]]];
    if (process.platform !== 'win32') entries.push(['sh', [path.join(root, '관리도구/전체_자동시험.sh')]]);
    for (const [command, args] of entries) {
      let result = run(command, args);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout, /INPUT_REQUIRED/);
      assert.match(result.stdout, /probe_test.cjs.*PASS|PASS probe_test.cjs/);
      assert.equal(fs.existsSync(marker), false, 'unqualified artifact suite never executes');
      result = run(command, args, { ULTRALIGHT_ARTIFACT_DIR: root, RELEASE_PARITY_CONTROL_DIR: root });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ran'); fs.unlinkSync(marker);
    }
    fs.writeFileSync(path.join(root, 'tools/ensure_build_support.cjs'), 'throw Error("support unavailable");');
    for (const [command, args] of entries) {
      const result = run(command, args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(fs.existsSync(marker), false);
    }
    const listed = run(process.execPath, [path.join(root, 'tools/run_regression_tests.cjs'), '--list']);
    assert.equal(listed.status, 0); assert.match(listed.stdout, /probe_test.cjs/);
    const missing = run(process.execPath, [path.join(root, 'tools/run_regression_tests.cjs'), 'typo_test.cjs']);
    assert.equal(missing.status, 1); assert.match(missing.stderr, /regression_test_not_found/);
    fs.writeFileSync(path.join(root, 'tools/ensure_build_support.cjs'),
      `exports.ensureBuildSupportDependencies=()=>({modulesDir:${JSON.stringify(modules)}});`);
    fs.writeFileSync(path.join(root, 'tests/probe_test.cjs'), 'process.exitCode=7;');
    const failed = run(process.execPath, [path.join(root, 'tools/run_regression_tests.cjs'), 'probe_test.cjs']);
    assert.equal(failed.status, 1); assert.match(failed.stdout, /files_fail=1/);
    const bat = fs.readFileSync(path.join(program, '관리도구/전체_자동시험.bat'), 'utf8');
    assert.match(bat, /MEMORY_SUITE_NODE_ONLY=1[\s\S]*call .*_common.cmd/);
    assert.match(bat, /run_regression_tests\.cjs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
