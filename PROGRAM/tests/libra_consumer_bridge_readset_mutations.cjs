'use strict';
// Mutation gate for libra_consumer_bridge_readset_test.cjs.
//
// The suite could pass without the bridge mechanism existing: with no bridge list the read set is
// supposed to be unchanged, so a builder that ignores bridges entirely would still satisfy four of the
// five cases. This gate removes the mechanism and requires the suite to FAIL, which is what proves the
// suite is sensitive to the bridge feature rather than to its absence.
//
// The mutants run against a throwaway copy of the plugin, so the repository is never modified.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROGRAM = path.resolve(__dirname, '..');
const PLUGIN = path.join(PROGRAM, 'plugins', 'LIBRA.js');
const SUITE = path.join(PROGRAM, 'tests', 'libra_consumer_bridge_readset_test.cjs');
const FIXTURE = path.join(PROGRAM, 'tests', 'fixtures', 'libra_lore_link_index_fixture.cjs');
const MAX_BUFFER = 64 * 1024 * 1024;

const MUTANTS = [
  {
    id: 'M1-bridge-list-ignored',
    why: 'the builder stops reading the bridge list, so a pass-through lore never becomes a dependency',
    from: "const bridgeIds=asArray(packet?.associative_links?.bridges).map(row=>string(asObject(row).id||'')).filter(Boolean);",
    to: "const bridgeIds=[];",
  },
  {
    id: 'M2-bridge-entries-dropped',
    why: 'bridges are collected but never added to the read set',
    from: 'bridgeEntries.forEach(add);',
    to: 'void bridgeEntries;',
  },
  {
    id: 'M3-bridge-tag-blanked',
    why: 'the disclosure field stops naming the bridges, so a dependency cannot be told from a delivery',
    from: 'bridgeDependencyIds:bridgedIds,',
    to: 'bridgeDependencyIds:[],',
  },
  {
    id: 'M4-consumed-not-excluded',
    why: 'a lore the prompt already consumed is counted as a bridge too, double-counting delivered material',
    from: "inventory.lore.filter(entry=>bridgeIds.includes(entry.id) && !usedIds.has(entry.id))",
    to: 'inventory.lore.filter(entry=>bridgeIds.includes(entry.id))',
  },
];

// The suite reads the plugin through the harness, which resolves the plugin path itself; a copy of the
// whole PROGRAM tree is what makes the mutation reachable without touching the repository.
const copyProgram = (tag) => {
  const root = path.join(os.tmpdir(), `bridge-readset-mut-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  const sandbox = path.join(root, 'PROGRAM');
  fs.cpSync(PROGRAM, sandbox, { recursive: true, filter: source => !source.includes('.ultralight-dist') });
  return { root, sandbox };
};

const runSuite = sandbox => {
  const run = spawnSync(process.execPath, [path.join(sandbox, 'tests', 'libra_consumer_bridge_readset_test.cjs')],
    { cwd: sandbox, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 300000 });
  return { passed: run.status === 0, output: `${run.stdout || ''}${run.stderr || ''}` };
};

const original = fs.readFileSync(PLUGIN, 'utf8');
const results = [];

// Control first: the unmutated plugin must PASS, otherwise a mutant failure is unattributable.
{
  const { root, sandbox } = copyProgram('control');
  try {
    const control = runSuite(sandbox);
    results.push({ id: 'control-unmutated', expected: 'pass', observed: control.passed ? 'pass' : 'fail', detected: control.passed });
    if (!control.passed) {
      console.error(JSON.stringify({ results, controlOutput: control.output.slice(-900) }, null, 1));
      throw new Error('the control run must pass against the unmutated plugin');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const mutant of MUTANTS) {
  const occurrences = original.split(mutant.from).length - 1;
  if (occurrences !== 1) {
    results.push({ id: mutant.id, expected: 'fail', observed: `site appeared ${occurrences}x`, detected: false });
    continue;
  }
  const { root, sandbox } = copyProgram(mutant.id);
  try {
    fs.writeFileSync(path.join(sandbox, 'plugins', 'LIBRA.js'), original.replace(mutant.from, mutant.to));
    const outcome = runSuite(sandbox);
    results.push({
      id: mutant.id, why: mutant.why, expected: 'fail', observed: outcome.passed ? 'pass' : 'fail',
      detected: outcome.passed === false,
      failureExcerpt: outcome.passed ? '' : outcome.output.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200),
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// The repository copy must be untouched.
const byteIdentical = fs.readFileSync(PLUGIN, 'utf8') === original;
const undetected = results.filter(entry => entry.id !== 'control-unmutated' && entry.detected !== true);
void SUITE; void FIXTURE;
console.log(JSON.stringify({ results, undetected: undetected.map(e => e.id), byteIdentical }, null, 1));
assert.strictEqual(byteIdentical, true, 'the repository plugin is unchanged');
assert.strictEqual(undetected.length, 0, `every mutant must be detected: ${undetected.map(e => e.id).join(', ')}`);
console.log(`libra_consumer_bridge_readset_mutations: PASS (${MUTANTS.length} mutants detected, control passed)`);
