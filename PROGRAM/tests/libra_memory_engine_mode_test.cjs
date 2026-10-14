'use strict';
// LIBRA memory engine routing policy contract (M01 closure):
// 1. The default mode is legacy and says so, because E3/E4 are open.
// 2. A present-but-unknown mode is refused rather than silently degrading to legacy.
// 3. Every recall result records the engine that served it (never an inline literal).
// 4. The policy block embedded in plugins/LIBRA.js is compared with the pure module so the two
//    copies cannot drift, and the retired inline fallback/literal cannot come back.
// The embedding check is negative-controlled at the end: a mutated copy must NOT compare equal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const resolveTool = name => {
  const candidates = [path.join(__dirname, '..', 'tools', name), path.join(__dirname, name)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('Cannot resolve tool module: ' + name);
};

const policy = resolveTool('libra_memory_engine_mode.cjs');
const pluginPath = path.join(__dirname, '..', 'plugins', 'LIBRA.js');
const toolPath = path.join(__dirname, '..', 'tools', 'libra_memory_engine_mode.cjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const markedBlock = source => {
  const match = /\/\* LIBRA_MEMORY_ENGINE_MODE_POLICY:START \*\/([\s\S]*?)\/\* LIBRA_MEMORY_ENGINE_MODE_POLICY:END \*\//.exec(source);
  assert.ok(match, 'policy markers must be present');
  return match[1];
};
const normalizeBlock = text => text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');

test('V: default routing mode is legacy and declares why it is not unified', () => {
  const decision = policy.resolveMemoryEngineMode({});
  assert.equal(decision.schema, 'libra.memory_engine_decision.v1');
  assert.equal(decision.mode, 'legacy');
  assert.equal(decision.source, 'default');
  assert.equal(decision.defaultApplied, true);
  assert.equal(decision.declared, null);
  assert.equal(decision.qualification, 'qualified_baseline');
  assert.deepEqual([...policy.DEFAULT_MODE_OPEN_GATES], ['E3', 'E4'], 'the open gates behind the legacy default must be named');
});

test('M01: an explicit request wins over the setting and is marked unqualified', () => {
  const fromRequest = policy.resolveMemoryEngineMode({ requestValue: 'unified', settingValue: 'legacy' });
  assert.equal(fromRequest.mode, 'unified');
  assert.equal(fromRequest.source, 'request');
  assert.equal(fromRequest.defaultApplied, false);
  assert.equal(fromRequest.qualification, 'unqualified_until_E3_E4');
  const fromSetting = policy.resolveMemoryEngineMode({ settingValue: 'shadow' });
  assert.equal(fromSetting.mode, 'shadow');
  assert.equal(fromSetting.source, 'setting');
});

test('M01: blank values count as absent, not as a choice', () => {
  const decision = policy.resolveMemoryEngineMode({ requestValue: '   ', settingValue: '' });
  assert.equal(decision.mode, 'legacy');
  assert.equal(decision.source, 'default');
  assert.equal(policy.normalizeMemoryEngineMode('', { fallback: 'shadow' }), 'shadow');
});

test('M01: whitespace is formatting, not a different mode', () => {
  const padded = policy.resolveMemoryEngineMode({ requestValue: '  unified  ' });
  assert.equal(padded.mode, 'unified');
  assert.equal(padded.source, 'request');
  assert.equal(policy.normalizeMemoryEngineMode(' legacy '), 'legacy');
});

test('M01 negative control: an unknown or mis-cased mode is refused, not degraded to legacy', () => {
  for (const bad of ['Unified', 'UNIFIED', 'fast', 'unified!', 1]) {
    assert.throws(() => policy.resolveMemoryEngineMode({ requestValue: bad }),
      error => error.code === 'LIBRA_MEMORY_ENGINE_MODE_INVALID' && error.value === String(bad).trim(),
      'mode ' + String(bad) + ' must be refused');
  }
  assert.throws(() => policy.normalizeMemoryEngineMode('nope'),
    error => error.code === 'LIBRA_MEMORY_ENGINE_MODE_INVALID' && error.allowed.length === 3,
    'the refusal must list the allowed modes');
});

test('M01: the decision is stamped onto diagnostics without disturbing existing keys', () => {
  const decision = policy.resolveMemoryEngineMode({ requestValue: 'shadow' });
  const result = { diagnostics: { candidates: 3, unifiedShadowEvaluation: { mode: 'shadow' } } };
  const stamped = policy.stampMemoryEngineDecision(result, decision);
  assert.equal(stamped, result, 'stamping must return the same result object');
  assert.equal(result.diagnostics.memoryEngine.mode, 'shadow');
  assert.equal(result.diagnostics.memoryEngine.source, 'request');
  assert.equal(result.diagnostics.candidates, 3);
  assert.equal(result.diagnostics.unifiedShadowEvaluation.mode, 'shadow');
  assert.deepEqual(policy.stampMemoryEngineDecision(null, decision), null);
});

test('closure: the plugin embeds the policy block verbatim', () => {
  const pluginBlock = normalizeBlock(markedBlock(fs.readFileSync(pluginPath, 'utf8')));
  const toolBlock = normalizeBlock(markedBlock(fs.readFileSync(toolPath, 'utf8')));
  assert.equal(pluginBlock, toolBlock, 'the embedded policy must match the pure module');
  assert.ok(pluginBlock.includes('const DEFAULT_MEMORY_ENGINE_MODE = \'legacy\''), 'the default must be part of the embedded block');
  assert.notEqual(pluginBlock, normalizeBlock(toolBlock.replace('DEFAULT_MEMORY_ENGINE_MODE = \'legacy\'', 'DEFAULT_MEMORY_ENGINE_MODE = \'unified\'')),
    'negative control: a drifted copy must not compare equal');
});

test('closure: recall resolves the mode through the policy and records the serving engine', () => {
  const source = fs.readFileSync(pluginPath, 'utf8');
  assert.ok(source.includes('const unifiedEngineMode = memoryEngineDecision.mode;'), 'recall must take the mode from the policy decision');
  assert.ok(source.includes('stampMemoryEngineDecision(result, memoryEngineDecision)'), 'legacy/shadow results must carry the decision');
  assert.ok(source.includes('stampMemoryEngineDecision(unifiedResult, memoryEngineDecision'), 'unified results must carry the decision');
  assert.equal(source.includes("settings?.unifiedMemoryEngineMode || 'legacy'"), false, 'the retired inline fallback must not return');
  assert.equal(source.includes("const unifiedEngineMode = string(suppliedBundle?.unifiedEngineMode"), false, 'the inline mode expression must not return');
});

test('closure: the canonical record derives its engine flag instead of asserting a literal', () => {
  const source = fs.readFileSync(pluginPath, 'utf8');
  assert.equal(source.includes("const engineMode='librarian',unified=true"), false, 'the hardcoded unified literal must not return');
  assert.ok(source.includes('const unified=isReadableUnifiedEngineVersion(UNIFIED_ENGINE_VERSION);'),
    'the canonical flag must be derived from the engine version identity');
});

test('closure: ranking coefficients declare themselves uncalibrated', () => {
  const source = fs.readFileSync(pluginPath, 'utf8');
  assert.ok(source.includes('const MEMORY_ENGINE_SCORE_WEIGHTS = Object.freeze({'), 'the weights must be a named table');
  assert.ok(source.includes("calibration: 'unmeasured'"), 'the table must declare its provenance');
  const table = /const MEMORY_ENGINE_SCORE_WEIGHTS = Object\.freeze\(\{([\s\S]*?)\n  \}\);/.exec(source);
  assert.ok(table, 'weight table must be readable');
  assert.ok(table[1].includes('lexical: 0.38'), 'the calibrated-by-hand coefficients must stay visible, not be hidden in literals');
});

(async () => {
  const results = [];
  for (const t of tests) {
    await t.fn();
    results.push(t.name);
  }
  console.log(JSON.stringify({ suite: 'libra_memory_engine_mode', passed: results.length, tests: results }, null, 0));
})();
