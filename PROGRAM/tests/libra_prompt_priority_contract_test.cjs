'use strict';
// RED/GREEN guard for the canonical-memory prompt's REQUIRED/OPTIONAL priority contract.
//
// THE PROBLEM THIS LOCKS DOWN
//
// The librarian stage asks for a lot in one request: 24 claimKinds, up to 100 entities, up to 120
// facts, up to 120 state bindings, each fact carrying exact-source evidence spans. The fourteen
// lens sections describe every rule but never say which requirements are MANDATORY and which are
// best-effort — and the output instruction ("[COMPACT MEMORY OUTPUT] Return compact JSON
// directly...") talks only about brevity.
//
// A model reading that has no way to know that returning three well-evidenced facts is a SUCCESS.
// It is told to be complete, so a partial artifact reads as a failure to the model, and models in
// that position either overreach (inventing coverage) or stall. Downstream, the pipeline already
// supports partial acceptance — `quarantineUnifiedProviderRecords` records per-record rejections
// and `acceptedFacts` is reported, and the GUI already renders "기억 부분 저장 · 사실 N개 보존 ·
// 제외 사실 M개". The prompt simply never tells the model that this is an acceptable outcome.
//
// WHAT IS ASSERTED
//
//   1. The librarian prompt states an explicit minimum that must always be present, so "one
//      confirmed, evidenced fact" is unambiguous rather than inferred.
//   2. It states separately what is OPTIONAL / best-effort, so completeness is encouraged but not
//      treated as a hard requirement.
//   3. It says a partial artifact is still a valid memory, matching what the pipeline actually does.
//   4. The existing hard requirements (schema, exact evidence, five pairs) are NOT weakened — this
//      adds a floor and a permission, it does not remove a rule.
//   5. Nothing changes for the other stages: their section sets are untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

(async () => {
  const harness = await createLibraVmHarness();
  try {
    const api = harness.api;
    const out = await api.debugCompileMemoryPrompt('librarian');
    const profile = typeof out?.profileBody === 'string' ? out.profileBody : '';
    const contract = typeof out?.body === 'string' ? out.body : '';
    const prompt = `${contract}\n\n${profile}`;

    assert.ok(prompt.trim().length > 0, 'the librarian prompt must be compilable');

    // ------------------------------------------------------------------------------------
    // 1. An explicit mandatory minimum.
    // ------------------------------------------------------------------------------------
    assert.match(prompt, /\[REQUIRED\]/,
      'the librarian prompt must mark its mandatory minimum explicitly');
    const requiredIdx = prompt.indexOf('[REQUIRED]');
    const requiredBlock = prompt.slice(requiredIdx, requiredIdx + 700);
    assert.match(requiredBlock, /(?:at least one|minimum of one|하나 이상|최소 한)/i,
      'the REQUIRED block must state a concrete minimum');
    assert.match(requiredBlock, /evidence|quote|근거/i,
      'the REQUIRED block must tie the minimum to a source-evidence requirement, so lowering the '
      + 'count can never be read as lowering the evidence standard');

    // ------------------------------------------------------------------------------------
    // 2. Optional / best-effort material named separately.
    // ------------------------------------------------------------------------------------
    assert.match(prompt, /\[OPTIONAL\]/,
      'the librarian prompt must separate best-effort material from the mandatory minimum');
    const optionalIdx = prompt.indexOf('[OPTIONAL]');
    const optionalBlock = prompt.slice(optionalIdx, optionalIdx + 900);
    assert.match(optionalBlock, /(?:best.?effort|as many as|where possible|가능한)/i,
      'the OPTIONAL block must say the material is best-effort');

    // ------------------------------------------------------------------------------------
    // 3. A partial artifact must be declared a valid outcome, matching the pipeline's own
    //    partial-acceptance support (acceptedFacts is reported and the GUI shows 부분 저장).
    // ------------------------------------------------------------------------------------
    assert.match(prompt, /partial/i,
      'the prompt must state that a partial artifact is still a valid memory');
    assert.match(prompt, /(?:valid memory|still (?:a )?valid|저장됩니다|유효한 기억)/i,
      'the partial-artifact statement must say the result is accepted, not discarded');

    // ------------------------------------------------------------------------------------
    // 4. The hard requirements must remain. This adds a floor and a permission; it must not
    //    weaken the schema, the evidence rule, or the five-pair contract.
    // ------------------------------------------------------------------------------------
    assert.match(prompt, /libra\.canonical_artifact\.v5/,
      'the artifact schema requirement must remain');
    assert.match(prompt, /shortest exact source quotation|exact source/i,
      'the exact-evidence rule must remain');
    const evidenceLens = prompt.includes('not an entire descriptive passage');
    assert.ok(evidenceLens, 'the evidence lens must be preserved verbatim');

    // ------------------------------------------------------------------------------------
    // 5. Other stages are untouched.
    // ------------------------------------------------------------------------------------
    for (const stage of ['ariadne', 'character_ito', 'world_ito', 'plot_ito']) {
      const stageOut = await api.debugCompileMemoryPrompt(stage);
      const stageBody = `${stageOut?.body || ''}\n\n${stageOut?.profileBody || ''}`;
      assert.ok(!stageBody.includes('[REQUIRED]'),
        `the REQUIRED/OPTIONAL contract is librarian-specific and must not leak into ${stage}`);
    }

    console.log(JSON.stringify({
      test: 'libra_prompt_priority_contract',
      requiredBlockPresent: true,
      optionalBlockPresent: true,
      partialArtifactIsValid: true,
      hardRequirementsPreserved: true,
      otherStagesUntouched: 4
    }, null, 1));
    process.stdout.write('libra_prompt_priority_contract_test: PASS\n');
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
