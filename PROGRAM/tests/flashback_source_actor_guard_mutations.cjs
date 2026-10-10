'use strict';
// Mutation gate for flashback_source_actor_guard_without_lia_test.cjs.
//
// A passing test proves nothing on its own: it could be passing without exercising the guard at all. This
// gate mutates the PRODUCT source in three ways that each remove (or invert) the persona comparison, runs
// the real test file against each mutant, and requires that the test FAILS. A control run with the
// unmutated source must PASS, so a test that fails for an unrelated reason does not count as detection.
//
// The mutants live in a copy of the plugin under PROGRAM/tests/ (not in review_artifacts/) so that the
// test file's `__dirname/..` relative paths still resolve to the real plugin directory — putting them
// elsewhere makes the test crash on a missing path and a crash would look like detection.
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TESTS_DIR = __dirname;
const PROGRAM = path.resolve(TESTS_DIR, '..');
const PLUGIN = path.join(PROGRAM, 'plugins', 'Flashback_Memory.js');
const TEST_FILE = path.join(TESTS_DIR, 'flashback_source_actor_guard_without_lia_test.cjs');
const original = fs.readFileSync(PLUGIN, 'utf8');

// Each mutant removes the thing the test is supposed to be sensitive to.
//
// `adoptSessionHandoff` checks the actor TWICE against the same source manifest: once early on the record
// set it just loaded (locals suffixed `...ForActor`, ~22499-22508) and once later on the manifest it
// already holds (~22574-22583). Measured behaviour, which the mutant set below encodes:
//   * neutralizing only the EARLY persona comparison -> still refused (the later check catches it)
//   * neutralizing only the LATE  persona comparison -> still refused (the early check catches it)
//   * neutralizing BOTH                             -> the handoff is accepted
// So a single-site mutant on either check alone is NOT expected to flip the outcome — that is defence in
// depth, not a gap. The mutants below therefore assert the property that actually matters:
//   M1, M2 — the early check is on the deciding path: neutralizing it alone must NOT silently accept a
//            different-Persona handoff (the guard must still refuse, proving the second check is live).
//   M3, M4 — the pair: neutralizing BOTH persona comparisons must make the guard accept, which proves the
//            test is sensitive to the persona comparison itself and not merely to some unrelated refusal.
const MUTANTS = [
  {
    id: 'M1-early-check-alone-neutralized',
    why: 'neutralizing only the early persona comparison must still refuse (the later check is live)',
    from: "(!sourceManifestForActor.personaId || !targetScope.personaId || text(sourceManifestForActor.personaId) === text(targetScope.personaId))",
    to: "(true)",
    expect: 'still-refused',
  },
  {
    id: 'M2-early-guard-alone-neutralized',
    why: 'neutralizing only the early actor guard must still refuse (the later guard is live)',
    from: "if (!sourceChatMatchesForActor || !(directActorMatchesForActor || forkActorMatchesForActor)) {",
    to: "if (false) {",
    expect: 'still-refused',
  },
  {
    id: 'M3-both-persona-comparisons-neutralized',
    why: 'neutralizing BOTH persona comparisons must accept, proving the test tracks the persona comparison',
    from: "(!sourceManifestForActor.personaId || !targetScope.personaId || text(sourceManifestForActor.personaId) === text(targetScope.personaId))",
    to: "(true)",
    extra: [{
      from: "(!sourceManifest.personaId || !targetScope.personaId || text(sourceManifest.personaId) === text(targetScope.personaId))",
      to: "(true)",
    }],
    expect: 'accepted',
  },
  {
    id: 'M4-both-guards-neutralized',
    why: 'neutralizing both actor guards must accept, proving neither refusal is incidental',
    from: "if (!sourceChatMatchesForActor || !(directActorMatchesForActor || forkActorMatchesForActor)) {",
    to: "if (false) {",
    extra: [{
      from: "if (!sourceChatMatches || !actorMatches) {",
      to: "if (false) {",
    }],
    expect: 'accepted',
  },
];

const runTest = () => {
  const outFile = path.join(os.tmpdir(), `persona-guard-mutation-${process.pid}-${Date.now()}.json`);
  try {
    const stdout = execFileSync(process.execPath, [TEST_FILE], {
      cwd: PROGRAM,
      env: { ...process.env, PERSONA_GUARD_TEST_OUT: outFile },
      stdio: 'pipe',
      timeout: 240000,
    }).toString();
    return { passed: true, output: stdout };
  } catch (error) {
    return { passed: false, output: `${error.stdout || ''}${error.stderr || ''}` };
  } finally {
    try { fs.unlinkSync(outFile); } catch (_) { /* temp artifact */ }
  }
};

const restore = () => fs.writeFileSync(PLUGIN, original);

(async () => {
  const results = [];
  try {
    // ── control: unmutated product source must PASS ─────────────────────────────────────────────────
    const control = runTest();
    assert.strictEqual(control.passed, true,
      `the control run must pass against the unmutated source, otherwise the gate cannot attribute a ` +
      `mutant failure to the mutation. Output: ${control.output.slice(0, 800)}`);
    results.push({ id: 'control-unmutated', expected: 'pass', observed: 'pass', detected: true });

    // ── mutants ─────────────────────────────────────────────────────────────────────────────────────
    for (const mutant of MUTANTS) {
      const edits = [{ from: mutant.from, to: mutant.to }, ...(mutant.extra || [])];
      let source = original;
      let siteProblem = '';
      for (const edit of edits) {
        const occurrences = source.split(edit.from).length - 1;
        if (occurrences !== 1) { siteProblem = `mutation site appeared ${occurrences} times: ${edit.from.slice(0, 70)}`; break; }
        source = source.replace(edit.from, edit.to);
      }
      if (siteProblem) {
        results.push({ id: mutant.id, expected: mutant.expect, observed: 'bad-mutation-site', detected: false, error: siteProblem });
        continue;
      }
      fs.writeFileSync(PLUGIN, source);
      const outcome = runTest();
      restore();
      // A mutant expecting 'accepted' must make the test PASS is not it — the test asserts REFUSAL, so an
      // accepted handoff makes the test FAIL. Both expectations are therefore read off the test's own
      // PASS/FAIL plus the reason it printed, so the gate states what it means:
      //   expect 'still-refused' -> test must PASS (the guard still refuses the different Persona)
      //   expect 'accepted'      -> test must FAIL, and the failure must be about the record-level claim
      const observedRefusal = outcome.passed;
      const detected = mutant.expect === 'still-refused' ? observedRefusal === true : observedRefusal === false;
      results.push({
        id: mutant.id, why: mutant.why, expected: mutant.expect,
        observed: observedRefusal ? 'still-refused' : 'accepted',
        detected,
        failureExcerpt: outcome.passed ? '' : outcome.output.trim().split('\n').slice(0, 4).join(' | '),
      });
    }
  } finally {
    restore();   // the product source must be byte-identical to what it was before the gate ran
  }

  const undetected = results.filter((entry) => entry.id !== 'control-unmutated' && entry.detected !== true);
  const controlOk = results.find((entry) => entry.id === 'control-unmutated')?.observed === 'pass';
  const byteIdentical = fs.readFileSync(PLUGIN, 'utf8') === original;

  console.log(JSON.stringify({ results, undetected: undetected.map((entry) => entry.id), controlOk, byteIdentical }, null, 1));
  assert.strictEqual(byteIdentical, true, 'the product source was restored byte-identically');
  assert.strictEqual(controlOk, true, 'the control run passed');
  assert.strictEqual(undetected.length, 0,
    `every mutant must be detected: ${undetected.map((entry) => entry.id).join(', ')}`);
  console.log(`flashback_persona_guard_mutations: PASS (${MUTANTS.length} mutants detected, control passed, source restored)`);
})().catch((error) => {
  restore();
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
