'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const program = path.resolve(__dirname, '..');
const wrapper = path.join(__dirname, 'wm_suite_test.cjs');
const identityFile = path.join(program, 'tools/wm_test_execution_identity.cjs');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const names = ['libra_settings_uncertain_outcome_test.cjs', 'libra_settings_verified_persistence_test.cjs',
  'wm-preset-dirty-navigation.test.cjs', 'wm-preset-dirty-races.test.cjs', 'wm_shared_helper_test.cjs'];

async function exercise(mutate = () => {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-reuse-identity-'));
  const lib = path.join(temp, 'LIB'), root = path.join(lib, 'PROGRAM'), wm = path.join(root, 'wm');
  const cache = path.join(temp, 'cache'), output = path.join(temp, 'evidence'), deps = path.join(temp, 'deps');
  const write = (relative, value) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  const helper = write('wm/tools/shared-gui-helper.cjs', 'module.exports = 41;\n');
  const guard = write('wm/tools/strict-offline-guard.cjs', '// synthetic selected guard\n');
  write('wm/tools/portable-test-paths.cjs', '// synthetic selected hook\n');
  const fixture = write('wm/tools/fixtures/mock.json', '{"value":41}\n');
  write('tests/wm_suite_test.cjs', fs.readFileSync(wrapper));
  if (fs.existsSync(identityFile)) write('tools/wm_test_execution_identity.cjs', fs.readFileSync(identityFile));
  for (let index = 0; index < 6; index++) write('plugins/plugin-' + index + '.js', '// synthetic existing plugin\n');
  const artifact = write('plugins/LIBRA_World_Manager.js', '// synthetic WM artifact, no runtime evaluation\n');
  for (const filename of names) write('wm/tools/' + filename, "require('./shared-gui-helper.cjs');\n");
  fs.mkdirSync(cache); fs.mkdirSync(deps); fs.writeFileSync(path.join(deps, 'dependency.cjs'), 'module.exports = 41;\n');
  const variables = { WM_SUITE_REUSE_DIR: cache, WM_EVIDENCE_DIR: output, LIBRA_NETWORK_AUDIT: path.join(output, 'network.jsonl'), NODE_PATH: deps };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    const api = fs.existsSync(identityFile) ? require(identityFile) : {};
    const environment = { NODE_PATH: deps, NODE_OPTIONS: '--require=' + JSON.stringify(guard) + ' --require=' + JSON.stringify(path.join(wm, 'tools/portable-test-paths.cjs')), WM_TEST_PROFILE: 'source' };
    const capture = profile => typeof api.captureWmExecutionIdentity === 'function'
      ? api.captureWmExecutionIdentity({ programDir: root, artifact, profile, environment }) : { placeholder: true, profile };
    for (const filename of names) {
      const resultFile = path.join(cache, filename + '.result.json');
      const row = { status: 'PASS', complete: true, exit: 0, counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
        customPass: 0, customFail: 0, testFileSha256: sha(path.join(wm, 'tools', filename)), artifactSha256: sha(artifact), dependencies: {}, executionIdentity: capture('source') };
      fs.writeFileSync(resultFile, JSON.stringify(row));
      fs.writeFileSync(path.join(cache, filename + '.json'), JSON.stringify({ ...row, resultFile, resultFileSha256: sha(resultFile) }));
    }
    const modifyRecords = change => {
      for (const filename of names) {
        const file = path.join(cache, filename + '.json'), row = JSON.parse(fs.readFileSync(file));
        change(row); fs.writeFileSync(file, JSON.stringify(row));
      }
    };
    await mutate({ root, wm, helper, guard, fixture, deps, cache, modifyRecords, capture });
    const filename = path.join(root, 'tests/wm_suite_test.cjs');
    const mod = new Module(filename, module); mod.filename = filename; mod.paths = module.paths;
    const requireOriginal = mod.require.bind(mod); let callback;
    mod.require = name => name === 'node:test' ? ((label, run) => { callback = run; })
      : name === '../tools/build_wm_source.cjs' ? { writeWmDevelopmentSource: async () => ({ owner: 'wm', profile: 'source', filename: 'LIBRA_World_Manager.js', outputSha256: sha(artifact) }) }
        : name === '../tools/wm_test_execution_identity.cjs' ? require(identityFile) : requireOriginal(name);
    mod._compile(fs.readFileSync(wrapper, 'utf8'), filename);
    assert.equal(typeof callback, 'function');
    await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('wm_reuse_identity_capture_is_available', () => {
  const api = fs.existsSync(identityFile) ? require(identityFile) : {};
  assert.equal(typeof api.captureWmExecutionIdentity, 'function', 'mandatory executed-input identity must be available');
});
test('wm_reuse_accepts_an_unchanged_closed_snapshot', async () => exercise());
for (const [name, mutate] of [
  ['shared helper', f => fs.appendFileSync(f.helper, '// changed helper\n')],
  ['guard', f => fs.appendFileSync(f.guard, '// changed guard\n')],
  ['fixture', f => fs.writeFileSync(f.fixture, '{"value":42}\n')],
  ['pinned dependency', f => fs.appendFileSync(path.join(f.deps, 'dependency.cjs'), '// changed dependency\n')]
]) test('wm_reuse_rejects_changed ' + name + ' with an empty legacy dependency map', async () => {
  await assert.rejects(exercise(mutate), /WM_REUSE_IDENTITY_MISMATCH/);
});
test('wm_reuse_rejects_missing_snapshot_identity', async () => {
  await assert.rejects(exercise(f => f.modifyRecords(row => { delete row.executionIdentity; })), /WM_REUSE_IDENTITY_REQUIRED/);
});
test('wm_reuse_rejects_a_different_explicit_profile', async () => {
  await assert.rejects(exercise(f => f.modifyRecords(row => { row.executionIdentity = f.capture('release'); })), /WM_REUSE_IDENTITY_MISMATCH/);
});
