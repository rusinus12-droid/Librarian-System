'use strict';
// Mutation gate for the accessibility assertions ADDED on top of Stage 7's own button claim.
//
// PROVENANCE MATTERS HERE, and the first revision of this gate got it wrong. Stage 7 (`ad406f8`) already
// asserts `omittedMemory.tagName === 'BUTTON'` on ONE memory node. A mutant that turns EVERY node into a
// div therefore fails on THAT assertion first, and the gate reports a detection it did not earn — the
// added "every node" claim is never exercised, so the gate proved something about Stage 7's assertion
// rather than about this one.
//
// Each mutant below is scoped so Stage 7's claim stays satisfied and only an ADDED claim can fail. That is
// the difference between "the suite fails" and "the assertion under test fails", and it is the reason a
// mutation gate needs its mutants aimed rather than merely present.
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
    id: 'M1-bridge-node-is-not-a-button',
    why: 'a BRIDGE node would be unreachable by keyboard. Scoped to the bridge type because Stage 7 inspects '
       + 'a MEMORY node: an unscoped mutant would be caught by that older assertion and this gate would appear '
       + 'to pass without ever exercising the "every node" claim it exists to test.',
    from: "    const node = (id, type, title, extra = '', attrs = {}) => {\n      const button = guiEl('button', {",
    to: "    const node = (id, type, title, extra = '', attrs = {}) => {\n      const button = guiEl(type === 'bridge' ? 'div' : 'button', {",
  },
  {
    id: 'M2-every-node-claims-to-be-selected',
    why: 'the "exactly one selection" claim would be false while every individual node still reports a '
       + 'non-empty pressed state — which is the case Stage 7 never checked',
    from: "        button.setAttribute('aria-pressed', keyValue === id ? 'true' : 'false');",
    to: "        button.setAttribute('aria-pressed', 'true');",
  },
  {
    id: 'M3-wires-not-decorative',
    why: 'the decorative wire layer would be announced, duplicating every connection as unlabeled graphics',
    from: "    svg.setAttribute('aria-hidden', 'true');",
    to: "    void svg;",
  },
];

const GAPS = [
  {
    rule: 'live region on the detail panel',
    why: 'NOT mutated: removing `aria-live` would be caught by the assertion, but the mutation touches the same '
       + 'construction line as the pressed-state claim and the two failures would be indistinguishable in a report. '
       + 'The claim is asserted; it is simply not mutated separately.'
  },
  {
    rule: 'the `type="button"` claim',
    why: 'NOT mutated: dropping the type attribute matters only inside a form, and these nodes never render inside '
       + 'one, so the mutation changes no observable behaviour in this harness. Kept as a cheap guard.'
  }
];

const copyProgram = tag => {
  const root = path.join(os.tmpdir(), `a11y-mut-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  const sandbox = path.join(root, 'PROGRAM');
  fs.cpSync(PROGRAM, sandbox, { recursive: true, filter: source => !source.includes('.ultralight-dist') });
  return { root, sandbox };
};

const runSuite = sandbox => {
  const run = spawnSync(process.execPath, [path.join(sandbox, 'tests', 'libra_associative_recall_gui_test.cjs')],
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
      console.error(JSON.stringify({ results, tail: control.output.slice(-900) }, null, 1));
      throw new Error('the control run must pass against the unmutated plugin');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const mutant of MUTANTS) {
  const occurrences = original.split(mutant.from).length - 1;
  if (occurrences !== 1) { results.push({ id: mutant.id, observed: `site appeared ${occurrences}x`, detected: false }); continue; }
  const { root, sandbox } = copyProgram(mutant.id);
  try {
    fs.writeFileSync(path.join(sandbox, 'plugins', 'LIBRA.js'), original.replace(mutant.from, mutant.to));
    const outcome = runSuite(sandbox);
    results.push({
      id: mutant.id, why: mutant.why, observed: outcome.passed ? 'pass' : 'fail', detected: outcome.passed === false,
      failureExcerpt: outcome.passed ? '' : outcome.output.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 230)
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const byteIdentical = fs.readFileSync(PLUGIN, 'utf8') === original;
const undetected = results.filter(entry => entry.detected !== true);
console.log(JSON.stringify({ results, undetected: undetected.map(e => e.id), coverageGaps: GAPS, byteIdentical }, null, 1));
assert.strictEqual(byteIdentical, true, 'the repository plugin is unchanged');
assert.strictEqual(undetected.length, 0, `every mutant must be detected: ${undetected.map(e => e.id).join(', ')}`);
console.log(`libra_assoc_graph_accessibility_mutations: PASS (${MUTANTS.length} mutants detected, control passed, ${GAPS.length} coverage gaps reported)`);
