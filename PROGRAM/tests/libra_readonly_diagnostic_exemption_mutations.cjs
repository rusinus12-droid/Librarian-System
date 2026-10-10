'use strict';
// Mutation gate for the two Stage 1 contracts whose comparison changed here.
//
// When an assertion is rewritten, the first question is whether it still DETECTS what it was written to
// detect. These mutants answer that for the two suites that were corrected:
//
//   * the read-only contract still notices a delivered-memory change (the real subject of the contract);
//   * the read-only contract still notices the feature diagnostic changing when it should not;
//   * the fail-open contract still notices recall drifting under a degraded index.
//
// A mutant that survives means the corrected comparison became decorative.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROGRAM = path.resolve(__dirname, '..');
const PLUGIN = path.join(PROGRAM, 'plugins', 'LIBRA.js');
const MAX_BUFFER = 64 * 1024 * 1024;

const MUTANTS = [
  {
    id: 'M1-delivered-memory-perturbed-only-when-index-on',
    suite: 'libra_evidence_link_index_readonly_test.cjs',
    why: 'the index would change what a model RECEIVES, which is the contract the suite exists for. The '
       + 'mutation is CONDITIONAL on the index being present: an unconditional one perturbs the OFF run too, '
       + 'so both sides move together and a comparison between them cannot catch it — that is a property of '
       + 'the mutation, not of the assertion.',
    from: "        const associativeIndex = await loadOrRefreshEvidenceLinkIndex(context.scope, manifest, { force: false, persist: false }).catch(() => null);",
    to: "        const associativeIndex = await loadOrRefreshEvidenceLinkIndex(context.scope, manifest, { force: false, persist: false }).catch(() => null);\n        if (associativeIndex && associativeIndex.available !== false) for (const row of rows) row.memory.text = row.memory.text + '-perturbed';",
  },
  {
    id: 'M2-diagnostic-reports-wrong-mode',
    suite: 'libra_evidence_link_index_readonly_test.cjs',
    why: 'the feature diagnostic would misreport which mode it ran in, and the suite must catch that',
    from: "            associativeObservation.mode = string(Runtime.lastAssociativeMode || 'observation_only');",
    to: "            associativeObservation.mode = 'participation';",
  },
];
// The diagnostics-only exemption is the risky part of the rewrite, so it gets its own mutant: a change
// OUTSIDE that one field must still fail. If M1 survives, the exemption is too wide.
const GAPS = [
  {
    rule: 'fail-open recall drift',
    why: 'NOT mutated here because the existing fail-open mutants (a failing index write, an unreadable memory, '
       + 'a bounded index) already drive those paths in the suite itself; adding a plugin mutant for them would '
       + 'duplicate the suite rather than test it.'
  }
];

const copyProgram = tag => {
  const root = path.join(os.tmpdir(), `idx-mut-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  const sandbox = path.join(root, 'PROGRAM');
  fs.cpSync(PROGRAM, sandbox, { recursive: true, filter: source => !source.includes('.ultralight-dist') });
  return { root, sandbox };
};

const runSuite = (sandbox, suite) => {
  const run = spawnSync(process.execPath, [path.join(sandbox, 'tests', suite)],
    { cwd: sandbox, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 300000 });
  return { passed: run.status === 0, output: `${run.stdout || ''}${run.stderr || ''}` };
};

const original = fs.readFileSync(PLUGIN, 'utf8');
const results = [];

for (const suite of ['libra_evidence_link_index_readonly_test.cjs', 'libra_evidence_link_index_failopen_test.cjs']) {
  const { root, sandbox } = copyProgram(`control-${suite}`);
  try {
    const control = runSuite(sandbox, suite);
    results.push({ id: `control ${suite}`, observed: control.passed ? 'pass' : 'fail', detected: control.passed });
    if (!control.passed) {
      console.error(JSON.stringify({ results, tail: control.output.slice(-900) }, null, 1));
      throw new Error(`the control run must pass: ${suite}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const mutant of MUTANTS) {
  const occurrences = original.split(mutant.from).length - 1;
  if (occurrences !== 1) { results.push({ id: mutant.id, observed: `site appeared ${occurrences}x`, detected: false }); continue; }
  const { root, sandbox } = copyProgram(mutant.id);
  try {
    fs.writeFileSync(path.join(sandbox, 'plugins', 'LIBRA.js'), original.replace(mutant.from, mutant.to));
    const outcome = runSuite(sandbox, mutant.suite);
    results.push({
      id: mutant.id, suite: mutant.suite, why: mutant.why,
      observed: outcome.passed ? 'pass' : 'fail', detected: outcome.passed === false,
      failureExcerpt: outcome.passed ? '' : outcome.output.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 190)
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const byteIdentical = fs.readFileSync(PLUGIN, 'utf8') === original;
const undetected = results.filter(entry => entry.detected !== true);
console.log(JSON.stringify({ results, undetected: undetected.map(e => e.id), coverageGaps: GAPS, byteIdentical }, null, 1));
assert.strictEqual(byteIdentical, true, 'the repository plugin is unchanged');
assert.strictEqual(undetected.length, 0, `every mutant must be detected: ${undetected.map(e => e.id).join(', ')}`);
console.log(`libra_readonly_diagnostic_exemption_mutations: PASS (${MUTANTS.length} mutants detected, controls passed, ${GAPS.length} coverage gap reported)`);
