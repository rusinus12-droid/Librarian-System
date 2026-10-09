'use strict';
// Does the REAL plugin ACCEPT the artifact the REAL Gemma-4 produced for the REAL LIBRA prompt?
//
// WHY THIS TEST EXISTS
//
// Every other LIBRA suite injects a hand-written artifact through `control.artifact`, and even the
// prompt-fidelity suite (libra_memory_e2e_test.cjs) has its artifact written by hand in the test
// file. Neither answers "can an actual small model produce one?" So this file takes the answer the
// real Gemma-4 returned for the real captured prompt and drives LIBRA with it.
//
// THE MEASUREMENT
//
// hf.co/unsloth/gemma-4-12B-it-qat-GGUF UD-Q4_K_XL, ollama 0.34.1, think=false.
// Prompt: 12,972 chars (system 11,793 + user 1,179), captured from the plugin's own request.
// First attempt: 181 s, 4,499 chars, a Markdown-fenced JSON object with
// schema "libra.canonical_artifact.v4", 5 entities, 6 facts, no contract violations.
//
// WHAT IS ASSERTED
//
//   1. The captured answer names the schema, so it is an answer to THIS contract.
//   2. The plugin COMMITS it — completed, stored, and a state head written.
//   3. It commits BOTH delivery shapes: the verbatim answer and the same JSON with any fence removed.
//      LIBRA strips a fence itself (stripFence), so a small model that fences its output is not
//      penalised — that is worth pinning, because HAYAKU's normal-turn path did NOT tolerate a fence
//      and a fix was needed there.
//   4. The evidence rule is NOT weakened by any of this: the existing suite that proves a bogus quote
//      is rejected must still pass. It is run here as a subprocess so the two facts sit together —
//      "the model's answer is accepted" and "the validator still bites" — instead of being two
//      half-claims in different files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const GEMMA = '/tmp/gemma_libra_result.json';

const loadAnswer = () => {
  if (!fs.existsSync(GEMMA)) return null;
  const dump = JSON.parse(fs.readFileSync(GEMMA, 'utf8'));
  const attempt = (dump.attempts || []).find(row => typeof row.rawContent === 'string' && row.rawContent.trim());
  return attempt ? attempt.rawContent : null;
};

const runWith = async answer => {
  const f = await fixture();
  try {
    f.control.onCall = args => (typeof answer === 'function' ? answer(args[0]) : answer);
    let result = null;
    let error = '';
    try {
      result = await f.run();
    } catch (caught) {
      error = String(caught?.message || caught).slice(0, 300);
    }
    const memory = f.getMemory();
    return {
      completed: result?.completed ?? null,
      error,
      stored: Boolean(memory),
      factCount: (memory?.canonicalArtifact?.facts || []).length,
      stateHeadSchema: f.getHead()?.schema || ''
    };
  } finally {
    await f.r.cleanup();
  }
};

(async () => {
  const observed = {};
  const answer = loadAnswer();
  observed.answerAvailable = Boolean(answer);

  if (answer) {
    // What shape the model produced, recorded so the acceptance below is not a surprise later.
    observed.modelAnswer = {
      chars: answer.length,
      fenced: /```/.test(answer),
      namesSchema: answer.includes('libra.canonical_artifact.v4')
    };

    // The verbatim answer, exactly as the model returned it.
    observed.verbatim = await runWith(answer);

    // The same JSON with any fence removed — the literal shape the prompt asks for ("No prose ...
    // one complete JSON object").
    const stripped = answer.replace(/```[a-zA-Z]*\n?/g, '').trim();
    observed.fenceStripped = await runWith(stripped);
  }

  // The existing suite that proves a quote absent from the source is rejected. If this ever stops
  // passing, "the model's answer was accepted" becomes worthless, so the two are asserted together.
  let evidenceSuite = 'not run';
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'libra_memory_e2e_test.cjs')], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe',
      timeout: 240000
    });
    evidenceSuite = 'PASS';
  } catch (error) {
    evidenceSuite = `FAIL: ${String(error?.message || error).slice(0, 160)}`;
  }
  observed.evidenceRuleSuite = evidenceSuite;

  console.log(JSON.stringify({ test: 'gemma4_libra_artifact_acceptance', observed }, null, 1));

  // --- assertions ---------------------------------------------------------------------------
  if (!observed.answerAvailable) {
    // No captured answer: nothing to judge. Report it in the runner's skip convention instead of
    // exiting non-zero — a missing capture is NOT_RUN, and filing it as FAIL made every regression
    // report one permanent failure, which is where a real failure would hide. The three sibling
    // acceptance suites already behave this way.
    console.log('SKIP: no captured Gemma-4 answer; run tools/_gemma_libra_check.py to produce one');
    console.log('libra_gemma4_artifact_acceptance_test: PASS (skipped, no recording)');
    return;
  }
  assert.equal(observed.modelAnswer.namesSchema, true,
    'the captured answer must name libra.canonical_artifact.v4');
  // 1 + 2 + 3: the plugin commits the model's own answer, in both delivery shapes.
  assert.equal(observed.verbatim.completed, 1,
    `the plugin must commit the model's verbatim answer (got ${JSON.stringify(observed.verbatim)})`);
  assert.equal(observed.verbatim.stored, true,
    'the committed artifact must be stored durably');
  assert.equal(observed.fenceStripped.completed, 1,
    `the plugin must commit the model's answer with the fence removed (got ${JSON.stringify(observed.fenceStripped)})`);
  assert.match(observed.verbatim.stateHeadSchema, /libra\.continuity_state/,
    'a state head must be written for the committed memory');
  // 4: and the validator is not weakened.
  assert.equal(observed.evidenceRuleSuite, 'PASS',
    'the suite proving a bogus quote is rejected must still pass, or the acceptance above means nothing');
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
