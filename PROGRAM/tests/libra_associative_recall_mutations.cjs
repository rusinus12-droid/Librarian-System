'use strict';
// Mutation gate for libra_associative_recall_test.cjs.
//
// Every mutant below must make the suite FAIL, or the suite is asserting something other than what it
// says. The suite drives only the PUBLIC surface (LIBRA's contract forbids a `_test` developer surface),
// so the mutants are the rules that public path actually exercises:
//
//   * the exclusion of a memory the direct search already returned;
//   * the factKey -> memory direction the traversal depends on.
//
// Rules the research note defines that are NOT covered by a mutant here are stated rather than hidden —
// a gate that lists only what it caught invites the reading that everything else is covered. Each gap
// names the MEASUREMENT that produced it, not a guess: two of them exist because reaching a memory and
// passing the evidence gate turn out to be mutually exclusive in a fixture without embeddings, which is
// a property of the design worth knowing rather than a shortcoming of this gate.
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
    id: 'M1-direct-candidates-not-excluded',
    why: 'a memory already returned directly would be reached again, double-counting it as an addition',
    from: "          if (directKeys.has(rowKey)) continue;                     // already a direct candidate",
    to: "          if (false) continue;",
  },
  {
    id: 'M2-fact-memory-direction-dropped',
    why: 'the traversal would lose the factKey -> memory direction the shipped index publishes',
    from: "      for (const [factKey, memoryKey] of Object.entries(asObject(evidenceIndex.links?.factMemory))) {",
    to: "      for (const [factKey, memoryKey] of []) {",
  },
];

// Reported, never hidden. A gate that lists only what it caught invites the reading that the rest is
// covered; each entry below names why the CURRENT fixture cannot decide that rule.
const COVERAGE_GAPS = [
  {
    rule: 'relevance floor on an associative row',
    why: 'MEASURED, not assumed. The rule runs after the evidence gate in the batch loop, and no associative '
       + 'row in this fixture ever reaches that loop: instrumenting it showed `associativeRows: 0`. Every '
       + 'reached candidate is instead already hydrated by the shortlist and reported as `agreed`.'
  },
  {
    rule: 'evidence gate check on an associative row',
    why: 'the same measurement, and it is a property of the design worth knowing: reaching a memory REQUIRES '
       + 'that the query did not directly match it (a direct match makes it a direct candidate the traversal '
       + 'skips), while passing the gate REQUIRES evidence of a match. Without embeddings the only channel left '
       + 'is lexical/BM25F, so the two are mutually exclusive in this fixture. The dense channel breaks the tie '
       + 'in production, which is why the rule stays in the product — but this fixture cannot decide it.'
  },
  {
    rule: 'admit limit',
    why: 'no query against this fixture reaches more than one candidate, so the cap is never the deciding rule'
  },
  {
    rule: 'entity fan-out limit',
    why: "this fixture's entity sets never exceed the bound, so removing the limit changes no observable output"
  },
];

const copyProgram = tag => {
  const root = path.join(os.tmpdir(), `assoc-mut-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  const sandbox = path.join(root, 'PROGRAM');
  fs.cpSync(PROGRAM, sandbox, { recursive: true, filter: source => !source.includes('.ultralight-dist') });
  return { root, sandbox };
};

const runSuite = sandbox => {
  const run = spawnSync(process.execPath, [path.join(sandbox, 'tests', 'libra_associative_recall_test.cjs')],
    { cwd: sandbox, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 300000 });
  return { passed: run.status === 0, output: `${run.stdout || ''}${run.stderr || ''}` };
};

const original = fs.readFileSync(PLUGIN, 'utf8');
const results = [];

{
  const { root, sandbox } = copyProgram('control');
  try {
    const control = runSuite(sandbox);
    results.push({ id: 'control-unmutated', observed: control.passed ? 'pass' : 'fail', detected: control.passed });
    if (!control.passed) {
      console.error(JSON.stringify({ results, tail: control.output.slice(-800) }, null, 1));
      throw new Error('the control run must pass against the unmutated plugin');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const mutant of MUTANTS) {
  const occurrences = original.split(mutant.from).length - 1;
  if (occurrences !== 1) {
    results.push({ id: mutant.id, observed: `site appeared ${occurrences}x`, detected: false });
    continue;
  }
  const { root, sandbox } = copyProgram(mutant.id);
  try {
    fs.writeFileSync(path.join(sandbox, 'plugins', 'LIBRA.js'), original.replace(mutant.from, mutant.to));
    const outcome = runSuite(sandbox);
    results.push({
      id: mutant.id, why: mutant.why, observed: outcome.passed ? 'pass' : 'fail',
      detected: outcome.passed === false,
      failureExcerpt: outcome.passed ? '' : outcome.output.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 190),
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const byteIdentical = fs.readFileSync(PLUGIN, 'utf8') === original;
const undetected = results.filter(entry => entry.id !== 'control-unmutated' && entry.detected !== true);
console.log(JSON.stringify({ results, undetected: undetected.map(e => e.id), coverageGaps: COVERAGE_GAPS, byteIdentical }, null, 1));
assert.strictEqual(byteIdentical, true, 'the repository plugin is unchanged');
assert.strictEqual(undetected.length, 0, `every mutant must be detected: ${undetected.map(e => e.id).join(', ')}`);
console.log(`libra_associative_recall_mutations: PASS (${MUTANTS.length} mutants detected, control passed, ${COVERAGE_GAPS.length} coverage gaps reported)`);
