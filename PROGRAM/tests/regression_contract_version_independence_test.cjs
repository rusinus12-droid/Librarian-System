'use strict';
// Executes the real read-only contract validators on in-memory source variants.
// No plugin execution, model calls, network access or product-file mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
function run(name, transform = (_file, source) => source) {
  const filename = path.join(__dirname, name);
  const wrappedFs = Object.create(fs);
  wrappedFs.readFileSync = (file, ...args) => {
    const value = fs.readFileSync(file, ...args);
    return typeof value === 'string' ? transform(String(file), value) : value;
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'node:fs' ? wrappedFs : require(name),
    __dirname, console: {log() {}}, process: {stdout: {write() {}}}
  }, {filename});
}
const argTest = 'flashback_arg_settings_gui_contract_test.cjs';
const computeTest = 'compute_gui_and_libra_open_latency_contract_test.cjs';
// The real inventory is complete. Add one coherent test-only setting to
// verify that healthy inventory growth remains independent of old counts.
const coveredFixture = s => s.replace('const FLASHBACK_ARGUMENT_SETTING_FIELDS = Object.freeze([', "const FLASHBACK_ARGUMENT_SETTING_FIELDS = Object.freeze([\n    Object.freeze({ name: 'fixture_extra', key: 'fixtureExtra' }),").replace('const SETTING_ARGUMENT_NAMES = Object.freeze([', "const SETTING_ARGUMENT_NAMES = Object.freeze([ 'fixture_extra',") + '\n//@arg fixture_extra string Test-only additional setting\n';
test('a complete in-memory settings inventory passes independent of historical count', () => run(argTest, (file, s) => file.endsWith('Flashback_Memory.js') ? coveredFixture(s) : s));
test('a future coherent Flashback version passes the same complete-inventory contracts', () => run(argTest, (file, s) => file.endsWith('Flashback_Memory.js') ? coveredFixture(s).replace(/(^\/\/@version )\S+/m, '$19.8.7').replace(/(const PLUGIN_VERSION = ')[^']+/, '$19.8.7') : s));
test('a future SDK comment version preserves GUI contracts', () => run(computeTest, (file, s) => file.endsWith('MemorySuiteComputeClient.source.js') ? s.replace('SDK v0.3.6', 'SDK v9.8.7') : s));
function runCovered(transform = source => source) {
  return run(argTest, (file, source) => file.endsWith('Flashback_Memory.js') ? transform(coveredFixture(source)) : source);
}
test('duplicate ARG declarations still fail', () => {
  runCovered();
  assert.throws(() => runCovered(source => source + '\n//@arg mode string Duplicate\n'), /unique/);
});
test('removing an editable setting control still fails', () => {
  runCovered();
  assert.throws(() => runCovered(source => {
    const changed = source.replace(/^.*Object\.freeze\(\{ name: 'lexical_weight'.*\n/m, '');
    assert.notEqual(changed, source, 'negative control actually removes lexical_weight');
    return changed;
  }), error => /every normal setting ARG/.test(error.message)
    && JSON.stringify(error.actual) === JSON.stringify(['lexical_weight']));
});
test('undeclared normal settings still fail', () => {
  runCovered();
  assert.throws(() => runCovered(source => source.replace(/^\/\/@arg lexical_weight .*\n/m, '')), /declared ARG/);
});
test('loss of authoritative settings hydration remains a failure', () => assert.throws(() => run(computeTest, (file, s) => file.endsWith('MemorySuiteStorageClient.libra.source.js') ? s.replaceAll('await scopedGetConnectionSettings({ force:true })', 'cachedSettings') : s), /authoritative|hydration/));
