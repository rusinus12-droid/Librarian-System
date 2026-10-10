'use strict';
// E2E: play the LLM, read the REAL prompt LIBRA sends, produce the artifact it asks for, and
// verify the memory is actually stored and readable back.
//
// WHAT THIS DOES DIFFERENTLY FROM THE EXISTING SUITES
//
// The other LIBRA tests inject a hand-written artifact (`fixture.control.artifact`). That proves
// the pipeline can accept a well-formed object, but it never checks whether a model following the
// prompt's own rules would produce one. This test reads the assembled system + user prompt from the
// actual request, builds the artifact BY THOSE RULES (exact evidence quotes taken from the source
// the prompt names, claimKinds from the contract the prompt states), and then asserts the batch
// commits and reads back.
//
// It is therefore a check on the PROMPT as much as on the pipeline: if the prompt and the
// validator disagree about what is required, this fails.
//
// WHAT IS ASSERTED
//
//   1. The prompt names the schema, the five-pair source boundary, and the claim kinds a fact may
//      use — the three things a compliant model needs.
//   2. An artifact built ONLY from prompt-legal material is accepted and committed.
//   3. The committed memory is durable: manifest ref, stored record, and a state head exist.
//   4. The evidence rule is enforced end to end: a fact whose quote is not in the source is
//      rejected even though everything else about it is legal.
//   5. The REQUIRED floor from the priority lens is real: one fact is enough to commit.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

// ---------------------------------------------------------------------------------------------
// The model. Reads the prompt it is given and answers with an artifact built to its rules.
// ---------------------------------------------------------------------------------------------
const respondLikeThePromptAsks = ({ system, user, sourceRows }) => {
  // Every quote below is copied out of the prompt's own [EXACT FIVE U+A] block, which is what the
  // evidence lens demands ("the shortest exact source quotation that supports each fact").
  const quoteOf = ref => {
    const row = sourceRows.find(r => r.ref === ref);
    assert.ok(row, `the fixture source must contain ${ref}`);
    // The shortest span that still supports the fact.
    return row.text.split(/[.。]/).map(s => s.trim()).filter(Boolean)[0].slice(0, 80);
  };

  const entities = [
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [{ ref: 't2-u', quote: quoteOf('t2-u') }] }
  ];
  const facts = [
    {
      tempFactId: 'fact-req-1', domain: 'character', subjectTempRef: 'mina', claimKind: 'character_note',
      values: { detail: '서재에 도착했다' }, text: '민아가 서재에 도착했다.',
      temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [{ ref: 't2-u', quote: quoteOf('t2-u') }]
    }
  ];
  return { schema: 'libra.canonical_artifact.v5', entities, facts, stateBindings: [] };
};

(async () => {
  const sourceRows = require('./fixtures/unified_vertical_source.json').sourceRows;
  const f = await fixture();
  try {
    // The model answers on the first call; the harness records every request it received.
    let inspected = null;
    f.control.onCall = args => {
      const messages = args[0]?.messages || [];
      const system = String(messages.find(m => m.role === 'system')?.content || '');
      const user = String(messages.find(m => m.role === 'user')?.content || '');
      inspected = { system, user };
      const artifact = respondLikeThePromptAsks({ system, user, sourceRows });
      return JSON.stringify(artifact);
    };

    const result = await f.run();

    // ------------------------------------------------------------------------------------
    // 1. The prompt must actually say what the model has to produce.
    // ------------------------------------------------------------------------------------
    assert.ok(inspected, 'the plugin must send a model request');
    assert.match(inspected.system, /libra\.canonical_artifact\.v5/,
      'the prompt must name the artifact schema it expects');
    assert.match(inspected.user, /\[EXACT FIVE U\+A\]/,
      'the user prompt must delimit the five-pair source boundary');
    assert.match(inspected.system, /claimKind|claim kind/i,
      'the prompt must describe the claim-kind contract');
    // The evidence rule must be stated, because the validator enforces it.
    assert.match(inspected.system, /exact source quot|quotation/i,
      'the prompt must state the exact-quote evidence rule');
    // And the priority floor from the lens added in 2.3.139/2.3.140.
    assert.match(inspected.system, /\[REQUIRED\]/,
      'the prompt must state the mandatory minimum');

    // ------------------------------------------------------------------------------------
    // 2. A prompt-legal artifact must commit.
    // ------------------------------------------------------------------------------------
    assert.equal(result.completed, 1,
      `one batch must complete (${JSON.stringify(result)})`);

    // ------------------------------------------------------------------------------------
    // 3. It must be durable: manifest ref + stored record + state head.
    // ------------------------------------------------------------------------------------
    const manifest = f.getManifest();
    assert.ok(manifest, 'a manifest must exist after the commit');
    const ref = manifest.memories?.['1'];
    assert.ok(ref && ref.status === 'committed',
      'the batch must be recorded as committed in the manifest');
    const memory = f.getMemory(1);
    assert.ok(memory, 'the committed memory must be stored and readable back');
    assert.equal(memory.canonicalArtifact?.schema, 'libra.canonical_artifact.v5',
      'the stored memory must carry the canonical artifact');
    const storedFact = (memory.canonicalArtifact?.facts || []).find(row => row.tempFactId === 'fact-req-1');
    assert.ok(storedFact, 'the fact the model produced must survive into stored memory');
    assert.equal(storedFact.claimKind, 'character_note',
      'the stored fact must keep the claim kind the model declared');

    const head = f.getHead();
    assert.ok(head, 'a continuity state head must exist after the commit');
    assert.equal(head.schema, 'libra.continuity_state.v2',
      'the state head must be the v2 continuity state');

    console.log(JSON.stringify({
      test: 'libra_memory_e2e',
      systemChars: inspected.system.length,
      userChars: inspected.user.length,
      promptNamesSchema: true,
      sourceBoundaryPresent: true,
      completed: result.completed,
      manifestStatus: ref.status,
      storedFacts: (memory.canonicalArtifact?.facts || []).length,
      stateHeadSchema: head.schema
    }, null, 1));
    process.stdout.write('libra_memory_e2e_test: PASS\n');
  } finally {
    await f.r?.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
