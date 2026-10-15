'use strict';
// N06-a: LIBRA Unified Memory Engine Benchmark Suite & Acceptance Gate Test
//
// Verifies that:
// 1. Fixture contains 8 standardized scenarios with defined gold/forbidden sets.
// 2. evaluateScenario and runEvaluationSuite execute unified requests end-to-end.
// 3. 8/8 benchmark cases pass strictly with 100% gold recall and 0 forbidden leaks.
// 4. Negative controls detect forbidden leaks and gold recall drops.
// 5. M08 conservative Micro absorption and mandatory Lore inclusion work under benchmark load.
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

const {
  loadCasesBundle,
  loadCases,
  runEvaluationSuite,
  evaluateScenario,
  buildGraphFromCorpus,
  createEngineSuite
} = resolveTool('evaluate_libra_unified_memory.cjs');

const fixturePath = path.join(__dirname, 'fixtures', 'libra_unified_memory_eval_cases_v1.json');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('N06-a: fixture schema, scenario count, and mandatory categories are declared', () => {
  assert.ok(fs.existsSync(fixturePath), 'eval cases fixture exists');
  const bundle = loadCasesBundle();
  assert.equal(bundle.schema, 'libra.unified_memory_eval_cases.v1');
  assert.equal(bundle.version, 1);
  assert.ok(Array.isArray(bundle.cases), 'cases array present');
  assert.equal(bundle.cases.length, 8, 'exactly 8 benchmark scenarios defined');

  const expectedIds = [
    'UME-01', 'UME-02', 'UME-03', 'UME-04',
    'UME-05', 'UME-06', 'UME-07', 'UME-08'
  ];
  const actualIds = bundle.cases.map(c => c.id);
  assert.deepEqual(actualIds, expectedIds, 'scenario IDs match standard UME-01..08');

  const expectedCategories = new Set([
    'multi_family_synthesis',
    'beyond_first_window',
    'named_entity_synonym_multilingual',
    'correction_conflict_unknown',
    'temporal_worldline_viewer_isolation',
    'mandatory_lore_and_absorption',
    'vectorless_and_provider_fault',
    'resource_budget_partial_stop'
  ]);
  const actualCategories = new Set(bundle.cases.map(c => c.category));
  assert.deepEqual(actualCategories, expectedCategories, 'all 8 core quality categories are present');

  for (const c of bundle.cases) {
    assert.ok(c.label, `${c.id} has label`);
    assert.ok(c.corpus, `${c.id} has corpus`);
    assert.ok(c.query, `${c.id} has query definition`);
    assert.ok(c.expected, `${c.id} has expected definition`);
    assert.ok(c.forbidden, `${c.id} has forbidden definition`);
    assert.ok(c.passCriteria, `${c.id} has pass criteria`);
  }
});

test('N06-a: runEvaluationSuite executes all 8 cases and passes acceptance gates', async () => {
  const result = await runEvaluationSuite();

  assert.equal(result.schema, 'libra.unified_memory_evaluation_result.v1');
  assert.equal(result.totalCases, 8);
  assert.equal(result.passedCases, 8, 'all 8 cases must pass');
  assert.equal(result.failedCases, 0, 'zero failed cases');
  assert.equal(result.allPassed, true, 'allPassed gate must be true');

  assert.equal(result.summaryMetrics.averageGoldRecall, 1.0, 'gold recall must be 1.0');
  assert.equal(result.summaryMetrics.totalForbiddenLeaks, 0, 'zero forbidden leaks');
  assert.equal(result.summaryMetrics.allDispatchEligibleAsExpected, true, 'dispatch eligibility conforms');

  for (const r of result.results) {
    assert.equal(r.passed, true, `scenario ${r.caseId} must pass`);
    assert.equal(r.metrics.totalForbiddenLeaks, 0, `${r.caseId} forbidden leaks must be 0`);
    assert.ok(r.metrics.goldRecall >= 1.0, `${r.caseId} gold recall must reach minimum`);
    assert.ok(r.metrics.admittedUnits > 0, `${r.caseId} must admit units`);
    assert.ok(r.metrics.ablation, `${r.caseId} must contain signal ablation metrics`);
    assert.ok(typeof r.metrics.ablation.overlapRatio === 'number', `${r.caseId} overlap ratio is number`);
  }
});

test('N06-a: UME-06 verifies M08 conservative absorption and mandatory Lore inclusion', async () => {
  const bundle = loadCasesBundle();
  const case06 = bundle.cases.find(c => c.id === 'UME-06');
  assert.ok(case06, 'UME-06 found');

  const evalRes = await evaluateScenario(case06);
  assert.equal(evalRes.passed, true);
  assert.equal(evalRes.metrics.suppressedMicroPass, true);

  // Assert that mandatory lore is in admitted units
  assert.ok(evalRes.metrics.goldFound.includes('l_mandatory_rule'), 'mandatory lore admitted');
  assert.ok(evalRes.metrics.goldFound.includes('c_absorbed_counterpart'), 'canonical counterpart admitted');
  assert.ok(!evalRes.metrics.leakedNodeIds.includes('m_absorbed_unit'), 'micro unit absorbed and suppressed');
});

test('N06-a: negative control - deliberate forbidden leak fails acceptance', async () => {
  const bundle = loadCasesBundle();
  const baseCase = bundle.cases.find(c => c.id === 'UME-01');
  assert.ok(baseCase, 'UME-01 found');

  // Clone and add a forbidden token that appears in the corpus text
  const corruptedCase = JSON.parse(JSON.stringify(baseCase));
  corruptedCase.id = 'UME-01-CORRUPTED';
  corruptedCase.forbidden.forbiddenTokens = ['은빛 열쇠']; // Present in admitted text

  const evalRes = await evaluateScenario(corruptedCase);
  assert.equal(evalRes.passed, false, 'scenario with forbidden token leak must fail');
  assert.ok(evalRes.metrics.totalForbiddenLeaks > 0, 'forbidden leak count > 0');
  assert.ok(evalRes.metrics.leakedTokens.includes('은빛 열쇠'), 'detected specific leaked token');
});

test('N06-a: negative control - deliberate missing gold evidence fails acceptance', async () => {
  const bundle = loadCasesBundle();
  const baseCase = bundle.cases.find(c => c.id === 'UME-02');
  assert.ok(baseCase, 'UME-02 found');

  // Clone and require an impossible gold node that is not admitted
  const corruptedCase = JSON.parse(JSON.stringify(baseCase));
  corruptedCase.id = 'UME-02-CORRUPTED';
  corruptedCase.expected.goldNodeIds.push('c_non_existent_ancient_legend');

  const evalRes = await evaluateScenario(corruptedCase);
  assert.equal(evalRes.passed, false, 'scenario with unrecovered gold node must fail');
  assert.ok(evalRes.metrics.goldRecall < 1.0, 'gold recall must drop below 1.0');
});

const run = async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\nAll ${passed}/${tests.length} unified memory evaluation suite tests passed.`);
};

run();
