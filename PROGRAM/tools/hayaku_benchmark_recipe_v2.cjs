'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const PINS = Object.freeze({
  fixtureV1: '190f35784dd687a5a295e5b5d122713e55a97e4b06192754350f6442f596edb6',
  fixtureV2: '9f52fffea821492e5c9bf6ade87a4a2fc1b6ca6de5d2db174a36f9caffe80ac8',
  runner: 'fef4e60bbfd1f32d552fbbfc6974552e090985bd7bd73dbbfdc161c58ce1601a',
  gold: '9b9a9c2d00876f288375e31e68a0eacf01fd010e1d81f4ade5f2ee4fb0a80c68',
  baselineProduct: '98f0e2fb4d23db99c389dfb246ebd7369092c83de884ff7af622a8d96f470ccb',
  baselineRevision: '56dfa4db5014df0272aab8bac960a79b16b4b7a2',
  currentProduct: 'db7c1495795c8b8f6a59b4e0be03323a43543b1ca0d7af79a3bfb881b0dece9f',
  currentRevision: '15b40a5c8477b55a73384fff4737efe67072d7ea'
});
const archive = path.resolve(__dirname, '../tests/fixtures/hayaku-benchmark-recipe-v2');
const workspace = path.resolve(__dirname, '../../..');
const GUARD = 'C:/Users/rusin/Desktop/LIB/LIB/work/recovery-20261002/no-model-network.cjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function verifyPin(bytes, expected, label) {
  const actual = hash(bytes);
  assert.equal(actual, expected, `${label} pin mismatch`);
  return actual;
}
function privateOutput(root) {
  const absolute = path.resolve(root);
  const relative = path.relative(workspace, absolute);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'output must be inside this private workspace');
  return absolute;
}
function verifyExecutionGuard(execArgv = process.execArgv, nodeOptions = process.env.NODE_OPTIONS, networkLog = process.env.RECOVERY_NETWORK_LOG) {
  const normalized = execArgv.map(v => v.replace(/\\/g, '/'));
  assert.ok(normalized.some((v, i) => v === `--require=${GUARD}` || (v === '--require' && normalized[i + 1] === GUARD)), 'explicit --require recovery guard is required');
  assert.ok(String(nodeOptions || '').replace(/\\/g, '/').includes(`--require=${GUARD}`), 'NODE_OPTIONS recovery guard is required');
  assert.ok(networkLog, 'private network log is required');
  privateOutput(networkLog);
}

function loadRecipe({ fixtureVersion = 'v1', outputRoot = path.join(workspace, 'work/hayaku-recipe-v2/runs') } = {}) {
  assert.ok(['v1', 'v2'].includes(fixtureVersion), 'unknown fixture version');
  outputRoot = privateOutput(outputRoot);
  const fixtureFile = path.join(archive, `hayaku-runtime-${fixtureVersion}.cjs`);
  const fixtureSha256 = verifyPin(fs.readFileSync(fixtureFile), PINS[fixtureVersion === 'v1' ? 'fixtureV1' : 'fixtureV2'], fixtureVersion);
  const fixture = require(fixtureFile);
  const runnerFile = path.join(archive, 'frozen-runner-fef4e60bbfd1.cjs');
  const bytes = fs.readFileSync(runnerFile);
  const runnerSha256 = verifyPin(bytes, PINS.runner, 'legacy runner');
  const interceptedRequires = [];
  const mutableFixture = 'C:/Users/rusin/Desktop/LIB/LIB/Librarian-System/PROGRAM/tests/fixtures/hayaku_runtime_harness.cjs';
  const allowed = new Set(['node:fs', 'node:path', 'node:crypto', 'node:assert/strict']);
  const localRequire = name => {
    if (name === mutableFixture) { interceptedRequires.push(name); return fixture; }
    if (name === 'node:child_process') return new Proxy({}, { get() { throw Error('recipe forbids Git/child execution; supply a pinned product snapshot'); } });
    assert.ok(allowed.has(name), `unapproved legacy require: ${name}`);
    return require(name);
  };
  const module = { exports: {} };
  // The legacy source bytes and runOne body remain exact. Only its private export
  // and dependency binding are supplied by this separately versioned wrapper.
  const compile = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${bytes.toString('utf8')}\nmodule.exports.runOne=runOne;\n})`, { filename: runnerFile });
  compile(localRequire, module, module.exports, runnerFile, outputRoot);
  assert.equal(interceptedRequires.length, 1, 'only the pinned legacy runtime require is translated');
  const runner = module.exports;
  verifyPin(Buffer.from(JSON.stringify(runner.gold)), PINS.gold, 'gold');
  return { schema: 'hayaku.benchmark-recipe.v2', fixtureVersion, fixtureSha256, runnerSha256, outputRoot, interceptedRequires, fixture, runner, resolveDependency: localRequire };
}

function productSnapshot(file, product = 'baseline') {
  assert.ok(['baseline', 'current'].includes(product), 'unknown product pin');
  const absolute = fs.realpathSync(file);
  const sha256 = verifyPin(fs.readFileSync(absolute), PINS[`${product}Product`], `${product} product`);
  return { file: absolute, sha256, revision: PINS[`${product}Revision`], worktree: 'immutable snapshot; no Git execution' };
}

async function runFrozen({ fixtureVersion, productFile, product = 'baseline', n = 10, repeat = 1, outputRoot, label }) {
  verifyExecutionGuard();
  assert.ok([10, 100, 1000, 2000].includes(n), 'unsupported frozen scale');
  assert.ok(Number.isInteger(repeat) && repeat > 0 && repeat <= 3, 'unsupported independent repeat');
  assert.match(label, /^[a-zA-Z0-9_-]+$/, 'run label must be a filename component');
  const recipe = loadRecipe({ fixtureVersion, outputRoot });
  const snapshot = productSnapshot(productFile, product);
  fs.mkdirSync(recipe.outputRoot, { recursive: true });
  const output = path.join(recipe.outputRoot, `${label}.json`);
  assert.equal(fs.existsSync(output), false, 'existing run evidence must never be overwritten');
  const result = await recipe.runner.runOne(snapshot, n, repeat, output);
  const manifest = {
    schema: recipe.schema, fixtureVersion: recipe.fixtureVersion,
    fixtureSha256: recipe.fixtureSha256, runnerSha256: recipe.runnerSha256,
    wrapperSha256: hash(fs.readFileSync(__filename)), snapshot,
    outputSha256: hash(fs.readFileSync(output)), n, repeat,
    actualModels: 0, actualEmbeddings: 0,
    limits: ['One run does not fulfill the four-scale, three-process matrix.', 'Legacy failed starts remain failures.', 'API publication eligibility changed; stalled observation wall time cannot be merged with v1.']
  };
  fs.writeFileSync(output + '.recipe-v2.json', JSON.stringify(manifest, null, 2));
  return { result, manifest, output };
}

module.exports = { PINS, GUARD, hash, verifyPin, verifyExecutionGuard, loadRecipe, productSnapshot, runFrozen };
